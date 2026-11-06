import { CalendarCheck, Check, LoaderCircle, RotateCcw } from "lucide-react";
import { DAILY_CHECK_IN_REWARD } from "@paintopia/shared";
import type { DailyCheckInControl } from "./useDailyCheckIn";
import styles from "./DailyCheckIn.module.css";

/** 个人资料「剩余额度」行内的签到按钮；状态由应用外壳统一提供。 */
export function DailyCheckIn({ checkIn }: { checkIn: DailyCheckInControl }) {
  const { phase, error, notice, claim, reload } = checkIn;
  const reward = checkIn.reward ?? DAILY_CHECK_IN_REWARD;
  const failedToLoad = phase === "error";
  const feedback = error || notice;
  return <span className={styles.checkIn}>
    {failedToLoad
      ? <button type="button" className={styles.claim} onClick={reload}><RotateCcw size={14} aria-hidden="true" />重新加载签到</button>
      : <button type="button" className={styles.claim} data-claimed={phase === "claimed" || undefined}
        disabled={phase !== "available"} aria-busy={phase === "claiming"} onClick={claim}>
        {phase === "loading" || phase === "claiming" ? <LoaderCircle size={14} className={styles.spinner} aria-hidden="true" />
          : phase === "claimed" ? <Check size={14} aria-hidden="true" /> : <CalendarCheck size={14} aria-hidden="true" />}
        {phase === "loading" ? "读取中…" : phase === "claiming" ? "领取中…" : phase === "claimed" ? "今日已签" : `签到 +${reward}`}
      </button>}
    <span className={styles.feedback} data-error={Boolean(error) || undefined} role={error ? "alert" : "status"} aria-live="polite">{feedback}</span>
  </span>;
}
