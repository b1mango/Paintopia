import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Download, ImagePlus, Maximize2, RotateCcw, Send } from "lucide-react";
import { apiClient, type GeneratedAsset } from "../../lib/apiClient";
import { artSize, formatBytes, QUALITY_LABELS } from "../../lib/artMeta";
import { smallThumbnail, smallThumbnailFallback } from "../../lib/thumbnail";
import { formatDuration } from "../../app/formatters";
import { Enso } from "./Enso";
import styles from "./create.module.css";

export interface StageProps {
  isGenerating: boolean;
  status: string;
  previewImageUrl: string | null;
  duration: number | null;
  assets: GeneratedAsset[];
  assetIndex: number;
  setAssetIndex: (index: number) => void;
  /** Requested pixel size / ratio, used while nothing has been painted yet. */
  imageWidth: string; imageHeight: string; aspectRatio: string;
  onZoom: (origin: DOMRect | null) => void;
  onReuse: (asset: GeneratedAsset) => void;
  onUseAsReference: (asset: GeneratedAsset) => void;
  onRetry: () => void;
}

const thumb = (asset: GeneratedAsset) => asset.thumbnailUrl ?? `/api/assets/${encodeURIComponent(asset.id)}/thumbnail`;

function ratioOf(asset: GeneratedAsset | null, width: string, height: string, aspectRatio: string) {
  const size = asset ? artSize(asset) : undefined;
  if (size) return size.width / size.height;
  const requested = typeof asset?.params?.size === "string" ? asset.params.size.match(/^(\d+)x(\d+)$/) : null;
  if (requested) return Number(requested[1]) / Number(requested[2]);
  if (!asset && Number(width) > 0 && Number(height) > 0) return Number(width) / Number(height);
  const ratio = (typeof asset?.params?.aspectRatio === "string" ? asset.params.aspectRatio : aspectRatio).split(":").map(Number);
  return ratio.length === 2 && ratio[0] > 0 && ratio[1] > 0 ? ratio[0] / ratio[1] : 1;
}

