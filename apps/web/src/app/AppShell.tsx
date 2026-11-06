import { clearMediaCache } from "../lib/useMediaFeed";
import { Suspense, useEffect, useRef, useState } from "react";
import styles from "./AppShell.module.css";
import shell from "./Shell.module.css";
import { apiClient, type GeneratedAsset, type ImageModelCapability, type QuotaPricingRule } from "../lib/apiClient";
import { resolveImageSize, validateImageSize, inferImageResolution, inferImageAspectRatio } from "@paintopia/shared";
import { useUiStore, useResolvedTheme } from "../lib/uiStore";
import { PromptApplyDialog } from "../features/prompts/PromptApplyDialog";
import { useDailyCheckIn } from "../features/account/useDailyCheckIn";
import { TopNavigation } from "../components/TopNavigation";
import { CreateView } from "../features/create/CreateView";
import { PROVIDER_CHANGE_EVENT } from "./providerShared";
import { DEFAULT_IMAGE_RESOLUTION, IMAGE_RESOLUTION_OPTIONS, fallbackImageCapabilities, capabilityKey, defaultQuotaPricingRules, matchHistorySource, getEstimatedQuotaCost, MAX_REFERENCE_IMAGES } from "./creationShared";
import { formatDuration } from "./formatters";
import { lazyPage, whenIdle } from "../lib/lazyPage";
import { type PaintopiaUser, type ConfigSection, type ModuleId } from "./appTypes";

export type { PaintopiaUser, ConfigSection, ModuleId } from "./appTypes";

// 创作页随外壳首载；其余页面按需拆包，登录后空闲时预载
const PromptLibraryView = lazyPage(() => import("../features/prompts/PromptLibraryView"), "PromptLibraryView");
const GalleryView = lazyPage(() => import("./GalleryView"), "GalleryView");
const AssetsView = lazyPage(() => import("./AssetsView"), "AssetsView");
const ProfileView = lazyPage(() => import("./AccountViews"), "ProfileView");
const SettingsView = lazyPage(() => import("./AccountViews"), "SettingsView");
const UsageLogView = lazyPage(() => import("./StatsView"), "UsageLogView");
const ConfigView = lazyPage(() => import("./ConfigView"), "ConfigView");
export const preloadAppPages = () => Promise.all([PromptLibraryView, GalleryView, AssetsView, ProfileView, SettingsView, UsageLogView, ConfigView].map(page => page.preload()));

type AppShellProps = { user: PaintopiaUser; activeModule?: ModuleId; onNavigate?: (moduleId: ModuleId) => void; onLogout?: () => void };

