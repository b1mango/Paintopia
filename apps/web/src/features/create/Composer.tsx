import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeftRight, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Grid2x2, ImagePlus, Images, Layers, Sparkles, SunMedium, Upload, X } from "lucide-react";
import type { GeneratedAsset, ImageModelCapability } from "../../lib/apiClient";
import { QUALITY_LABELS } from "../../lib/artMeta";
import { capabilityKey, MAX_REFERENCE_IMAGES } from "../../app/creationShared";
import { ASPECT_RATIOS as RATIOS, detectPromptAspectRatio, needsAspectHint, type PromptAspectMatch } from "../../lib/promptAspect";
import styles from "./create.module.css";

export type PopoverId = "model" | "size" | "quality" | "count" | "reference";

/** 停笔多久后再提示识别到的比例，免得边打字边闪。 */
const RATIO_HINT_DELAY = 600;
const RESOLUTIONS = ["1K", "2K", "4K", "auto"] as const;
/** 生成中毛笔在印面上书写的一笔（坐标为 46×46 印面）。 */
const BRUSH_STROKE = "M10 31C13 19 19 12 23 19S28 34 34 25S38 12 31 12";

export interface ComposerProps {
  promptRef: RefObject<HTMLTextAreaElement | null>;
  prompt: string; setPrompt: (value: string) => void;
  files: File[]; assetIds: string[]; referenceAssets: GeneratedAsset[];
  referenceMessage: string;
  onUpload: (files: File[]) => void;
  onRemoveFile: (index: number) => void;
  onMoveFile: (index: number, direction: number) => void;
  onRemoveAsset: (id: string) => void;
  onOpenPicker: () => void;
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
  isGenerating: boolean; canGenerate: boolean; onGenerate: () => void;
  onOptimize: () => void; onOpenLibrary: () => void;
}

