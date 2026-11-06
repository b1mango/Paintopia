import { useEffect, useId, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { GripVertical, PlugZap, Plus, RefreshCw } from "lucide-react";
import styles from "../features/admin/admin.module.css";
import { useProviderDrag } from "./useProviderDrag";
import providerStyles from "./ProviderConfig.module.css";
import { apiClient, type ProviderQuotaResponse } from "../lib/apiClient";
import { StyledMultiSelect, StyledSelect } from "../components/StyledSelect";
import { AdminDrawer } from "../features/admin/AdminDialog";
import { AdminState, SectionHeading } from "../features/admin/AdminLayout";
import { saveProviderConfig, type ImageProviderPreset, type ProviderTestState, type ProviderConfigProps, readProviderForm, moveProviderBefore, persistedProviderIds, ProviderTestBadge, ProviderDeleteDialog, splitProviderModels, joinProviderModels, mergeModelOptions, preferredFetchedImageModels, providerModelSummary, notifyProviderChange } from "./providerShared";

function createBlankImageProvider(id = `new-image-${Date.now()}`): ImageProviderPreset {
  return { id, kind: "image", name: "", baseUrl: "", apiKey: "", model: "", mode: "generations", maxConcurrency: 1, enabled: true };
}

export function ImageConfig({ savedProviders, providerLoadError }: ProviderConfigProps) {
  const startPointerDrag = useProviderDrag((from, to, after) => { void reorderImageProvider(from, to, after); });
  const [deleteTarget, setDeleteTarget] = useState<ImageProviderPreset | null>(null);
  const formId = useId();
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutating, setMutating] = useState(false);
  const mutationLock = useRef(false);
  const editorVersion = useRef(0);
  const [manualModel, setManualModel] = useState("");
  const persistedProviders = useRef(new Map<string, ImageProviderPreset>());
  const [providers, setProviders] = useState<ImageProviderPreset[]>(() => [createBlankImageProvider("new-image-initial")]);
  const [activeId, setActiveId] = useState("new-image-initial");
  const [status, setStatus] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState<Record<string, string[]>>({});
  const [testStates, setTestStates] = useState<Record<string, ProviderTestState>>({});
  const [providerQuotas, setProviderQuotas] = useState<Record<string, ProviderQuotaResponse>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const active = providers.find((provider) => provider.id === activeId) ?? providers[0] ?? createBlankImageProvider("new-image-empty");
  const selectedModels = splitProviderModels(active.model);
  const modelOptions = mergeModelOptions(selectedModels, modelOptionsByProvider[active.id]);

  useEffect(() => {
    if (savedProviders === null) return;
    const savedImageProviders = savedProviders
      .filter((provider) => provider.kind === "image")
      .map((provider) => ({ ...provider, apiKey: "" })) as ImageProviderPreset[];
    const nextProviders = savedImageProviders.length ? savedImageProviders : [createBlankImageProvider("new-image-empty")];
    persistedProviders.current = new Map(savedImageProviders.map((item) => [item.id, item]));
    setProviders(nextProviders);
    setActiveId((current) => nextProviders.some((provider) => provider.id === current) ? current : nextProviders[0]!.id);
  }, [savedProviders]);

  useEffect(() => {
    if (savedProviders === null) return;
    let cancelled = false;
    apiClient.listProviderQuotas()
      .then((items) => {
        if (!cancelled) {
          setProviderQuotas(Object.fromEntries(items.map((item) => [item.providerId, item])));
        }
      })
      .catch(() => {
        if (!cancelled) setProviderQuotas({});
      });
    return () => {
      cancelled = true;
    };
  }, [savedProviders]);

  useEffect(() => {
    if (providerLoadError) {
      setStatus(providerLoadError);
    }
  }, [providerLoadError]);

  async function refreshProviders() {
    if (refreshing) return;
    setRefreshing(true);
    setTestStatus("正在刷新额度与模型...");
    try {
      const quotas = await apiClient.listProviderQuotas();
      setProviderQuotas(Object.fromEntries(quotas.map((item) => [item.providerId, item])));
      const results = await Promise.allSettled(providers.filter((item) => !item.id.startsWith("new-image-")).map(async (item) => {
        const result = await apiClient.listProviderModels({ providerId: item.id, baseUrl: item.baseUrl });
        setModelOptionsByProvider((current) => ({ ...current, [item.id]: result.models }));
      }));
      const failed = results.filter((item) => item.status === "rejected").length;
      setTestStatus(failed ? `额度已刷新，${failed} 个接口的模型刷新失败` : "额度与模型已刷新");
    } catch (error) { setTestStatus(error instanceof Error ? error.message : "刷新失败"); }
    finally { setRefreshing(false); }
  }

  async function toggleProvider(provider: ImageProviderPreset) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setMutating(true);
    setToggling(true);
    try {
      const stored = persistedProviders.current.get(provider.id);
      if (!stored) throw new Error("请先保存接口配置");
      const updated = await apiClient.updateProvider(provider.id, { ...stored, apiKey: "", enabled: provider.enabled === false });
      persistedProviders.current.set(updated.id, { ...updated, apiKey: "" });
      setProviders((current) => current.map((item) => item.id === provider.id ? { ...item, enabled: updated.enabled } : item));
      notifyProviderChange();
      setStatus(updated.enabled ? "接口已启用" : "接口已禁用");
    } catch (error) { setStatus(error instanceof Error ? error.message : "切换失败"); }
    finally { setToggling(false); mutationLock.current = false; setMutating(false); }
  }

  const listedProviders = providers.filter(provider => !provider.id.startsWith("new-image-"));
  const isLoading = savedProviders === null && !providerLoadError;

  function closeEditor() {
    if (saving) return;
    editorVersion.current += 1;
    const stored = persistedProviders.current.get(active.id);
    setProviders(items => items.filter(item => !item.id.startsWith("new-image-")).map(item => item.id === active.id && stored ? { ...stored } : item));
    setEditorOpen(false);
    setManualModel("");
    setStatus("");
  }

  function editProvider(provider: ImageProviderPreset) {
    editorVersion.current += 1;
    setActiveId(provider.id);
    setManualModel("");
    setStatus("");
    setEditorOpen(true);
  }

  function moveProvider(index: number, direction: -1 | 1) {
    const neighbor = listedProviders[index + direction];
    const current = listedProviders[index];
    if (!neighbor || !current) return;
    // Moving the next item before this one is a one-step downward swap.
    void reorderImageProvider(direction === -1 ? current.id : neighbor.id, direction === -1 ? neighbor.id : current.id);
  }

  function addProvider() {
    if (mutationLock.current || saving) return;
    editorVersion.current += 1;
    const next = createBlankImageProvider();
    setProviders((value) => [...value.filter(item => !item.id.startsWith("new-image-")), next]);
    setManualModel("");
    setActiveId(next.id);
    setEditorOpen(true);
    setStatus("");
  }

  function updateActiveProvider(patch: Partial<ImageProviderPreset>) {
    setProviders((value) => value.map((provider) => provider.id === active.id ? { ...provider, ...patch } : provider));
  }

  async function deleteProvider(provider: ImageProviderPreset) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setMutating(true);
    try {
      if (!provider.id.startsWith("new-image-")) await apiClient.deleteProvider(provider.id);
      persistedProviders.current.delete(provider.id);
      setProviders(items => items.filter(item => item.id !== provider.id));
      if (active.id === provider.id) setEditorOpen(false);
      notifyProviderChange();
      setStatus("渠道已删除"); setDeleteTarget(null);
    } catch (error) { setStatus(error instanceof Error ? `删除失败：${error.message}` : "删除失败"); }
    finally { mutationLock.current = false; setMutating(false); }
  }

  async function saveProvider(event: MouseEvent<HTMLButtonElement>) {
    if (saving || mutationLock.current) return;
    const request = readProviderForm(event.currentTarget.form, active);
    mutationLock.current = true;
    setSaving(true);
    try {
      const updated = await saveProviderConfig(active.id, request, "new-image-");
      const updatedId = updated.id ?? active.id;
      setProviders((value) => value.map((provider) => provider.id === active.id ? { ...provider, ...request, ...updated, id: updatedId, apiKey: "" } : provider));
      persistedProviders.current.set(updatedId, { ...request, ...updated, id: updatedId, apiKey: "" });
      setActiveId(updatedId);
      notifyProviderChange();
      editorVersion.current += 1;
      setStatus("配置已保存");
      setEditorOpen(false);
    } catch (error) {
      setStatus(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
    } finally { mutationLock.current = false; setSaving(false); }
  }

  async function testVisibleProviders(event: MouseEvent<HTMLButtonElement>) {
    const activeRequest = event.currentTarget.form ? readProviderForm(event.currentTarget.form, active) : active;
    setTestStatus(`正在测试 ${listedProviders.length} 个接口...`);
    for (const provider of listedProviders) {
      setTestStates((value) => ({ ...value, [provider.id]: { status: "testing" } }));
      const request = provider.id === active.id ? activeRequest : { ...provider, apiKey: "" };
      try {
        const result = await apiClient.testProvider({ ...request, providerId: provider.id });
        setTestStates((value) => ({ ...value, [provider.id]: { status: "connected", latencyMs: result.latencyMs } }));
      } catch {
        setTestStates((value) => ({ ...value, [provider.id]: { status: "failed" } }));
      }
    }
    setTestStatus("测试完成");
  }

  async function loadModels(event: MouseEvent<HTMLButtonElement>) {
    const requestVersion = editorVersion.current;
    const data = new FormData(event.currentTarget.form ?? undefined);
    const baseUrl = String(data.get("baseUrl") || active.baseUrl);
    const apiKey = String(data.get("apiKey") ?? "");
    const providerId = active.id.startsWith("new-image-") ? undefined : active.id;
    if (!baseUrl || (!apiKey && !providerId)) {
      setStatus("请先填写 Base URL 和 API Key");
      return;
    }
    try {
      const result = await apiClient.listProviderModels({ baseUrl, apiKey, providerId });
      if (requestVersion !== editorVersion.current) return;
      const nextModels = result.models.length ? result.models : selectedModels;
      setModelOptionsByProvider((value) => ({ ...value, [active.id]: nextModels }));
      if (selectedModels.length === 0 && result.models.length > 0) {
        updateActiveProvider({ model: joinProviderModels(preferredFetchedImageModels(result.models)) });
      }
      setStatus(`已获取 ${result.models.length} 个候选模型，请勾选后保存配置`);
    } catch (error) {
      if (requestVersion !== editorVersion.current) return;
      setStatus(error instanceof Error ? `获取模型失败：${error.message}` : "获取模型失败");
    }
  }

  async function reorderImageProvider(draggedId: string | null, targetId: string, after = false) {
    if (mutationLock.current || !draggedId || draggedId === targetId) {
      return;
    }
    const previousProviders = providers;
    const nextProviders = moveProviderBefore(providers, draggedId, targetId);
    if (after) {
      const from = nextProviders.findIndex(item => item.id === draggedId);
      const [moved] = nextProviders.splice(from, 1);
      nextProviders.splice(nextProviders.findIndex(item => item.id === targetId) + 1, 0, moved);
    }
    setProviders(nextProviders);
    setStatus("正在保存接口顺序…");
    const ids = persistedProviderIds(nextProviders, "new-image-");
    if (ids.length === 0) {
      return;
    }
    mutationLock.current = true;
    setMutating(true);
    try {
      await apiClient.reorderProviders("image", ids);
      setStatus("接口顺序已保存");
      notifyProviderChange();
    } catch (error) {
      setProviders(previousProviders);
      setStatus(error instanceof Error ? `优先级同步失败：${error.message}` : "优先级同步失败");
    } finally { mutationLock.current = false; setMutating(false); }
  }

  function handleProviderDragStart(event: DragEvent<HTMLButtonElement>, providerId: string) {
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", providerId);
    }
    setDraggingProviderId(providerId);
  }

  function handleProviderDragOver(event: DragEvent<HTMLElement>, targetId: string) {
    const rect = event.currentTarget.getBoundingClientRect();
    setDropHint({ id: targetId, after: event.clientY > rect.top + rect.height / 2 });
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  }

  async function handleProviderDrop(event: DragEvent<HTMLElement>, targetId: string) {
    event.preventDefault();
    const draggedId = event.dataTransfer?.getData("text/plain") || draggingProviderId;
    setDraggingProviderId(null);
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setDropHint(null);
    await reorderImageProvider(draggedId, targetId, after);
  }

  return (
    <div className={styles.providerListPage}>
      <SectionHeading title="生图配置" description="管理生图渠道与模型。列表从上到下，依次作为调用优先级。" />
      {deleteTarget && <ProviderDeleteDialog name={deleteTarget.name} busy={mutating} onCancel={() => setDeleteTarget(null)} onConfirm={() => void deleteProvider(deleteTarget)} />}
      <aside className={styles.configRail} data-testid="image-provider-rail">
        <div className={styles.railHeader}>
          <div><strong>接口列表</strong><p>{listedProviders.length} 个已保存接口 · 拖动左侧手柄调整顺序</p></div>
          <div className={styles.railHeaderActions}>
            <button type="button" className={styles.railIconButton} disabled={refreshing || isLoading} aria-label="刷新接口额度与模型" title="刷新额度与模型" onClick={refreshProviders}><RefreshCw size={16} /></button>
            <button type="button" className={styles.railIconButton} form={formId} aria-label="测试连接" title="测试连接" disabled={isLoading || listedProviders.length === 0} onClick={testVisibleProviders}><PlugZap size={16} /></button>
            <button type="button" className={styles.railIconButton} aria-label="新增生图接口" title="新增生图接口" disabled={isLoading} onClick={addProvider}><Plus size={16} /></button>
          </div>
        </div>
        <div className={styles.providerTagList}>
          {listedProviders.map((provider, index) => (
            <div key={provider.id} className={providerStyles.row} data-provider-id={provider.id} data-disabled={provider.enabled === false} data-drop={dropHint?.id === provider.id && draggingProviderId !== provider.id ? (dropHint.after ? "after" : "before") : undefined} onDragOver={event => handleProviderDragOver(event, provider.id)} onDrop={event => handleProviderDrop(event, provider.id)}>
            <button type="button" className={providerStyles.dragHandle} onPointerDown={event => startPointerDrag(event, provider.id)} disabled={mutating || saving} aria-label={`拖动排序 ${provider.name}`} title="拖动排序；键盘上下键调整优先级" onDragStart={event => handleProviderDragStart(event, provider.id)} onDragEnd={() => { setDraggingProviderId(null); setDropHint(null); }} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveProvider(index, event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical size={18} /></button>
            <button type="button" disabled={mutating || saving}  className={`${provider.id === active.id ? styles.providerTagActive : styles.providerTagButton} ${draggingProviderId === provider.id ? styles.providerTagDragging : ""}`} aria-label={provider.name || "未命名生图接口"} data-active={provider.id === active.id ? "true" : "false"} onClick={() => editProvider(provider)} onDragStart={(event) => handleProviderDragStart(event, provider.id)}  onDragEnd={() => { setDraggingProviderId(null); setDropHint(null); }}>
              <span className={styles.providerTagTitle}>
                <strong>{provider.name || "未命名生图接口"}</strong>
                <span className={styles.providerTagMetrics}>
                  <ProviderTestBadge state={testStates[provider.id]} />
                </span>
              </span>
              <span>{provider.mode} · {providerModelSummary(provider.model)}</span>
            </button>
            <div className={providerStyles.actions}>
              <button type="button" disabled={mutating || saving} aria-label={`编辑接口 ${provider.name}`} onClick={() => editProvider(provider)}>编辑</button>
              <button type="button" disabled={mutating || saving || toggling} aria-label={`${provider.enabled === false ? "启用" : "禁用"}接口 ${provider.name}`} onClick={() => toggleProvider(provider)}>{provider.enabled === false ? "启用" : "禁用"}</button>
              <button type="button" className={providerStyles.danger} disabled={mutating || saving} aria-label={`删除接口 ${provider.name}`} onClick={() => setDeleteTarget(provider)}>删除</button>
            </div>
            </div>
          ))}
        </div>
        {isLoading ? <AdminState loading testId="image-provider-loading">正在加载接口...</AdminState> : !providerLoadError && listedProviders.length === 0 ? <AdminState>暂无已保存渠道，请点击上方新增。</AdminState> : null}
        {providerLoadError ? <AdminState error>{providerLoadError}</AdminState> : null}
        {testStatus ? <p className={styles.providerRailStatus} data-testid="image-provider-test-status">{testStatus}</p> : null}
      </aside>
      <AdminDrawer open={editorOpen} title="编辑生图渠道" onClose={closeEditor}>
      {editorOpen ? <form key={active.id} id={formId} className={`${styles.panel} ${providerStyles.form}`} data-testid="image-provider-form">
        <h2>生图接口</h2>
        <div className={providerStyles.formGrid}>
          <label className={styles.field}>名称<input name="name" defaultValue={active.name} /></label>
          <label className={styles.field}>接口模式<StyledSelect name="mode" ariaLabel="接口模式" defaultValue={active.mode} options={["generations", "edits", "responses", "chat_completions"].map((item) => ({ value: item, label: item }))} /></label>
          <label className={`${styles.field} ${providerStyles.fullWidth}`}>Base URL<input name="baseUrl" defaultValue={active.baseUrl} /></label>
          <label className={`${styles.field} ${providerStyles.fullWidth}`}>API Key<input name="apiKey" type="password" autoComplete="new-password" placeholder={active.id.startsWith("new-image-") ? "填写渠道密钥" : "留空保留已保存的密钥"} /></label>

          <div className={`${styles.modelLookupRow} ${providerStyles.fullWidth}`}>
            <label className={styles.field}>模型名称<StyledMultiSelect name="model" ariaLabel="模型名称" values={selectedModels} onChange={(models) => updateActiveProvider({ model: joinProviderModels(models) })} options={modelOptions.map((model) => ({ value: model, label: model || "未填写模型" }))} /></label>
            <button type="button" className={styles.secondaryAction} onClick={loadModels}>获取模型</button>
          </div>
          <div className={styles.manualModelRow}><input aria-label="手动添加模型" placeholder="上游原始模型名称" value={manualModel} onChange={event => setManualModel(event.target.value)} /><button type="button" className={styles.secondaryAction} disabled={!manualModel.trim()} onClick={() => { updateActiveProvider({model:joinProviderModels([...selectedModels,manualModel.trim()])}); setManualModel(""); }}>添加模型</button></div>

          <label className={styles.field}>最大并发<input name="maxConcurrency" type="number" min={1} defaultValue={active.maxConcurrency ?? 1} /></label>
        <label className={styles.inlineSetting}><input name="enabled" type="checkbox" key={String(active.enabled)} defaultChecked={active.enabled ?? true} aria-label="启用生图接口" />启用生图接口</label>
        </div>
        {active.model !== (persistedProviders.current.get(active.id)?.model ?? "") ? <p className={styles.statusText} role="status">模型选择尚未保存，请点击“保存配置”同步到创作页。</p> : null}
        <details className={styles.capabilityDetails}><summary>高级参数与接口能力</summary>
          <p className={styles.sizeNote}>按渠道文档配置；默认以 size 指定像素，不自动猜测质量枚举。</p>
          <label className={styles.field}>尺寸字段<select name="sizeField" defaultValue={active.imageCapabilities?.sizeField === null ? "none" : active.imageCapabilities?.sizeField ?? "size"}><option value="size">size（像素，如 3840x2160）</option><option value="image_size">image_size（像素）</option><option value="none">不发送尺寸字段</option></select></label>
          <label className={styles.field}>档位字段<select name="resolutionField" defaultValue={active.imageCapabilities?.resolutionField === null ? "none" : active.imageCapabilities?.resolutionField ?? "resolution"}><option value="none">不额外发送档位</option><option value="resolution">resolution（1K / 2K / 4K）</option><option value="image_size">image_size（1K / 2K / 4K）</option></select></label>
          <label className={styles.field}>允许的质量值<input name="qualities" defaultValue={active.imageCapabilities?.qualities?.join(", ") ?? ""} placeholder="auto, high, medium, low；留空按默认值" /></label>
          <input type="hidden" name="supportsStreamingConfigured" value="true" />
          <label className={styles.inlineSetting}><input type="checkbox" name="supportsStreaming" defaultChecked={active.imageCapabilities?.supportsStreaming === true} />尝试流式过程预览</label>
        </details>

        <div className={providerStyles.formActions}>
          <button type="button" className={styles.primaryAction} disabled={saving || mutating} onClick={saveProvider}>保存配置</button>
          <button type="button" className={styles.secondaryAction} disabled={saving} onClick={closeEditor}>取消</button>
        </div>
        {status ? <p className={styles.statusText}>{status}</p> : null}
      </form> : null}
      </AdminDrawer>
      {status && !editorOpen && !providerLoadError ? <p role="status" className={styles.statusText}>{status}</p> : null}
    </div>
  );
}
