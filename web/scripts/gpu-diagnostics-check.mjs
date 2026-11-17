import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Exercise real task-card rendering as well as the shared labels, without network or GPU calls.
const { outputFiles } = await build({
  stdin: { contents: `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { TasksPanel } from './src/pages/JobsPage';
    import { JobHistoryDetails } from './src/components/JobHistoryDetails';
    import { taskStatusNote } from './src/lib/job-detail-copy';
    import { gpuLabel, canRetainJobInstance } from './src/lib/gpu-label';
    import { rankColabGpuSpecs } from './src/lib/colab-check';
    module.exports = { gpuLabel, canRetainJobInstance, taskStatusNote, rankColabGpuSpecs,
      renderDetails(job) { return renderToStaticMarkup(createElement(JobHistoryDetails, { job, live: true })); },
      render(job) {
      return renderToStaticMarkup(createElement(TasksPanel, {
        jobs: [job], error: '', refreshing: false,
        onRefresh() {}, onCancel() {}, onRetry() {}, onDetail() {}, onRetain() {}
      }));
    }};
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', write: false, outfile: 'gpu-check.cjs',
  external: ['react', 'react-dom/server'], loader: { '.css': 'empty' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { gpuLabel, canRetainJobInstance, taskStatusNote, render, renderDetails } = module.exports;
const { rankColabGpuSpecs } = module.exports;
const spec = (accelerator, shape = 'SHAPE_STANDARD', eligible = true, variant = 'VARIANT_GPU') => ({
  key: { variant, accelerator, shape }, eligible,
});
const machineList = [spec('NONE', 'SHAPE_STANDARD', true, 'VARIANT_CPU'), spec('L4'),
  spec('A100', 'SHAPE_HIGHMEM'), spec('T4', 'SHAPE_HIGHMEM'), spec('L4'), spec('T4', 'SHAPE_STANDARD', false)];
assert.deepEqual(rankColabGpuSpecs(machineList), machineList.slice(1, 4));
assert.deepEqual(rankColabGpuSpecs(machineList, machineList[3].key), [machineList[3]]);
assert.deepEqual(rankColabGpuSpecs(machineList, spec('T4').key), []);
const base = { id: 'test', project_id: 'example', provider: 'colab', state: 'completed',
  instance_id: 'instance', instance_state: 'deleted', runtime_deleted: true,
  runtime_spec_requested: { accelerator: 'L4' } };
assert.equal(gpuLabel(base), '申请 GPU：L4（未实测）');
assert.equal(gpuLabel({ ...base, gpu_reported: 'NVIDIA A100-SXM4-40GB' }), '实测 GPU：NVIDIA A100-SXM4-40GB');
assert.equal(gpuLabel({ provider: 'mock' }), '模拟 GPU');
assert.equal(gpuLabel({ prep: true }), 'CPU 预热');
assert.equal(canRetainJobInstance(base), false);
assert.equal(canRetainJobInstance({ ...base, instance_state: 'unknown', runtime_deleted: false }), false);
assert.doesNotMatch(render(base), /保留这台机器|等待分配机器|GPU 未确认/);
assert.doesNotMatch(render({ ...base, retained_until: '2099-01-01' }), /已保留|保留这台机器/);
assert.match(render({ ...base, instance_state: 'busy', runtime_deleted: false }), /保留这台机器/);
const cancelled = render({ ...base, state: 'cancelled', instance_id: null, instance_state: null });
assert.match(cancelled, /未分配机器/);
assert.doesNotMatch(cancelled, /等待分配机器|保留这台机器/);
const waitingPrep = { ...base, state: 'waiting_for_capacity', instance_id: null, instance_state: null,
  awaiting_prep: true, prep_job_id: 'cpu-prep', cache_prep: {
    id: 'cpu-prep', project_id: 'example', prep: true, state: 'running', stage: 'prep_weights',
    runtime_logs: { collected_at: 100, worker: 'model-download 50%' },
    poll_retry_count: 2, poll_last_error: 'Colab kernel inspect HTTP 403',
  } };
assert.match(render(waitingPrep), /准备缓存/);
assert.match(render(waitingPrep), /缓存完成后申请 GPU/);
assert.doesNotMatch(render(waitingPrep), /等待分配机器|排队等待中|申请 GPU：/);
assert.match(taskStatusNote(waitingPrep), /CPU.*缓存.*GPU/);
assert.match(renderDetails(waitingPrep), /CPU 缓存任务/);
assert.match(renderDetails(waitingPrep), /准备模型权重/);
assert.match(renderDetails(waitingPrep), /model-download 50%/);
assert.match(renderDetails(waitingPrep), /HTTP 403/);
assert.doesNotMatch(render({ ...waitingPrep, state: 'cancelled' }), /CPU 准备缓存|缓存完成后申请 GPU/);
console.log('GPU evidence labels and task-card lifecycle checks passed');