/** 砚台：提示词 + 参考图 + 参数芯片 + 「绘」印。 */
export function Composer(props: ComposerProps) {
  const [open, setOpen] = useState<PopoverId | null>(null);
  const [fire, setFire] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Partial<Record<PopoverId, HTMLButtonElement | null>>>({});
  const capability = props.imageCapabilities.find((item) => capabilityKey(item) === props.imageModel);
  const qualities = capability?.imageCapabilities?.qualities?.length ? capability.imageCapabilities.qualities : ["auto", "high", "medium", "low"];
  const modelTier = capability?.model.match(/-(1k|2k|4k)$/i)?.[1]?.toUpperCase();
  const referenceCount = props.files.length + props.assetIds.length;
  const referencesFull = referenceCount >= MAX_REFERENCE_IMAGES;
  const assetsById = new Map(props.referenceAssets.map((item) => [item.id, item]));
  const sources = Array.from(new Set(props.imageCapabilities.map((item) => item.providerName ?? "未命名接口")));
  const ratioLabel = props.aspectRatio === "auto" ? "自动" : props.aspectRatio;
  const resolutionLabel = props.imageResolution === "auto" ? "自动" : props.imageResolution;
  const autoEstimate = props.imageQuality === "auto" || props.imageResolution === "auto";
  const [ratioHint, setRatioHint] = useState<PromptAspectMatch | null>(null);
  // 已经切换或忽略过的比例不再追问；清空提示词视为重新开始
  const handledRatios = useRef(new Set<string>());

  useEffect(() => {
    if (!open) return;
    // 只要点在当前芯片与其浮层之外（包括砚台内的空白处）就收起；芯片自身的点击交给 toggle
    const outside = (event: Event) => { if (event.target instanceof Node && !chipRefs.current[open]?.parentElement?.contains(event.target)) setOpen(null); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      chipRefs.current[open]?.focus();
      setOpen(null);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);

  // 画面为砚台让出空间：把实际高度交给父级
  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!root || !host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => host.style.setProperty("--composer-h", `${Math.round(root.offsetHeight)}px`));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // 提示词随内容长高
  useLayoutEffect(() => {
    const textarea = props.promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    if (textarea.scrollHeight) textarea.style.height = `${textarea.scrollHeight}px`;
  }, [props.prompt, props.promptRef]);

  // 提示词里写了比例（16:9、1920x1080、竖屏…）且与当前画幅不同时，询问是否切换
  useEffect(() => {
    if (!props.prompt.trim()) handledRatios.current.clear();
    const match = detectPromptAspectRatio(props.prompt);
    if (!match || !needsAspectHint(match, props.aspectRatio) || handledRatios.current.has(hintKey(match))) { setRatioHint(null); return; }
    const timer = window.setTimeout(() => setRatioHint(match), RATIO_HINT_DELAY);
    return () => window.clearTimeout(timer);
  }, [props.prompt, props.aspectRatio]);
  const settleRatioHint = (apply: boolean) => {
    if (!ratioHint) return;
    handledRatios.current.add(hintKey(ratioHint));
    if (apply) props.setAspectRatio(ratioHint.ratio);
    setRatioHint(null);
  };

  const toggle = (id: PopoverId) => setOpen((current) => current === id ? null : id);
  const chip = (id: PopoverId, label: string, icon: ReactNode, value: ReactNode) => (
    <button type="button" ref={(node) => { chipRefs.current[id] = node; }} className={styles.chip} aria-label={label} aria-haspopup="true" aria-expanded={open === id} onClick={() => toggle(id)}>
      {icon}<span className={styles.chipValue}>{value}</span>
    </button>
  );
  const popover = (id: PopoverId, label: string, children: ReactNode, className = "") => (
    <div className={`${styles.pop} ${className}`} role="group" aria-label={label} data-open={open === id || undefined} inert={open !== id}>{children}</div>
  );
  const generate = () => { if (!props.canGenerate) return; setFire((value) => value + 1); setOpen(null); props.onGenerate(); };

  return (
    <div className={styles.composer} ref={rootRef} data-busy={props.isGenerating || undefined}>
      {ratioHint && !open ? <div className={styles.ratioHint} role="group" aria-label="识别到画幅比例" key={ratioHint.ratio}>
        <i className={styles.ratioIcon} style={ratioIconSize(ratioHint.ratio)} aria-hidden="true" />
        <p aria-live="polite">{ratioHint.conflict ? <>「<b>{ratioHint.conflict}</b>」与「<b>{ratioHint.text}</b>」方向相反，画面可能被拉伸变形。切换画幅为 <b>{ratioHint.ratio}</b>？</> : ratioHint.text === ratioHint.ratio ? <>识别到比例 <b>{ratioHint.ratio}</b>，是否切换画幅？</> : <>识别到「<b>{ratioHint.text}</b>」，切换画幅为 <b>{ratioHint.ratio}</b>？</>}</p>
        <button type="button" className={styles.ratioHintApply} aria-label={`切换画幅为 ${ratioHint.ratio}`} onClick={() => settleRatioHint(true)}>切换</button>
        <button type="button" className={styles.ratioHintKeep} onClick={() => settleRatioHint(false)}>保持 {ratioLabel}</button>
      </div> : null}
      <div className={styles.composerRow}>
        {referenceCount ? <ul className={styles.refs} aria-label="参考图">
          {props.files.map((file, index) => <ReferenceFile key={`${file.name}-${file.size}-${index}`} file={file} index={index} total={props.files.length} onRemove={props.onRemoveFile} onMove={props.onMoveFile} />)}
          {props.assetIds.map((id) => {
            const asset = assetsById.get(id);
            return <li key={id} className={styles.ref} title={asset?.prompt}>
              <img src={(asset?.thumbnailUrl ?? `/api/assets/${encodeURIComponent(id)}/thumbnail`) + "?size=320"} alt="" decoding="async" />
              <button type="button" className={styles.refRemove} aria-label={`移除资产 ${asset?.prompt || id}`} onClick={() => props.onRemoveAsset(id)}><X size={10} strokeWidth={2.4} aria-hidden="true" /></button>
            </li>;
          })}
        </ul> : null}
        <span className={styles.chipWrap}>
          <button type="button" ref={(node) => { chipRefs.current.reference = node; }} className={styles.addRef} aria-label="添加参考图" aria-haspopup="true" aria-expanded={open === "reference"}
            title="垫图：上传、拖入或粘贴参考图（有参考图即为图生图）" onClick={() => toggle("reference")}>
            <ImagePlus size={18} strokeWidth={1.6} aria-hidden="true" />
          </button>
          {popover("reference", "添加参考图", <>
            <label className={styles.menuItem} data-disabled={referencesFull || undefined}>
              <Upload size={15} aria-hidden="true" />上传图片
              <input className="sr-only" data-testid="image-edit-upload" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={referencesFull}
                onChange={(event) => { const input = event.currentTarget; props.onUpload(Array.from(input.files ?? [])); input.value = ""; setOpen(null); }} />
            </label>
            <button type="button" className={styles.menuItem} data-testid="open-reference-asset-picker" disabled={referencesFull && props.assetIds.length === 0} onClick={() => { setOpen(null); props.onOpenPicker(); }}>
              <Images size={15} aria-hidden="true" />从我的作品选
            </button>
            <p className={styles.popNote}>也可直接拖入或粘贴图片。PNG / JPEG / WebP，单张 ≤ 20MB，合计 ≤ 50MB，最多 {MAX_REFERENCE_IMAGES} 张。</p>
          </>, styles.popMenu)}
        </span>
        <textarea ref={props.promptRef} className={styles.prompt} rows={1} aria-label="提示词" placeholder="描述你心中的画面…" value={props.prompt}
          onChange={(event) => props.setPrompt(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); generate(); } }} />
      </div>
      <p className={styles.modeHint} data-on={referenceCount > 0 || Boolean(props.referenceMessage) || undefined} aria-live="polite">
        {referenceCount > 0 ? <span>图生图 · 已垫 {referenceCount} 张参考</span> : null}
        {props.referenceMessage ? <span className={styles.warn}>{props.referenceMessage}</span> : null}
      </p>
      {!props.imageCapabilities.length ? <p className={styles.modeHint} data-on>暂无可用模型，请检查已启用的生图接口。</p> : null}
      <div className={styles.bar}>
        <span className={styles.chipWrap}>
          <button type="button" ref={(node) => { chipRefs.current.model = node; }} className={`${styles.chip} ${styles.modelChip}`} title={capability ? `${capability.model} · ${capability.providerName ?? "未命名接口"}` : "选择模型"}
            aria-label={`模型 ${capability?.model ?? "未选择"}`} aria-haspopup="listbox" aria-expanded={open === "model"} onClick={() => toggle("model")}>
            <Layers size={15} aria-hidden="true" />
            <span className={styles.chipValue}>{capability?.model ?? "选择模型"}</span>
            <ChevronDown size={13} className={styles.chipCaret} aria-hidden="true" />
          </button>
          <div className={`${styles.pop} ${styles.popMenu} ${styles.modelPop}`} role="listbox" aria-label="模型" data-open={open === "model" || undefined} inert={open !== "model"}>
            {sources.map((source) => <div key={source} role="group" aria-label={source}>
              <p className={styles.modelGroup} aria-hidden="true">{source}</p>
              {props.imageCapabilities.filter((item) => (item.providerName ?? "未命名接口") === source).map((item) => {
                const key = capabilityKey(item);
                const selected = key === props.imageModel;
                return <button key={key} type="button" role="option" aria-label={`${item.model} · ${source}`} aria-selected={selected} className={styles.menuItem} data-selected={selected || undefined}
                  onClick={() => { props.setImageModel(key); setOpen(null); chipRefs.current.model?.focus(); }}>
                  <span className={styles.modelName}>{item.model}</span>
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                </button>;
              })}
            </div>)}
          </div>
        </span>

        <span className={styles.chipWrap}>
          {chip("size", `画幅 ${ratioLabel} · ${resolutionLabel}`, <i className={styles.ratioIcon} style={ratioIconSize(props.aspectRatio)} data-auto={props.aspectRatio === "auto" || undefined} aria-hidden="true" />, `${ratioLabel} · ${resolutionLabel}`)}
          {popover("size", "画幅", <>
            <h4 className={styles.popTitle}>画幅<small>{props.imageWidth && props.imageHeight ? `${props.imageWidth} × ${props.imageHeight}` : "上游自动决定"}</small></h4>
            <div>
              <span className={styles.popLabel}>宽高比</span>
              <div className={styles.ratios}>
                {RATIOS.map(([ratio, w, h]) => {
                  const k = 22 / Math.max(w, h);
                  return <button key={ratio} type="button" aria-pressed={props.aspectRatio === ratio} onClick={() => props.setAspectRatio(ratio)}>
                    <i style={{ width: Math.max(8, w * k), height: Math.max(8, h * k) }} aria-hidden="true" />{ratio}
                  </button>;
                })}
                <button type="button" aria-pressed={props.aspectRatio === "auto"} disabled={Boolean(modelTier)} onClick={() => props.setAspectRatio("auto")}>
                  <i data-auto aria-hidden="true" />自动
                </button>
              </div>
            </div>
            <span className={styles.popLabel}>精度</span>
            <Segmented label="精度" value={props.imageResolution} onChange={props.setImageResolution}
              options={RESOLUTIONS.map((value) => ({ value, label: value === "auto" ? "自动" : value, disabled: Boolean(modelTier && modelTier !== value) }))} />
            <span className={styles.popLabel}>像素 · 自动对齐 16</span>
            <div className={styles.dims}>
              <input aria-label="图片宽度" type="number" min={16} step={16} inputMode="numeric" placeholder="自动" value={props.imageWidth} onChange={(event) => props.setImageWidth(event.target.value)} onBlur={props.commitDimensions} />
              <button type="button" className={styles.iconButton} aria-label="交换宽高" title="交换宽高" onClick={props.swapDimensions}><ArrowLeftRight size={14} aria-hidden="true" /></button>
              <input aria-label="图片高度" type="number" min={16} step={16} inputMode="numeric" placeholder="自动" value={props.imageHeight} onChange={(event) => props.setImageHeight(event.target.value)} onBlur={props.commitDimensions} />
            </div>
            <div className={styles.popRow}>
              <span>透明背景 <small>· 部分模型可用</small></span>
              <button type="button" role="switch" aria-label="透明背景" aria-checked={props.transparentBackground} className={styles.toggle} onClick={() => props.setTransparentBackground(!props.transparentBackground)} />
            </div>
            {capability?.mode === "chat_completions" ? <p className={styles.popNote}>分辨率和质量会提交给上游；是否生效取决于该接口，实际像素以生成结果为准。</p> : null}
          </>, styles.popWide)}
        </span>

        <span className={styles.chipWrap}>
          {chip("quality", `质量 ${QUALITY_LABELS[props.imageQuality] ?? props.imageQuality}`, <SunMedium size={15} aria-hidden="true" />, `质量 ${QUALITY_LABELS[props.imageQuality] ?? props.imageQuality}`)}
          {popover("quality", "质量", <>
            <h4 className={styles.popTitle}>质量</h4>
            <Segmented label="质量" value={props.imageQuality} onChange={props.setImageQuality} options={qualities.map((value) => ({ value, label: QUALITY_LABELS[value] ?? value }))} />
            <p className={styles.popNote}>自动按上限预估额度；实际以返回结果为准。</p>
          </>)}
        </span>

        <span className={styles.chipWrap}>
          {chip("count", `张数 ${props.imageCount}`, <Grid2x2 size={15} aria-hidden="true" />, `${props.imageCount} 张`)}
          {popover("count", "张数", <>
            <h4 className={styles.popTitle}>张数<small>{props.imageCount} / 8</small></h4>
            <div className={styles.dots}>
              {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => (
                <button key={count} type="button" aria-label={`${count} 张`} aria-pressed={props.imageCount === count} data-filled={count <= props.imageCount || undefined} onClick={() => props.setImageCount(count)} />
              ))}
            </div>
          </>)}
        </span>

        <span className={styles.sep} aria-hidden="true" />
        <button type="button" className={`${styles.chip} ${styles.ghost}`} title="AI 润色提示词" onClick={props.onOptimize}><Sparkles size={15} aria-hidden="true" />润色</button>
        <button type="button" className={`${styles.chip} ${styles.ghost}`} title="从灵感库选用提示词" onClick={props.onOpenLibrary}><BookOpen size={15} aria-hidden="true" />灵感</button>
        <span className={styles.spacer} />
        <span className={styles.cost} title={`预计消耗本站额度：${props.estimatedQuotaCost}`}>
          <span aria-hidden="true">≈ {props.estimatedQuotaCost} 点</span>
          <span className="sr-only">预计消耗本站额度：{props.estimatedQuotaCost}{autoEstimate ? "（自动参数按上限预估）" : ""}</span>
        </span>
        <button key={fire} type="button" className={styles.seal} data-testid="start-generation-button" data-fire={fire > 0 || undefined} data-busy={props.isGenerating || undefined}
          aria-label={props.isGenerating ? "生成中" : "开始生成"} title="落笔生成 · ⌘ Enter" disabled={!props.canGenerate} onClick={generate}>
          <span aria-hidden="true">绘</span>
          <i className={styles.sealRing} aria-hidden="true" />
          <span className={styles.brushInk} aria-hidden="true">
            <svg className={styles.brushTrail} viewBox="0 0 46 46"><path d={BRUSH_STROKE} pathLength={1} /></svg>
            <span className={styles.brush} style={{ offsetPath: `path("${BRUSH_STROKE}")` }}>
              <svg className={styles.brushBody} viewBox="0 0 12 46">
                <defs><linearGradient id="paintopia-brush-tip" x1="0" y1="29" x2="0" y2="46" gradientUnits="userSpaceOnUse"><stop offset="0" style={{ stopColor: "var(--ink)" }} /><stop offset="1" style={{ stopColor: "var(--seal-ink)" }} /></linearGradient></defs>
                <rect className={styles.brushHandle} x="4.2" y="0" width="3.6" height="27" rx="1.8" />
                <rect className={styles.brushNode} x="4.2" y="10" width="3.6" height=".9" />
                <rect className={styles.brushFerrule} x="3.6" y="26" width="4.8" height="3.6" rx="1" />
                <path d="M3.8 29.4C3.1 34.5 4.6 40.5 6 46C7.4 40.5 8.9 34.5 8.2 29.4Z" fill="url(#paintopia-brush-tip)" />
              </svg>
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

