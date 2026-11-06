export const INITIAL_USER_QUOTA = 66;
export const DAILY_CHECK_IN_REWARD = 5;
export const DAILY_CHECK_IN_TIME_ZONE = "Asia/Shanghai";

export type DailyCheckInStatus = {
  day: string;
  timeZone: string;
  reward: number;
  checkedIn: boolean;
  nextResetAt: string;
  remainingQuota: number;
};

export type DailyCheckInResult = DailyCheckInStatus & { credited: boolean };
