import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Plug, Cpu, Layers, LogOut, Sparkles, HardDrive } from 'lucide-react';
import { WorkflowsPanel } from './WorkflowManager';
import { ComputeResourcesSection, ComputeUsageSection, ThemePicker } from './ComputePage';
import type { ComputeSpec, GpuSettings, GpuUsage, GpuWorkflow } from '../lib/gpu-api';
import { GoogleOAuthSetup } from '../components/GoogleOAuthSetup';
import { AccountDirectory, type GpuAccount, type GpuInstance } from '../components/AccountDirectory';
import { Card } from '../components/ui';
import styles from '../gpu.module.css';

export type SettingsSection = 'accounts' | 'workflows' | 'appearance' | 'usage' | 'resources';

export function SettingsPanel({
  settings, workflows, error, accounts = [], onAccountsChange,
  usage = null, instances = [], specs = [], specsNote = '',
  loadingCheck = false, loadingStop = false, resourceError = '',
  projectId = '', projectTitle = '', initialSection, initialView = 'main',
  oauthJustConnected = false, hasUsableColab = false,
  onGoCreate, onCheckGpu, onStopCompute, onContinueInstance, onOpenWorkbench, onRefreshInstances,
  onImport, onValidate, onPublish, onRollback, onDeactivate, onActivated, onOpenJob, onUseProject, onLogout,
}: {
  settings: GpuSettings | null;
  workflows: GpuWorkflow[];
  error: string;
  usage?: GpuUsage | null;
  instances?: GpuInstance[];
  specs?: ComputeSpec[];
  specsNote?: string;
  loadingCheck?: boolean;
  loadingStop?: boolean;
  resourceError?: string;
  onImport: (bundle: string) => void;
  onValidate: (workflow: GpuWorkflow) => void;
  onPublish: (workflow: GpuWorkflow) => void;
  onRollback: (workflow: GpuWorkflow) => void;
  onDeactivate?: (workflow: GpuWorkflow) => void;
  onActivated?: () => void;
  projectId?: string;
  projectTitle?: string;
  initialSection?: SettingsSection;
  initialView?: 'main' | 'workflows';
  oauthJustConnected?: boolean;
  hasUsableColab?: boolean;
  onGoCreate?: () => void;
  onOpenCompute?: () => void;
  onCheckGpu?: () => void;
  onStopCompute?: () => void;
  onContinueInstance?: (instance: GpuInstance) => void;
  onOpenWorkbench?: (instance: GpuInstance) => void;
  onRefreshInstances?: () => void;
  onOpenJob?: (jobId: string, projectId?: string) => void;
  onUseProject?: (projectId: string) => void;
  onLogout: () => void;
  onBack?: () => void;
  accounts?: GpuAccount[];
  onAccountsChange?: (accounts: GpuAccount[]) => void;
}) {
  const resolvedInitial: SettingsSection = initialSection ?? (initialView === 'workflows' ? 'workflows' : 'accounts');
  const [section, setSection] = useState<SettingsSection>(resolvedInitial);
  const [oauthConfigRevision, setOauthConfigRevision] = useState(0);
  const oauthSetupRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    setSection(initialSection ?? (initialView === 'workflows' ? 'workflows' : 'accounts'));
  }, [initialSection, initialView]);

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

  const liveInstancesCount = useMemo(
    () => instances.filter((inst) => String(inst.state || '').toLowerCase() !== 'deleted').length,
    [instances],
  );

  const menuItems: Array<{
    id: SettingsSection;
    title: string;
    sub: string;
    icon: typeof Plug;
    badge?: string;
  }> = [
    {
      id: 'accounts',
      title: 'Google 账号设置',
      sub: 'Colab / Drive 授权与分配',
      icon: Plug,
    },
    {
      id: 'workflows',
      title: '工作流 + 模型设置',
      sub: `已启用 ${publishedCount}/${familyCount} · 校验与发布`,
      icon: Layers,
    },
    {
      id: 'appearance',
      title: '外观设置',
      sub: '深色、浅色与系统主题',
      icon: Monitor,
    },
    {
      id: 'usage',
      title: '算力用量',
      sub: 'CU 用量、扣费对账',
      icon: HardDrive,
    },
    {
      id: 'resources',
      title: '资源管理',
      sub: '当前设备、实例中心',
      icon: Cpu,
      badge: liveInstancesCount > 0 ? String(liveInstancesCount) : undefined,
    },
  ];

  return (
    <div className={styles.settingsShell}>
      <aside className={styles.settingsSidebar}>
        <nav className={styles.settingsMenu} aria-label="设置二级菜单">
          {menuItems.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={styles.settingsMenuItem}
                data-active={active || undefined}
                aria-current={active ? 'page' : undefined}
                onClick={() => setSection(item.id)}
              >
                <Icon size={17} strokeWidth={1.6} aria-hidden />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.sub}</small>
                </span>
                {item.badge && <em className="pill solid">{item.badge}</em>}
              </button>
            );
          })}
        </nav>

        <div className={styles.settingsSideFoot}>
          <button className="button secondary block" type="button" onClick={onLogout}>
            <LogOut size={16} strokeWidth={1.6} aria-hidden />退出登录
          </button>
        </div>
      </aside>

      <div className={styles.settingsContent}>
        {section === 'accounts' && (
          <div className={styles.stack}>
            {(oauthJustConnected || hasUsableColab) && (
              <div className={styles.warmBanner} data-tone={hasUsableColab ? 'warm' : 'attention'}>
                <span>
                  <Sparkles size={16} strokeWidth={1.8} aria-hidden />
                  {oauthJustConnected && hasUsableColab
                    ? 'Google 账号已授权就绪！现在可以直接回到「创作」页用 Colab GPU 生成图片或视频。'
                    : oauthJustConnected
                      ? 'Google 授权回跳成功，请确认下方账号的 Drive 授权与「允许分配」已开启。'
                      : 'Colab 账号已连接并可分配，随时可以回到创作页出图或生视频。'}
                </span>
                {onGoCreate && (
                  <button type="button" className="button small" onClick={onGoCreate}>开始 Colab 创作</button>
                )}
              </div>
            )}

            <Card
              icon={<Plug size={17} strokeWidth={1.6} aria-hidden />}
              title="Google 账号设置"
              aside={settings?.offline_mode ? <span className="pill">离线模式</span> : undefined}
            >
              <AccountDirectory
                key={oauthConfigRevision}
                accounts={accounts}
                onAccountsChange={onAccountsChange}
                onSetupRequested={() => {
                  if (oauthSetupRef.current) {
                    oauthSetupRef.current.open = true;
                    oauthSetupRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                }}
              />
              {!settings?.offline_mode && (
                <details ref={oauthSetupRef} className="foldable">
                  <summary>Google 应用配置（首次使用）</summary>
                  <div className="foldContent"><GoogleOAuthSetup onConfigured={() => setOauthConfigRevision((revision) => revision + 1)} /></div>
                </details>
              )}
            </Card>
            {error && <p className="status error" role="alert">{error}</p>}
          </div>
        )}

        {section === 'workflows' && (
          <div className={styles.stack}>
            <Card
              icon={<Layers size={17} strokeWidth={1.6} aria-hidden />}
              title="工作流 + 模型设置"
              aside={<span className={`pill ${publishedCount > 0 ? 'solid' : ''}`}>已启用 {publishedCount} / {familyCount}</span>}
            >
              <p className="muted small">
                共 {familyCount} 个工作流、{workflows.length} 个版本
                {unactivatedCount > 0 ? `，还有 ${unactivatedCount} 个工作流待首次 Colab 冒烟启用。` : '，全部可用工作流已完成检查。'}
              </p>
            </Card>
            <WorkflowsPanel
              workflows={workflows}
              projectId={projectId}
              projectTitle={projectTitle}
              onImport={onImport}
              onValidate={onValidate}
              onPublish={onPublish}
              onRollback={onRollback}
              onDeactivate={onDeactivate}
              onActivated={onActivated || (() => undefined)}
              onOpenJob={onOpenJob}
              onUseProject={onUseProject}
            />
            {error && <p className="status error" role="alert">{error}</p>}
          </div>
        )}

        {section === 'appearance' && (
          <div className={styles.stack}>
            <Card icon={<Monitor size={17} strokeWidth={1.6} aria-hidden />} title="外观设置">
              <ThemePicker />
            </Card>
          </div>
        )}

        {section === 'usage' && (
          <ComputeUsageSection settings={settings} usage={usage} />
        )}

        {section === 'resources' && (
          <ComputeResourcesSection
            settings={settings}
            usage={usage}
            instances={instances}
            onContinue={onContinueInstance}
            onOpenWorkbench={onOpenWorkbench}
            onRefreshInstances={onRefreshInstances}
            onStop={onStopCompute}
            onCheck={onCheckGpu}
            loadingStop={loadingStop}
            loadingCheck={loadingCheck}
            specs={specs}
            specsNote={specsNote}
            error={error || resourceError}
          />
        )}
      </div>
    </div>
  );
}
