import { useEffect, useId, useState } from "react";
import { Plus } from "lucide-react";
import styles from "../features/admin/admin.module.css";
import { apiClient, type TemplateResponse } from "../lib/apiClient";
import { BUILT_IN_PROMPT_TEMPLATES } from "@paintopia/shared";
import { AdminState, SectionHeading } from "../features/admin/AdminLayout";
import { ConfirmDialog } from "../features/admin/AdminDialog";

type PromptTemplatePreset = TemplateResponse;

/** 接口不可用时的只读兜底：内置模板，第一份即默认。 */
const promptTemplates: PromptTemplatePreset[] = BUILT_IN_PROMPT_TEMPLATES.map((template, index) => ({ ...template, isDefault: index === 0 }));

const defaultPromptTemplateIds = new Set(promptTemplates.map((template) => template.id));

const isDraft = (id: string) => id.startsWith("new-template-");

export function PromptConfig() {
  return <div className={styles.promptConfigPage}><SectionHeading title="提示词配置" description="创作页的「优化」使用默认模板改写提示词；中文 / 英文输出与输出格式由系统自动追加，模板只需写改写规则。" /><PromptTemplateConfig /></div>;
}

function PromptTemplateConfig() {
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState(promptTemplates);
  const headingId = useId();
  const [activeId, setActiveId] = useState(promptTemplates[0]!.id);
  const active = templates.find((template) => template.id === activeId) ?? templates[0]!;
  const [draft, setDraft] = useState(active);
  useEffect(() => setDraft(active), [active]);
  useEffect(() => {
    let cancelled = false;
    apiClient.listTemplates()
      .then((items) => {
        if (cancelled || items.length === 0) return;
        setTemplates(items);
        setActiveId((current) => items.some((template) => template.id === current) ? current : items[0]!.id);
      })
      .catch(() => { if (!cancelled) setLoadError("模板加载失败，当前显示内置模板。请刷新后再编辑。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const busy = loading || saving || deleting || Boolean(loadError);
  const builtIn = defaultPromptTemplateIds.has(active.id);
  const deleteBlocked = active.isDefault ? "默认模板不能删除，请先把其他模板设为默认" : builtIn ? "内置模板不能删除，可直接修改内容" : "";

  function blankTemplate(): PromptTemplatePreset {
    return { id: `new-template-${Date.now()}`, name: "", type: "optimize", targetModel: "general", content: "", isDefault: false };
  }

  function addTemplate() {
    const next = blankTemplate();
    setTemplates((value) => [...value, next]);
    setActiveId(next.id);
    setDraft(next);
    setSaveStatus("");
  }

  async function deleteTemplate() {
    setDeleting(true);
    setSaveStatus("");
    try {
      if (!isDraft(active.id)) await apiClient.deleteTemplate(active.id);
      const remaining = templates.filter(template => template.id !== active.id);
      const next = remaining[0] ?? blankTemplate();
      setTemplates(remaining.length ? remaining : [next]);
      setActiveId(next.id);
      setDraft(next);
      setConfirmDelete(false);
      setSaveStatus("模板已删除");
    } catch (error) { setSaveStatus(error instanceof Error ? `删除失败：${error.message}` : "删除失败，请重试"); }
    finally { setDeleting(false); }
  }

  async function makeDefault() {
    setSaving(true);
    setSaveStatus("");
    try {
      setTemplates(await apiClient.setDefaultTemplate(active.id));
      setSaveStatus(`已设为默认：创作页优化将使用“${active.name}”`);
    } catch (error) { setSaveStatus(error instanceof Error ? `设置失败：${error.message}` : "设置失败，请重试"); }
    finally { setSaving(false); }
  }

  async function saveTemplate() {
    if (!draft.name.trim() || !draft.content.trim()) { setSaveStatus("请填写模板名称和内容"); return; }
    setSaving(true); setSaveStatus("");
    try {
      const input = { name: draft.name, type: "optimize" as const, targetModel: draft.targetModel || "general", content: draft.content };
      const saved = isDraft(draft.id) ? await apiClient.createTemplate(input) : await apiClient.updateTemplate(draft.id, input);
      setTemplates((value) => value.map((template) => template.id === active.id ? saved : template));
      setActiveId(saved.id);
      setDraft(saved);
      setSaveStatus("模板已保存");
    } catch (error) { setSaveStatus(error instanceof Error ? error.message : "保存失败，请重试"); }
    finally { setSaving(false); }
  }

  return (
    <section className={styles.templateSection} aria-labelledby={headingId}>
      <header className={styles.templateHeader}>
        <div>
          <h3 id={headingId}>优化模板<span className={styles.templateCount} aria-hidden="true">{templates.length}</span></h3>
          <p>在保留原意的前提下补全构图、光影与质感细节。标为“默认”的一份会被创作页的「优化」使用。</p>
        </div>
        <button type="button" className={styles.templateAdd} disabled={busy} aria-label="新增优化模板" onClick={addTemplate}><Plus size={14} aria-hidden="true" />新增</button>
      </header>
      {loading ? <AdminState loading>正在读取模板…</AdminState> : null}
      {loadError ? <AdminState error>{loadError}</AdminState> : null}
      <div className={styles.adminSplitPane}>
        <aside className={styles.configRail} data-testid="prompt-template-rail">
          <div className={styles.templateList}>
            {templates.map((template) => (
              <button key={template.id} type="button" disabled={loading || saving || deleting} className={template.id === active.id ? styles.templateTagActive : styles.templateTagButton} data-active={template.id === active.id ? "true" : "false"} onClick={() => { setActiveId(template.id); setSaveStatus(""); }}>
                {template.name || "未命名模板"}
                {template.isDefault ? <span className={styles.templateDefault}>默认</span> : null}
              </button>
            ))}
          </div>
        </aside>
        <section className={styles.panel}>
          <div className={styles.formGridTwo}>
            <label className={styles.field}>模板名称<input disabled={busy} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          </div>
          <label className={styles.field}>模板内容<span className={styles.templateHint}>只写改写规则（补什么细节、保留什么）。输出语言与“只输出一段提示词”的要求由系统按用户选择自动追加。</span><textarea aria-label="模板内容" disabled={busy} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>
          {saveStatus ? <p role="status" className={styles.statusText}>{saveStatus}</p> : null}
          <div className={styles.formActionRow}>
            <button type="button" className={styles.primaryAction} disabled={busy} onClick={saveTemplate}>保存模板</button>
            <button type="button" className={styles.secondaryAction} disabled={busy || active.isDefault || isDraft(active.id)} title={isDraft(active.id) ? "先保存模板，再设为默认" : undefined} onClick={() => void makeDefault()}>{active.isDefault ? "当前默认" : "设为默认"}</button>
            <button type="button" className={styles.dangerAction} disabled={busy || Boolean(deleteBlocked)} title={deleteBlocked || undefined} onClick={() => setConfirmDelete(true)}>删除模板</button>
          </div>
          {confirmDelete ? <ConfirmDialog label="删除模板确认" title="删除这份模板？" busy={deleting} onCancel={() => setConfirmDelete(false)} onConfirm={() => void deleteTemplate()}><p>将删除“{active.name || "未命名模板"}”。请确认不再需要这份规则。</p>{saveStatus ? <p role="status">{saveStatus}</p> : null}</ConfirmDialog> : null}
        </section>
      </div>
    </section>
  );
}
