import { useEffect, useState } from "react";
import styles from "../features/admin/admin.module.css";
import { AdminState, SectionHeading } from "../features/admin/AdminLayout";
import { apiClient, type GenerationStats } from "../lib/apiClient";
import { GenerationHistoryPanel } from "../features/history/GenerationHistoryPanel";
import { formatDuration, formatRate } from "./formatters";

export function StatsView({ isAdmin }: { isAdmin: boolean }) {
  const [stats, setStats] = useState<GenerationStats | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError("");
    (isAdmin ? apiClient.getAdminGenerationStats() : apiClient.getGenerationStats())
      .then(value => { if (!cancelled) setStats(value); })
      .catch(() => { if (!cancelled) setError("统计暂时无法读取，调用记录仍可单独查询。"); });
    return () => { cancelled = true; };
  }, [isAdmin, revision]);
  const textStats = stats?.textStats;
  const userStats = stats?.userStats;
  return <div className={styles.statsStack}>
    <SectionHeading title="统计" description="从每一次调用，读懂画案的日常。" />
    {error ? <AdminState error action={<button type="button" className={styles.secondaryAction} onClick={() => setRevision(value => value + 1)}>重新加载统计</button>}>{error}</AdminState> : null}
    <GenerationHistoryPanel allUsers={isAdmin} summary={<div className={styles.statGrid} aria-busy={!stats}>
      <div><span>总任务</span><strong>{stats?.total ?? "—"}</strong></div>
      <div><span>成功率</span><strong>{stats ? formatRate(stats.successRate) : "—"}</strong></div>
      <div><span>平均时长</span><strong>{stats ? formatDuration(stats.averageDurationMs) : "—"}</strong></div>
      <div><span>成功 / 失败</span><strong>{stats ? `${stats.succeeded} / ${stats.failed}` : "—"}</strong></div>
    </div>} />
    {isAdmin ? <div className={styles.statsSecondary}>
      <section className={styles.tablePanel}><h2>提示词优化统计</h2>
        {!stats ? <AdminState loading={!error}>{error ? "文本统计尚未读取。" : "正在整理文本调用…"}</AdminState> : <div className={styles.tableScroll}><table className={styles.dataTable}>
          <thead><tr><th>接口</th><th>调用次数</th><th>成功率</th><th>Token</th><th>平均耗时</th></tr></thead>
          <tbody>{(textStats?.byProvider ?? []).map(provider => <tr key={provider.providerId ?? "unconfigured"} data-testid={"text-provider-stat-" + (provider.providerId ?? "unconfigured")}><td>{provider.providerName}</td><td className={styles.numeric}>{provider.totalRuns}</td><td>{formatRate(provider.successRate)}</td><td className={styles.numeric}>{provider.totalTokens}</td><td>{formatDuration(provider.averageDurationMs)}</td></tr>)}
            {!textStats?.byProvider?.length ? <tr><td colSpan={5}><AdminState>{error ? "文本统计尚未读取。" : "尚无提示词优化调用"}</AdminState></td></tr> : null}
          </tbody><tfoot><tr><td>总计</td><td>—</td><td>{textStats ? formatRate(textStats.successRate) : "—"}</td><td className={styles.numeric} data-testid="text-total-tokens">{textStats?.totalTokens ?? 0}</td><td>—</td></tr></tfoot>
        </table></div>}
      </section>
      <section className={styles.tablePanel}><h2>用户统计</h2>
        {!stats ? <AdminState loading={!error}>{error ? "用户统计尚未读取。" : "正在读取用户概况…"}</AdminState> : <table className={styles.dataTable}><thead><tr><th>用户状态</th><th className={styles.numeric}>数量</th></tr></thead><tbody><tr><td>全部用户</td><td className={styles.numeric} data-testid="user-total-count">{userStats?.total ?? 0}</td></tr><tr><td>正常用户</td><td className={styles.numeric}>{(userStats?.total ?? 0) - (userStats?.disabled ?? 0)}</td></tr><tr><td>已封禁</td><td className={styles.numeric}>{userStats?.disabled ?? 0}</td></tr></tbody></table>}
      </section>
    </div> : null}
  </div>;
}

/** 使用日志：管理员也只看自己的记录，全站记录在后台「统计」。 */
export function UsageLogView() {
  return <div className={styles.statsStack}><SectionHeading title="使用日志" description="每次创作的去向、用时与额度，都有迹可循。" /><GenerationHistoryPanel /></div>;
}
