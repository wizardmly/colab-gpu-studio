import { timingRows, type TimingDetail } from '../lib/job-history';
import { jobStageLabel, jobStateLabel } from '../lib/job-stage-rows';
import type { RuntimeLogSnapshot } from '../lib/gpu-api';
import styles from '../gpu.module.css';

export interface JobHistoryDetailRecord {
  state?: string;
  stage?: string | null;
  timings?: Record<string, number>;
  timing_details?: Record<string, TimingDetail>;
  logs?: Array<{ id?: string; state?: string; created_at?: string; message?: string }>;
  events?: Array<{ id?: string; state?: string; created_at?: string; message?: string }>;
  prep?: boolean;
  runtime_logs?: RuntimeLogSnapshot;
  poll_retry_count?: number;
  poll_last_error?: string | null;
}

export function JobHistoryDetails({ job, live = false }: { job: JobHistoryDetailRecord; live?: boolean }) {
  const rows = timingRows(job);
  const logs = job.logs || job.events || [];
  const runtimeLogs = job.runtime_logs;
  const collectedAt = runtimeLogs?.collected_at ? new Date(runtimeLogs.collected_at * 1000).toLocaleString() : null;
  return (
    <>
      <p className="muted small">
        状态：{jobStateLabel(job.state)}
        {job.stage ? ` · 当前阶段：${jobStageLabel(job.stage)}` : ''}
      </p>
      <details className="foldable" open>
        <summary>{job.prep ? '缓存准备运行日志' : '模型与 ComfyUI 运行日志'}</summary>
        <div className="foldContent" aria-label="运行时日志">
          <p className="muted small">
            {collectedAt ? `最近读取 ${collectedAt}` : live ? '等待运行时日志回传' : '尚无运行日志记录'}
            {live ? ' · 每 4 秒刷新' : ''}
          </p>
          {job.poll_last_error && <p className="status error" role="status">{live ? `状态查询正在重试（${job.poll_retry_count || 0}/5）` : '最近状态查询错误'} · {job.poll_last_error}</p>}
          {runtimeLogs?.worker && <><h3>模型与环境</h3><pre className={styles.diagnostics} tabIndex={0} aria-label="模型与环境日志">{runtimeLogs.worker}</pre></>}
          {runtimeLogs?.comfyui && <><h3>ComfyUI</h3><pre className={styles.diagnostics} tabIndex={0} aria-label="ComfyUI 日志">{runtimeLogs.comfyui}</pre></>}
          {!runtimeLogs?.worker && !runtimeLogs?.comfyui && <p className="muted small">{job.prep ? '模型下载、缓存上传和环境安装输出会显示在这里。' : '模型准备及 ComfyUI 输出会显示在这里。'}</p>}
          {collectedAt && <p className="muted small">显示各日志文件的最近内容，连接中断期间保留上次读取结果。</p>}
        </div>
      </details>
      {rows.length ? (
        <details className="foldable" open>
          <summary>各阶段耗时</summary>
          <div className="foldContent">
            <dl className="kv">
              {rows.map((row) => (
                <div key={row.key} style={{ display: 'contents' }}>
                  <dt>{row.label}</dt>
                  <dd>{row.value} <span className="muted small">· {row.source}</span></dd>
                </div>
              ))}
            </dl>
            <p className="muted small">单位是秒，按服务端墙钟记录。各阶段独立计时，可能重叠，相加不是工作流发布又等待的时间。</p>
          </div>
        </details>
      ) : null}
      {logs.length ? (
        <details className="foldable" open>
          <summary>任务状态事件</summary>
          <div className="foldContent">
            {logs.map((log, index) => (
              <p key={log.id || index} className="muted small">
                {log.created_at ? `${log.created_at} · ` : ''}{log.message || (log.state ? jobStateLabel(log.state) : '状态事件')}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}
