import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export {
        colabPipelineSteps,
        describeColabRuntime,
        parseOAuthReturnLocation,
        resolveDefaultProvider,
        shortGpuName,
      } from './src/lib/colab-studio.ts';
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    sourcefile: 'colab-studio-ux-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  logLevel: 'silent',
});

const {
  colabPipelineSteps,
  describeColabRuntime,
  parseOAuthReturnLocation,
  resolveDefaultProvider,
  shortGpuName,
} = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

const realSettings = { real_enabled: true, offline_mode: false, storage: 'drive' };
const usableAccount = {
  account_id: 'acct-ultra',
  alias: 'Jake-Ultra',
  status: 'connected',
  enabled: true,
  allow_allocation: true,
  budget: { daily: 100, daily_units: 100 },
  authorization: { colab: { connected: true }, drive: { connected: true } },
};
const unallocatedAccount = {
  ...usableAccount,
  account_id: 'acct-unallocated',
  alias: '待启用号',
  allow_allocation: false,
  budget: {},
};
const noDriveAccount = {
  ...usableAccount,
  account_id: 'acct-no-drive',
  alias: '缺云盘号',
  authorization: { colab: { connected: true }, drive: { connected: false } },
};

test('resolveDefaultProvider defaults to colab when real GPU and usable account exist', () => {
  assert.equal(resolveDefaultProvider(realSettings, [usableAccount], null), 'colab');
  assert.equal(resolveDefaultProvider({ real_enabled: true, offline_mode: true }, [usableAccount], null), 'mock');
  assert.equal(resolveDefaultProvider({ real_enabled: false, offline_mode: false }, [usableAccount], null), 'mock');
  assert.equal(resolveDefaultProvider(realSettings, [unallocatedAccount], null), 'mock');
});

test('describeColabRuntime surfaces warm, busy, ready, attention, and mock states accurately', () => {
  const baseChoice = { accountId: null, instanceId: null };

  const ready = describeColabRuntime({
    runtime: 'colab',
    settings: realSettings,
    accounts: [usableAccount],
    instances: [],
    runtimeChoice: baseChoice,
  });
  assert.equal(ready.tone, 'ready');
  assert.equal(ready.pillLabel, 'Colab 就绪');
  assert.equal(ready.pillSub, 'Jake-Ultra');

  const warm = describeColabRuntime({
    runtime: 'colab',
    settings: realSettings,
    accounts: [usableAccount],
    instances: [{ id: 'vm-1', state: 'retained_idle', gpu_reported: 'NVIDIA L4', account_id: 'acct-ultra' }],
    runtimeChoice: baseChoice,
  });
  assert.equal(warm.tone, 'warm');
  assert.equal(warm.pillLabel, 'L4 热机就绪');
  assert.equal(warm.pillSub, 'Jake-Ultra');

  const busy = describeColabRuntime({
    runtime: 'colab',
    settings: realSettings,
    accounts: [usableAccount],
    instances: [{ id: 'vm-2', state: 'busy', gpu_reported: 'NVIDIA A100-SXM4-40GB', account_id: 'acct-ultra' }],
    runtimeChoice: baseChoice,
  });
  assert.equal(busy.tone, 'busy');
  assert.equal(busy.pillLabel, 'A100 运行中');

  const allocNeeded = describeColabRuntime({
    runtime: 'mock',
    settings: realSettings,
    accounts: [unallocatedAccount],
    instances: [],
    runtimeChoice: baseChoice,
  });
  assert.equal(allocNeeded.tone, 'attention');
  assert.equal(allocNeeded.needsAllocationAccount?.account_id, 'acct-unallocated');

  const driveNeeded = describeColabRuntime({
    runtime: 'mock',
    settings: realSettings,
    accounts: [noDriveAccount],
    instances: [],
    runtimeChoice: baseChoice,
  });
  assert.equal(driveNeeded.tone, 'attention');
  assert.equal(driveNeeded.needsDriveAccount?.account_id, 'acct-no-drive');

  const explicitMock = describeColabRuntime({
    runtime: 'mock',
    settings: realSettings,
    accounts: [usableAccount],
    instances: [],
    runtimeChoice: baseChoice,
  });
  assert.equal(explicitMock.tone, 'mock');
  assert.equal(explicitMock.pillLabel, '离线模拟');
  assert.equal(shortGpuName({ provider: 'colab', runtime_spec_requested: { accelerator: 'T4' } }), 'T4');
});

test('parseOAuthReturnLocation strips google=connected while preserving unrelated params', () => {
  assert.deepEqual(
    parseOAuthReturnLocation('?google=connected&foo=bar', '/studio', '#google-accounts'),
    { justConnected: true, cleanUrl: '/studio?foo=bar' },
  );
  assert.deepEqual(
    parseOAuthReturnLocation('?google=connected', '/', '#google-accounts'),
    { justConnected: true, cleanUrl: '/' },
  );
  assert.deepEqual(
    parseOAuthReturnLocation('?tab=create', '/'),
    { justConnected: false, cleanUrl: '/?tab=create' },
  );
});

test('colabPipelineSteps reflects allocate, warm_reuse, restore_runtime, sampling, and upload', () => {
  assert.deepEqual(
    colabPipelineSteps({ state: 'allocating', stage: 'allocate' }).map((s) => s.status),
    ['active', 'pending', 'pending', 'pending'],
  );
  const warmSteps = colabPipelineSteps({ state: 'preparing', stage: 'warm_reuse' });
  assert.equal(warmSteps[1].label, '热机秒复用');
  assert.deepEqual(warmSteps.map((s) => s.status), ['done', 'active', 'pending', 'pending']);
  assert.deepEqual(
    colabPipelineSteps({ state: 'running', stage: 'sampling' }).map((s) => s.status),
    ['done', 'done', 'active', 'pending'],
  );
  assert.deepEqual(
    colabPipelineSteps({ state: 'uploading', stage: 'upload' }).map((s) => s.status),
    ['done', 'done', 'done', 'active'],
  );
  assert.deepEqual(
    colabPipelineSteps({ state: 'completed', stage: 'upload' }).map((s) => s.status),
    ['done', 'done', 'done', 'done'],
  );
});

test('PC workspace keeps ColabRuntimeBar, stays on Creation after submit, and deduplicates Settings', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const create = readFileSync('src/pages/CreatePage.tsx', 'utf8');
  const settings = readFileSync('src/pages/SettingsPage.tsx', 'utf8');

  assert.match(app, /<ColabRuntimeBar\b/);
  assert.match(app, /replaceState/);
  const submitBlockMatch = app.match(/async function submitJob\(\)[\s\S]*?\n  \}/);
  assert.ok(submitBlockMatch, 'submitJob function should exist in App.tsx');
  assert.doesNotMatch(submitBlockMatch[0], /setTab\('任务'\)/);
  assert.match(create, /createStage/);
  assert.match(create, /colabPipelineSteps/);
  assert.doesNotMatch(settings, /InstanceCenter/);
});
