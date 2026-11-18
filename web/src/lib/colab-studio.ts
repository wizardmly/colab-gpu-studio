import type { GpuAccount, GpuInstance } from '../components/AccountDirectory';
import type { RuntimeChoice } from '../pages/CreatePage';
import { isColabAccountQueryable, isColabAccountUsable, resolveGpuCheckRequest } from './colab-check';
import type { GpuJob, GpuSettings, Provider } from './gpu-api';
import { instanceIdentity, instanceReusable } from './instance-submission';

export type ColabRuntimeTone = 'warm' | 'busy' | 'ready' | 'attention' | 'mock';

export interface ColabRuntimeSummary {
  tone: ColabRuntimeTone;
  pillLabel: string;
  pillSub: string;
  liveInstances: GpuInstance[];
  reusableInstances: GpuInstance[];
  primaryInstance: GpuInstance | null;
  activeAccount: GpuAccount | null;
  usableAccounts: GpuAccount[];
  needsDriveAccount: GpuAccount | null;
  needsAllocationAccount: GpuAccount | null;
}

export interface ColabPipelineStep {
  key: 'allocate' | 'restore' | 'sample' | 'upload';
  label: string;
  status: 'done' | 'active' | 'pending';
}

const LIVE_INSTANCE_STATES = new Set([
  'requested',
  'allocating',
  'ready',
  'busy',
  'retained_idle',
  'releasing',
]);

function isColabConnected(account: GpuAccount): boolean {
  return account.authorization?.colab?.connected === true
    || account.colab?.status === 'connected'
    || account.colab_status === 'connected';
}

function isDriveConnected(account: GpuAccount): boolean {
  return account.authorization?.drive?.connected === true
    || account.drive?.status === 'connected'
    || account.drive_status === 'connected';
}

export function isAccountBudgetMissing(account: GpuAccount): boolean {
  if (typeof account.budget === 'number') return !Number.isFinite(account.budget);
  if (account.budget && typeof account.budget === 'object') return Object.keys(account.budget).length === 0;
  return account.budget_limit == null;
}

/** Pick Colab automatically whenever real GPU is enabled and a usable account exists. */
export function resolveDefaultProvider(
  settings: { real_enabled?: boolean; offline_mode?: boolean } | null,
  accounts: GpuAccount[],
  selectedAccountId: string | null | undefined,
): Provider {
  const decision = resolveGpuCheckRequest(settings, accounts, selectedAccountId || null, true);
  return decision.provider === 'colab' ? 'colab' : 'mock';
}

/** Extract a concise GPU accelerator label (e.g. A100, L4, T4) for status pills. */
export function shortGpuName(record?: {
  gpu_reported?: string | null;
  runtime_spec_requested?: { accelerator?: string; variant?: string } | Record<string, unknown> | null;
  provider?: string | null;
  prep?: boolean | null;
} | null): string {
  if (!record) return 'Colab GPU';
  if (record.provider === 'mock') return '模拟';
  if (record.prep) return 'CPU';
  const reported = typeof record.gpu_reported === 'string' ? record.gpu_reported.trim() : '';
  if (reported) {
    const known = reported.match(/\b(A100|H100|L4|T4|V100|P100)\b/i);
    if (known) return known[1].toUpperCase();
    return reported.replace(/^(NVIDIA|Tesla)\s+/i, '');
  }
  const spec = record.runtime_spec_requested as Record<string, unknown> | null | undefined;
  const accelerator = typeof spec?.accelerator === 'string' ? spec.accelerator.trim().toUpperCase() : '';
  if (accelerator && accelerator !== 'NONE') return accelerator;
  const variant = typeof spec?.variant === 'string' ? spec.variant.trim().toUpperCase() : '';
  if (variant.includes('CPU')) return 'CPU';
  return 'Colab GPU';
}

