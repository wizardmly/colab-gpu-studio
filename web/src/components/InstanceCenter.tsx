import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Square, Timer, Wrench } from 'lucide-react';
import { apiMessage, getGpuInstance, setInstanceRetention, stopInstance } from '../lib/gpu-api';
import type { GpuInstance } from './AccountDirectory';
import { InstanceWorkbench } from './InstanceWorkbench';
import { formatInstanceTime as formatTime } from '../lib/instance-time';
import { gpuLabel } from '../lib/gpu-label';
import styles from './v020.module.css';

type Filter = 'current' | 'active' | 'retained' | 'history';
type Action = 'retain' | 'stop';
type Detail = GpuInstance & {
  jobs?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
};

const emptyMessages: Record<Filter, { title: string; description: string }> = {
  current: { title: '当前没有实例', description: '提交任务后，服务端分配的实例会显示在这里。' },
  active: { title: '当前没有活动实例', description: '分配中、运行中和保留中的实例会显示在这里。' },
  retained: { title: '当前没有保留实例', description: '已保留且可继续使用的机器会显示在这里。' },
  history: { title: '还没有历史实例', description: '实例确认释放后，会保存在这里。' },
};

export interface InstanceCenterProps {
  instances?: GpuInstance[];
  onContinue?: (instance: GpuInstance) => void;
  onOpenWorkbench?: (instance: GpuInstance) => void;
  onRefresh?: () => void;
}

let keySequence = 0;
function newIdempotencyKey(prefix: string): string {
  keySequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${keySequence.toString(36)}`;
}

function instanceId(instance: Pick<GpuInstance, 'id' | 'instance_id'>): string {
  return instance.id || instance.instance_id || '';
}

function normalizedInstance(instance: GpuInstance): GpuInstance {
  const id = instanceId(instance);
  return { ...instance, id, instance_id: instance.instance_id || id };
}

function shortId(value?: string | null): string {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  return raw.length > 14 ? `#${raw.slice(0, 8)}` : raw;
}

function label(instance: GpuInstance): string {
  const id = instanceId(instance);
  return instance.instance_label || instance.label || (id ? `实例 ${shortId(id)}` : '未命名实例');
}

function stateLabel(value?: string): string {
  return ({
    requested: '请求中', allocating: '分配中', ready: '就绪', busy: '运行中',
    retained_idle: '保留空闲', releasing: '释放中', deleted: '已释放',
    unknown: '未知', cleanup_pending: '待清理', quarantined: '已隔离',
  } as Record<string, string>)[String(value || '')] || value || '状态未知';
}

function isHistory(instance: GpuInstance): boolean {
  return String(instance.state || '').toLowerCase() === 'deleted';
}

function isActive(instance: GpuInstance): boolean {
  return ['requested', 'allocating', 'ready', 'busy', 'retained_idle', 'releasing'].includes(String(instance.state || '').toLowerCase());
}

function isRetained(instance: GpuInstance): boolean {
  const state = String(instance.state || '').toLowerCase();
  return isActive(instance) && state !== 'releasing' && (state === 'retained_idle' || instance.retained_until != null);
}

function errorText(cause: unknown): string {
  return apiMessage(cause);
}