/** 同一建议（比例 + 是否方向矛盾）处理过一次就不再追问。 */
const hintKey = (match: PromptAspectMatch) => `${match.ratio}|${match.conflict ?? ""}`;

function ratioIconSize(ratio: string) {
  const [w, h] = ratio === "auto" ? [1, 1] : ratio.split(":").map(Number);
  return { width: Math.max(6, 15 * Math.min(1, w / h)), height: Math.max(6, 15 * Math.min(1, h / w)) };
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string; disabled?: boolean }[]; onChange: (value: string) => void }) {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  return (
    <div className={styles.seg} role="group" aria-label={label} style={{ "--n": options.length, "--i": index } as React.CSSProperties} data-empty={options.every((option) => option.value !== value) || undefined}>
      <span className={styles.knob} aria-hidden="true" />
      {options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value} disabled={option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  );
}

function ReferenceFile({ file, index, total, onRemove, onMove }: { file: File; index: number; total: number; onRemove: (index: number) => void; onMove: (index: number, direction: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => { URL.revokeObjectURL?.(next); };
  }, [file]);
  return (
    <li className={styles.ref} title={file.name}>
      {url ? <img src={url} alt={file.name} /> : <span className={styles.refFallback}>{file.name}</span>}
      <button type="button" className={styles.refRemove} aria-label={`移除 ${file.name}`} onClick={() => onRemove(index)}><X size={10} strokeWidth={2.4} aria-hidden="true" /></button>
      {total > 1 ? <span className={styles.refMove}>
        <button type="button" aria-label={`前移参考图 ${index + 1}`} disabled={index === 0} onClick={() => onMove(index, -1)}><ChevronLeft size={11} aria-hidden="true" /></button>
        <button type="button" aria-label={`后移参考图 ${index + 1}`} disabled={index === total - 1} onClick={() => onMove(index, 1)}><ChevronRight size={11} aria-hidden="true" /></button>
      </span> : null}
    </li>
  );
}