/** Derive topbar pill and studio contextual banners from live accounts and Colab VMs. */
export function describeColabRuntime({
  runtime,
  settings,
  accounts,
  instances,
  runtimeChoice,
}: {
  runtime: Provider;
  settings: GpuSettings | null;
  accounts: GpuAccount[];
  instances: GpuInstance[];
  runtimeChoice: Pick<RuntimeChoice, 'accountId' | 'instanceId'>;
}): ColabRuntimeSummary {
  const liveInstances = instances.filter(
    (item) => item.provider !== 'mock' && LIVE_INSTANCE_STATES.has(String(item.state || '').toLowerCase()),
  );
  const reusableInstances = liveInstances.filter((item) => instanceReusable(item));
  const pinnedInstance = runtimeChoice.instanceId
    ? liveInstances.find((item) => instanceIdentity(item) === runtimeChoice.instanceId) || null
    : null;
  const primaryInstance = pinnedInstance
    || liveInstances.find((item) => String(item.state || '').toLowerCase() === 'busy')
    || reusableInstances[0]
    || liveInstances[0]
    || null;

  const requiresDrive = settings?.storage === 'drive';
  const usableAccounts = accounts.filter(
    (account) => isColabAccountUsable(account) && (!requiresDrive || isDriveConnected(account)),
  );
  const needsDriveAccount = requiresDrive
    ? accounts.find((account) => account.enabled !== false && isColabConnected(account) && !isDriveConnected(account)) || null
    : null;
  const needsAllocationAccount = accounts.find(
    (account) => account.enabled !== false
      && isColabConnected(account)
      && (!requiresDrive || isDriveConnected(account))
      && (account.allow_allocation !== true || isAccountBudgetMissing(account)),
  ) || null;
  const activeAccount = (runtimeChoice.accountId
    ? accounts.find((account) => account.account_id === runtimeChoice.accountId)
    : undefined)
    || usableAccounts[0]
    || accounts.find((account) => isColabAccountQueryable(account))
    || null;

  const realAvailable = Boolean(settings?.real_enabled) && settings?.offline_mode !== true;

  if (!realAvailable) {
    return {
      tone: 'mock',
      pillLabel: '离线模拟',
      pillSub: '不扣 CU',
      liveInstances,
      reusableInstances,
      primaryInstance,
      activeAccount,
      usableAccounts,
      needsDriveAccount,
      needsAllocationAccount,
    };
  }

  if (runtime === 'mock' && usableAccounts.length > 0) {
    return {
      tone: 'mock',
      pillLabel: '离线模拟',
      pillSub: '不扣 CU',
      liveInstances,
      reusableInstances,
      primaryInstance,
      activeAccount,
      usableAccounts,
      needsDriveAccount,
      needsAllocationAccount,
    };
  }

  if (usableAccounts.length === 0) {
    if (needsAllocationAccount) {
      return {
        tone: 'attention',
        pillLabel: '需开启分配',
        pillSub: needsAllocationAccount.alias || 'Google 账号',
        liveInstances,
        reusableInstances,
        primaryInstance,
        activeAccount,
        usableAccounts,
        needsDriveAccount,
        needsAllocationAccount,
      };
    }
    if (needsDriveAccount) {
      return {
        tone: 'attention',
        pillLabel: '需连接云盘',
        pillSub: needsDriveAccount.alias || 'Google Drive',
        liveInstances,
        reusableInstances,
        primaryInstance,
        activeAccount,
        usableAccounts,
        needsDriveAccount,
        needsAllocationAccount,
      };
    }
    return {
      tone: 'attention',
      pillLabel: '连接 Colab',
      pillSub: runtime === 'mock' ? '当前为模拟' : '未授权账号',
      liveInstances,
      reusableInstances,
      primaryInstance,
      activeAccount,
      usableAccounts,
      needsDriveAccount,
      needsAllocationAccount,
    };
  }

  const accountAlias = (primaryInstance?.account_id
    && accounts.find((account) => account.account_id === primaryInstance.account_id)?.alias)
    || primaryInstance?.account_alias_snapshot
    || activeAccount?.alias
    || 'Colab 账号';

  if (primaryInstance) {
    const state = String(primaryInstance.state || '').toLowerCase();
    const gpu = shortGpuName(primaryInstance);
    if (state === 'requested' || state === 'allocating') {
      return {
        tone: 'busy',
        pillLabel: '分配 GPU…',
        pillSub: accountAlias,
        liveInstances,
        reusableInstances,
        primaryInstance,
        activeAccount,
        usableAccounts,
        needsDriveAccount,
        needsAllocationAccount,
      };
    }
    if (state === 'busy') {
      return {
        tone: 'busy',
        pillLabel: `${gpu} 运行中`,
        pillSub: accountAlias,
        liveInstances,
        reusableInstances,
        primaryInstance,
        activeAccount,
        usableAccounts,
        needsDriveAccount,
        needsAllocationAccount,
      };
    }
    if (state === 'ready' || state === 'retained_idle') {
      return {
        tone: 'warm',
        pillLabel: `${gpu} 热机就绪`,
        pillSub: accountAlias,
        liveInstances,
        reusableInstances,
        primaryInstance,
        activeAccount,
        usableAccounts,
        needsDriveAccount,
        needsAllocationAccount,
      };
    }
  }

  return {
    tone: 'ready',
    pillLabel: 'Colab 就绪',
    pillSub: accountAlias,
    liveInstances,
    reusableInstances,
    primaryInstance,
    activeAccount,
    usableAccounts,
    needsDriveAccount,
    needsAllocationAccount,
  };
}

