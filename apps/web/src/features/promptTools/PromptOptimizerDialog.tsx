import { useEffect, useId, useRef, useState } from 'react';
import { apiClient, type OptimizeTemplateOption } from '../../lib/apiClient';
import styles from './PromptOptimizerDialog.module.css';

type OutputLanguage = 'zh' | 'en';
const LANGUAGE_KEY = 'paintopia-optimize-language';
const languages: { id: OutputLanguage; label: string }[] = [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }];
const TEMPLATE_KEY = 'paintopia-optimize-template';
function storedLanguage(): OutputLanguage {
  try { return localStorage.getItem(LANGUAGE_KEY) === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}
function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式下不记忆选择 */ }
}
function storedTemplate(templates: OptimizeTemplateOption[]) {
  let saved: string | null = null;
  try { saved = localStorage.getItem(TEMPLATE_KEY); } catch { /* 同上 */ }
  return (templates.find(template => template.id === saved) ?? templates.find(template => template.isDefault) ?? templates[0])?.id ?? '';
}

export interface PromptOptimizerDialogProps { initialPrompt: string; targetModel: string; onApply: (text: string) => void; onClose: () => void }

export function PromptOptimizerDialog({ initialPrompt, targetModel, onApply, onClose }: PromptOptimizerDialogProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const sequence = useRef(0);
  const closed = useRef(false);
  const busy = useRef(false);
  const [draft, setDraft] = useState(initialPrompt);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [language, setLanguage] = useState<OutputLanguage>(storedLanguage);
  const [templates, setTemplates] = useState<OptimizeTemplateOption[]>([]);
  const [templateId, setTemplateId] = useState('');
  useEffect(() => {
    let cancelled = false;
    // 读不到模板时不显示选择，后端自动用默认模板
    apiClient.listOptimizeTemplates().then(items => {
      if (cancelled) return;
      setTemplates(items);
      setTemplateId(storedTemplate(items));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closed.current = false;
    element.showModal();
    input.current?.focus();
    return () => { closed.current = true; sequence.current += 1; element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    sequence.current += 1; busy.current = false; setLoading(false); setResult(null); setError(null); setFeedback('');
  }, [targetModel]);
  function close() {
    if (closed.current) return;
    closed.current = true; sequence.current += 1; dialog.current?.close(); onClose();
  }
  async function optimize() {
    if (busy.current || closed.current || !draft.trim()) return;
    const id = ++sequence.current;
    busy.current = true; setLoading(true); setResult(null); setError(null); setFeedback('');
    try {
      const response = await apiClient.optimize({ inputPrompt: draft.trim(), targetModel: targetModel || 'general', outputLanguage: language, ...(templateId ? { templateId } : {}) });
      if (id !== sequence.current || closed.current) return;
      if (response.providerConfigured !== true) throw new Error('尚未配置可用的文本模型，请联系管理员后重试');
      if (typeof response.text !== 'string' || !response.text.trim()) throw new Error('模型未返回优化内容，请重试');
      setResult(response.text);
    } catch (reason) {
      if (id === sequence.current && !closed.current) setError(reason instanceof Error ? reason.message : '优化失败，请重试');
    } finally {
      if (id === sequence.current && !closed.current) { busy.current = false; setLoading(false); }
    }
  }
  async function copy() {
    const id = sequence.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(result ?? '');
      if (id === sequence.current && !closed.current) setFeedback('已复制优化结果');
    } catch {
      if (id === sequence.current && !closed.current) setFeedback('复制失败，请手动选择文本复制');
    }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className={styles.header}>
      <div><h2 id={titleId}>优化提示词</h2><p>先调整描述、选好模板与输出语言，再将优化结果应用到创作。</p></div>
      <button type="button" onClick={close} aria-label="关闭优化提示词">关闭</button>
    </header>
    <div className={styles.body}>
      <label className={styles.field}>原始提示词<textarea ref={input} rows={5} value={draft} disabled={loading} onChange={(event) => { setDraft(event.target.value); setResult(null); setError(null); setFeedback(''); }} /></label>
      {templates.length > 1 ? <div className={styles.templates} role="radiogroup" aria-label="优化模板">
        <span className={styles.templatesLabel}>优化模板</span>
        {templates.map(template => <button key={template.id} type="button" role="radio" aria-checked={templateId === template.id} disabled={loading}
          onClick={() => { if (templateId === template.id) return; setTemplateId(template.id); setResult(null); setError(null); setFeedback(''); remember(TEMPLATE_KEY, template.id); }}>{template.name}</button>)}
      </div> : null}
      <div className={styles.runRow}><div className={styles.language} role="radiogroup" aria-label="输出语言">{languages.map(option => <button key={option.id} type="button" role="radio" aria-checked={language === option.id} disabled={loading} onClick={() => { if (language === option.id) return; setLanguage(option.id); setResult(null); setError(null); setFeedback(''); remember(LANGUAGE_KEY, option.id); }}>{option.label}</button>)}</div><button type="button" disabled={loading || !draft.trim()} onClick={() => void optimize()}>{loading ? '正在优化…' : '开始优化'}</button><span>仅处理文本，不生成图片</span></div>
      {loading && <p role="status" className={styles.feedback}>正在等待文本模型返回，可随时关闭。</p>}
      {error && <p role="alert" className={styles.feedback}>{error}</p>}
      {result !== null && <label className={styles.field}>优化结果<textarea rows={7} value={result} onChange={(event) => { setResult(event.target.value); setFeedback(''); }} /></label>}
      {feedback && <p role="status" className={styles.feedback}>{feedback}</p>}
    </div>
    <footer className={styles.footer}>
      <button type="button" onClick={close}>取消</button>
      <div className={styles.resultActions}><button type="button" disabled={loading || !result?.trim()} onClick={() => void copy()}>复制结果</button><button type="button" className={styles.primary} disabled={loading || !result?.trim()} onClick={() => { if (result?.trim()) { onApply(result); close(); } }}>应用到提示词</button></div>
    </footer>
  </dialog>;
}
