import { useEffect, useMemo, useState } from 'react';
import {
  Sparkles, Image as ImageIcon, Film, Layers, Pencil, SlidersHorizontal, Play, Monitor, Cloud,
  ChevronRight, Minus, Plus, X, Check, Star, Download, RotateCcw, Eye, Square, Timer, Cpu,
} from 'lucide-react';
import {
  assetUrl,
  type GalleryAsset,
  type GpuJob,
  type GpuManifest,
  type GpuModel,
  type GpuPreset,
  type GpuSettings,
  type GpuWorkflow,
  type Provider,
} from '../lib/gpu-api';
import { GpuParamForm, splitParams } from '../components/GpuParamForm';
import { ReferencePicker, supportsReferences } from '../components/ReferencePicker';
import { RuntimeSelection } from '../components/RuntimeSelection';
import type { RuntimeLifecycle, RuntimeSelectionValue } from '../components/RuntimeSelection';
import type { GpuAccount, GpuInstance } from '../components/AccountDirectory';
import { Card, InfoTip, Segmented } from '../components/ui';
import { colabPipelineSteps, describeColabRuntime, shortGpuName } from '../lib/colab-studio';
import { canRetainJobInstance, gpuLabel } from '../lib/gpu-label';
import { instanceIdentity, instanceReusable } from '../lib/instance-submission';
import { jobStageLabel, jobStateLabel } from '../lib/job-stage-rows';
import { RUNTIME_HELP } from '../lib/labels';
import { formatDateTime, parameterKey, parameterList, progressPercent, shown, terminalStates } from '../lib/ui-helpers';
import { workflowTitle, workflowUsage } from '../lib/workflow-copy';
import styles from '../gpu.module.css';

type Category = 'image' | 'video';
export type RuntimeChoice = RuntimeSelectionValue;

const isVideoKey = (key: string) => /i2v|video|ref2v|t2v/i.test(key);

const LIFECYCLE_SHORT: Record<RuntimeLifecycle, string> = {
  save: '跑完释放',
  batch: '批次复用',
  smart: '智能保留',
  retain: '保留热机',
};

/** 常用画幅。图片使用固定尺寸表；视频等小分辨率工作流按工作流默认像素量等比换算。 */
const RATIOS = [
  { label: '1:1', rw: 1, rh: 1, size: [992, 992] },
  { label: '3:4', rw: 3, rh: 4, size: [768, 1024] },
  { label: '9:16', rw: 9, rh: 16, size: [576, 1024] },
  { label: '4:3', rw: 4, rh: 3, size: [1024, 768] },
  { label: '16:9', rw: 16, rh: 9, size: [1024, 576] },
] as const;

const roundTo = (value: number, step: number) => Math.max(step, Math.round(value / step) * step);

function buildSizes(defW: number, defH: number, step: number, min: number, max: number) {
  const area = defW * defH;
  const scale = area > 0 && area < 700_000;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return RATIOS.map((ratio) => {
    let [w, h]: number[] = [...ratio.size];
    if (scale) {
      h = Math.sqrt(area * ratio.rh / ratio.rw);
      w = h * ratio.rw / ratio.rh;
      w = roundTo(w, step);
      h = roundTo(h, step);
    }
    return { ...ratio, w: clamp(w), h: clamp(h) };
  });
}

function assetDims(asset: GalleryAsset): string {
  const meta = (asset.metadata || {}) as Record<string, unknown>;
  const w = Number(meta.width ?? asset.width);
  const h = Number(meta.height ?? asset.height);
  return w > 0 && h > 0 ? `${w} × ${h}` : '';
}

function specBadgeText(manifest: GpuManifest | null | undefined): string {
  const spec = manifest?.compute_spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return '';
  const accelerator = typeof (spec as Record<string, unknown>).accelerator === 'string'
    ? String((spec as Record<string, unknown>).accelerator).toUpperCase()
    : '';
  return accelerator && accelerator !== 'NONE' ? accelerator : '';
}