export function AppShell({ user, activeModule = "create", onNavigate, onLogout }: AppShellProps) {
  const { theme, language, reduceMotion, setTheme, setLanguage, setReduceMotion } = useUiStore();
  const resolvedTheme = useResolvedTheme();

  const [prompt, setPrompt] = useState("一座雾中的山谷，温暖的夕阳，电影感构图");
  const [pendingLibraryPrompt, setPendingLibraryPrompt] = useState<string | null>(null);
  const [imageModel, setImageModel] = useState("gpt-image-2");
  const restoredSource = useRef<Record<string, unknown> | null>(null);
  const [imageCapabilities, setImageCapabilities] = useState<ImageModelCapability[]>(fallbackImageCapabilities);
  const [imageResolution, setImageResolution] = useState(DEFAULT_IMAGE_RESOLUTION);
  const [imageQuality, setImageQuality] = useState("high");
  const [imageCount, setImageCount] = useState(1);
  const [imageWidth, setImageWidth] = useState(() => resolveImageSize(DEFAULT_IMAGE_RESOLUTION, "1:1").split("x")[0]);
  const [imageHeight, setImageHeight] = useState(() => resolveImageSize(DEFAULT_IMAGE_RESOLUTION, "1:1").split("x")[1]);
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  // 有参考图即为图生图
  const mode: "text" | "edit" = files.length + assetIds.length > 0 ? "edit" : "text";
  const [referenceAssets, setReferenceAssets] = useState<GeneratedAsset[]>([]);
  const [referencesWanted, setReferencesWanted] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState("等待生成");
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const generationStartedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!isGenerating) return;
    const timer = window.setInterval(() => setDuration(Date.now() - (generationStartedAt.current ?? Date.now())), 1000);
    return () => window.clearInterval(timer);
  }, [isGenerating]);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [assetIndex, setAssetIndex] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [remainingQuota, setRemainingQuota] = useState(user.quota);
  const checkIn = useDailyCheckIn(user.id ?? user.email, setRemainingQuota);
  const [quotaPricingRules, setQuotaPricingRules] = useState<QuotaPricingRule[]>(defaultQuotaPricingRules);

  const applySizePreset = (resolution: string, ratio: string) => {
    setImageResolution(ratio === "auto" ? "auto" : resolution); setAspectRatio(resolution === "auto" ? "auto" : ratio);
    const size = resolveImageSize(resolution, ratio);
    if (size === "auto") { setImageWidth(""); setImageHeight(""); }
    else { const [width, height] = size.split("x"); setImageWidth(width); setImageHeight(height); }
  };
  const swapDimensions = () => {
    setImageWidth(imageHeight); setImageHeight(imageWidth);
    if (aspectRatio !== "auto") setAspectRatio(aspectRatio.split(":").reverse().join(":"));
  };
  const changeWidth = (value: string) => { setImageWidth(value); };
  const changeHeight = (value: string) => { setImageHeight(value); };
  const commitDimensions = () => {
    const width = Math.round(Number(imageWidth) / 16) * 16;
    const height = Math.round(Number(imageHeight) / 16) * 16;
    if (width > 0 && height > 0) {
      setImageWidth(String(width)); setImageHeight(String(height));
      setImageResolution(inferImageResolution(String(width) + "x" + String(height)));
      setAspectRatio(inferImageAspectRatio(String(width) + "x" + String(height)));
    }
  };

  useEffect(() => {
    setRemainingQuota(user.quota);
  }, [user.quota]);

  const isAdmin = user.role === "admin";
  useEffect(() => whenIdle(() => {
    void PromptLibraryView.preload();
    void GalleryView.preload();
    void AssetsView.preload();
    if (isAdmin) void ConfigView.preload();
  }), [isAdmin]);

  const hasAssetReferences = assetIds.length > 0;
  useEffect(() => {
    if (!referencesWanted && !hasAssetReferences) return;
    apiClient.listAssets().then(setReferenceAssets).catch(() => setReferenceAssets([]));
  }, [referencesWanted, hasAssetReferences, refreshKey]);

  // 定价与渠道能力只服务创作页；其他页面不请求
  const onCreatePage = activeModule === "create";
  useEffect(() => {
    if (!onCreatePage) return;
    let live = true;
    const refresh = () => { void apiClient.listQuotaPricing().then(rules => { if(live) setQuotaPricingRules(rules); }).catch(() => {}); };
    refresh(); window.addEventListener("paintopia-pricing-updated", refresh); window.addEventListener("focus", refresh); window.addEventListener("storage", refresh);
    return () => { live=false; window.removeEventListener("paintopia-pricing-updated",refresh); window.removeEventListener("focus",refresh); window.removeEventListener("storage",refresh); };
  }, [onCreatePage]);

  useEffect(() => {
    if (!onCreatePage) return;
    let cancelled = false;
    let latestRequest = 0;
    const refresh = async () => {
      const requestId = ++latestRequest;
      try {
        const result = await apiClient.listImageCapabilities();
        if (cancelled || requestId !== latestRequest) return;
        const available = result.models.filter((item) => !item.mode || (mode === "edit" ? true : item.mode !== "edits"));
        setImageCapabilities(available);
        setImageModel((current) => {
          if (restoredSource.current) { const source = matchHistorySource(available, restoredSource.current); return source ? capabilityKey(source) : ""; }
          return available.some((item) => capabilityKey(item) === current) ? current : available[0] ? capabilityKey(available[0]) : "";
        });
      } catch {
        // Keep the last successful list on a transient refresh failure.
      }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === PROVIDER_CHANGE_EVENT) void refresh(); };
    void refresh();
    window.addEventListener(PROVIDER_CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(PROVIDER_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
    };
  }, [onCreatePage, mode]);

  useEffect(() => {
    const activeCapability = imageCapabilities.find((item) => capabilityKey(item) === imageModel);
    if (!activeCapability) {
      return;
    }
    const modelTier = activeCapability.model.match(/-(1k|2k|4k)$/i)?.[1]?.toUpperCase();
    if (modelTier && imageResolution !== modelTier) { applySizePreset(modelTier, aspectRatio === "auto" ? "1:1" : aspectRatio); return; }
    if (imageResolution !== "auto" && !IMAGE_RESOLUTION_OPTIONS.includes(imageResolution as typeof IMAGE_RESOLUTION_OPTIONS[number])) {
      setImageResolution(DEFAULT_IMAGE_RESOLUTION);
    }
  }, [imageCapabilities, imageModel, imageResolution]);

  function captureDraft() { return { prompt, files, assetIds, assets, assetIndex, imageModel, imageResolution, imageQuality, imageCount, imageWidth, imageHeight, aspectRatio, transparentBackground, duration, status, previewImageUrl }; }
  const historyDraft = useRef<ReturnType<typeof captureDraft> | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  function selectHistory(item: GeneratedAsset) {
    if (isGenerating) return;
    if (selectedHistoryId === item.id && historyDraft.current) {
      const d = historyDraft.current;
      restoredSource.current = null;
      setPrompt(d.prompt); setFiles(d.files); setAssetIds(d.assetIds); setAssets(d.assets); setAssetIndex(d.assetIndex);
      setImageModel(d.imageModel); setImageResolution(d.imageResolution); setImageQuality(d.imageQuality); setImageCount(d.imageCount);
      setImageWidth(d.imageWidth); setImageHeight(d.imageHeight); setAspectRatio(d.aspectRatio); setTransparentBackground(d.transparentBackground);
      setDuration(d.duration); setStatus(d.status); setPreviewImageUrl(d.previewImageUrl);
      historyDraft.current = null; setSelectedHistoryId(null); return;
    }
    if (!historyDraft.current) historyDraft.current = captureDraft();
    setSelectedHistoryId(item.id); restoreAsset(item);
  }
  function restoreAsset(item: GeneratedAsset) {
    const params = item.params ?? {};
    setPrompt(item.prompt); setAssets([item]); setAssetIndex(0); setPreviewImageUrl(null);
    restoredSource.current = params;
    const source = matchHistorySource(imageCapabilities, params);
    const isEdit = params.mode === "image-edit";
    setFiles([]);
    setAssetIds(isEdit && Array.isArray(params.assetIds) ? params.assetIds.filter((id): id is string => typeof id === "string") : []);
    setImageModel(source ? capabilityKey(source) : "");
    setStatus(source ? "已恢复创作参数，点击生成将发起新的请求" : "已恢复参数；请核对原接口与模型是否可用");
    if (isEdit && Number(params.referenceImageCount) > (Array.isArray(params.assetIds) ? params.assetIds.length : 0)) setStatus("已恢复参数；原本地上传的参考图需重新上传");
    setImageResolution(params.size === "auto" ? "auto" : typeof params.resolution === "string" ? params.resolution : "1K");
    setImageQuality(typeof params.quality === "string" ? params.quality : "auto");
    setImageCount(typeof params.n === "number" ? Math.max(1, Math.min(8, params.n)) : 1);
    setTransparentBackground(params.background === "transparent");
    setAspectRatio(params.size === "auto" ? "auto" : typeof params.aspectRatio === "string" ? params.aspectRatio : "1:1");
    const size = typeof params.size === "string" ? params.size.match(/^(\d+)x(\d+)$/) : null;
    if (size) { const pixels = size[1] + "x" + size[2]; setImageWidth(size[1]); setImageHeight(size[2]); setImageResolution(inferImageResolution(pixels)); setAspectRatio(typeof params.aspectRatio === "string" ? params.aspectRatio : inferImageAspectRatio(pixels)); }
    else { const restoredSize = params.size === "auto" ? "auto" : resolveImageSize(typeof params.resolution === "string" ? params.resolution : "1K", typeof params.aspectRatio === "string" ? params.aspectRatio : "1:1"); const [width, height] = restoredSize === "auto" ? ["", ""] : restoredSize.split("x"); setImageWidth(width); setImageHeight(height); }
    setDuration(null);
  }

  function applyPrompt(text: string) {
    if (prompt.trim() && prompt !== text) setPendingLibraryPrompt(text);
    else { setPrompt(text); onNavigate?.("create"); }
  }

  async function startGeneration() {
    if (!prompt.trim() || isGenerating || !imageCapabilities.length) return;
    historyDraft.current = null; setSelectedHistoryId(null);
    const startedAt = Date.now();
    generationStartedAt.current = startedAt;
    setDuration(0);
    setIsGenerating(true);
    setAssets([]);
    setPreviewImageUrl(null);
    setStatus("正在提交生成请求，等待上游响应");
    try {
      const selected = imageCapabilities.find((item) => capabilityKey(item) === imageModel);
      if (!selected) throw new Error("请选择可用接口与模型");
      if (selected.imageCapabilities?.qualities?.length && !selected.imageCapabilities.qualities.includes(imageQuality)) throw new Error("当前质量不在该渠道的允许选项中，请重新选择");
      const providerId = selected.providerId;
      const size = !imageWidth && !imageHeight ? "auto" : validateImageSize(String(Math.round(Number(imageWidth) / 16) * 16) + "x" + String(Math.round(Number(imageHeight) / 16) * 16));
      const params = { model: selected.model, resolution: size === "auto" ? "auto" : inferImageResolution(size), aspectRatio, size, quality: imageQuality, background: transparentBackground ? "transparent" : "auto", n: imageCount };
      const result = mode === "edit"
        ? await apiClient.generateEdit(
            { prompt, params, providerId, images: files, assetIds },
            () => setStatus("连接已中断，正在检查生成结果")
          )
        : await apiClient.generateStream({ prompt, params, providerId }, (preview) => {
          setPreviewImageUrl(preview.imageUrl);
          setStatus("已收到过程预览，等待最终图片");
        }, (event) => setStatus(event.message));
      const elapsed = Date.now() - startedAt;
      setDuration(elapsed);
      setAssets(result.assets);
      setPreviewImageUrl(null);
      setAssetIndex(0);
      if (typeof result.remainingQuota === "number") {
        setRemainingQuota(result.remainingQuota);
      }
      const warnings = Array.from(new Set(result.assets.map((item) => item.params?.resolutionWarning).filter((value): value is string => typeof value === "string")));
      const completionStatus = result.assets.length < imageCount ? "已保留 " + result.assets.length + "/" + imageCount + " 张图片，仅按成功张数结算，用时 " + formatDuration(elapsed) : result.assets.length > 1 ? `生成完成，共 ${result.assets.length} 张，用时 ${formatDuration(elapsed)}` : `生成完成，用时 ${formatDuration(elapsed)}`;
      setStatus(warnings.length ? `${completionStatus}。${warnings.join("；")}` : completionStatus);
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setPreviewImageUrl(null);
      setStatus(error instanceof Error ? error.message : "生成失败");
    } finally {
      setDuration(Date.now() - startedAt);
      setIsGenerating(false);
    }
  }

  const estimatedQuotaCost = getEstimatedQuotaCost(quotaPricingRules, imageWidth && imageHeight && Number(imageWidth) > 0 && Number(imageHeight) > 0 ? inferImageResolution(String(Math.max(16, Math.round(Number(imageWidth) / 16) * 16)) + "x" + String(Math.max(16, Math.round(Number(imageHeight) / 16) * 16))) : "auto", imageQuality, imageCount);
  const isCreate = activeModule === "create";

  return (
    <div className={`${styles.shell} ${shell.root}`} data-testid="app-shell" data-theme={resolvedTheme} data-language={language} data-reduce-motion={reduceMotion}>
      <TopNavigation
        activeModule={activeModule}
        userEmail={user.email}
        isAdmin={user.role === "admin"}
        theme={theme}
        quota={remainingQuota}
        checkIn={checkIn}
        onNavigate={(moduleId) => onNavigate?.(moduleId)}
        onToggleTheme={() => setTheme(resolvedTheme === "light" ? "dark" : "light")}
        onLogout={() => { clearMediaCache(); onLogout?.(); }}
      />
      {pendingLibraryPrompt !== null ? <PromptApplyDialog currentPrompt={prompt} incomingPrompt={pendingLibraryPrompt} onApply={text => { setPrompt(text); onNavigate?.("create"); }} onClose={() => setPendingLibraryPrompt(null)} /> : null}
      <main className={`${styles.main} ${isCreate ? shell.createMain : shell.pageMain}`}>
        <div className={`${styles.content} ${isCreate ? shell.createContent : shell.pageContent}`} key={activeModule.startsWith("config") ? "config" : activeModule}>
          {isCreate ? <CreateView prompt={prompt} setPrompt={setPrompt}
            files={files} setFiles={(next) => { restoredSource.current = null; setFiles(next); }}
            assetIds={assetIds} setAssetIds={(next) => { restoredSource.current = null; setAssetIds(next); }}
            referenceAssets={referenceAssets} onWantReferences={() => setReferencesWanted(true)}
            imageModel={imageModel} setImageModel={(model) => { restoredSource.current = null; setImageModel(model); }} imageCapabilities={imageCapabilities}
            imageResolution={imageResolution} setImageResolution={(resolution) => applySizePreset(resolution, aspectRatio === "auto" && resolution !== "auto" ? "1:1" : aspectRatio)}
            imageQuality={imageQuality} setImageQuality={setImageQuality}
            imageCount={imageCount} setImageCount={setImageCount}
            imageWidth={imageWidth} setImageWidth={changeWidth} imageHeight={imageHeight} setImageHeight={changeHeight}
            aspectRatio={aspectRatio} setAspectRatio={(ratio) => applySizePreset(imageResolution === "auto" && ratio !== "auto" ? DEFAULT_IMAGE_RESOLUTION : imageResolution, ratio)}
            transparentBackground={transparentBackground} setTransparentBackground={setTransparentBackground}
            swapDimensions={swapDimensions} commitDimensions={commitDimensions} estimatedQuotaCost={estimatedQuotaCost}
            isGenerating={isGenerating} status={status} previewImageUrl={previewImageUrl} duration={duration}
            assets={assets} assetIndex={assetIndex} setAssetIndex={setAssetIndex} startGeneration={startGeneration}
            refreshKey={refreshKey} selectedHistoryId={selectedHistoryId} onHistoryToggle={selectHistory} onHistorySelect={restoreAsset}
            onOpenLibrary={() => onNavigate?.("prompt-library")} /> : null}
          <Suspense fallback={<div className={shell.pageFallback} aria-busy="true" />}>
          {activeModule === "prompt-library" ? <PromptLibraryView onUsePrompt={applyPrompt} canManage={user.role === "admin"} /> : null}
          {activeModule === "gallery" ? <GalleryView account={user.email} canManage={user.role === "admin"} onUsePrompt={applyPrompt} /> : null}
          {activeModule === "assets" ? <AssetsView account={user.email} refreshKey={refreshKey} showOwner={false} canCurate={user.role === "admin"}
            onReuse={(asset) => { restoreAsset(asset); onNavigate?.("create"); }}
            onUseAsReference={(asset) => { if (!assetIds.includes(asset.id) && files.length + assetIds.length < MAX_REFERENCE_IMAGES) { restoredSource.current = null; setAssetIds([...assetIds, asset.id]); setReferencesWanted(true); } onNavigate?.("create"); }} /> : null}
          {activeModule === "usage-log" ? <UsageLogView /> : null}
          {activeModule === "profile" ? <div className={styles.settingsLayout}><ProfileView user={{...user,quota:remainingQuota}} checkIn={checkIn} onLogout={onLogout} /></div> : null}
          {activeModule === "settings" ? <div className={styles.settingsLayout}><SettingsView theme={theme} language={language} reduceMotion={reduceMotion} setTheme={setTheme} setLanguage={setLanguage} setReduceMotion={setReduceMotion} /></div> : null}
          {(activeModule === "config" || activeModule.startsWith("config-")) && user.role === "admin" ? <ConfigView section={(activeModule === "config" ? "stats" : activeModule.slice(7)) as ConfigSection} onSectionChange={section => onNavigate?.(section === "stats" ? "config" : ("config-" + section) as ModuleId)} /> : null}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
