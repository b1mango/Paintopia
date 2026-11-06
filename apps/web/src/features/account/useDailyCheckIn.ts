import { useCallback, useEffect, useRef, useState } from "react";
import type { DailyCheckInStatus } from "@paintopia/shared";
import { apiClient } from "../../lib/apiClient";

export type DailyCheckInPhase = "loading" | "available" | "claiming" | "claimed" | "error";

export interface DailyCheckInControl {
  phase: DailyCheckInPhase;
  reward: number | null;
  /** 最近一次领取的反馈（成功入账或已签到），用于短暂提示。 */
  notice: string;
  error: string;
  /** 每次真正入账 +1，用于触发余额跳动等一次性动效。 */
  creditedCount: number;
  claim: () => void;
  reload: () => void;
}

// 窗口重新聚焦时，至少间隔这么久才重新读取，避免频繁请求。
const FOCUS_REFRESH_MS = 5 * 60 * 1000;

/**
 * 应用级签到状态：只在登录后的外壳里挂载一次，顶栏、菜单和个人资料页共用。
 * 跨日（服务端 nextResetAt）自动刷新；领取期间及领取后，旧的读取响应不会覆盖结果。
 */
export function useDailyCheckIn(account: string, onQuotaChange?: (quota: number) => void): DailyCheckInControl {
  const [status, setStatus] = useState<DailyCheckInStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creditedCount, setCreditedCount] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const claiming = useRef(false);
  const revision = useRef(0);
  const statusRef = useRef<DailyCheckInStatus | null>(null);
  const quotaRef = useRef(onQuotaChange);
  quotaRef.current = onQuotaChange;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loadedAt = 0;
    async function load() {
      if (claiming.current) return;
      const requestRevision = ++revision.current;
      try {
        const result = await apiClient.getDailyCheckIn(controller.signal);
        if (controller.signal.aborted || requestRevision !== revision.current) return;
        loadedAt = Date.now();
        statusRef.current = result;
        setStatus(result); setError("");
        quotaRef.current?.(result.remainingQuota);
        clearTimeout(timer);
        timer = setTimeout(() => void load(), Math.min(24 * 60 * 60 * 1000, Math.max(1000, Date.parse(result.nextResetAt) - Date.now() + 1000)));
      } catch (cause) {
        if (!controller.signal.aborted && requestRevision === revision.current) setError(cause instanceof Error ? cause.message : "签到状态加载失败，请重试");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    const onFocus = () => {
      if (claiming.current) return;
      const current = statusRef.current;
      const crossedReset = current ? Date.now() >= Date.parse(current.nextResetAt) : true;
      if (crossedReset || Date.now() - loadedAt >= FOCUS_REFRESH_MS) void load();
    };
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("focus", onFocus); };
  }, [account, reloadKey]);

  // 切换账户时清空上一账户的状态。
  useEffect(() => {
    statusRef.current = null;
    setStatus(null); setNotice(""); setError(""); setLoading(true);
  }, [account]);

  const claim = useCallback(() => {
    const current = statusRef.current;
    if (claiming.current || !current || current.checkedIn) return;
    claiming.current = true; ++revision.current;
    setBusy(true); setError(""); setNotice("");
    void (async () => {
      try {
        const result = await apiClient.claimDailyCheckIn();
        statusRef.current = result;
        setStatus(result);
        quotaRef.current?.(result.remainingQuota);
        if (result.credited) setCreditedCount(count => count + 1);
        setNotice(result.credited ? `已领取 ${result.reward} 积分` : "今日已签到，明天再来");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "签到未完成，请重试");
      } finally { claiming.current = false; setBusy(false); }
    })();
  }, []);

  const reload = useCallback(() => { setLoading(true); setError(""); setReloadKey(key => key + 1); }, []);

  const phase: DailyCheckInPhase = busy ? "claiming" : status ? (status.checkedIn ? "claimed" : "available") : loading ? "loading" : "error";
  return { phase, reward: status?.reward ?? null, notice, error, creditedCount, claim, reload };
}
