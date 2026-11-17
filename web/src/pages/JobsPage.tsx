import { useState, useMemo } from 'react';
import { Zap, Search, RefreshCw, Image as ImageIcon, Film, Loader, ChevronRight, Square, RotateCcw, Archive, ArchiveRestore } from 'lucide-react';
import { apiMessage, type GpuJob } from '../lib/gpu-api';
import styles from '../gpu.module.css';
import { formatDateTime, jobSize, progressPercent, readableState, terminalStates } from '../lib/ui-helpers';
import { jobStageLabel, jobStateLabel } from '../lib/job-stage-rows';
import { canRetainJobInstance, gpuLabel } from '../lib/gpu-label';

// 与后端 scheduler.ACTIVE_STATES 对应：前四个算排队，后面算运行。
const WAITING = ['queued', 'validating', 'waiting_for_capacity', 'allocating'];
const RUNNING = ['preparing', 'loading', 'running', 'uploading', 'cleaning_up', 'cleanup_pending'];
const DONE = ['completed', 'succeeded'];
const FAILED = ['failed', 'failed_final', 'cancelled', 'cancelled_local', 'blocked'];

type Filter = 'all' | 'running' | 'completed' | string;

export function TasksPanel({
  jobs, error, refreshing, onRefresh, onCancel, onRetry, onDetail, onRetain, onInstance, onArchive, onRelease,
}: {
  jobs: GpuJob[];
  error: string;
  refreshing: boolean;
  onRefresh: () => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onDetail: (job: GpuJob) => void;
  onRetain?: (job: GpuJob) => void;
  onInstance?: (job: GpuJob) => void;
  onArchive?: (job: GpuJob, archived: boolean) => Promise<unknown>;
  onRelease?: (job: GpuJob) => Promise<unknown>;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(30);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [status, setStatus] = useState('');
  const [releaseTarget, setReleaseTarget] = useState<GpuJob | null>(null);

  const stateOf = (job: GpuJob) => String(job.state || 'queued').toLowerCase();
  const isActive = (job: GpuJob) => !terminalStates.has(stateOf(job));
  const uniqueJobs = useMemo(() => {
    const seen = new Set<string>();
    return jobs.filter((job, index) => {
      const key = String(job.id || job.job_id || `job-${index}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [jobs]);

  const counts = useMemo(() => ({
    all: uniqueJobs.filter((job) => !job.archived_at).length,
    running: uniqueJobs.filter((job) => !job.archived_at && isActive(job)).length,
    completed: uniqueJobs.filter((job) => !job.archived_at && DONE.includes(stateOf(job))).length,
    archived: uniqueJobs.filter((job) => job.archived_at).length,
  }), [uniqueJobs]);

  const filtered = uniqueJobs.filter((job) => {
    const s = stateOf(job);
    if (Boolean(job.archived_at) !== (filter === 'archived')) return false;
    if (filter === 'running' && !isActive(job)) return false;
    if (filter === 'completed' && !DONE.includes(s)) return false;
    if (!['all', 'running', 'completed', 'archived'].includes(filter) && s !== filter) return false;
    return `${job.workflow_key || ''} ${job.id}`.toLowerCase().includes(query.toLowerCase());
  });

  const chip = (value: Filter, label: string) => (
    <button type="button" className={styles.chip} data-active={filter === value} onClick={() => setFilter(value)}>{label}</button>
  );

  async function archive(job: GpuJob) {
    if (!onArchive || busy) return;
    setBusy(job.id); setActionError(''); setStatus('');
    try {
      await onArchive(job, !job.archived_at);
      setStatus(job.archived_at ? '任务已恢复到任务列表。' : '任务已归档，可在“已归档”中查看和恢复。');
    } catch (cause) {
      setActionError(apiMessage(cause));
    } finally {
      setBusy('');
    }
  }

  async function release() {
    if (!releaseTarget || !onRelease || busy) return;
    setBusy(releaseTarget.id); setActionError(''); setStatus('');
    try {
      await onRelease(releaseTarget);
      setReleaseTarget(null);
      setStatus('已提交实例释放请求，远端状态由服务端持续核查。');
    } catch (cause) {
      setActionError(apiMessage(cause));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className={styles.stack}>
      <div className={styles.pageTitle}>
        <h2><Zap size={20} strokeWidth={1.6} aria-hidden />任务队列</h2>
        <button className="button secondary small" type="button" onClick={onRefresh}>
          <RefreshCw size={14} strokeWidth={1.8} aria-hidden className={refreshing ? styles.spin : undefined} />{refreshing ? '刷新中' : '刷新'}
        </button>
      </div>

      {error && <p className="status error" role="alert">{error}</p>}
      {actionError && !releaseTarget && <p className="status error" role="alert">{actionError}</p>}
      {status && <p className="status" role="status">{status}</p>}

      <label className={styles.searchBox}>
        <Search size={17} strokeWidth={1.6} aria-hidden />
        <input aria-label="搜索任务" placeholder="搜索任务（名称、编号）" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(30); }} />
      </label>

      <div className={styles.filterBar}>
        <div className={styles.chipRow}>
          {chip('all', `全部 ${counts.all}`)}
          {chip('running', `进行中 ${counts.running}`)}
          {chip('completed', `已完成 ${counts.completed}`)}
        </div>
        <select aria-label="按状态筛选" className={styles.miniSelect} value={['all', 'running', 'completed'].includes(filter) ? '' : filter} onChange={(e) => setFilter(e.target.value || 'all')}>
          <option value="">更多状态</option>
          <option value="archived">已归档 {counts.archived}</option>
          {[...new Set(uniqueJobs.filter((job) => !job.archived_at).map(stateOf))].map((state) => <option value={state} key={state}>{jobStateLabel(state)}</option>)}
        </select>
      </div>

      {counts.running > 0 && filter !== 'running' && (
        <button type="button" className={styles.banner} onClick={() => setFilter('running')}>
          <Loader size={16} strokeWidth={1.6} aria-hidden className={styles.spin} />
          <span><strong>{counts.running} 个任务</strong>正在排队或运行</span>
          <ChevronRight size={16} strokeWidth={1.6} aria-hidden />
        </button>
      )}

      {filtered.length ? (
        <div className={styles.list}>
          {filtered.slice(0, limit).map((job, index) => {
            const jobKey = String(job.id || job.job_id || `job-${index}`);
            const s = stateOf(job);
            const pct = progressPercent(job.progress);
            const done = DONE.includes(s);
            const running = RUNNING.includes(s);
            const failed = FAILED.includes(s);
            const waiting = WAITING.includes(s);
            const awaitingPrep = s === 'waiting_for_capacity' && job.awaiting_prep === true;
            const video = /i2v|video|ref2v|t2v/i.test(job.workflow_key || '');
            const thumb = done && job.output_asset_ids?.[0] && !video ? `/api/assets/${job.output_asset_ids[0]}/thumbnail` : '';
            const size = jobSize(job);
            const err = job.error_message || job.error;
            const instanceId = String(job.instance_id || '');
            const accountSnapshot = String(job.account_alias_snapshot || job.account_id || '');
            const machineInfo = [
              accountSnapshot ? `账号 ${accountSnapshot}` : '',
              String(job.instance_label || instanceId.slice(0, 8)),
              awaitingPrep ? 'CPU 准备缓存' : gpuLabel(job),
              instanceId ? readableState(String(job.instance_state || '未知')) : awaitingPrep ? '缓存完成后申请 GPU' : terminalStates.has(s) ? '未分配机器' : '等待分配机器',
            ].filter(Boolean).join(' · ');
            const liveInstance = canRetainJobInstance(job);
            const retained = liveInstance && Boolean(job.retained_until || job.instance_state === 'retained_idle');

            return (
              <article className={styles.jobCard} key={jobKey}>
                <div className={styles.jobTop}>
                  <div className={styles.jobThumb}>
                    {thumb ? <img src={thumb} alt="" loading="lazy" /> : video ? <Film size={22} strokeWidth={1.4} aria-hidden /> : <ImageIcon size={22} strokeWidth={1.4} aria-hidden />}
                  </div>
                  <div className={styles.jobInfo}>
                    <div className={styles.jobTitleRow}>
                      <strong title={job.workflow_key || job.id}>{job.workflow_key || `任务 ${job.id.slice(0, 8)}`}</strong>
                      <span className={`pill ${done ? 'solid' : failed ? 'danger' : ''}`}>{jobStateLabel(job.state, job)}</span>
                    </div>
                    <p className="muted small">
                      {[video ? '视频' : '图片', size, job.provider === 'mock' ? '模拟' : job.provider === 'colab' ? 'Colab' : ''].filter(Boolean).join(' · ')}
                    </p>
                    <p className="muted small">创建于 {formatDateTime(job.created_at)}</p>
                    {instanceId ? <button type="button" className={styles.linkButton} onClick={() => onInstance?.(job)}>{machineInfo}</button>
                      : <p className="muted small">{machineInfo}</p>}
                  </div>
                </div>

                {(running || waiting) && (
                  <div className={styles.progressBlock}>
                    <div className={styles.progressText}>
                      <span>{awaitingPrep ? '等待 CPU 缓存准备完成' : running ? (job.stage ? jobStageLabel(job.stage) : pct !== null ? `生成中 ${pct}%` : '生成中…') : '排队等待中'}</span>
                    </div>
                    <div className={styles.progress} data-indeterminate={pct === null}><span style={pct !== null ? { width: `${pct}%` } : undefined} /></div>
                  </div>
                )}

                {err && <p className="status error" role="alert">{err}</p>}

                <div className={styles.cardActions}>
                  <button className="button small" style={{ flex: 1 }} type="button" onClick={() => onDetail(job)}>查看详情</button>
                  {liveInstance && !retained && onRetain && <button className="button secondary small" type="button" onClick={() => onRetain(job)}>保留这台机器</button>}
                  {retained && <span className="pill">已保留{job.retained_until ? `至 ${formatDateTime(String(job.retained_until))}` : ''}</span>}
                  {!terminalStates.has(s) ? (
                    <button className="button secondary small" style={{ flex: 1 }} type="button" onClick={() => onCancel(job.id)}>
                      <Square size={13} strokeWidth={1.8} aria-hidden />取消
                    </button>
                  ) : (
                    <button className="button secondary small" style={{ flex: 1 }} type="button" disabled={Boolean(busy)} onClick={() => onRetry(job.id)}>
                      <RotateCcw size={13} strokeWidth={1.8} aria-hidden />{failed ? '重试' : '再来一次'}
                    </button>
                  )}
                  {terminalStates.has(s) && onArchive && <button className="button secondary small" type="button" disabled={Boolean(busy)} onClick={() => void archive(job)}>
                    {job.archived_at ? <ArchiveRestore size={13} aria-hidden /> : <Archive size={13} aria-hidden />}{job.archived_at ? '恢复到列表' : '归档'}
                  </button>}
                  {terminalStates.has(s) && instanceId && !job.runtime_deleted && job.instance_state !== 'deleted' && onRelease && <button
                    className="button danger small" type="button" disabled={Boolean(busy) || job.instance_state === 'releasing'}
                    onClick={() => { setActionError(''); setReleaseTarget(job); }}
                  ><Square size={13} aria-hidden />{job.instance_state === 'releasing' ? '释放中' : '释放关联实例'}</button>}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty">
          <strong>{filter === 'archived' ? '没有已归档任务' : uniqueJobs.length ? '当前筛选没有任务' : '还没有任务'}</strong>
          <span>{filter === 'archived' ? '已结束任务归档后会显示在这里。' : counts.archived > 0 ? '可在“更多状态”中选择“已归档”查看历史任务。' : '在「创作」里点「立即生成」，任务会出现在这里。'}</span>
        </div>
      )}

      {filtered.length > limit && (
        <button className="button secondary block" type="button" onClick={() => setLimit(limit + 30)}>加载更多任务</button>
      )}
      {releaseTarget && <div className={styles.dialogBackdrop} role="presentation">
        <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="确认释放关联实例">
          <h2>释放关联实例？</h2>
          <p>实例 {String(releaseTarget.instance_label || releaseTarget.instance_id)} 释放后，该机器上正在运行的任务会停止。服务端会核查远端状态，确认释放后更新记录。</p>
          {actionError && <p className="status error" role="alert">{actionError}</p>}
          <div className="actions">
            <button className="button secondary" type="button" disabled={Boolean(busy)} onClick={() => setReleaseTarget(null)}>取消</button>
            <button className="button danger" type="button" disabled={Boolean(busy)} onClick={() => void release()}>{busy ? '提交中…' : '确认释放'}</button>
          </div>
        </section>
      </div>}
    </div>
  );
}
