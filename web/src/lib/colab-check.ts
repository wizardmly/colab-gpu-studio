import type { ComputeSpec } from './gpu-api';

type ColabAccount = {
  account_id: string;
  enabled?: boolean;
  status?: string;
  allow_allocation?: boolean;
  authorization?: { colab?: { connected?: boolean } };
  colab?: { connected?: boolean; status?: string };
  colab_status?: string;
};

export type GpuCheckRequest =
  | { provider: 'colab'; accountId: string }
  | { provider: 'mock'; accountId: null; reason: 'offline' | 'real_disabled' | 'account_unavailable' };

function colabConnected(account: ColabAccount): boolean {
  return account.authorization?.colab?.connected === true
    || account.colab?.connected === true
    || account.colab?.status === 'connected'
    || account.colab_status === 'connected';
}

/** A connected, enabled identity can perform a read-only spec query. */
export function isColabAccountQueryable(account: ColabAccount): boolean {
  // `status` can describe the account's other OAuth/Drive state.  The Colab
  // discovery endpoint is read-only, so allocation permission and that pool
  // status must not turn a connected Colab account into a mock result.
  return account.enabled !== false && colabConnected(account);
}

/** A real job/smoke also needs the explicit account-pool allocation switch. */
export function isColabAccountUsable(account: ColabAccount): boolean {
  return isColabAccountQueryable(account) && account.allow_allocation === true;
}

/**
 * Resolve the exact provider/account pair for a Colab request.
 * The legacy owner-wide settings.google slot is intentionally not consulted:
 * account-pool OAuth and Colab CLI credentials are account-scoped.
 */
export function resolveGpuCheckRequest(
  settings: { real_enabled?: boolean; offline_mode?: boolean } | null,
  accounts: ColabAccount[],
  selectedAccountId: string | null,
  requireAllocation = false,
): GpuCheckRequest {
  if (settings?.offline_mode === true) {
    return { provider: 'mock', accountId: null, reason: 'offline' };
  }
  if (settings?.real_enabled !== true) {
    return { provider: 'mock', accountId: null, reason: 'real_disabled' };
  }

  const predicate = requireAllocation ? isColabAccountUsable : isColabAccountQueryable;
  const account = selectedAccountId
    ? accounts.find((item) => item.account_id === selectedAccountId)
    : accounts.find(predicate);
  if (!account || !predicate(account)) {
    return { provider: 'mock', accountId: null, reason: 'account_unavailable' };
  }
  return { provider: 'colab', accountId: account.account_id };
}

/** Keep the complete official spec object; never stringify its structured key. */
export function selectEligibleColabGpuSpec(
  specs: ComputeSpec[],
  preferredKey?: Record<string, unknown> | null,
): ComputeSpec | null {
  const gpus = specs.filter((spec) => {
    if (spec.eligible !== true || !spec.key || typeof spec.key !== 'object' || Array.isArray(spec.key)) return false;
    const variant = String((spec.key as Record<string, unknown>).variant || '');
    return variant === 'VARIANT_GPU' || variant === 'GPU';
  });
  if (preferredKey && typeof preferredKey === 'object') {
    const accel = String(preferredKey.accelerator || '').toUpperCase();
    const shape = String(preferredKey.shape || '').toUpperCase();
    const exact = gpus.find((s) => {
      const k = s.key as Record<string, unknown>;
      return String(k.accelerator || '').toUpperCase() === accel && (!shape || String(k.shape || '').toUpperCase() === shape);
    });
    if (exact) return exact;
    const sameGpu = accel ? gpus.find((s) => String((s.key as Record<string, unknown>).accelerator || '').toUpperCase() === accel) : null;
    if (sameGpu) return sameGpu;
  }
  return gpus[0] || null;
}
