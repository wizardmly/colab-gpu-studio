import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Check, ImagePlus, Images, RefreshCw, Upload, X } from 'lucide-react';
import { assetUrl, type GalleryAsset, type GpuParameter } from '../lib/gpu-api';
import { fillAssetSlots, removeAndCompactAssetSlot } from '../lib/colab-studio';
import { friendlyLabel } from '../lib/labels';
import { InfoTip } from './ui';
import styles from '../gpu.module.css';

export interface AssetSlotEntry {
  key: string;
  param: GpuParameter;
}

type PickerState =
  | { mode: 'refs-add' }
  | { mode: 'slot'; key: string; acceptType: string; isRefGroup: boolean }
  | null;

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

function isCompatibleAsset(asset: GalleryAsset, expectedType: string): boolean {
  const mime = String(asset.mime || '').toLowerCase();
  if (expectedType === 'image') return ALLOWED_IMAGE_MIME.has(mime);
  if (expectedType === 'video' || expectedType === 'audio') return mime.startsWith(`${expectedType}/`);
  return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/');
}

function acceptAttr(expectedType: string): string | undefined {
  if (expectedType === 'image') return 'image/png,image/jpeg,image/webp';
  if (expectedType === 'video') return 'video/*';
  if (expectedType === 'audio') return 'audio/*';
  return 'image/*,video/*,audio/*';
}

function isMultiRefEntry({ key, param }: AssetSlotEntry): boolean {
  return param.slot_group === 'refs' || /^ref_\d+$/i.test(key);
}

