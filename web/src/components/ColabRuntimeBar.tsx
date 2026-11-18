import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Cpu, HardDrive, Loader, Play, Power, Search, Square, Timer, Wrench } from 'lucide-react';
import {
  apiMessage,
  updateGoogleAccount,
  type ComputeSpec,
  type GpuSettings,
  type GpuUsage,
  type Provider,
} from '../lib/gpu-api';
import {
  describeColabRuntime,
  isAccountBudgetMissing,
  shortGpuName,
} from '../lib/colab-studio';
import { formatInstanceTime } from '../lib/instance-time';
import { instanceIdentity, instanceReusable } from '../lib/instance-submission';
import { cuNumber, keyId, readableState } from '../lib/ui-helpers';
import type { RuntimeChoice } from '../pages/CreatePage';
import type { GpuAccount, GpuInstance } from './AccountDirectory';
import { ComputeSpecs } from './ComputeSpecs';
import type { RuntimeLifecycle } from './RuntimeSelection';

const LIFECYCLE_OPTIONS: Array<{ value: RuntimeLifecycle; label: string }> = [
  { value: 'save', label: '跑完释放（最省 CU）' },
  { value: 'retain', label: '跑完保留热机（连抽免冷启动）' },
  { value: 'smart', label: '智能短暂保留（约 2 分钟）' },
  { value: 'batch', label: '批次排队复用' },
];

export interface ColabRuntimeBarProps {
  runtime: Provider;
  onRuntimeChange: (next: Provider) => void;
  settings: GpuSettings | null;
  usage: GpuUsage | null;
  accounts: GpuAccount[];
  onAccountsChange: (next: GpuAccount[]) => void;
  instances: GpuInstance[];
  runtimeChoice: RuntimeChoice;
  onRuntimeChoiceChange: (next: RuntimeChoice) => void;
  maxRuntime: number;
  onMaxRuntimeChange: (next: number) => void;
  runtimeCap: number;
  runtimeError: string;
  activeJobsCount: number;
  specs: ComputeSpec[];
  specsNote: string;
  loadingCheck: boolean;
  onCheckGpu: () => void;
  onRetainInstance: (instance: GpuInstance) => void;
  onStopInstance: (instance: GpuInstance) => void;
  onEmergencyStop: () => void;
  onOpenCompute: () => void;
  onOpenSettings: () => void;
}

