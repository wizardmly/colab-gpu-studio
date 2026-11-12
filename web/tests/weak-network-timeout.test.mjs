import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { transform } from 'esbuild';

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