/** Detect and clean Google OAuth callback query marker so refreshes return to Creation. */
export function parseOAuthReturnLocation(
  search: string,
  pathname = '/',
  hash = '',
): { justConnected: boolean; cleanUrl: string } {
  const params = new URLSearchParams(search);
  const justConnected = params.get('google') === 'connected';
  if (!justConnected) {
    return { justConnected: false, cleanUrl: `${pathname}${search}${hash}` };
  }
  params.delete('google');
  const nextQuery = params.toString();
  const nextHash = hash === '#google-accounts' ? '' : hash;
  return {
    justConnected: true,
    cleanUrl: `${pathname}${nextQuery ? `?${nextQuery}` : ''}${nextHash}`,
  };
}

/** Build the 4-stage Colab execution progress bar for active jobs on the stage. */
export function colabPipelineSteps(job: Pick<GpuJob, 'state' | 'stage' | 'awaiting_prep'>): ColabPipelineStep[] {
  const state = String(job.state || '').toLowerCase();
  const stage = String(job.stage || '').toLowerCase();
  const warmReuse = stage === 'warm_reuse';

  let activeIndex = 0;
  let allDone = false;

  if (state === 'completed' || state === 'succeeded') {
    allDone = true;
  } else if (stage === 'upload' || state === 'uploading') {
    activeIndex = 3;
  } else if (stage === 'sampling' || state === 'running') {
    activeIndex = 2;
  } else if (
    warmReuse
    || ['restore_env', 'restore_weights', 'restore_runtime', 'restore_loras', 'comfy_start', 'start_comfy'].includes(stage)
    || state === 'preparing'
    || state === 'loading'
  ) {
    activeIndex = 1;
  } else {
    activeIndex = 0;
  }

  const definitions: Array<{ key: ColabPipelineStep['key']; label: string }> = [
    { key: 'allocate', label: job.awaiting_prep ? '准备共享缓存' : '申请 GPU' },
    { key: 'restore', label: warmReuse ? '热机秒复用' : '恢复环境与模型' },
    { key: 'sample', label: 'ComfyUI 采样' },
    { key: 'upload', label: '回传云盘' },
  ];

  return definitions.map((step, index) => ({
    ...step,
    status: allDone || index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'pending',
  }));
}