export function ColabRuntimeBar({
  runtime,
  onRuntimeChange,
  settings,
  usage,
  accounts,
  onAccountsChange,
  instances,
  runtimeChoice,
  onRuntimeChoiceChange,
  maxRuntime,
  onMaxRuntimeChange,
  runtimeCap,
  runtimeError,
  activeJobsCount,
  specs,
  specsNote,
  loadingCheck,
  onCheckGpu,
  onRetainInstance,
  onStopInstance,
  onEmergencyStop,
  onOpenCompute,
  onOpenSettings,
}: ColabRuntimeBarProps) {
  const [open, setOpen] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [localError, setLocalError] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const enableKeys = useRef<Record<string, string>>({});

  const summary = describeColabRuntime({ runtime, settings, accounts, instances, runtimeChoice });
  const realAvailable = Boolean(settings?.real_enabled) && settings?.offline_mode !== true;
  const dailyCap = Number(usage?.daily_limit || settings?.budget?.daily_units || 0);
  const used = Number(usage?.actual_units ?? usage?.estimated_units ?? 0);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function quickEnable(account: GpuAccount) {
    if (enabling) return;
    setEnabling(true);
    setLocalError('');
    const key = enableKeys.current[account.account_id] ||= `enable-${account.account_id}-${keyId()}`;
    const patch: Record<string, unknown> = { allow_allocation: true };
    if (isAccountBudgetMissing(account)) {
      const fallbackCap = dailyCap > 0 ? dailyCap : 100;
      patch.budget = { daily: fallbackCap, daily_units: fallbackCap };
    }
    try {
      const updated = await updateGoogleAccount(account.account_id, patch, key) as unknown as GpuAccount;
      delete enableKeys.current[account.account_id];
      onAccountsChange(accounts.map((item) => (item.account_id === account.account_id ? { ...item, ...updated } : item)));
      onRuntimeChange('colab');
    } catch (cause) {
      setLocalError(apiMessage(cause));
    } finally {
      setEnabling(false);
    }
  }

  function updateChoice(patch: Partial<RuntimeChoice>) {
    onRuntimeChoiceChange({ ...runtimeChoice, ...patch });
  }

  return (
    <div className="runtimeBar" ref={wrapRef}>
      <button
        type="button"
        className="runtimePill"
        data-tone={summary.tone}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Colab 运行时状态：${summary.pillLabel}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="runtimeDot" data-tone={summary.tone} aria-hidden />
        <span className="runtimePillTitle">{summary.pillLabel}</span>
        {summary.pillSub && <small className="runtimePillSub">{summary.pillSub}</small>}
        <ChevronDown size={14} strokeWidth={1.8} aria-hidden className={open ? 'runtimeChevOpen' : undefined} />
      </button>

      {open && (
        <section className="runtimePopover" role="dialog" aria-label="Colab 运行时控制">
          <div className="runtimePopHead">
            <div>
              <strong>Colab 运行时</strong>
              <p className="muted small">
                今日用量 {cuNumber(used)} / {dailyCap || '—'} CU
                {activeJobsCount > 0 ? ` · ${activeJobsCount} 个进行中` : ''}
              </p>
            </div>
            <span className={`pill ${runtime === 'colab' && realAvailable ? 'solid' : ''}`}>
              {runtime === 'colab' && realAvailable ? 'Colab GPU' : '离线模拟'}
            </span>
          </div>

          <div className="runtimeSwitch" role="group" aria-label="执行模式">
            <button
              type="button"
              disabled={!realAvailable}
              data-active={runtime === 'colab'}
              onClick={() => onRuntimeChange('colab')}
            >
              <Cpu size={14} strokeWidth={1.8} aria-hidden />
              <span>Colab GPU（真实算力）</span>
            </button>
            <button
              type="button"
              data-active={runtime === 'mock'}
              onClick={() => onRuntimeChange('mock')}
            >
              <Play size={14} strokeWidth={1.8} aria-hidden />
              <span>离线模拟（不扣 CU）</span>
            </button>
          </div>

          {realAvailable && !summary.activeAccount && (
            <div className="runtimeNotice">
              <p className="small">还没有已连接的 Google Colab 账号。先完成 Google 授权才能申请免费或付费 GPU。</p>
              <button
                type="button"
                className="button small"
                onClick={() => { setOpen(false); onOpenSettings(); }}
              >
                连接 Google 账号
              </button>
            </div>
          )}

          {realAvailable && summary.needsDriveAccount && (
            <div className="runtimeNotice">
              <p className="small">
                账号「{summary.needsDriveAccount.alias}」尚缺 Google Drive 授权，无法缓存模型和回传作品。
              </p>
              <button
                type="button"
                className="button small"
                onClick={() => { setOpen(false); onOpenSettings(); }}
              >
                <HardDrive size={14} strokeWidth={1.8} aria-hidden />
                继续去连接 Google Drive
              </button>
            </div>
          )}

          {realAvailable && !summary.usableAccounts.length && summary.needsAllocationAccount && (
            <div className="runtimeNotice">
              <p className="small">
                账号「{summary.needsAllocationAccount.alias}」已连接，但尚未开启「允许分配」或安全预算。
              </p>
              <button
                type="button"
                className="button small"
                disabled={enabling}
                onClick={() => void quickEnable(summary.needsAllocationAccount!)}
              >
                <Power size={14} strokeWidth={1.8} aria-hidden />
                {enabling ? '开启中…' : `一键启用「${summary.needsAllocationAccount.alias}」算力分配`}
              </button>
            </div>
          )}

          {localError && <p className="status error small" role="alert">{localError}</p>}

          {summary.liveInstances.length > 0 && (
            <div className="runtimeMachines">
              <div className="runtimeSubhead">
                <span>在线 Colab 机器</span>
                <small className="muted">{summary.liveInstances.length} 台</small>
              </div>
              {summary.liveInstances.map((inst) => {
                const id = instanceIdentity(inst);
                const state = String(inst.state || '').toLowerCase();
                const reusable = instanceReusable(inst);
                const pinned = runtimeChoice.instanceId === id;
                const cutoff = inst.retained_until || inst.idle_deadline_at || inst.hard_deadline_at;
                const alias = (inst.account_id && accounts.find((a) => a.account_id === inst.account_id)?.alias)
                  || inst.account_alias_snapshot
                  || 'Colab';
                return (
                  <div className="runtimeMachineRow" key={id} data-pinned={pinned}>
                    <div className="runtimeMachineMeta">
                      <strong>
                        {shortGpuName(inst)} · {inst.instance_label || inst.label || id.slice(0, 8)}
                      </strong>
                      <small className="muted">
                        {alias} · {readableState(state)}
                        {cutoff ? ` · 截止 ${formatInstanceTime(cutoff)}` : ''}
                      </small>
                    </div>
                    <div className="runtimeMachineBtns">
                      {reusable && (
                        <button
                          type="button"
                          className={`button small ${pinned ? '' : 'secondary'}`}
                          onClick={() => updateChoice({
                            accountId: inst.account_id || runtimeChoice.accountId,
                            instanceId: pinned ? null : id,
                          })}
                        >
                          {pinned ? '已锁定复用' : '复用此热机'}
                        </button>
                      )}
                      {state !== 'releasing' && (
                        <>
                          <button
                            type="button"
                            className="button secondary small"
                            title="延长空闲保留"
                            onClick={() => onRetainInstance(inst)}
                          >
                            <Timer size={13} aria-hidden />保留
                          </button>
                          <button
                            type="button"
                            className="button danger small"
                            onClick={() => onStopInstance(inst)}
                          >
                            <Square size={12} aria-hidden />释放
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {runtime === 'colab' && (
            <div className="runtimeControls">
              <label className="field">
                <span>调度账号</span>
                <select
                  id="topbar-runtime-account"
                  value={runtimeChoice.accountId || ''}
                  disabled={!summary.usableAccounts.length}
                  onChange={(event) => updateChoice({ accountId: event.target.value || null, instanceId: null })}
                >
                  <option value="">自动选择已启用账号</option>
                  {accounts.map((account) => (
                    <option
                      key={account.account_id}
                      value={account.account_id}
                      disabled={!summary.usableAccounts.some((item) => item.account_id === account.account_id)}
                    >
                      {account.alias || account.account_id} · {account.status === 'connected' ? '可用' : readableState(account.status)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>任务结束后策略</span>
                <select
                  id="topbar-runtime-lifecycle"
                  value={runtimeChoice.lifecycle}
                  onChange={(event) => updateChoice({ lifecycle: event.target.value as RuntimeLifecycle })}
                >
                  {LIFECYCLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              {(runtimeChoice.lifecycle === 'retain' || runtimeChoice.lifecycle === 'smart') && (
                <label className="field">
                  <span>空闲保留分钟数（1–30）</span>
                  <input
                    id="topbar-retain-minutes"
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    value={runtimeChoice.retainIdleMinutes}
                    onChange={(event) => updateChoice({
                      retainIdleMinutes: Math.max(1, Math.min(30, Number(event.target.value) || 1)),
                    })}
                  />
                </label>
              )}

              {!runtimeChoice.instanceId && (
                <label className="field">
                  <span>GPU 选机策略</span>
                  <select
                    id="topbar-runtime-gpu"
                    value={runtimeChoice.gpuSelection || 'workflow'}
                    onChange={(event) => updateChoice({ gpuSelection: event.target.value as 'workflow' | 'auto' })}
                  >
                    <option value="workflow">按工作流推荐机型</option>
                    <option value="auto">自动顺延可用机型</option>
                  </select>
                </label>
              )}

              <label className="field">
                <span>单任务最长运行（分钟，上限 {runtimeCap}）</span>
                <input
                  id="topbar-max-runtime"
                  type="number"
                  min={1}
                  max={runtimeCap}
                  value={maxRuntime || ''}
                  onChange={(event) => onMaxRuntimeChange(Number(event.target.value))}
                />
              </label>
              {runtimeError && <p className="status error small" role="alert">{runtimeError}</p>}
            </div>
          )}

          {specsNote && <p className="muted small" role="status">{specsNote}</p>}
          {specs.length > 0 && <ComputeSpecs specs={specs} />}

          <div className="runtimePopFooter">
            <button
              type="button"
              className="button secondary small"
              disabled={loadingCheck}
              onClick={onCheckGpu}
            >
              {loadingCheck ? <Loader size={13} className="runtimeSpin" aria-hidden /> : <Search size={13} aria-hidden />}
              {loadingCheck ? '检查中…' : '检查可用 GPU'}
            </button>
            <button
              type="button"
              className="button secondary small"
              onClick={() => { setOpen(false); onOpenCompute(); }}
            >
              <Wrench size={13} aria-hidden />算力与对账
            </button>
            {activeJobsCount > 0 && (
              <button
                type="button"
                className="button danger small"
                onClick={() => { setOpen(false); onEmergencyStop(); }}
              >
                <Square size={12} aria-hidden />急停任务 ({activeJobsCount})
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
