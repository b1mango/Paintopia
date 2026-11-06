import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { GripVertical, PlugZap, Plus } from "lucide-react";
import styles from "../features/admin/admin.module.css";
import { useProviderDrag } from "./useProviderDrag";
import providerStyles from "./ProviderConfig.module.css";
import { apiClient, type ProviderConfigResponse } from "../lib/apiClient";
import { StyledSelect } from "../components/StyledSelect";
import { AdminDrawer } from "../features/admin/AdminDialog";
import { AdminState, SectionHeading } from "../features/admin/AdminLayout";
import { saveProviderConfig, type TextProvider, type ProviderTestState, type ProviderConfigProps, readProviderForm, moveProviderBefore, persistedProviderIds, ProviderTestBadge, ProviderDeleteDialog, mergeModelOptions, notifyProviderChange } from "./providerShared";

function textProvidersFromSaved(savedProviders: ProviderConfigResponse[] | null, fallbackProvider: TextProvider): TextProvider[] {
  if (savedProviders === null) {
    return [];
  }
  const savedTextProviders = savedProviders.filter((provider) => provider.kind === "text") as TextProvider[];
  return savedTextProviders.length
    ? savedTextProviders.map((provider) => ({ ...provider, apiKey: "" }))
    : [fallbackProvider];
}

