import { DAILY_CHECK_IN_REWARD, DAILY_CHECK_IN_TIME_ZONE, type DailyCheckInStatus } from "@paintopia/shared";
import type { AppDatabase, DatabaseExecutor } from "../db/database.js";
import { getQuota } from "../db/repository.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

function checkInDay(now: number) {
  const dayIndex = Math.floor((now + UTC_OFFSET_MS) / DAY_MS);
  return {
    day: new Date(dayIndex * DAY_MS).toISOString().slice(0, 10),
    nextResetAt: new Date((dayIndex + 1) * DAY_MS - UTC_OFFSET_MS).toISOString()
  };
}

export function createDailyCheckInService(db: AppDatabase, now = Date.now) {
  function period(userId: string) {
    const current = checkInDay(now());
    return { ...current, id: `daily-check-in:${userId}:${current.day}` };
  }
  async function status(tx: DatabaseExecutor, userId: string, current: ReturnType<typeof period>): Promise<DailyCheckInStatus> {
    const record = await tx.queryOne<{ id: string }>(
      "SELECT id FROM usage_ledger WHERE id = ? AND user_id = ? AND action = 'daily_check_in'", [current.id, userId]
    );
    return {
      day: current.day, nextResetAt: current.nextResetAt, timeZone: DAILY_CHECK_IN_TIME_ZONE,
      reward: DAILY_CHECK_IN_REWARD, checkedIn: Boolean(record), remainingQuota: await getQuota(tx, userId)
    };
  }
  return {
    status: (userId: string) => status(db, userId, period(userId)),
    claim: (userId: string) => db.transaction(async tx => {
      const current = period(userId);
      const timestamp = now();
      const inserted = await tx.execute(`INSERT INTO usage_ledger (id, user_id, action, amount, note, created_at)
        VALUES (?, ?, 'daily_check_in', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [current.id, userId, DAILY_CHECK_IN_REWARD, JSON.stringify({ day: current.day, timeZone: DAILY_CHECK_IN_TIME_ZONE }), timestamp]);
      if (inserted === 1) {
        const changed = await tx.execute("UPDATE users SET quota = quota + ?, updated_at = ? WHERE id = ? AND status = 'active'",
          [DAILY_CHECK_IN_REWARD, timestamp, userId]);
        if (changed !== 1) throw new Error("签到账户不可用");
      }
      return { ...await status(tx, userId, current), credited: inserted === 1 };
    })
  };
}
