import { useEffect, useState } from "react";
import styles from "../features/admin/admin.module.css";
import { apiClient, type QuotaPricingRule } from "../lib/apiClient";
import { AdminState, SectionHeading } from "../features/admin/AdminLayout";

export function PricingConfig() {
  const [rules, setRules] = useState<QuotaPricingRule[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    apiClient.listQuotaPricing().then(setRules).catch(() => setError("额度配置加载失败，请检查连接后刷新重试")).finally(() => setLoading(false));
  }, []);

  async function savePricing() {
    if (rules.some(rule => !Number.isFinite(rule.amount) || rule.amount < 0)) { setError("请输入不小于 0 的额度。"); return; }
    setSaving(true); setError(""); setMessage("");
    try {
    const updated = await apiClient.updateQuotaPricing(rules.map((rule) => ({ key: rule.key, amount: rule.amount })));
    setRules(updated);
    window.dispatchEvent(new Event("paintopia-pricing-updated"));
    try { localStorage.setItem("paintopia-pricing-updated", String(Date.now())); } catch { /* Same-tab notification still applies. */ }
    setMessage("额度配置已保存");
    } catch (error) { setError(error instanceof Error ? `保存失败：${error.message}` : "额度保存失败，请重试"); }
    finally { setSaving(false); }
  }

  return (
    <div className={styles.stack}>
    <SectionHeading title="定价额度" description="按分辨率与质量设定每张图的本站额度，保存后应用于后续创作。" />
    <section className={styles.panel}>
      {loading ? <AdminState loading>正在读取额度规则…</AdminState> : null}
      {error ? <AdminState error>{error}</AdminState> : null}
      {!loading && !error && !rules.length ? <AdminState>尚无可编辑的额度规则。</AdminState> : null}
      <div className={styles.pricingGrid}>
        {rules.map((rule) => (
          <label className={styles.field} key={rule.key}>
            {rule.label}
            <input
              aria-label={`${rule.label} 每张图额度`}
              type="number"
              min={0}
              disabled={saving}
              value={rule.amount}
              onChange={(event) => setRules((value) => value.map((item) => item.key === rule.key ? { ...item, amount: Number(event.target.value) } : item))}
            />
          </label>
        ))}
      </div>
      <div className={styles.formActionRow}>
        <button type="button" className={styles.primaryAction} disabled={!rules.length || saving} onClick={savePricing}>保存额度配置</button>
      </div>
      {message ? <p className={styles.statusText}>{message}</p> : null}
    </section>
    </div>
  );
}
