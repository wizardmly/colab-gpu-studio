import { useEffect, useMemo, useRef, useState } from 'react';
import { Settings, ChevronLeft, ChevronRight, Monitor, Plug, Cpu, Layers, LogOut, Sparkles } from 'lucide-react';
import { WorkflowsPanel } from './WorkflowManager';
import { ThemePicker } from './ComputePage';
import type { GpuSettings, GpuWorkflow } from '../lib/gpu-api';
import { GoogleOAuthSetup } from '../components/GoogleOAuthSetup';
import { AccountDirectory, type GpuAccount } from '../components/AccountDirectory';
import { Card } from '../components/ui';
import styles from '../gpu.module.css';

export function SettingsPanel({
  settings, workflows, error, accounts = [], onAccountsChange,
  projectId = '', projectTitle = '', initialView = 'main',
  oauthJustConnected = false, hasUsableColab = false,
  onGoCreate, onOpenCompute,
  onImport, onValidate, onPublish, onRollback, onDeactivate, onActivated, onOpenJob, onUseProject, onLogout, onBack,
}: {
  settings: GpuSettings | null;
  workflows: GpuWorkflow[];
  error: string;
  onImport: (bundle: string) => void;
  onValidate: (workflow: GpuWorkflow) => void;
  onPublish: (workflow: GpuWorkflow) => void;
  onRollback: (workflow: GpuWorkflow) => void;
  onDeactivate?: (workflow: GpuWorkflow) => void;
  onActivated?: () => void;
  projectId?: string;
  projectTitle?: string;
  initialView?: 'main' | 'workflows';
  oauthJustConnected?: boolean;
  hasUsableColab?: boolean;
  onGoCreate?: () => void;
  onOpenCompute?: () => void;
  onOpenJob?: (jobId: string, projectId?: string) => void;
  onUseProject?: (projectId: string) => void;
  onLogout: () => void;
  onBack?: () => void;
  accounts?: GpuAccount[];
  onAccountsChange?: (accounts: GpuAccount[]) => void;
}) {
  const [view, setView] = useState<'main' | 'workflows'>(initialView);
  const [oauthConfigRevision, setOauthConfigRevision] = useState(0);
  const oauthSetupRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  const { familyCount, publishedCount, unactivatedCount } = useMemo(() => {
    const keys = new Set<string>();
    const published = new Set<string>();
    workflows.forEach((wf) => {
      keys.add(wf.workflow_key);
      if (wf.state === 'published') published.add(wf.workflow_key);
    });
    return {
      familyCount: keys.size,
      publishedCount: published.size,
      unactivatedCount: Math.max(0, keys.size - published.size),
    };
  }, [workflows]);

  if (view === 'workflows') {
    return (
      <div className={styles.stack}>
        <div className={styles.subHead}>
          <button type="button" className={styles.backBtn} onClick={() => setView('main')}><ChevronLeft size={18} strokeWidth={1.6} aria-hidden />设置</button>
          <h2>工作流与模型</h2>
        </div>
        <WorkflowsPanel workflows={workflows} projectId={projectId} projectTitle={projectTitle} onImport={onImport} onValidate={onValidate} onPublish={onPublish} onRollback={onRollback} onDeactivate={onDeactivate} onActivated={onActivated || (() => undefined)} onOpenJob={onOpenJob} onUseProject={onUseProject} />
        {error && <p className="status error" role="alert">{error}</p>}
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <div className={styles.subHead}>
        <button type="button" className={styles.backBtn} onClick={onBack}><ChevronLeft size={18} strokeWidth={1.6} aria-hidden />返回</button>
        <h2><Settings size={20} strokeWidth={1.6} aria-hidden />设置</h2>
      </div>

      {(oauthJustConnected || hasUsableColab) && (
        <div className={styles.warmBanner} data-tone={hasUsableColab ? 'warm' : 'attention'}>
          <span>
            <Sparkles size={16} strokeWidth={1.8} aria-hidden />
            {oauthJustConnected && hasUsableColab
              ? 'Google 账号已授权就绪！现在可以直接回到「创作」页用 Colab GPU 生成图片或视频。'
              : oauthJustConnected
                ? 'Google 授权回跳成功，请确认下方账号的 Drive 授权与「允许分配」已开启。'
                : 'Colab 账号已连接并可分配，随时可以回到创作舞台出图或生视频。'}
          </span>
          {onGoCreate && (
            <button type="button" className="button small" onClick={onGoCreate}>开始 Colab 创作</button>
          )}
        </div>
      )}

      <div className={styles.managementLayout}>
        <div className={styles.stack}>
          <Card icon={<Plug size={17} strokeWidth={1.6} aria-hidden />} title="Google 账号" aside={settings?.offline_mode ? <span className="pill">离线模式</span> : undefined}>
            <AccountDirectory key={oauthConfigRevision} accounts={accounts} onAccountsChange={onAccountsChange} onSetupRequested={() => {
              if (oauthSetupRef.current) {
                oauthSetupRef.current.open = true;
                oauthSetupRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }} />
            {!settings?.offline_mode && (
              <details ref={oauthSetupRef} className="foldable">
                <summary>Google 应用配置（首次使用）</summary>
                <div className="foldContent"><GoogleOAuthSetup onConfigured={() => setOauthConfigRevision((revision) => revision + 1)} /></div>
              </details>
            )}
          </Card>
        </div>

        <div className={styles.stack}>
          <Card
            icon={<Layers size={17} strokeWidth={1.6} aria-hidden />}
            title="工作流与模型"
            aside={<span className={`pill ${publishedCount > 0 ? 'solid' : ''}`}>已启用 {publishedCount} / {familyCount}</span>}
          >
            <p className="muted small">
              共 {familyCount} 个工作流、{workflows.length} 个版本
              {unactivatedCount > 0 ? `，还有 ${unactivatedCount} 个工作流待首次 Colab 冒烟启用。` : '，全部可用工作流已完成检查。'}
            </p>
            <button type="button" className="button secondary block" onClick={() => setView('workflows')}>
              管理与启用工作流
              <ChevronRight size={16} strokeWidth={1.6} aria-hidden />
            </button>
          </Card>

          <Card icon={<Monitor size={17} strokeWidth={1.6} aria-hidden />} title="外观">
            <ThemePicker />
          </Card>

          {onOpenCompute && (
            <button type="button" className={styles.navRow} onClick={onOpenCompute}>
              <Cpu size={18} strokeWidth={1.5} aria-hidden />
              <span><strong>算力、在线机器与 CU 对账</strong><small className="muted">查看活跃 Colab 机器、延长保留、释放实例与实测扣费</small></span>
              <ChevronRight size={18} strokeWidth={1.5} aria-hidden />
            </button>
          )}

          <button className="button secondary big" type="button" onClick={onLogout}><LogOut size={17} strokeWidth={1.6} aria-hidden />退出登录</button>
          {error && <p className="status error" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}