export function VisualAssetSlots({
  entries,
  values,
  assets,
  uploadProgress,
  onPatchParams,
  onUpload,
  onInsertPromptTag,
}: {
  entries: AssetSlotEntry[];
  values: Record<string, unknown>;
  assets: GalleryAsset[];
  uploadProgress: Record<string, number>;
  onPatchParams: (patch: Record<string, unknown>) => void;
  onUpload: (file: File) => Promise<GalleryAsset | null>;
  onInsertPromptTag?: (tag: string) => void;
}) {
  const [picker, setPicker] = useState<PickerState>(null);
  const [dragOver, setDragOver] = useState(false);
  const refsUploadInputRef = useRef<HTMLInputElement | null>(null);
  const slotUploadInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const pickerUploadInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!picker) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPicker(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [picker]);

  if (!entries.length) return null;

  const refEntries = entries.filter(isMultiRefEntry);
  const multiRefGroup = refEntries.length > 1 ? refEntries : [];
  const multiRefKeySet = new Set(multiRefGroup.map((item) => item.key));
  const individualEntries = entries.filter((item) => !multiRefKeySet.has(item.key));

  const refKeys = multiRefGroup.map((item) => item.key);
  const filledRefs = multiRefGroup
    .map((entry, index) => ({
      entry,
      index,
      assetId: String(values[entry.key] ?? ''),
    }))
    .filter((item) => item.assetId !== '');
  const hasRequiredRef = multiRefGroup.some((item) => item.param.required);

  function assetById(id: string): GalleryAsset | undefined {
    return assets.find((item) => item.id === id);
  }

  function onlyKeysDelta(keys: string[], nextValues: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(keys.map((key) => [key, nextValues[key] ?? '']));
  }

  async function uploadMultipleToRefs(files: FileList | File[], targetKey?: string) {
    const fileList = Array.from(files).filter((file) => !file.type || file.type.startsWith('image/'));
    if (!fileList.length) return;
    let working = { ...values };
    let nextTarget = targetKey;
    for (const file of fileList) {
      const uploaded = await onUpload(file);
      if (!uploaded) continue;
      working = fillAssetSlots(refKeys, working, [uploaded.id], nextTarget);
      nextTarget = undefined;
      onPatchParams(onlyKeysDelta(refKeys, working));
    }
  }

  async function uploadToSingleSlot(key: string, file: File) {
    const uploaded = await onUpload(file);
    if (uploaded) onPatchParams({ [key]: uploaded.id });
  }

  function handleRefsDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer?.files?.length) {
      void uploadMultipleToRefs(event.dataTransfer.files);
    }
  }

  const pickerAcceptType = picker?.mode === 'slot' ? picker.acceptType : 'image';
  const pickerAssets = assets.filter((item) => isCompatibleAsset(item, pickerAcceptType));
  const refSelectedMap = new Map<string, number>();
  filledRefs.forEach((item, idx) => {
    if (!refSelectedMap.has(item.assetId)) refSelectedMap.set(item.assetId, idx + 1);
  });

  const activeUploads = Object.entries(uploadProgress);

  return (
    <div className={styles.assetSlotsWrap} role="group" aria-label="参考素材槽位">
      {multiRefGroup.length > 0 && (
        <div className={styles.assetGroupBlock}>
          <div className={styles.assetGroupHead}>
            <span className={styles.assetGroupTitle}>
              参考图
              <b>
                已选 {filledRefs.length}/{multiRefGroup.length}
                {hasRequiredRef ? ' · 至少 1 张' : ''}
              </b>
            </span>
            <div className={styles.assetGroupHeadActions}>
              {filledRefs.length > 0 && (
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => onPatchParams(Object.fromEntries(refKeys.map((key) => [key, ''])))}
                >
                  清空
                </button>
              )}
            </div>
          </div>

          <div
            className={styles.assetRefGrid}
            data-dragover={dragOver || undefined}
            onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleRefsDrop}
          >
            {filledRefs.map(({ entry, assetId }, visibleIndex) => {
              const slotNum = visibleIndex + 1;
              const asset = assetById(assetId);
              return (
                <div className={styles.assetSlotTile} key={entry.key}>
                  <button
                    type="button"
                    className={styles.assetSlotThumb}
                    title={asset?.filename || `替换第 ${slotNum} 张参考图`}
                    aria-label={`替换参考图 ${slotNum}`}
                    onClick={() => setPicker({ mode: 'slot', key: entry.key, acceptType: String(entry.param.type || 'image'), isRefGroup: true })}
                  >
                    {asset && asset.mime.startsWith('image/') ? (
                      <img src={assetUrl(asset, true)} alt={asset.filename || `参考图 ${slotNum}`} loading="lazy" />
                    ) : (
                      <span className={styles.refMedia}>已选</span>
                    )}
                  </button>
                  <span className={styles.assetSlotBadge}>#{slotNum}</span>
                  <button
                    type="button"
                    className={styles.assetSlotRemove}
                    aria-label={`移除参考图 ${slotNum}`}
                    onClick={() => onPatchParams(
                      onlyKeysDelta(refKeys, removeAndCompactAssetSlot(refKeys, values, entry.key, true)),
                    )}
                  >
                    <X size={12} strokeWidth={2.2} aria-hidden />
                  </button>
                  {onInsertPromptTag && (
                    <button
                      type="button"
                      className={styles.assetTagChip}
                      title={`点击插入 <Picture ${slotNum}> 到提示词`}
                      onClick={() => onInsertPromptTag(`<Picture ${slotNum}>`)}
                    >
                      {`<Picture ${slotNum}>`}
                    </button>
                  )}
                </div>
              );
            })}

            {filledRefs.length < multiRefGroup.length && (
              <div className={styles.assetAddTile}>
                <button
                  type="button"
                  className={styles.assetAddPrimary}
                  onClick={() => refsUploadInputRef.current?.click()}
                >
                  <ImagePlus size={18} strokeWidth={1.6} aria-hidden />
                  <span>上传图</span>
                </button>
                <button
                  type="button"
                  className={styles.assetAddLibrary}
                  onClick={() => setPicker({ mode: 'refs-add' })}
                >
                  <Images size={12} strokeWidth={1.8} aria-hidden />
                  <span>图库{assets.some((a) => isCompatibleAsset(a, 'image')) ? '' : ' (空)'}</span>
                </button>
                <input
                  ref={refsUploadInputRef}
                  type="file"
                  hidden
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  onChange={async (event) => {
                    if (event.target.files?.length) {
                      await uploadMultipleToRefs(event.target.files);
                    }
                    event.target.value = '';
                  }}
                />
              </div>
            )}
          </div>

          <p className="muted small">
            {onInsertPromptTag
              ? '点图片可替换，点底部 <Picture N> 可插入提示词，支持拖入多图上传。'
              : '支持直接拖入多张图片上传，或从本项目图库点选。'}
          </p>
        </div>
      )}

      {individualEntries.length > 0 && (
        <div
          className={styles.assetFrameGrid}
          data-single={individualEntries.length === 1 || undefined}
        >
          {individualEntries.map(({ key, param }) => {
            const label = friendlyLabel(key, param.label || param.name || key);
            const expectedType = String(param.type || 'image');
            const currentId = String(values[key] ?? '');
            const asset = currentId ? assetById(currentId) : undefined;
            const compatibleCount = assets.filter((item) => isCompatibleAsset(item, expectedType)).length;

            return (
              <div className={styles.assetFrameCard} key={key}>
                <div className={styles.assetFrameHead}>
                  <span>
                    {label}
                    {param.required && <b className={styles.requiredMark} aria-label="必填">*</b>}
                  </span>
                  <div className={styles.assetFrameHeadRight}>
                    {param.description && <InfoTip label={`${label}说明`} text={param.description} />}
                    {currentId && (
                      <button
                        type="button"
                        className={styles.iconGhost}
                        style={{ width: 22, height: 22 }}
                        aria-label={`清除 ${label}`}
                        onClick={() => onPatchParams(
                          onlyKeysDelta([key], removeAndCompactAssetSlot([key], values, key, false)),
                        )}
                      >
                        <X size={13} strokeWidth={2} aria-hidden />
                      </button>
                    )}
                  </div>
                </div>

                {currentId ? (
                  <div className={styles.assetFrameFilled}>
                    <button
                      type="button"
                      className={styles.assetFrameThumbBtn}
                      aria-label={`更换 ${label}`}
                      onClick={() => setPicker({ mode: 'slot', key, acceptType: expectedType, isRefGroup: false })}
                    >
                      {asset && asset.mime.startsWith('image/') ? (
                        <img src={assetUrl(asset, true)} alt={asset.filename || label} loading="lazy" />
                      ) : (
                        <span className={styles.refMedia}>{asset?.filename || '已选素材'}</span>
                      )}
                    </button>
                    <div className={styles.assetFrameBtns}>
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => setPicker({ mode: 'slot', key, acceptType: expectedType, isRefGroup: false })}
                      >
                        <RefreshCw size={12} aria-hidden />换图
                      </button>
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => slotUploadInputRefs.current[key]?.click()}
                      >
                        <Upload size={12} aria-hidden />上传
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.assetFrameEmpty}>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => slotUploadInputRefs.current[key]?.click()}
                    >
                      <Upload size={13} aria-hidden />上传图片
                    </button>
                    {compatibleCount > 0 && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => setPicker({ mode: 'slot', key, acceptType: expectedType, isRefGroup: false })}
                      >
                        <Images size={13} aria-hidden />选图库
                      </button>
                    )}
                  </div>
                )}

                <input
                  ref={(node) => { slotUploadInputRefs.current[key] = node; }}
                  type="file"
                  hidden
                  accept={acceptAttr(expectedType)}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) await uploadToSingleSlot(key, file);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      {activeUploads.length > 0 && (
        <div className={styles.assetUploadList}>
          {activeUploads.map(([name, progress]) => (
            <small className={styles.hint} key={name}>正在上传 {name}：{progress}%</small>
          ))}
        </div>
      )}

      {picker && (
        <div className={styles.dialogBackdrop} role="presentation" onClick={() => setPicker(null)}>
          <section
            className={`${styles.dialog} ${styles.assetPickerDialog}`}
            role="dialog"
            aria-modal="true"
            aria-label="选择参考图片"
            onClick={(event) => event.stopPropagation()}
          >
            <div className={styles.cardHead}>
              <h2>
                {picker.mode === 'refs-add'
                  ? `添加参考图（${filledRefs.length}/${multiRefGroup.length}）`
                  : '选择替换图片'}
              </h2>
              <div className={styles.assetGroupHeadActions}>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => pickerUploadInputRef.current?.click()}
                >
                  <Upload size={13} aria-hidden />上传新图片
                </button>
                <button className={styles.iconGhost} type="button" aria-label="关闭" onClick={() => setPicker(null)}>
                  <X size={18} strokeWidth={1.6} aria-hidden />
                </button>
              </div>
            </div>
            <input
              ref={pickerUploadInputRef}
              type="file"
              hidden
              multiple={picker.mode === 'refs-add'}
              accept={acceptAttr(pickerAcceptType)}
              onChange={async (event) => {
                const selectedFiles = event.target.files;
                if (!selectedFiles?.length) return;
                if (picker.mode === 'refs-add') {
                  await uploadMultipleToRefs(selectedFiles);
                } else {
                  const file = selectedFiles[0];
                  if (picker.isRefGroup) {
                    await uploadMultipleToRefs([file], picker.key);
                  } else {
                    await uploadToSingleSlot(picker.key, file);
                  }
                  setPicker(null);
                }
                event.target.value = '';
              }}
            />

            {pickerAssets.length > 0 ? (
              <div className={styles.assetLibraryGrid}>
                {pickerAssets.map((asset) => {
                  const slotNum = picker.mode === 'refs-add' ? refSelectedMap.get(asset.id) : undefined;
                  const isCurrentSlot = picker.mode === 'slot' && String(values[picker.key] ?? '') === asset.id;
                  const selected = Boolean(slotNum || isCurrentSlot);
                  return (
                    <button
                      type="button"
                      key={asset.id}
                      className={styles.assetLibraryTile}
                      data-selected={selected || undefined}
                      title={asset.filename || asset.id}
                      onClick={() => {
                        if (picker.mode === 'refs-add') {
                          const existingEntry = multiRefGroup.find((item) => String(values[item.key] ?? '') === asset.id);
                          if (existingEntry) {
                            onPatchParams(
                              onlyKeysDelta(refKeys, removeAndCompactAssetSlot(refKeys, values, existingEntry.key, true)),
                            );
                          } else {
                            onPatchParams(
                              onlyKeysDelta(refKeys, fillAssetSlots(refKeys, values, [asset.id])),
                            );
                          }
                        } else if (picker.isRefGroup) {
                          onPatchParams(
                            onlyKeysDelta(refKeys, fillAssetSlots(refKeys, values, [asset.id], picker.key)),
                          );
                          setPicker(null);
                        } else {
                          onPatchParams({ [picker.key]: asset.id });
                          setPicker(null);
                        }
                      }}
                    >
                      {asset.mime.startsWith('image/') ? (
                        <img src={assetUrl(asset, true)} alt={asset.filename || '图片'} loading="lazy" />
                      ) : (
                        <span className={styles.refMedia}>{asset.filename || '素材'}</span>
                      )}
                      {slotNum && <span className={styles.assetSlotBadge}>#{slotNum}</span>}
                      {isCurrentSlot && (
                        <span className={styles.refCheck}><Check size={12} strokeWidth={2.4} aria-hidden /></span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty">
                <strong>当前项目还没有可选图片</strong>
                <span>点右上角「上传新图片」即可添加并自动填入槽位。</span>
              </div>
            )}

            {picker.mode === 'refs-add' && (
              <div className="actions" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="button small" onClick={() => setPicker(null)}>完成</button>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
