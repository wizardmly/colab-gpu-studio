import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { transform } from 'esbuild';
import { smokeIdempotencyKey } from '../src/lib/activation-resume.ts';
import { rankColabGpuSpecs, selectEligibleColabGpuSpec } from '../src/lib/colab-check.ts';

async function loadApi() {
  const sourcePath = join(process.cwd(), 'src/lib/gpu-api.ts');
  const source = readFileSync(sourcePath, 'utf8');
  const compiled = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2020',
    define: { 'import.meta.env.VITE_API_BASE_URL': '""' },
    sourcemap: false,
  });
  const modulePath = join(tmpdir(), `gpu-api-timeout-${Date.now()}-${Math.random()}.mjs`);
  writeFileSync(modulePath, compiled.code);
  return import(`${pathToFileURL(modulePath).href}?test=${Math.random()}`);
}

test('apiFetch uses extended 45s timeout for cross-border mobile cellular calls', async () => {
  const scheduled = [];
  globalThis.window = {
    setTimeout(fn, ms) {
      scheduled.push(ms);
      return setTimeout(fn, ms);
    },
    clearTimeout(id) {
      clearTimeout(id);
    },
    dispatchEvent() {},
  };
  globalThis.sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });

  const api = await loadApi();
  await api.getProjects();
  assert.deepEqual(scheduled, [45000]);
});

test('uploadAsset sets 180s XHR timeout, handles ontimeout, and surfaces backend error messages', async () => {
  globalThis.window = { setTimeout, clearTimeout, dispatchEvent() {} };
  globalThis.sessionStorage = { getItem: () => 'tok', setItem() {}, removeItem() {} };

  let lastXhr = null;
  let nextMode = 'timeout';
  globalThis.XMLHttpRequest = class MockXHR {
    constructor() {
      this.headers = {};
      this.upload = {};
      this.timeout = 0;
      lastXhr = this;
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    send() {
      if (nextMode === 'timeout') {
        this.ontimeout?.();
      } else if (nextMode === 'error413') {
        this.status = 413;
        this.responseText = JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求超过上传限制' } });
        this.onload?.();
      }
    }
  };

  const api = await loadApi();
  const fakeFile = new Blob(['img'], { type: 'image/png' });

  await assert.rejects(
    () => api.uploadAsset('proj-1', fakeFile),
    (err) => err.code === 'UPLOAD_TIMEOUT' && err.message.includes('超时'),
  );
  assert.equal(lastXhr.timeout, 180000);

  nextMode = 'error413';
  await assert.rejects(
    () => api.uploadAsset('proj-1', fakeFile),
    (err) => err.status === 413 && err.code === 'PAYLOAD_TOO_LARGE' && err.message === '请求超过上传限制',
  );
});

test('smokeIdempotencyKey rotates after a terminal failed smoke job instead of replaying old failure', () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  };

  const first = smokeIdempotencyKey('wf-1', 'proj-1', []);
  assert.equal(smokeIdempotencyKey('wf-1', 'proj-1', []), first);

  const afterFailed = smokeIdempotencyKey('wf-1', 'proj-1', [], 'failed-job-0325');
  assert.notEqual(afterFailed, first);
  assert.equal(smokeIdempotencyKey('wf-1', 'proj-1', [], 'failed-job-0325'), afterFailed);
});

test('rankColabGpuSpecs preserves eligible machine-list order and matches exact requested key', () => {
  const a100 = { key: { variant: 'VARIANT_GPU', accelerator: 'A100', shape: 'SHAPE_HIGHMEM' }, eligible: true };
  const t4High = { key: { variant: 'VARIANT_GPU', accelerator: 'T4', shape: 'SHAPE_HIGHMEM' }, eligible: true };
  const l4 = { key: { variant: 'VARIANT_GPU', accelerator: 'L4', shape: 'SHAPE_STANDARD' }, eligible: true };
  const l4Spec = { variant: 'VARIANT_GPU', accelerator: 'L4', shape: 'SHAPE_STANDARD' };

  assert.deepEqual(
    selectEligibleColabGpuSpec([t4High, a100, l4]),
    t4High,
  );
  assert.deepEqual(
    rankColabGpuSpecs([t4High, a100, l4]),
    [t4High, a100, l4],
  );
  assert.deepEqual(
    rankColabGpuSpecs([t4High, a100, l4], l4Spec),
    [l4],
  );
  assert.deepEqual(
    selectEligibleColabGpuSpec([t4High, a100, l4], l4Spec),
    l4,
  );
});
