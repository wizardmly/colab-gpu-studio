import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const requireFromWeb = createRequire(new URL('../package.json', import.meta.url));

const bundled = await build({
  stdin: {
    contents: `
      export {
        colabPipelineSteps,
        describeColabRuntime,
        fillAssetSlots,
        parseOAuthReturnLocation,
        removeAndCompactAssetSlot,
        resolveDefaultMaxRuntime,
        resolveDefaultProvider,
        shortGpuName,
        videoDurationPresets,
      } from './src/lib/colab-studio.ts';
    `,
    resolveDir: webRoot,
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
  fillAssetSlots,
  parseOAuthReturnLocation,
  removeAndCompactAssetSlot,
  resolveDefaultMaxRuntime,
  resolveDefaultProvider,
  shortGpuName,
  videoDurationPresets,
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

test('PC workspace keeps ColabRuntimeBar, removes Colab 实时舞台, constrains ref images, and deduplicates Settings', () => {
  const app = readFileSync('src/App.tsx', 'utf8');
  const create = readFileSync('src/pages/CreatePage.tsx', 'utf8');
  const settings = readFileSync('src/pages/SettingsPage.tsx', 'utf8');
  const slots = readFileSync('src/components/VisualAssetSlots.tsx', 'utf8');

  assert.match(app, /<ColabRuntimeBar\b/);
  assert.match(app, /navLogoutBtn/);
  assert.match(app, /replaceState/);
  const submitBlockMatch = app.match(/async function submitJob\(\)[\s\S]*?\n  \}/);
  assert.ok(submitBlockMatch, 'submitJob function should exist in App.tsx');
  assert.doesNotMatch(submitBlockMatch[0], /setTab\('任务'\)/);
  assert.doesNotMatch(create, /Colab 实时舞台/);
  assert.match(slots, /assetThumbImg/);
  assert.match(slots, /assetLibraryImg/);
  assert.doesNotMatch(settings, /InstanceCenter/);
});

test('resolveDefaultMaxRuntime respects manifest recommendation within server runtimeCap', () => {
  assert.equal(resolveDefaultMaxRuntime(120, 60), 60);
  assert.equal(resolveDefaultMaxRuntime(120, 180), 120);
  assert.equal(resolveDefaultMaxRuntime(40, 60), 40);
  assert.equal(resolveDefaultMaxRuntime(null, 60), 30);
  assert.equal(resolveDefaultMaxRuntime(undefined, 20), 20);
});

test('videoDurationPresets maps 3s-15s cleanly onto discrete frame step grids', () => {
  const ref2vPresets = videoDurationPresets(22, 362, 17, 24);
  assert.deepEqual(
    ref2vPresets.map((p) => p.label),
    ['3秒', '5秒', '8秒', '10秒', '15秒'],
  );
  assert.deepEqual(
    ref2vPresets.map((p) => p.frames),
    [73, 124, 192, 243, 362],
  );

  const i2vPresets = videoDurationPresets(22, 244, 17, 24);
  assert.deepEqual(
    i2vPresets.map((p) => p.label),
    ['3秒', '5秒', '8秒', '10秒'],
  );
});

test('fillAssetSlots and removeAndCompactAssetSlot manage ref slots and frame slots accurately', () => {
  const slotKeys = ['ref_1', 'ref_2', 'ref_3'];
  const filled = fillAssetSlots(slotKeys, { ref_1: 'asset-a' }, ['asset-b', 'asset-c']);
  assert.deepEqual(filled, { ref_1: 'asset-a', ref_2: 'asset-b', ref_3: 'asset-c' });

  const replaced = fillAssetSlots(slotKeys, filled, ['asset-z'], 'ref_2');
  assert.equal(replaced.ref_2, 'asset-z');

  const compacted = removeAndCompactAssetSlot(slotKeys, replaced, 'ref_2', true);
  assert.deepEqual(compacted, { ref_1: 'asset-a', ref_2: 'asset-c', ref_3: '' });

  const frameCleared = removeAndCompactAssetSlot(['first_frame', 'last_frame'], {
    first_frame: 'f1',
    last_frame: 'f2',
  }, 'first_frame', false);
  assert.deepEqual(frameCleared, { first_frame: '', last_frame: 'f2' });
});

async function loadSsrExports(contents, sourcefile) {
  const cssModuleStubPlugin = {
    name: 'css-module-stub',
    setup(buildApi) {
      buildApi.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-stub' }));
      buildApi.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({
        contents: 'export default new Proxy({}, { get: (_, prop) => String(prop) });',
        loader: 'js',
      }));
    },
  };

  const ssrBundle = await build({
    stdin: {
      contents,
      resolveDir: webRoot,
      sourcefile,
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    write: false,
    platform: 'node',
    jsx: 'automatic',
    define: { 'import.meta.env': '{}' },
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'lucide-react'],
    plugins: [cssModuleStubPlugin],
    logLevel: 'silent',
  });

  const cjsMod = { exports: {} };
  const loader = new Function('exports', 'require', 'module', ssrBundle.outputFiles[0].text);
  loader(cjsMod.exports, requireFromWeb, cjsMod);
  return cjsMod.exports;
}

test('CreatePanel SSR renders visual ref slots, non-advanced video_vae chips, and duration presets without blind selects', async () => {
  const React = requireFromWeb('react');
  const { renderToStaticMarkup } = requireFromWeb('react-dom/server');
  const { CreatePanel } = await loadSsrExports(
    `export { CreatePanel } from './src/pages/CreatePage.tsx';`,
    'create-panel-ssr-entry.ts',
  );

  const refManifest = {
    model_id: 'minimax-h3',
    title: 'MiniMax H3 多参考生视频',
    max_runtime_minutes: 120,
    compute_spec: { accelerator: 'T4' },
    parameters: [
      { key: 'prompt', label: '提示词', type: 'text', default: '' },
      { key: 'ref_1', label: '参考图 1', type: 'image', slot_group: 'refs', required: true },
      { key: 'ref_2', label: '参考图 2', type: 'image', slot_group: 'refs' },
      { key: 'mode', label: '模式', type: 'select', default: 'hq', options: [
        { value: 'fast', label: '快速' },
        { value: 'hq', label: '高质量' },
      ] },
      { key: 'video_vae', label: '视频解码器', type: 'select', default: 'dully_seamless', options: [
        { value: 'dully_seamless', label: '无接缝 VAE（推荐）' },
        { value: 'original', label: '原版 VAE' },
      ] },
      { key: 'length', label: '帧数（24 帧/秒）', type: 'integer', default: 124, min: 22, max: 362, step: 17 },
      { key: 'width', label: '宽', type: 'integer', default: 960, min: 256, max: 1280, step: 16 },
      { key: 'height', label: '高', type: 'integer', default: 544, min: 256, max: 1280, step: 16 },
    ],
  };
  const refWorkflow = {
    id: 'wf-ref2v-140',
    workflow_key: 'minimax-h3-ref2v',
    workflow_version: '1.4.0',
    model_id: 'minimax-h3',
    state: 'active',
    active: true,
    title: 'MiniMax H3 多参考生视频',
    manifest: refManifest,
  };

  const noop = () => {};
  const html = renderToStaticMarkup(React.createElement(CreatePanel, {
    projectId: 'proj-1',
    models: [{ model_id: 'minimax-h3', display_name: 'MiniMax H3', enabled: true }],
    workflows: [refWorkflow],
    presets: [],
    settings: realSettings,
    manifest: refManifest,
    params: {
      prompt: 'test',
      ref_1: 'asset-ref-1',
      mode: 'hq',
      video_vae: 'dully_seamless',
      length: 124,
      width: 960,
      height: 544,
    },
    setParams: noop,
    gallery: [{ id: 'asset-ref-1', filename: 'hero.png', mime: 'image/png', url: '/assets/hero.png', created_at: '2026-11-18T00:00:00Z' }],
    outputs: [],
    jobs: [],
    highlightedJobId: null,
    selectedAssets: [],
    setSelectedAssets: noop,
    uploadProgress: {},
    onUpload: async () => null,
    modelId: 'minimax-h3',
    setModelId: noop,
    workflowId: 'wf-ref2v-140',
    setWorkflowId: noop,
    runtime: 'colab',
    setRuntime: noop,
    maxRuntime: 60,
    setMaxRuntime: noop,
    runtimeCap: 60,
    runtimeError: '',
    timeoutRisk: '',
    batchCount: 1,
    setBatchCount: noop,
    batchMode: 'smart',
    setBatchMode: noop,
    runtimeChoice: { mode: 'auto', lifecycle: 'smart', retainIdleMinutes: 15, accountId: null, instanceId: null },
    accounts: [usableAccount],
    instances: [],
    onRuntimeChoiceChange: noop,
    loading: '',
    error: '',
    onSubmit: noop,
    onApplyPreset: noop,
    onSavePreset: noop,
  }));

  assert.doesNotMatch(html, /id="gpu-ref_1"/);
  assert.doesNotMatch(html, /id="batch-mode-select"/);
  assert.doesNotMatch(html, /Colab 实时舞台/);
  assert.match(html, /aria-label="创作类型"/);
  assert.match(html, /图片生成/);
  assert.match(html, /视频生成/);
  assert.match(html, /模型选择/);
  assert.match(html, /class="assetThumbImg"/);
  assert.match(html, /MiniMax H3 多参考生视频/);
  assert.match(html, /<Picture 1>|&lt;Picture 1&gt;/);
  assert.match(html, /无接缝 VAE（推荐）/);
  assert.match(html, /3秒/);
  assert.match(html, /5秒/);
  assert.match(html, /15秒/);
  assert.match(html, /限时 60m/);
});

test('SettingsPanel SSR renders 5 secondary menu items and usage/resources panels', async () => {
  const React = requireFromWeb('react');
  const { renderToStaticMarkup } = requireFromWeb('react-dom/server');
  const { SettingsPanel } = await loadSsrExports(
    `export { SettingsPanel } from './src/pages/SettingsPage.tsx';`,
    'settings-panel-ssr-entry.ts',
  );
  const noop = () => {};

  const settingsBaseProps = {
    settings: realSettings,
    workflows: [],
    error: '',
    accounts: [usableAccount],
    usage: { estimated_units: 12, actual_units: 8, daily_limit: 100, active_runtimes: 0 },
    instances: [],
    onImport: noop,
    onValidate: noop,
    onPublish: noop,
    onRollback: noop,
    onLogout: noop,
    onBack: noop,
  };

  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prevWindow = globalThis.window;
  globalThis.window = { location: { origin: 'http://localhost' } };
  try {
    const accountsHtml = renderToStaticMarkup(React.createElement(SettingsPanel, {
      ...settingsBaseProps,
      initialSection: 'accounts',
    }));
    for (const label of ['Google 账号设置', '工作流 + 模型设置', '外观设置', '算力用量', '资源管理']) {
      assert.ok(accountsHtml.includes(label), `Settings menu missing ${label}`);
    }

    const usageHtml = renderToStaticMarkup(React.createElement(SettingsPanel, {
      ...settingsBaseProps,
      initialSection: 'usage',
    }));
    assert.match(usageHtml, /CU 用量/);
    assert.match(usageHtml, /扣费对账/);

    const resourcesHtml = renderToStaticMarkup(React.createElement(SettingsPanel, {
      ...settingsBaseProps,
      initialSection: 'resources',
    }));
    assert.match(resourcesHtml, /当前设备/);
    assert.match(resourcesHtml, /当前没有实例/);
  } finally {
    if (hadWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});