export function InstanceCenter({ instances = [], onContinue, onOpenWorkbench, onRefresh }: InstanceCenterProps) {
  const [filter, setFilter] = useState<Filter>('current');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [workbench, setWorkbench] = useState<GpuInstance | null>(null);
  const currentWorkbench = workbench ? instances.find((item) => instanceId(item) === instanceId(workbench)) || workbench : null;
  const [confirm, setConfirm] = useState<{ action: Action; instance: GpuInstance } | null>(null);
  const [retainMinutes, setRetainMinutes] = useState(15);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const keyRef = useRef<Record<string, string>>({});

  const rows = useMemo(() => {
    const seen = new Set<string>();
    return instances.map(normalizedInstance).filter((item) => {
      const id = instanceId(item);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [instances]);

  useEffect(() => {
    if (selectedId && !rows.some((item) => instanceId(item) === selectedId)) {
      setSelectedId(''); setDetail(null);
    }
  }, [rows, selectedId]);

  const currentCount = rows.filter((instance) => !isHistory(instance)).length;
  const retainedCount = rows.filter(isRetained).length;
  const historyCount = rows.length - currentCount;
  const filtered = rows.filter((instance) => {
    if (filter === 'active') return isActive(instance);
    if (filter === 'retained') return isRetained(instance);
    if (filter === 'history') return isHistory(instance);
    return !isHistory(instance);
  });

  function keyFor(action: Action, id: string) {
    const operation = `${action}:${id}`;
    return keyRef.current[operation] ||= newIdempotencyKey(`instance-${action}`);
  }

  function clearKey(action: Action, id: string) { delete keyRef.current[`${action}:${id}`]; }

  async function openDetail(instance: GpuInstance) {
    const id = instanceId(instance);
    if (!id) return;
    setSelectedId(id); setDetail(null); setError(''); setStatus('正在读取实例详情…');
    try {
      const result = normalizedInstance(await getGpuInstance(id) as unknown as GpuInstance) as Detail;
      setDetail(result);
      setStatus('实例详情已刷新。');
    } catch (cause) {
      setError(errorText(cause)); setStatus('详情读取未确认，请重试。');
    }
  }

  function updateAfterWrite(result: GpuInstance, message: string) {
    const next = normalizedInstance(result);
    const id = instanceId(next);
    setDetail((current) => current && instanceId(current) === id ? { ...current, ...next } : current);
    setStatus(message);
    setError('');
    // The parent is the authoritative list owner. The returned row is applied
    // only after the server confirms the write; refresh then reconciles it.
    onRefresh?.();
  }

  async function submitAction() {
    if (!confirm || busy) return;
    const { action, instance } = confirm;
    const id = instanceId(instance);
    if (!id) return;
    setBusy(`${action}:${id}`); setError(''); setStatus('正在等待服务端确认…');
    try {
      if (action === 'retain') {
        const version = typeof instance.version === 'number' && Number.isFinite(instance.version) ? instance.version : 0;
        const result = await setInstanceRetention(id, {
          retention_mode: 'retain',
          idle_minutes: Math.max(0, Math.min(1440, retainMinutes)),
          expected_version: version,
        }, keyFor(action, id)) as unknown as GpuInstance;
        clearKey(action, id);
        updateAfterWrite(result, '实例已确认进入保留策略。');
      } else {
        const result = await stopInstance(id, keyFor(action, id)) as unknown as GpuInstance;
        clearKey(action, id);
        updateAfterWrite(result, '已确认停止请求；实例仍需等待远端释放完成。');
      }
      setConfirm(null);
    } catch (cause) {
      // Keep the same key and confirmation open: retrying is safe and is not
      // presented as success until the backend returns a result.
      setError(errorText(cause)); setStatus('操作未确认；再次重试会复用同一幂等键。');
    } finally { setBusy(null); }
  }

  function chooseWorkbench(instance: GpuInstance) {
    onOpenWorkbench?.(instance);
    setWorkbench(normalizedInstance(instance));
  }

  if (workbench) {
    return <div className={styles.center}>
      <InstanceWorkbench instance={currentWorkbench || workbench} onBack={() => setWorkbench(null)} onQueued={() => onRefresh?.()} />
    </div>;
  }

  return <section className={styles.center} aria-label="实例中心">
    <div className={styles.sectionHeader}>
      <div><p className={styles.eyebrow}>资源管理</p><h2>实例中心</h2><p className={styles.muted}>查看真实实例状态；停止和保留均以服务端返回为准。</p></div>
      <button type="button" className={styles.iconButton} aria-label="刷新实例" onClick={onRefresh}><RefreshCw size={18} aria-hidden /></button>
    </div>
    {status && <p className={styles.status} role="status">{status}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.summaryRow} aria-label="实例统计">
      <div className={styles.summaryCell}><span className={styles.muted}>当前</span><b>{currentCount}</b></div>
      <div className={styles.summaryCell}><span className={styles.muted}>保留</span><b>{retainedCount}</b></div>
      <div className={styles.summaryCell}><span className={styles.muted}>历史</span><b>{historyCount}</b></div>
    </div>
    <div className={styles.toolbar}>
      <div className={styles.filterGroup} role="group" aria-label="实例筛选">
        {([['current', '当前'], ['active', '活动'], ['retained', '保留'], ['history', '历史']] as const).map(([value, text]) => <button key={value} type="button" className={styles.filterButton} aria-pressed={filter === value} onClick={() => setFilter(value)}>{text}</button>)}
      </div>
    </div>
    {!filtered.length ? <div className={styles.empty}>
      <strong>{emptyMessages[filter].title}</strong>
      <span>{emptyMessages[filter].description}</span>
      {filter === 'current' && historyCount > 0 && <button type="button" className={styles.buttonSecondary} onClick={() => setFilter('history')}>查看历史实例</button>}
    </div> : <div className={styles.instanceMeta}>
      {filtered.map((instance) => {
        const id = instanceId(instance);
        const isSelected = selectedId === id;
        const canMutate = isActive(instance) && String(instance.state || '').toLowerCase() !== 'releasing';
        const currentTask = instance.current_job_id ? shortId(instance.current_job_id) : '空闲';
        return <article className={styles.instanceCard} key={id}>
          <div className={styles.cardTop}><div className={styles.minWidth}><h3 title={id}>{label(instance)}</h3><p className={styles.muted}>{instance.account_alias_snapshot || (instance.account_id ? `账号 ${shortId(instance.account_id)}` : '账号未确认')} · {instance.provider || '运行时未确认'}</p></div><span className={`${styles.badge} ${instance.state === 'ready' || instance.state === 'busy' || instance.state === 'retained_idle' ? styles.good : ''}`}>{stateLabel(instance.state)}</span></div>
          <div className={styles.detailGrid}>
            <div className={styles.metaCell}><span>GPU</span><b>{gpuLabel(instance)}</b></div>
            <div className={styles.metaCell}><span>实例 ID</span><b title={id}>{shortId(id)}</b></div>
            <div className={styles.metaCell}><span>当前任务</span><b title={instance.current_job_id || ''}>{isHistory(instance) ? '已结束' : currentTask}</b></div>
            <div className={styles.metaCell}><span>保留截止</span><b>{formatTime(instance.retained_until || instance.idle_deadline_at)}</b></div>
          </div>
          <div className={styles.cardActions}>
            <button type="button" className={styles.buttonSecondary} onClick={() => void openDetail(instance)}><ChevronDown size={15} aria-hidden />{isSelected ? '刷新详情' : '查看详情'}</button>
            {onContinue && canMutate && <button type="button" className={styles.button} onClick={() => onContinue(instance)}>续用</button>}
            {onOpenWorkbench && <button type="button" className={styles.buttonSecondary} onClick={() => chooseWorkbench(instance)}><Wrench size={15} aria-hidden />{canMutate ? '工作台' : '工作台历史'}</button>}
            {canMutate && <button type="button" className={styles.buttonSecondary} disabled={busy === `retain:${id}`} onClick={() => setConfirm({ action: 'retain', instance })}><Timer size={15} aria-hidden />保留</button>}
            {canMutate && <button type="button" className={styles.buttonDanger} disabled={busy === `stop:${id}`} onClick={() => setConfirm({ action: 'stop', instance })}><Square size={14} aria-hidden />停止</button>}
          </div>
          {isSelected && detail && <div className={styles.detailPanel} aria-label={`${label(instance)}详情`}>
            <div className={styles.detailHeader}><strong>实例详情</strong><span className={styles.muted}>版本 {String(detail.version ?? '—')} · 创建于 {formatTime(detail.created_at)}</span></div>
            <div className={styles.jobList}>{(detail.jobs || []).map((job, index) => <div className={styles.jobItem} key={String(job.id || index)}><b>{String(job.title || job.workflow_key || '任务')} · {shortId(String(job.id || ''))}</b><span>{stateLabel(String(job.state || '状态未知'))} · {formatTime(typeof job.created_at === 'string' ? job.created_at : null)}</span></div>)}</div>
            {!detail.jobs?.length && <p className={styles.muted}>暂无关联任务。</p>}
            <div className={styles.eventList}>{(detail.events || []).slice(-5).map((event, index) => <div className={styles.eventItem} key={String(event.id || index)}><b>{String(event.message || event.event_type || event.state || '事件')}</b><span>{formatTime(typeof event.created_at === 'string' ? event.created_at : null)}</span></div>)}</div>
            {!detail.events?.length && <p className={styles.muted}>暂无实例事件。</p>}
          </div>}
        </article>;
      })}
    </div>}
    {confirm && <div className={styles.sheetBackdrop} role="presentation"><div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby="instance-confirm-title"><h3 id="instance-confirm-title">{confirm.action === 'stop' ? '确认停止实例？' : '确认保留实例？'}</h3><p className={styles.muted}>{confirm.action === 'stop' ? '停止请求提交后，实例进入释放中，远端释放完成后显示为已释放。' : '实例会保持可续用状态，并按服务端策略在空闲后释放。'}</p>{confirm.action === 'retain' && <label className={styles.field}>空闲保留分钟数<input type="number" min={0} max={30} value={retainMinutes} onChange={(event) => setRetainMinutes(Number(event.target.value) || 0)} /></label>}{error && <p className={styles.error} role="alert">{error}</p>}<div className={styles.sheetActions}><button type="button" className={styles.buttonSecondary} onClick={() => { if (!busy) setConfirm(null); }}>取消</button><button type="button" className={confirm.action === 'stop' ? styles.buttonDanger : styles.button} disabled={Boolean(busy)} onClick={() => void submitAction()}>{busy ? '提交中…' : confirm.action === 'stop' ? '确认停止' : '确认保留'}</button></div></div></div>}
  </section>;
}