/** 画案中央：空白时一笔圆相；落墨时晕染；成画后由中心显影并钤印。 */
export function Stage(props: StageProps) {
  const asset = props.assets[props.assetIndex] ?? null;
  const [revealId, setRevealId] = useState<string | null>(null);
  const [shared, setShared] = useState<Record<string, "busy" | "done" | "error">>({});
  const wasGenerating = useRef(props.isGenerating);
  const artRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wasGenerating.current && !props.isGenerating && props.assets[0]) setRevealId(props.assets[0].id);
    wasGenerating.current = props.isGenerating;
  }, [props.isGenerating, props.assets]);

  const hasError = !props.isGenerating && !asset && !props.previewImageUrl && /失败|错误|需要|请/.test(props.status);
  const empty = !props.isGenerating && !asset && !props.previewImageUrl && !hasError;
  const ratio = ratioOf(asset, props.imageWidth, props.imageHeight, props.aspectRatio);
  const seconds = Math.floor((props.duration ?? 0) / 1000);
  const quiet = props.isGenerating || !props.status || props.status === "等待生成" || props.status.startsWith("生成完成");

  async function share(item: GeneratedAsset) {
    setShared((current) => ({ ...current, [item.id]: "busy" }));
    try { await apiClient.syncAssetToGallery(item.id); setShared((current) => ({ ...current, [item.id]: "done" })); }
    catch { setShared((current) => ({ ...current, [item.id]: "error" })); }
  }

  const meta = asset ? (() => {
    const params = asset.params ?? {};
    const size = artSize(asset);
    return [
      size ? `${size.width} × ${size.height}` : "",
      asset.sizeBytes != null && asset.sizeBytes > 0 ? formatBytes(asset.sizeBytes) : "",
      typeof params.resolution === "string" && params.resolution !== "auto" ? params.resolution : "",
      typeof params.quality === "string" ? `质量 ${QUALITY_LABELS[params.quality] ?? params.quality}` : "",
      props.duration !== null ? formatDuration(props.duration) : "",
      typeof params.model === "string" ? params.model : ""
    ].filter(Boolean).join(" · ");
  })() : "";
  const shareState = asset ? shared[asset.id] ?? (asset.gallerySynced || asset.galleryItemId || asset.galleryStatus ? "done" : undefined) : undefined;

  return (
    <section className={styles.stage} aria-label="生成预览">
      <div className={styles.stageInner}>
        {empty ? (
          <div className={styles.empty}>
            <Enso className={styles.emptyEnso} variant="still" />
            <h1>落笔成境</h1>
            <p>写下一句话，或拖入一张图作参考。<br />画面会从墨色里慢慢显出来。</p>
            <div className={styles.tips} aria-hidden="true">
              <span><kbd>/</kbd> 聚焦输入</span>
              <span><kbd>⌘</kbd><kbd>↵</kbd> 落笔</span>
              <span><kbd>⌘</kbd><kbd>V</kbd> 粘贴垫图</span>
            </div>
          </div>
        ) : (
          <div className={styles.artWrap} data-reveal={asset && asset.id === revealId ? "" : undefined}>
            <div ref={artRef} className={styles.art} style={{ "--ratio": ratio } as CSSProperties}
              data-generating={props.isGenerating} data-complete={Boolean(asset) && !props.isGenerating && props.duration !== null} data-error={hasError || undefined}>
              {asset ? (
                <button type="button" className={styles.zoom} aria-label="放大生成图片" onClick={() => props.onZoom(artRef.current?.getBoundingClientRect() ?? null)}>
                  <img key={asset.id} src={thumb(asset)} decoding="async" alt="生成结果" />
                </button>
              ) : props.previewImageUrl ? (
                <button type="button" className={styles.zoom} aria-label="放大预览图片" onClick={() => props.onZoom(artRef.current?.getBoundingClientRect() ?? null)}>
                  <img src={props.previewImageUrl} alt="生成中的快速预览" />
                </button>
              ) : null}
              {props.isGenerating && !props.previewImageUrl ? (
                <div className={styles.brewing} aria-hidden="true">
                  <i className={styles.bloom} style={{ left: "18%", top: "22%", width: "46%", height: "46%" }} />
                  <i className={styles.bloom} style={{ left: "44%", top: "40%", width: "52%", height: "52%", animationDelay: "-2s" }} />
                  <i className={styles.bloom} style={{ left: "10%", top: "52%", width: "38%", height: "38%", animationDelay: "-4s" }} />
                  <div className={styles.brewCenter}>
                    <Enso className={styles.brewEnso} variant="draw" />
                    <span className={styles.brewState}>落墨中</span>
                    <span className={styles.brewSub}>{props.status}</span>
                    <span className={styles.brewTimer}>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span>
                    {seconds >= 30 ? <span className={styles.brewSub}>部分接口仅在完成后返回结果，请勿重复提交。</span> : null}
                  </div>
                </div>
              ) : null}
              {hasError ? (
                <div className={styles.failed}>
                  <Enso className={styles.brewEnso} variant="broken" />
                  <span className={styles.brewState}>墨未成形</span>
                  <button type="button" className={styles.tbtn} onClick={props.onRetry}><RotateCcw size={14} aria-hidden="true" />再试一次</button>
                </div>
              ) : null}
            </div>

            {asset && !props.isGenerating ? (
              <div className={styles.caption} key={asset.id}>
                <span className={styles.stamp} aria-hidden="true">成</span>
                <div className={styles.captionText}>
                  <p className={styles.poem} title={asset.prompt}>{asset.prompt}</p>
                  {meta ? <p className={styles.meta}>{meta}</p> : null}
                </div>
                <div className={styles.acts}>
                  <button type="button" className={styles.tbtn} onClick={() => props.onZoom(artRef.current?.getBoundingClientRect() ?? null)}><Maximize2 size={14} aria-hidden="true" />观画</button>
                  <a className={styles.tbtn} href={`/api/assets/${encodeURIComponent(asset.id)}/download`} download aria-label="下载创作图片"><Download size={14} aria-hidden="true" />下载</a>
                  <button type="button" className={styles.tbtn} title="回填这幅画的参数" onClick={() => props.onReuse(asset)}><RotateCcw size={14} aria-hidden="true" />复用</button>
                  <button type="button" className={styles.tbtn} title="垫为参考图" onClick={() => props.onUseAsReference(asset)}><ImagePlus size={14} aria-hidden="true" />作参考</button>
                  <button type="button" className={styles.tbtn} title="投稿到画廊，审核后公开" disabled={shareState === "busy" || shareState === "done"} onClick={() => void share(asset)}>
                    <Send size={14} aria-hidden="true" />{shareState === "done" ? "已投稿" : shareState === "busy" ? "投稿中" : shareState === "error" ? "重投" : "投稿"}
                  </button>
                </div>
              </div>
            ) : null}

            {props.assets.length > 1 ? (
              <div className={styles.multi} aria-label="本次生成">
                {props.assets.map((item, index) => (
                  <button key={item.id} type="button" data-testid={"generated-thumbnail-" + item.id} aria-label={`第 ${index + 1} 张`} aria-current={index === props.assetIndex ? "true" : undefined}
                    onClick={() => { setRevealId(null); props.setAssetIndex(index); }}>
                    <img src={smallThumbnail(item)} onError={smallThumbnailFallback(item)} decoding="async" alt="" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
        <p className={quiet ? "sr-only" : styles.note} role="status" data-error={hasError || undefined}>
          {props.status}
          {props.isGenerating ? <span aria-live="off">，已等待 {seconds} 秒</span> : null}
          {asset && props.duration === null && !props.isGenerating ? <span className="sr-only">（历史作品）</span> : null}
        </p>
      </div>
    </section>
  );
}
