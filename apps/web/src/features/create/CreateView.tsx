import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { GeneratedAsset, ImageModelCapability } from "../../lib/apiClient";
import { artMeta, dayLabel } from "../../lib/artMeta";
import { useModalFocus } from "../../lib/useModalFocus";
import { smallThumbnail, smallThumbnailFallback } from "../../lib/thumbnail";
import { Viewer, type ViewerItem } from "../../components/Viewer";
import { PromptOptimizerDialog } from "../promptTools/PromptOptimizerDialog";
import { HistoryGallery } from "../history/HistoryGallery";
import { capabilityKey, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_TOTAL_BYTES } from "../../app/creationShared";
import { Composer } from "./Composer";
import { Stage } from "./Stage";
import { Enso } from "./Enso";
import styles from "./create.module.css";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

export interface CreateViewProps {
  prompt: string; setPrompt: (value: string) => void;
  files: File[]; setFiles: (files: File[]) => void;
  assetIds: string[]; setAssetIds: (ids: string[]) => void;
  referenceAssets: GeneratedAsset[]; onWantReferences: () => void;
  imageModel: string; setImageModel: (value: string) => void; imageCapabilities: ImageModelCapability[];
  imageResolution: string; setImageResolution: (value: string) => void;
  imageQuality: string; setImageQuality: (value: string) => void;
  imageCount: number; setImageCount: (value: number) => void;
  imageWidth: string; setImageWidth: (value: string) => void;
  imageHeight: string; setImageHeight: (value: string) => void;
  aspectRatio: string; setAspectRatio: (value: string) => void;
  transparentBackground: boolean; setTransparentBackground: (value: boolean) => void;
  swapDimensions: () => void; commitDimensions: () => void;
  estimatedQuotaCost: number;
  isGenerating: boolean; status: string; previewImageUrl: string | null; duration: number | null;
  assets: GeneratedAsset[]; assetIndex: number; setAssetIndex: (index: number) => void;
  startGeneration: () => void;
  refreshKey: number; selectedHistoryId: string | null;
  onHistoryToggle: (item: GeneratedAsset) => void;
  onHistorySelect: (item: GeneratedAsset) => void;
  onOpenLibrary: () => void;
}

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** 画案：左侧卷轴、中央画面、底部砚台。 */
export function CreateView(props: CreateViewProps) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [optimizerOpen, setOptimizerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewer, setViewer] = useState<{ origin: DOMRect | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [referenceMessage, setReferenceMessage] = useState("");
  const capability = props.imageCapabilities.find((item) => capabilityKey(item) === props.imageModel);
  const referenceCount = props.files.length + props.assetIds.length;
  const canGenerate = !props.isGenerating && Boolean(props.prompt.trim()) && Boolean(capability);
  const overlayOpen = optimizerOpen || pickerOpen || viewer !== null;

  // Latest props for window-level listeners without re-binding them every render.
  const latest = useRef({ props, overlayOpen, referenceCount });
  latest.current = { props, overlayOpen, referenceCount };

  function addReferenceFiles(incoming: File[]) {
    const { props: current, referenceCount: count } = latest.current;
    incoming = incoming.filter((file) => ACCEPTED_TYPES.includes(file.type));
    if (incoming.length === 0) { setReferenceMessage("请选择 PNG、JPEG 或 WebP 图片"); return; }
    const remaining = Math.max(0, MAX_REFERENCE_IMAGES - count);
    if (remaining === 0) { setReferenceMessage(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`); return; }
    const sized = incoming.filter((file) => file.size <= MAX_REFERENCE_IMAGE_BYTES);
    const accepted: File[] = [];
    let remainingBytes = Math.max(0, MAX_REFERENCE_TOTAL_BYTES - current.files.reduce((sum, file) => sum + file.size, 0));
    let rejectedTotalSize = 0;
    for (const file of sized.slice(0, remaining)) {
      if (file.size > remainingBytes) { rejectedTotalSize += 1; continue; }
      accepted.push(file);
      remainingBytes -= file.size;
    }
    current.setFiles([...current.files, ...accepted]);
    const messages: string[] = [];
    if (incoming.length > sized.length) messages.push("已跳过超过 20MB 的图片");
    if (rejectedTotalSize > 0) messages.push("参考图总大小不能超过 50MB");
    if (sized.length - rejectedTotalSize > accepted.length) messages.push(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`);
    setReferenceMessage(messages.join("，"));
  }
  const addReferences = useRef(addReferenceFiles);
  addReferences.current = addReferenceFiles;

  function moveFile(index: number, direction: number) {
    const files = [...props.files];
    const target = index + direction;
    if (target < 0 || target >= files.length) return;
    [files[index], files[target]] = [files[target], files[index]];
    props.setFiles(files);
  }

  function toggleReferenceAsset(id: string) {
    if (props.assetIds.includes(id)) { props.setAssetIds(props.assetIds.filter((item) => item !== id)); setReferenceMessage(""); return; }
    if (referenceCount >= MAX_REFERENCE_IMAGES) { setReferenceMessage(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`); return; }
    props.setAssetIds([...props.assetIds, id]);
    setReferenceMessage("");
  }

  function useAsReference(id: string) {
    if (props.assetIds.includes(id)) return;
    if (referenceCount >= MAX_REFERENCE_IMAGES) { setReferenceMessage(`参考图最多 ${MAX_REFERENCE_IMAGES} 张`); return; }
    props.setAssetIds([...props.assetIds, id]);
    setReferenceMessage("");
  }

  // 拖入即垫图；粘贴图片同理；/ 聚焦；←→ 翻看本次结果
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => { if (!hasFiles(event)) return; depth += 1; setDragging(true); };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const leave = (event: DragEvent) => { if (!hasFiles(event)) return; depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault(); depth = 0; setDragging(false);
      addReferences.current(Array.from(event.dataTransfer?.files ?? []));
    };
    const paste = (event: ClipboardEvent) => {
      const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (!images.length || latest.current.overlayOpen) return;
      event.preventDefault();
      addReferences.current(images);
    };
    const keys = (event: KeyboardEvent) => {
      const { props: current, overlayOpen: blocked } = latest.current;
      if (blocked || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "/") { event.preventDefault(); promptRef.current?.focus(); return; }
      if (current.assets.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const step = event.key === "ArrowRight" ? 1 : -1;
        current.setAssetIndex((current.assetIndex + step + current.assets.length) % current.assets.length);
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
      window.removeEventListener("keydown", keys);
    };
  }, []);

  const viewerItems: ViewerItem[] = props.assets.length
    ? props.assets.map((item) => ({
      id: item.id,
      imageUrl: item.imageUrl,
      thumbnailUrl: item.thumbnailUrl ?? `/api/assets/${encodeURIComponent(item.id)}/thumbnail`,
      prompt: item.prompt,
      date: dayLabel(item.createdAt),
      meta: artMeta(item),
      downloadUrl: `/api/assets/${encodeURIComponent(item.id)}/download`
    }))
    : props.previewImageUrl ? [{ id: "preview", imageUrl: props.previewImageUrl, prompt: props.prompt }] : [];
  const findAsset = (item: ViewerItem) => props.assets.find((asset) => asset.id === item.id);

  return (
    <div className={styles.desk}>
      <aside className={styles.scroll} aria-label="创作卷轴">
        <HistoryGallery refreshKey={props.refreshKey} onSelect={props.onHistoryToggle} selectedId={props.selectedHistoryId} disabled={props.isGenerating} />
      </aside>
      <div className={styles.table}>
        <Stage isGenerating={props.isGenerating} status={props.status} previewImageUrl={props.previewImageUrl} duration={props.duration}
          assets={props.assets} assetIndex={props.assetIndex} setAssetIndex={props.setAssetIndex}
          imageWidth={props.imageWidth} imageHeight={props.imageHeight} aspectRatio={props.aspectRatio}
          onZoom={(origin) => setViewer({ origin })} onReuse={props.onHistorySelect} onUseAsReference={(asset) => useAsReference(asset.id)} onRetry={props.startGeneration} />
        <Composer promptRef={promptRef} prompt={props.prompt} setPrompt={props.setPrompt}
          files={props.files} assetIds={props.assetIds} referenceAssets={props.referenceAssets} referenceMessage={referenceMessage}
          onUpload={addReferenceFiles}
          onRemoveFile={(index) => { props.setFiles(props.files.filter((_, fileIndex) => fileIndex !== index)); setReferenceMessage(""); }}
          onMoveFile={moveFile}
          onRemoveAsset={(id) => { props.setAssetIds(props.assetIds.filter((item) => item !== id)); setReferenceMessage(""); }}
          onOpenPicker={() => { props.onWantReferences(); setPickerOpen(true); }}
          imageModel={props.imageModel} setImageModel={props.setImageModel} imageCapabilities={props.imageCapabilities}
          imageResolution={props.imageResolution} setImageResolution={props.setImageResolution}
          imageQuality={props.imageQuality} setImageQuality={props.setImageQuality}
          imageCount={props.imageCount} setImageCount={props.setImageCount}
          imageWidth={props.imageWidth} setImageWidth={props.setImageWidth}
          imageHeight={props.imageHeight} setImageHeight={props.setImageHeight}
          aspectRatio={props.aspectRatio} setAspectRatio={props.setAspectRatio}
          transparentBackground={props.transparentBackground} setTransparentBackground={props.setTransparentBackground}
          swapDimensions={props.swapDimensions} commitDimensions={props.commitDimensions}
          estimatedQuotaCost={props.estimatedQuotaCost}
          isGenerating={props.isGenerating} canGenerate={canGenerate} onGenerate={props.startGeneration}
          onOptimize={() => setOptimizerOpen(true)} onOpenLibrary={props.onOpenLibrary} />
      </div>

      <div className={styles.dropveil} data-open={dragging || undefined} aria-hidden="true">
        <div><Enso variant="still" className={styles.dropEnso} />松手即垫为参考图</div>
      </div>

      {optimizerOpen ? <PromptOptimizerDialog initialPrompt={props.prompt} targetModel={capability?.model ?? ""} onApply={props.setPrompt} onClose={() => setOptimizerOpen(false)} /> : null}
      {viewer && viewerItems.length ? (
        <Viewer title="创作图片" imageAlt="完整创作图片" items={viewerItems} index={Math.min(props.assetIndex, viewerItems.length - 1)} origin={viewer.origin}
          onIndexChange={props.assets.length > 1 ? props.setAssetIndex : undefined}
          onClose={() => setViewer(null)}
          onReuse={props.assets.length ? (item) => { const asset = findAsset(item); if (asset) { props.onHistorySelect(asset); setViewer(null); } } : undefined}
          onUseAsReference={props.assets.length ? (item) => { useAsReference(item.id); setViewer(null); } : undefined} />
      ) : null}
      {pickerOpen ? <ReferencePicker assets={props.referenceAssets} selected={props.assetIds} full={referenceCount >= MAX_REFERENCE_IMAGES}
        onToggle={toggleReferenceAsset} onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}

function ReferencePicker({ assets, selected, full, onToggle, onClose }: { assets: GeneratedAsset[]; selected: string[]; full: boolean; onToggle: (id: string) => void; onClose: () => void }) {
  const ref = useModalFocus<HTMLDivElement>();
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <div className={styles.pickerBackdrop} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={ref} className={styles.picker} role="dialog" aria-modal="true" aria-label="选择资产参考图">
        <header><h2>选择资产参考图</h2><span>{selected.length ? `已选 ${selected.length}` : "点选作品，垫为参考"}</span></header>
        {assets.length ? (
          <div className={styles.pickerGrid}>
            {assets.map((item) => {
              const on = selected.includes(item.id);
              return (
                <button key={item.id} type="button" data-testid={"select-reference-asset-" + item.id} aria-pressed={on} title={item.prompt} disabled={!on && full} onClick={() => onToggle(item.id)}>
                  <img src={smallThumbnail(item)} onError={smallThumbnailFallback(item)} decoding="async" alt="" />
                  <span className="sr-only">{item.prompt}</span>
                  {on ? <i aria-hidden="true"><Check size={12} strokeWidth={3} /></i> : null}
                </button>
              );
            })}
          </div>
        ) : <p className={styles.pickerEmpty}>还没有作品可选。</p>}
        <footer>
          <button type="button" className={styles.tbtn} onClick={onClose}>取消</button>
          <button type="button" className={styles.primaryButton} data-testid="confirm-reference-assets" data-autofocus onClick={onClose}>确定</button>
        </footer>
      </div>
    </div>
  );
}