export function TextConfig({ savedProviders, providerLoadError }: ProviderConfigProps) {
  const startPointerDrag = useProviderDrag((from, to, after) => { void reorderTextProvider(from, to, after); });
  const [deleteTarget, setDeleteTarget] = useState<TextProvider | null>(null);
  const formId = useId();
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutating, setMutating] = useState(false);
  const mutationLock = useRef(false);
  const editorVersion = useRef(0);
  const [manualModel, setManualModel] = useState("");
  function blankTextProvider(): TextProvider {
    return { id: `new-text-${Date.now()}`, kind: "text", name: "", baseUrl: "", apiKey: "", model: "", mode: "chat_completions" };
  }

  const fallbackProvider = useMemo(() => blankTextProvider(), []);
  const initialProviders = useMemo(
    () => providerLoadError ? [fallbackProvider] : textProvidersFromSaved(savedProviders, fallbackProvider),
    [fallbackProvider, providerLoadError, savedProviders]
  );
  const [providers, setProviders] = useState<TextProvider[]>(initialProviders);
  const persistedProviders = useRef(new Map(initialProviders.map(item => [item.id, item])));
  const [activeId, setActiveId] = useState(initialProviders[0]?.id ?? fallbackProvider.id);
  const isLoading = savedProviders === null && !providerLoadError;
  const [status, setStatus] = useState("");
  const [testStatus, setTestStatus] = useState("");
  const [testStates, setTestStates] = useState<Record<string, ProviderTestState>>({});
  const [modelOptionsByProvider, setModelOptionsByProvider] = useState<Record<string, string[]>>({});
  const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null);
  const active = providers.find((item) => item.id === activeId) ?? providers[0] ?? fallbackProvider;
  const modelOptions = [...(active.model ? [] : [""]), ...mergeModelOptions([active.model], modelOptionsByProvider[active.id])];

  useEffect(() => {
    if (isLoading) return;
    persistedProviders.current = new Map(initialProviders.map(item => [item.id, item]));
    setProviders(initialProviders);
    setActiveId((currentActiveId) => initialProviders.some((provider) => provider.id === currentActiveId) ? currentActiveId : initialProviders[0]?.id ?? fallbackProvider.id);
    if (providerLoadError) {
      setStatus(providerLoadError);
    }
  }, [fallbackProvider.id, initialProviders, isLoading, providerLoadError]);

  const listedProviders = providers.filter(provider => !provider.id.startsWith("new-text-"));

  function closeEditor() {
    if (saving) return;
    editorVersion.current += 1;
    const stored = persistedProviders.current.get(active.id);
    setProviders(items => items.filter(item => !item.id.startsWith("new-text-")).map(item => item.id === active.id && stored ? { ...stored } : item));
    setEditorOpen(false);
    setManualModel("");
    setStatus("");
  }

  function editProvider(provider: TextProvider) {
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
    void reorderTextProvider(direction === -1 ? current.id : neighbor.id, direction === -1 ? neighbor.id : current.id);
  }

  function addProvider() {
    if (mutationLock.current || saving) return;
    editorVersion.current += 1;
    const next = blankTextProvider();
    setProviders((value) => [...value.filter(item => !item.id.startsWith("new-text-")), next]);
    setManualModel("");
    setActiveId(next.id);
    setEditorOpen(true);
    setStatus("");
  }

  async function deleteProvider(provider: TextProvider) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setMutating(true);
    try {
      if (!provider.id.startsWith("new-text-")) await apiClient.deleteProvider(provider.id);
      persistedProviders.current.delete(provider.id);
      setProviders(items => items.filter(item => item.id !== provider.id));
      if (active.id === provider.id) setEditorOpen(false);
      notifyProviderChange();
      setStatus("渠道已删除"); setDeleteTarget(null);
    } catch (error) { setStatus(error instanceof Error ? `删除失败：${error.message}` : "删除失败"); }
    finally { mutationLock.current = false; setMutating(false); }
  }

  async function toggleProvider(provider: TextProvider) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setMutating(true);
    try {
      const stored = persistedProviders.current.get(provider.id);
      if (!stored || provider.id.startsWith("new-text-")) throw new Error("请先保存接口配置");
      const updated = await apiClient.updateProvider(provider.id, { ...stored, apiKey: "", enabled: provider.enabled === false });
      persistedProviders.current.set(provider.id, { ...stored, ...updated, apiKey: "" });
      setProviders(items => items.map(item => item.id === provider.id ? { ...item, enabled: updated.enabled } : item));
      notifyProviderChange();
      setStatus(updated.enabled ? "接口已启用" : "接口已禁用");
    } catch (error) { setStatus(error instanceof Error ? error.message : "切换失败"); }
    finally { mutationLock.current = false; setMutating(false); }
  }

  async function saveProvider(event: MouseEvent<HTMLButtonElement>) {
    if (saving || mutationLock.current) return;
    const request = readProviderForm(event.currentTarget.form, active);
    mutationLock.current = true;
    setSaving(true);
    try {
      const updated = await saveProviderConfig(active.id, request, "new-text-");
      const updatedId = updated.id ?? active.id;
      persistedProviders.current.set(updatedId, { ...active, ...request, ...updated, id: updatedId, apiKey: "" } as TextProvider);
      setProviders((value) => value.map((provider) => provider.id === active.id ? { ...provider, ...request, ...updated, id: updatedId, apiKey: "" } : provider));
      setActiveId(updatedId);
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
        const result = await apiClient.testProvider({
          ...request,
          providerId: provider.id,
          prompt: "Reply with OK only."
        });
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
    const providerId = active.id.startsWith("new-text-") ? undefined : active.id;
    if (!baseUrl || (!apiKey && !providerId)) {
      setStatus("请先填写 Base URL 和 API Key");
      return;
    }
    try {
      const result = await apiClient.listProviderModels({ baseUrl, apiKey, providerId });
      if (requestVersion !== editorVersion.current) return;
      setModelOptionsByProvider((value) => ({ ...value, [active.id]: result.models.length ? result.models : [active.model] }));
      setStatus(`已获取 ${result.models.length} 个模型`);
    } catch (error) {
      if (requestVersion !== editorVersion.current) return;
      setStatus(error instanceof Error ? `获取模型失败：${error.message}` : "获取模型失败");
    }
  }

  async function reorderTextProvider(draggedId: string | null, targetId: string, after = false) {
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
    const ids = persistedProviderIds(nextProviders, "new-text-");
    if (ids.length === 0) {
      return;
    }
    mutationLock.current = true;
    setMutating(true);
    try {
      await apiClient.reorderProviders("text", ids);
      setStatus("接口顺序已保存");
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
    await reorderTextProvider(draggedId, targetId, after);
  }

  return (
    <div className={styles.providerListPage}>
      <SectionHeading title="优化配置" description="管理提示词处理使用的文本渠道。拖动列表，调整接口调用优先级。" />
      {deleteTarget && <ProviderDeleteDialog name={deleteTarget.name} busy={mutating} onCancel={() => setDeleteTarget(null)} onConfirm={() => void deleteProvider(deleteTarget)} />}
      <aside className={styles.configRail} data-testid="text-provider-rail">
        <div className={styles.railHeader}>
          <div><strong>接口列表</strong><p>{listedProviders.length} 个已保存接口 · 拖动左侧手柄调整顺序</p></div>
          <div className={styles.railHeaderActions}>
            <button type="button" className={styles.railIconButton} form={formId} aria-label="测试连接" title="测试连接" data-testid="text-provider-test-button" disabled={isLoading} onClick={testVisibleProviders}><PlugZap size={14} /></button>
            <button type="button" className={styles.railIconButton} aria-label="新增优化接口" title="新增优化接口" disabled={isLoading} onClick={addProvider}><Plus size={14} /></button>
          </div>
        </div>
        <div className={styles.providerTagList}>
          {isLoading ? (
            <AdminState loading testId="text-provider-loading">正在加载接口...</AdminState>
          ) : listedProviders.map((provider, index) => (
            <div key={provider.id} className={providerStyles.row} data-provider-id={provider.id} data-disabled={provider.enabled === false} data-drop={dropHint?.id === provider.id && draggingProviderId !== provider.id ? (dropHint.after ? "after" : "before") : undefined} onDragOver={event => handleProviderDragOver(event, provider.id)} onDrop={event => handleProviderDrop(event, provider.id)}>
            <button type="button" className={providerStyles.dragHandle} onPointerDown={event => startPointerDrag(event, provider.id)} disabled={mutating || saving} aria-label={`拖动排序 ${provider.name}`} title="拖动排序；键盘上下键调整优先级" onDragStart={event => handleProviderDragStart(event, provider.id)} onDragEnd={() => { setDraggingProviderId(null); setDropHint(null); }} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); moveProvider(index, event.key === "ArrowUp" ? -1 : 1); } }}><GripVertical size={18} /></button>
            <button type="button" disabled={mutating || saving}  className={`${provider.id === activeId ? styles.providerTagActive : styles.providerTagButton} ${draggingProviderId === provider.id ? styles.providerTagDragging : ""}`} aria-label={provider.name || "未命名优化接口"} data-active={provider.id === activeId ? "true" : "false"} onClick={() => editProvider(provider)} onDragStart={(event) => handleProviderDragStart(event, provider.id)}  onDragEnd={() => { setDraggingProviderId(null); setDropHint(null); }}>
              <span className={styles.providerTagTitle}>
                <strong>{provider.name || "未命名优化接口"}</strong>
                <ProviderTestBadge state={testStates[provider.id]} />
              </span>
              <span>{provider.model}</span>
            </button>
            <div className={providerStyles.actions}>
              <button type="button" disabled={mutating || saving} aria-label={`编辑接口 ${provider.name}`} onClick={() => editProvider(provider)}>编辑</button>
              <button type="button" disabled={mutating || saving} aria-label={`${provider.enabled === false ? "启用" : "禁用"}接口 ${provider.name}`} onClick={() => toggleProvider(provider)}>{provider.enabled === false ? "启用" : "禁用"}</button>
              <button type="button" className={providerStyles.danger} disabled={mutating || saving} aria-label={`删除接口 ${provider.name}`} onClick={() => setDeleteTarget(provider)}>删除</button>
            </div>
            </div>
          ))}
        </div>
        {listedProviders.length === 0 && !isLoading && !providerLoadError ? <AdminState>暂无已保存渠道，请点击上方新增。</AdminState> : null}
        {providerLoadError ? <AdminState error>{providerLoadError}</AdminState> : null}
        {testStatus ? <p className={styles.providerRailStatus} data-testid="text-provider-test-status">{testStatus}</p> : null}
      </aside>
      <AdminDrawer open={editorOpen} title="编辑文本渠道" onClose={closeEditor}>
      {editorOpen ? isLoading ? (
        <section className={`${styles.panel} ${providerStyles.form}`} data-testid="text-provider-form">
          <h2>优化接口</h2>
          <AdminState loading>正在加载已保存的接口配置...</AdminState>
        </section>
      ) : <form key={active.id} id={formId} className={`${styles.panel} ${providerStyles.form}`} data-testid="text-provider-form">
        <h2>优化接口</h2>
        <div className={providerStyles.formGrid}>
          <label className={styles.field}>名称<input name="name" defaultValue={active.name} /></label>
          <label className={styles.field}>接口模式<StyledSelect name="mode" ariaLabel="接口模式" defaultValue={active.mode} options={[
          { value: "chat_completions", label: "OpenAI Chat Completions" },
          { value: "responses", label: "OpenAI Responses" },
          { value: "anthropic_messages", label: "Anthropic Messages" }
        ]} /></label>
          <label className={`${styles.field} ${providerStyles.fullWidth}`}>Base URL<input name="baseUrl" defaultValue={active.baseUrl} /></label>
          <label className={`${styles.field} ${providerStyles.fullWidth}`}>API Key<input name="apiKey" type="password" autoComplete="new-password" placeholder={active.id.startsWith("new-text-") ? "填写渠道密钥" : "留空保留已保存的密钥"} /></label>

        <div className={`${styles.modelLookupRow} ${providerStyles.fullWidth}`}>
          <label className={styles.field}>模型<StyledSelect name="model" ariaLabel="模型" value={active.model} onChange={model => setProviders(items => items.map(item => item.id === active.id ? {...item,model} : item))} options={modelOptions.map((model) => ({ value: model, label: model || "未填写模型" }))} /></label>
          <button type="button" className={styles.secondaryAction} onClick={loadModels}>获取模型</button>
        </div>
        <div className={styles.manualModelRow}><input aria-label="手动添加文本模型" placeholder="上游模型名称" value={manualModel} onChange={event => setManualModel(event.target.value)} /><button type="button" className={styles.secondaryAction} disabled={!manualModel.trim()} onClick={() => { setProviders(items => items.map(item => item.id === active.id ? {...item, model:manualModel.trim()} : item)); setManualModel(""); }}>使用模型</button></div>

        <label className={styles.field}>最大并发<input name="maxConcurrency" type="number" min={1} defaultValue={active.maxConcurrency ?? 1} /></label>
        <label className={styles.inlineSetting}><input name="enabled" type="checkbox" defaultChecked={active.enabled ?? true} aria-label="启用文本接口" />启用文本接口</label>
        </div>
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