export function CreatePanel({
  projectId, models, workflows, presets, settings, manifest, params, setParams, gallery,
  outputs = [], jobs = [], highlightedJobId = null,
  selectedAssets, setSelectedAssets, uploadProgress, onUpload, setModelId, workflowId, setWorkflowId,
  runtime, setRuntime, maxRuntime, setMaxRuntime, runtimeCap, runtimeError, timeoutRisk, batchCount, setBatchCount, batchMode,
  runtimeChoice, accounts, instances, onRuntimeChoiceChange,
  loading, error, onSubmit, onApplyPreset, onSavePreset,
  onOpenAsset, onFavoriteAsset, onReuseAsset,
  onOpenJobDetail, onCancelJob, onRetryJob, onRetainJob,
  onOpenGallery, onOpenJobs, onOpenSettings, onOpenWorkflows, onQuickEnableAccount,
}: {
  projectId: string;
  models: GpuModel[];
  workflows: GpuWorkflow[];
  presets: GpuPreset[];
  settings: GpuSettings | null;
  manifest: GpuManifest | null;
  params: Record<string, unknown>;
  setParams: (value: Record<string, unknown>) => void;
  gallery: GalleryAsset[];
  outputs?: GalleryAsset[];
  jobs?: GpuJob[];
  highlightedJobId?: string | null;
  selectedAssets: string[];
  setSelectedAssets: (value: string[]) => void;
  uploadProgress: Record<string, number>;
  onUpload: (file: File) => Promise<void>;
  modelId: string;
  setModelId: (value: string) => void;
  workflowId: string;
  setWorkflowId: (value: string) => void;
  runtime: Provider;
  setRuntime: (value: Provider) => void;
  maxRuntime: number;
  setMaxRuntime: (value: number) => void;
  runtimeCap: number;
  runtimeError: string;
  timeoutRisk: string;
  batchCount: number;
  setBatchCount: (n: number) => void;
  batchMode: 'save' | 'smart' | 'batch' | 'retain';
  setBatchMode: (m: 'save' | 'smart' | 'batch' | 'retain') => void;
  runtimeChoice: RuntimeChoice;
  accounts: GpuAccount[];
  instances: GpuInstance[];
  onRuntimeChoiceChange: (value: RuntimeChoice) => void;
  loading: string;
  error: string;
  onSubmit: () => void;
  onApplyPreset: (preset: GpuPreset) => void;
  onSavePreset: (name: string) => void;
  onOpenAsset?: (asset: GalleryAsset) => void;
  onFavoriteAsset?: (asset: GalleryAsset) => void;
  onReuseAsset?: (asset: GalleryAsset) => void;
  onOpenJobDetail?: (job: GpuJob) => void;
  onCancelJob?: (id: string) => void;
  onRetryJob?: (id: string) => void;
  onRetainJob?: (job: GpuJob) => void;
  onOpenGallery?: () => void;
  onOpenJobs?: () => void;
  onOpenSettings?: () => void;
  onOpenWorkflows?: () => void;
  onQuickEnableAccount?: (account: GpuAccount) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customSize, setCustomSize] = useState(false);
  const [presetName, setPresetName] = useState('');

  /* ───── 工作流分组：同一个 workflow_key 的所有版本归为一族 ───── */
  const families = useMemo(() => {
    const map = new Map<string, { key: string; modelId: string; items: GpuWorkflow[]; category: Category }>();
    workflows.forEach((wf) => {
      const fam = map.get(wf.workflow_key) || { key: wf.workflow_key, modelId: wf.model_id, items: [], category: isVideoKey(wf.workflow_key) ? 'video' as Category : 'image' as Category };
      fam.items.push(wf);
      map.set(wf.workflow_key, fam);
    });
    map.forEach((fam) => fam.items.sort((a, b) => String(b.workflow_version).localeCompare(String(a.workflow_version), undefined, { numeric: true })));
    return [...map.values()];
  }, [workflows]);

  const activeWorkflow = workflows.find((item) => item.id === workflowId);
  const currentFamily = activeWorkflow ? families.find((f) => f.key === activeWorkflow.workflow_key) : undefined;
  const category: Category = currentFamily?.category || 'image';
  const modelName = (id?: string) => models.find((m) => m.model_id === id)?.display_name || id || '';
  const pickable = (fam: typeof families[number]) => fam.items.some((i) => i.state === 'published') ? fam.items.filter((i) => i.state === 'published') : fam.items;

  function chooseWorkflow(wf: GpuWorkflow) {
    setModelId(wf.model_id);
    setWorkflowId(wf.id);
  }
  function chooseFamily(fam: typeof families[number]) {
    const list = pickable(fam);
    const target = list.find((i) => i.active) || list[0];
    if (target) chooseWorkflow(target);
  }
  function switchCategory(next: Category) {
    if (next === category) return;
    const fam = families.find((f) => f.category === next);
    if (fam) chooseFamily(fam);
  }

  const subtitle = activeWorkflow
    ? String(activeWorkflow.description || activeWorkflow.manifest?.description || manifest?.description || modelName(activeWorkflow.model_id))
    : '';
  const recommendedAccelerator = specBadgeText(manifest || activeWorkflow?.manifest);

  /* ───── 提示词、尺寸 ───── */
  const plist = useMemo(() => parameterList(manifest), [manifest]);
  const keys = useMemo(() => plist.map((p, i) => parameterKey(p, i)), [plist]);
  const promptKey = keys.find((k) => k === 'prompt') || keys.find((k) => /prompt|caption/i.test(k) && !/negative/i.test(k)) || 'prompt';
  const hasSize = keys.includes('width') && keys.includes('height');
  const wParam = plist.find((p, i) => parameterKey(p, i) === 'width');
  const hParam = plist.find((p, i) => parameterKey(p, i) === 'height');
  const step = Number(wParam?.step) > 1 ? Number(wParam?.step) : 16;
  const minSide = Math.max(Number(wParam?.min) || 0, Number(hParam?.min) || 0, 256);
  const maxSide = Math.min(Number(wParam?.max) || 2048, Number(hParam?.max) || 2048);
  const sizes = useMemo(
    () => buildSizes(Number(wParam?.default) || 0, Number(hParam?.default) || 0, step, minSide, maxSide),
    [wParam, hParam, step, minSide, maxSide],
  );
  const curW = Number(params.width) || 0;
  const curH = Number(params.height) || 0;
  const matched = sizes.find((s) => s.w === curW && s.h === curH);
  const showCustom = customSize || !matched;

  useEffect(() => { setCustomSize(false); }, [workflowId]);

  const excluded = useMemo(() => [promptKey, ...(hasSize ? ['width', 'height'] : [])], [promptKey, hasSize]);
  const split = useMemo(() => splitParams(manifest, excluded), [manifest, excluded]);
  const promptValue = String(params[promptKey] ?? '');
  const patch = (next: Record<string, unknown>) => setParams({ ...params, ...next });

  /* ───── Colab 运行时与右栏舞台数据 ───── */
  const summary = useMemo(
    () => describeColabRuntime({ runtime, settings, accounts, instances, runtimeChoice }),
    [runtime, settings, accounts, instances, runtimeChoice],
  );
  const realAvailable = Boolean(settings?.real_enabled) && settings?.offline_mode !== true;
  const pinnedReusable = runtimeChoice.instanceId
    ? summary.reusableInstances.find((item) => instanceIdentity(item) === runtimeChoice.instanceId) || null
    : null;
  const warmInstance = summary.primaryInstance && instanceReusable(summary.primaryInstance)
    ? summary.primaryInstance
    : null;

  const activeJobs = useMemo(
    () => jobs.filter((job) => !job.archived_at && !terminalStates.has(String(job.state || 'queued').toLowerCase())),
    [jobs],
  );

  const stageJobs = useMemo(() => {
    const failedJob = [...jobs]
      .filter((job) => !job.archived_at && ['failed', 'failed_final', 'blocked'].includes(String(job.state || '').toLowerCase()))
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];
    const newestCompleted = [...jobs]
      .filter((job) => ['completed', 'succeeded'].includes(String(job.state || '').toLowerCase()))
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];

    const list = [...activeJobs];
    if (failedJob && !list.some((item) => item.id === failedJob.id)) {
      const failedStamp = String(failedJob.updated_at || failedJob.created_at || '');
      const doneStamp = String(newestCompleted?.updated_at || newestCompleted?.created_at || '');
      if (failedJob.id === highlightedJobId || (failedStamp && (!doneStamp || failedStamp >= doneStamp))) {
        list.push(failedJob);
      }
    }
    return list;
  }, [activeJobs, jobs, highlightedJobId]);

  const sortedOutputs = useMemo(() => {
    if (!outputs.length) return [];
    const copy = [...outputs];
    copy.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return copy;
  }, [outputs]);

  const activeAccountAlias = summary.activeAccount?.alias || '自动账号';
  const colabBlocked = runtime === 'colab' && summary.usableAccounts.length === 0;
  const workflowUnpublished = !activeWorkflow || activeWorkflow.state !== 'published';
  const summaryLine = runtime === 'mock'
    ? '离线模拟 · 不连接 Colab、不扣 CU'
    : summary.usableAccounts.length > 0
      ? `Colab GPU · ${activeAccountAlias} · ${pinnedReusable ? `复用热机 ${shortGpuName(pinnedReusable)}` : '自动分配 GPU'} · ${LIFECYCLE_SHORT[runtimeChoice.lifecycle]} · 限时 ${maxRuntime}m`
      : '需先完成 Google 账号授权或开启算力分配';

  if (!projectId) {
    return (
      <div className="empty">
        <strong>请先选择或新建项目</strong>
        <span>点右上角的项目名称，项目用来归档你的参数预设、素材和作品。</span>
      </div>
    );
  }

  return (
    <div className={styles.createWorkspace}>
      {/* ───── 左侧紧凑参数轨 ───── */}
      <div className={styles.createRail}>
        <Card
          icon={<Layers size={17} strokeWidth={1.6} aria-hidden />}
          title="创作模式与工作流"
          aside={<button type="button" className={styles.linkButton} onClick={() => setPickerOpen(true)}>切换<ChevronRight size={15} strokeWidth={1.6} aria-hidden /></button>}
        >
          <Segmented<Category>
            ariaLabel="创作类型"
            value={category}
            onChange={switchCategory}
            options={[
              { value: 'image', label: '图片生成', icon: <ImageIcon size={16} strokeWidth={1.6} aria-hidden />, disabled: !families.some((f) => f.category === 'image') },
              { value: 'video', label: '视频生成', icon: <Film size={16} strokeWidth={1.6} aria-hidden />, disabled: !families.some((f) => f.category === 'video') },
            ]}
          />

          {activeWorkflow ? (
            <button type="button" className={styles.wfCard} onClick={() => setPickerOpen(true)} aria-label="切换工作流">
              <span className={styles.wfThumb}><Layers size={20} strokeWidth={1.4} aria-hidden /></span>
              <span className={styles.wfBody}>
                <span className={styles.wfName}>
                  <strong>{workflowTitle(activeWorkflow)}</strong>
                  <span className="pill">v{activeWorkflow.workflow_version}</span>
                  {recommendedAccelerator && <span className="pill solid">{recommendedAccelerator}</span>}
                </span>
                <small className="muted">{activeWorkflow.workflow_key}{subtitle ? ` · ${subtitle}` : ''}</small>
              </span>
            </button>
          ) : (
            <p className="muted small">还没有可用的工作流，请先到「设置 › 工作流与模型」启用。</p>
          )}

          {workflowUnpublished && (
            <div className={styles.railAlert}>
              <span className="small">此工作流尚未完成首次 Colab 冒烟启用，不能直接运行真实 GPU。</span>
              {onOpenWorkflows && (
                <button type="button" className="button secondary small" onClick={onOpenWorkflows}>
                  去启用工作流
                </button>
              )}
            </div>
          )}

          <details className={`foldable ${styles.presetBox}`}>
            <summary>参数预设{presets.filter((p) => p.workflow_version_id === workflowId).length ? `（${presets.filter((p) => p.workflow_version_id === workflowId).length}）` : ''}</summary>
            <div className="foldContent">
              <div className="field">
                <label htmlFor="preset-select">套用已存的参数</label>
                <select id="preset-select" defaultValue="" onChange={(e) => {
                  const preset = presets.find((p) => p.id === e.target.value);
                  if (preset) onApplyPreset(preset);
                }}>
                  <option value="">选择预设…</option>
                  {presets.filter((p) => p.workflow_version_id === workflowId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className={styles.inlineForm}>
                <input aria-label="新预设名称" placeholder="给当前参数起个名字" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
                <button className="button secondary" type="button" disabled={!presetName.trim() || !workflowId} onClick={() => { onSavePreset(presetName.trim()); setPresetName(''); }}>保存</button>
              </div>
            </div>
          </details>
        </Card>

        {/* 提示词与参考素材合卡 */}
        <Card className={styles.promptCard} icon={<Pencil size={17} strokeWidth={1.6} aria-hidden />} title="提示词与参考素材">
          <textarea
            aria-label="提示词"
            value={promptValue}
            placeholder="描述想要的画面：主体、风格、光线、镜头、动作细节……"
            rows={4}
            onChange={(e) => setParams({ ...params, [promptKey]: e.target.value })}
          />
          {manifest && (split.assets.length > 0 || supportsReferences(manifest)) && (
            <div className={styles.railSection}>
              <GpuParamForm
                section="assets"
                manifest={manifest}
                values={params}
                assets={gallery}
                uploadProgress={uploadProgress}
                onChange={(k, v) => setParams({ ...params, [k]: v })}
                onUpload={onUpload}
                excludeKeys={excluded}
              />
              <ReferencePicker
                manifest={manifest}
                assets={gallery}
                selected={selectedAssets}
                onChange={setSelectedAssets}
                onUpload={onUpload}
              />
            </div>
          )}
        </Card>

        {/* 画面尺寸 + 生成选项 + 数量合并为一张参数卡 */}
        <Card
          icon={<SlidersHorizontal size={17} strokeWidth={1.6} aria-hidden />}
          title="画面与生成参数"
          aside={hasSize ? <span className={styles.sizeBadge}>{curW || '—'} × {curH || '—'}</span> : undefined}
        >
          {hasSize && (
            <div className={styles.railGroup}>
              <div className={styles.ratioGrid} role="group" aria-label="画幅比例">
                {sizes.map((s) => {
                  const on = !showCustom && matched?.label === s.label;
                  const box = 20;
                  const bw = s.rw >= s.rh ? box : Math.round(box * s.rw / s.rh);
                  const bh = s.rh >= s.rw ? box : Math.round(box * s.rh / s.rw);
                  return (
                    <button key={s.label} type="button" className={styles.ratioChip} data-active={on} aria-pressed={on}
                      onClick={() => { setCustomSize(false); patch({ width: s.w, height: s.h }); }}>
                      <span className={styles.ratioShape} aria-hidden><i style={{ width: bw, height: bh }} /></span>
                      <strong>{s.label}</strong>
                      <small>{s.w}×{s.h}</small>
                    </button>
                  );
                })}
                <button type="button" className={styles.ratioChip} data-active={showCustom} aria-pressed={showCustom} onClick={() => setCustomSize(true)}>
                  <span className={styles.ratioShape} aria-hidden><i className={styles.ratioDashed} style={{ width: 20, height: 15 }} /></span>
                  <strong>自定义</strong>
                  <small>手动</small>
                </button>
              </div>
              {showCustom && (
                <div className={styles.customSize}>
                  <label className={styles.sizeInput}>
                    <span>宽</span>
                    <input type="number" inputMode="numeric" min={minSide} max={maxSide} step={step} value={String(params.width ?? '')}
                      onChange={(e) => patch({ width: Number(e.target.value) || 0 })} />
                    <em>px</em>
                  </label>
                  <span className="muted">×</span>
                  <label className={styles.sizeInput}>
                    <span>高</span>
                    <input type="number" inputMode="numeric" min={minSide} max={maxSide} step={step} value={String(params.height ?? '')}
                      onChange={(e) => patch({ height: Number(e.target.value) || 0 })} />
                    <em>px</em>
                  </label>
                </div>
              )}
              {showCustom && <p className="muted small">建议取 {step} 的倍数，范围 {minSide}–{maxSide}。</p>}
            </div>
          )}

          {split.options.length > 0 && (
            <div className={hasSize ? styles.railSection : undefined}>
              <GpuParamForm
                section="options"
                manifest={manifest}
                values={params}
                assets={gallery}
                uploadProgress={uploadProgress}
                onChange={(k, v) => setParams({ ...params, [k]: v })}
                onUpload={onUpload}
                excludeKeys={excluded}
              />
            </div>
          )}

          <div className={`${styles.countRow} ${hasSize || split.options.length > 0 ? styles.railSection : ''}`}>
            <div>
              <strong>生成数量</strong>
              <p className="muted small">同批连出会优先复用同一台机器</p>
            </div>
            <div className={styles.stepper}>
              <button type="button" aria-label="减少数量" disabled={batchCount <= 1} onClick={() => setBatchCount(Math.max(1, batchCount - 1))}><Minus size={16} strokeWidth={1.8} aria-hidden /></button>
              <input aria-label="生成数量" type="number" inputMode="numeric" min={1} max={100} value={batchCount}
                onChange={(e) => setBatchCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
              <button type="button" aria-label="增加数量" disabled={batchCount >= 100} onClick={() => setBatchCount(Math.min(100, batchCount + 1))}><Plus size={16} strokeWidth={1.8} aria-hidden /></button>
            </div>
          </div>
        </Card>

        {split.advanced.length > 0 && (
          <details className={`foldable ${styles.advanced}`}>
            <summary>
              <span className={styles.advTitle}><SlidersHorizontal size={16} strokeWidth={1.6} aria-hidden />高级参数<span className="pill">{split.advanced.length} 项</span></span>
            </summary>
            <div className="foldContent">
              <p className="muted small">一般不用改；不确定时保持默认即可。</p>
              <GpuParamForm section="advanced" manifest={manifest} values={params} assets={gallery} uploadProgress={uploadProgress}
                onChange={(k, v) => setParams({ ...params, [k]: v })} onUpload={onUpload} excludeKeys={excluded} />
            </div>
          </details>
        )}

        {/* 次级运行微调（顶栏已有快捷开关，这里保留完整表单兼容各尺寸屏幕） */}
        <details id="create-runtime" className="foldable">
          <summary>
            <span className={styles.advTitle}><Play size={16} strokeWidth={1.6} aria-hidden />运行与超时微调</span>
          </summary>
          <div className="foldContent">
            <div className={styles.cardHead}>
              <span className="muted small">也可直接点右上角 Colab 状态胶囊切换</span>
              <InfoTip label="运行方式说明" text={<><span className={styles.tipLine}><b>离线模拟</b>：{RUNTIME_HELP.mock}</span><span className={styles.tipLine}><b>Colab GPU</b>：{RUNTIME_HELP.colab}</span></>} />
            </div>
            <Segmented<Provider>
              ariaLabel="运行方式"
              value={runtime}
              onChange={setRuntime}
              options={[
                { value: 'colab', label: 'Colab GPU', sub: settings?.real_enabled ? '真实出图' : '未启用', disabled: !settings?.real_enabled, icon: <Cloud size={16} strokeWidth={1.6} aria-hidden /> },
                { value: 'mock', label: '离线模拟', sub: '不扣 CU', icon: <Monitor size={16} strokeWidth={1.6} aria-hidden /> },
              ]}
            />
            <RuntimeSelection value={runtimeChoice} accounts={accounts} instances={instances} provider={runtime}
              onChange={onRuntimeChoiceChange} />
            {batchMode === 'retain' && <p className="muted small">保留机器会继续产生 CU；Google 仍可能按配额回收空闲 VM。</p>}
            {runtime === 'colab' && (
              <div className="field">
                <label htmlFor="max-runtime">单个任务最长运行（分钟）</label>
                <input id="max-runtime" type="number" inputMode="numeric" min={1} max={runtimeCap} value={maxRuntime || ''}
                  aria-invalid={Boolean(runtimeError)} aria-describedby="max-runtime-hint" onChange={(e) => setMaxRuntime(Number(e.target.value))} />
                <span id="max-runtime-hint" className={styles.hint}>服务器上限 {runtimeCap} 分钟（含环境恢复与采样时间）。</span>
                {runtimeError && <p className="status error" role="alert">{runtimeError}</p>}
                {timeoutRisk && <p className="status" role="status">{timeoutRisk}</p>}
              </div>
            )}
          </div>
        </details>

        {/* 吸底免弹窗直出生成条 */}
        <div className={styles.createSubmit}>
          <div className={styles.submitMeta}>
            <span className="muted small" data-warn={colabBlocked || undefined}>{summaryLine}</span>
            {colabBlocked && onOpenSettings && (
              <button type="button" className={styles.linkButton} onClick={onOpenSettings}>去设置账号</button>
            )}
            {runtime === 'mock' && summary.usableAccounts.length > 0 && (
              <button type="button" className={styles.linkButton} onClick={() => setRuntime('colab')}>改用 Colab</button>
            )}
          </div>
          {timeoutRisk && <p className="status small" role="status">{timeoutRisk}</p>}
          {error && <p className="status error small" role="alert">{error}</p>}
          <button
            className="button big block"
            disabled={!workflowId || loading === 'submit' || Boolean(runtimeError) || colabBlocked}
            type="button"
            onClick={onSubmit}
          >
            <Sparkles size={18} strokeWidth={1.8} aria-hidden />
            {loading === 'submit' ? '正在派发到 Colab…' : '立即生成'}
          </button>
        </div>
      </div>

      {/* ───── 右侧实时 Colab 执行舞台 & 本项目作品墙 ───── */}
      <div className={styles.createStage}>
        <header className={styles.stageHead}>
          <div className={styles.stageTitleGroup}>
            <h2><Sparkles size={19} strokeWidth={1.6} aria-hidden />Colab 实时舞台</h2>
            {activeJobs.length > 0 && <span className="pill solid">{activeJobs.length} 个运行中</span>}
            <span className="pill">{sortedOutputs.length} 件作品</span>
          </div>
          <div className={styles.stageLinks}>
            {onOpenGallery && <button type="button" className="button secondary small" onClick={onOpenGallery}>全部作品</button>}
            {onOpenJobs && <button type="button" className="button secondary small" onClick={onOpenJobs}>任务记录</button>}
          </div>
        </header>

        {/* 上下文状态横幅 */}
        {realAvailable && summary.needsAllocationAccount && !summary.usableAccounts.length && (
          <div className={styles.warmBanner} data-tone="attention">
            <span>Google 账号「{summary.needsAllocationAccount.alias}」已连接，开启算力分配即可开始 Colab 创作。</span>
            {onQuickEnableAccount && (
              <button type="button" className="button small" onClick={() => onQuickEnableAccount(summary.needsAllocationAccount!)}>
                立即启用账号
              </button>
            )}
          </div>
        )}

        {realAvailable && !summary.needsAllocationAccount && !summary.usableAccounts.length && (
          <div className={styles.warmBanner} data-tone="attention">
            <span>
              {summary.needsDriveAccount
                ? `账号「${summary.needsDriveAccount.alias}」还差 Google Drive 授权，完成后才能用 Colab 创作。`
                : '尚未连接可用的 Google Colab 账号。授权后将自动切回真实 Colab GPU。'}
            </span>
            {onOpenSettings && (
              <button type="button" className="button small" onClick={onOpenSettings}>前往连接 Google 账号</button>
            )}
          </div>
        )}

        {runtime === 'colab' && warmInstance && (
          <div className={styles.warmBanner} data-tone="warm">
            <span>
              <Cpu size={15} strokeWidth={1.8} aria-hidden />
              Colab 热机在线（{shortGpuName(warmInstance)} · {
                (warmInstance.account_id && accounts.find((a) => a.account_id === warmInstance.account_id)?.alias)
                || warmInstance.account_alias_snapshot
                || '已连接'
              }）— 现在生成可直接免冷启动复用
            </span>
            <button
              type="button"
              className={`button small ${runtimeChoice.instanceId === instanceIdentity(warmInstance) ? '' : 'secondary'}`}
              onClick={() => {
                const warmId = instanceIdentity(warmInstance);
                const pinned = runtimeChoice.instanceId === warmId;
                onRuntimeChoiceChange({
                  ...runtimeChoice,
                  accountId: warmInstance.account_id || runtimeChoice.accountId,
                  instanceId: pinned ? null : warmId,
                });
              }}
            >
              {runtimeChoice.instanceId === instanceIdentity(warmInstance) ? '已锁定此热机' : '优先复用此热机'}
            </button>
          </div>
        )}

        {/* 运行中 / 最近异常的 Colab 任务进展示板 */}
        {stageJobs.length > 0 && (
          <section className={styles.activeStageList} aria-label="Colab 执行动态">
            {stageJobs.map((job) => {
              const s = String(job.state || 'queued').toLowerCase();
              const isTerminal = terminalStates.has(s);
              const failed = ['failed', 'failed_final', 'blocked'].includes(s);
              const pct = progressPercent(job.progress);
              const steps = colabPipelineSteps(job);
              const matchingWf = workflows.find((w) => w.workflow_key === job.workflow_key);
              const retained = canRetainJobInstance(job) && Boolean(job.retained_until || job.instance_state === 'retained_idle');
              const retainEligible = canRetainJobInstance(job) && !retained;
              const accountName = job.account_alias_snapshot || (job.account_id ? accounts.find((a) => a.account_id === job.account_id)?.alias : '') || '';
              return (
                <article className={styles.liveJobCard} key={job.id} data-failed={failed || undefined}>
                  <div className={styles.liveJobTop}>
                    <div className={styles.liveJobTitle}>
                      <strong>{matchingWf ? workflowTitle(matchingWf) : (job.workflow_key || `任务 ${job.id.slice(0, 8)}`)}</strong>
                      <span className="muted small">
                        {accountName ? `${accountName} · ` : ''}{gpuLabel(job)} · {formatDateTime(job.created_at)}
                      </span>
                    </div>
                    <span className={`pill ${failed ? 'danger' : !isTerminal ? 'solid' : ''}`}>{jobStateLabel(job.state, job)}</span>
                  </div>

                  {!failed && (
                    <ol className={styles.pipelineRow} aria-label="执行阶段">
                      {steps.map((stepItem) => (
                        <li key={stepItem.key} className={styles.pipelineStep} data-state={stepItem.status}>
                          <span className={styles.pipelineDot} aria-hidden />
                          <span>{stepItem.label}</span>
                        </li>
                      ))}
                    </ol>
                  )}

                  {!isTerminal && (
                    <div className={styles.progressBlock}>
                      <div className={styles.progressText}>
                        <span>{job.awaiting_prep ? '等待共享缓存准备完成' : job.stage ? jobStageLabel(job.stage) : '正在排队或恢复运行时…'}</span>
                        {pct !== null && <span>{pct}%</span>}
                      </div>
                      <div className={styles.progress} data-indeterminate={pct === null}><span style={pct !== null ? { width: `${pct}%` } : undefined} /></div>
                    </div>
                  )}

                  {(job.error_message || job.error) && (
                    <p className="status error small" role="alert">{job.error_message || job.error}</p>
                  )}

                  <div className={styles.liveJobActions}>
                    {onOpenJobDetail && (
                      <button type="button" className="button secondary small" onClick={() => onOpenJobDetail(job)}>实时日志</button>
                    )}
                    {retainEligible && onRetainJob && (
                      <button type="button" className="button secondary small" onClick={() => onRetainJob(job)}>
                        <Timer size={13} aria-hidden />跑完保留热机
                      </button>
                    )}
                    {retained && <span className="pill">已保留热机</span>}
                    {!isTerminal && onCancelJob && (
                      <button type="button" className="button secondary small" onClick={() => onCancelJob(job.id)}>
                        <Square size={12} aria-hidden />取消
                      </button>
                    )}
                    {failed && onRetryJob && (
                      <button type="button" className="button small" onClick={() => onRetryJob(job.id)}>
                        <RotateCcw size={13} aria-hidden />{job.error_code === 'gpu_timeout' ? '调参重试' : '重新生成'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {/* 本项目最新作品直出画廊 */}
        {sortedOutputs.length > 0 ? (
          <div className={styles.stageGalleryGrid}>
            {sortedOutputs.slice(0, 12).map((asset) => {
              const isVideo = asset.mime.startsWith('video/');
              const isJson = asset.mime.includes('json') || asset.filename?.toLowerCase().endsWith('.json');
              const dimText = assetDims(asset);
              return (
                <article className={styles.stageTile} key={asset.id}>
                  <div className={styles.tileMedia}>
                    <button
                      type="button"
                      className={styles.tileCover}
                      aria-label={`查看 ${asset.filename || '作品'}`}
                      onClick={() => onOpenAsset?.(asset)}
                    >
                      {isVideo ? (
                        <video src={assetUrl(asset)} preload="metadata" muted playsInline aria-label={asset.filename || '视频'} />
                      ) : isJson ? (
                        <span className={styles.tileJson}>JSON<small>诊断文件</small></span>
                      ) : (
                        <img loading="lazy" src={assetUrl(asset, true)} alt={asset.filename || '作品'} />
                      )}
                    </button>
                    <span className={styles.tileType}>
                      {isVideo ? <Film size={12} strokeWidth={1.8} aria-hidden /> : <ImageIcon size={12} strokeWidth={1.8} aria-hidden />}
                      {isVideo ? '视频' : '图片'}
                    </span>
                    {dimText && <span className={styles.tileHud}>{dimText}</span>}
                  </div>
                  <div className={styles.tileMeta}>
                    <div>
                      <strong title={asset.filename || asset.id}>{asset.filename || `作品 ${asset.id.slice(0, 6)}`}</strong>
                      <small className="muted">{asset.source_job_id ? `任务 ${asset.source_job_id.slice(0, 6)}` : '上传素材'}</small>
                    </div>
                    {onFavoriteAsset && (
                      <button
                        type="button"
                        className={styles.starBtn}
                        data-on={Boolean(asset.favorite)}
                        aria-label={asset.favorite ? '取消收藏' : '收藏'}
                        onClick={() => onFavoriteAsset(asset)}
                      >
                        <Star size={16} strokeWidth={1.6} fill={asset.favorite ? 'currentColor' : 'none'} aria-hidden />
                      </button>
                    )}
                  </div>
                  <div className={styles.stageTileActions}>
                    {onReuseAsset && asset.source_job_id && (
                      <button type="button" className="button secondary small" onClick={() => onReuseAsset(asset)}>
                        <RotateCcw size={12} aria-hidden />同参微调
                      </button>
                    )}
                    {onOpenAsset && (
                      <button type="button" className="button secondary small" onClick={() => onOpenAsset(asset)}>
                        <Eye size={12} aria-hidden />预览
                      </button>
                    )}
                    <a className="button secondary small" href={assetUrl(asset)} download={asset.filename || asset.id} target="_blank" rel="noreferrer">
                      <Download size={12} aria-hidden />下载
                    </a>
                  </div>
                </article>
              );
            })}
          </div>
        ) : stageJobs.length === 0 ? (
          <div className={styles.stageEmpty}>
            <div className={styles.stageEmptyIcon}><Sparkles size={24} strokeWidth={1.5} aria-hidden /></div>
            <strong>Colab 创作舞台已就绪</strong>
            <p className="muted small">
              当前工作流：{activeWorkflow ? workflowTitle(activeWorkflow) : '未选择'}
              {recommendedAccelerator ? `（推荐 ${recommendedAccelerator}）` : ''}
              {' · '}
              {runtime === 'colab' ? `执行账号：${activeAccountAlias}` : '当前为离线模拟模式'}
            </p>
            <ol className={styles.stageGuide}>
              <li><b>1. 填参数</b><span>在左侧输入提示词、画幅与参考素材</span></li>
              <li><b>2. 一键直跑</b><span>点「立即生成」自动申请或复用在线 Colab 热机</span></li>
              <li><b>3. 实时直出</b><span>推理进度与云盘回传作品会直接呈现在本舞台</span></li>
            </ol>
          </div>
        ) : null}

        {sortedOutputs.length > 12 && onOpenGallery && (
          <button type="button" className="button secondary block" onClick={onOpenGallery}>
            查看全部 {sortedOutputs.length} 件作品
          </button>
        )}
      </div>

      {/* 工作流选择面板 */}
      {pickerOpen && (
        <div className={styles.dialogBackdrop} role="presentation" onClick={() => setPickerOpen(false)}>
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-label="选择工作流" onClick={(e) => e.stopPropagation()}>
            <div className={styles.cardHead}>
              <h2>选择工作流</h2>
              <button className={styles.iconGhost} type="button" aria-label="关闭" onClick={() => setPickerOpen(false)}><X size={18} strokeWidth={1.6} aria-hidden /></button>
            </div>
            <p className="muted small">同一个工作流的不同版本收在一起，点版本即可切换。{category === 'image' ? '当前显示图片类。' : '当前显示视频类。'}</p>
            <div className={styles.pickList}>
              {families.filter((f) => f.category === category).map((fam) => {
                const list = pickable(fam);
                const here = currentFamily?.key === fam.key;
                return (
                  <div key={fam.key} className={styles.pickItem} data-on={here}>
                    <button type="button" className={styles.pickMain} onClick={() => { chooseFamily(fam); setPickerOpen(false); }}>
                      <span>
                        <strong>{workflowTitle(list[0] || { workflow_key: fam.key })}</strong>
                        <small className="muted">{workflowUsage(list[0] || { workflow_key: fam.key }) || modelName(fam.modelId)}</small>
                        <small className="muted">{fam.key}</small>
                      </span>
                      {here && <Check size={18} strokeWidth={1.8} aria-hidden />}
                    </button>
                    {list.length > 1 && (
                      <div className={styles.versionRow} role="group" aria-label={`${fam.key} 的版本`}>
                        {list.map((wf) => (
                          <button key={wf.id} type="button" data-active={wf.id === workflowId} onClick={() => { chooseWorkflow(wf); setPickerOpen(false); }}>
                            v{wf.workflow_version}{wf.active ? ' · 当前' : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {!families.some((f) => f.category === category) && <p className="muted small">这个类型下还没有工作流。</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
