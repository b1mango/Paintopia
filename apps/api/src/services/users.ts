import { nanoid } from "nanoid";
import { type AppDatabase } from "../db/database.js";
import * as repo from "../db/repository.js";

import {
  type UserRecord
} from "../services/authService.js";

export function serializeUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    quota: user.quota
  };
}

export function serializeAdminUser(user: UserRecord | undefined) {
  if (!user) {
    return user;
  }
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    quota: user.quota,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

export async function summarizeGenerationStats(appDb: AppDatabase, userId?: string) {
  const jobs = (await repo.listGenerationJobs(appDb))
    .filter((job) => !userId || job.userId === userId);
  const succeeded = jobs.filter((job) => job.status === "succeeded");
  const failed = jobs.filter((job) => job.status === "failed");
  const queued = jobs.filter((job) => job.status === "queued").length;
  const running = jobs.filter((job) => job.status === "running").length;
  const completed = succeeded.length + failed.length;
  const successfulDurations = succeeded
    .map((job) => Math.max(0, job.updatedAt.getTime() - job.createdAt.getTime()));
  const averageDurationMs = successfulDurations.length
    ? Math.round(successfulDurations.reduce((sum, duration) => sum + duration, 0) / successfulDurations.length)
    : 0;

  return {
    total: jobs.length,
    completed,
    succeeded: succeeded.length,
    failed: failed.length,
    running,
    queued,
    successRate: completed ? Math.round((succeeded.length / completed) * 1000) / 10 : 0,
    averageDurationMs
  };
}

export async function summarizeTextToolStats(appDb: AppDatabase) {
  const runs = await repo.listTextToolRuns(appDb);
  const providers = new Map(
    (await repo.listProviders(appDb)).map((provider) => [provider.id, provider.name])
  );

  return {
    ...summarizeTextRuns(runs),
    byProvider: summarizeTextRunGroups(
      runs,
      (run) => run.providerId ?? "unconfigured",
      (run) => ({
        providerId: run.providerId,
        providerName: run.providerId ? providers.get(run.providerId) ?? "已删除接口" : "未配置接口"
      })
    ).sort((left, right) => right.totalRuns - left.totalRuns || left.providerName.localeCompare(right.providerName)),
    byType: summarizeTextRunGroups(
      runs,
      (run) => run.type,
      (run) => ({ type: run.type })
    ).sort((left, right) => left.type.localeCompare(right.type))
  };
}

function summarizeTextRunGroups<T extends Record<string, unknown>>(
  runs: repo.TextToolRunRecord[],
  keyForRun: (run: repo.TextToolRunRecord) => string,
  metaForRun: (run: repo.TextToolRunRecord) => T
) {
  const groups = new Map<string, { meta: T; runs: repo.TextToolRunRecord[] }>();
  for (const run of runs) {
    const key = keyForRun(run);
    const existing = groups.get(key);
    if (existing) {
      existing.runs.push(run);
    } else {
      groups.set(key, { meta: metaForRun(run), runs: [run] });
    }
  }
  return Array.from(groups.values()).map((group) => ({
    ...group.meta,
    ...summarizeTextRuns(group.runs)
  }));
}

function summarizeTextRuns(runs: repo.TextToolRunRecord[]) {
  const succeeded = runs.filter((run) => run.status === "succeeded");
  const failed = runs.filter((run) => run.status === "failed");
  const averageDurationMs = succeeded.length
    ? Math.round(succeeded.reduce((sum, run) => sum + Math.max(0, run.durationMs), 0) / succeeded.length)
    : 0;

  return {
    totalRuns: runs.length,
    succeeded: succeeded.length,
    failed: failed.length,
    successRate: runs.length ? Math.round((succeeded.length / runs.length) * 1000) / 10 : 0,
    promptTokens: runs.reduce((sum, run) => sum + run.promptTokens, 0),
    completionTokens: runs.reduce((sum, run) => sum + run.completionTokens, 0),
    totalTokens: runs.reduce((sum, run) => sum + run.totalTokens, 0),
    averageDurationMs
  };
}

export async function summarizeUserStats(appDb: AppDatabase) {
  const users = await repo.listUsers(appDb);
  return {
    total: users.length,
    active: users.filter((user) => user.status === "active").length,
    disabled: users.filter((user) => user.status === "disabled").length,
    admins: users.filter((user) => user.role === "admin").length,
    regularUsers: users.filter((user) => user.role === "user").length
  };
}

export async function listAdminUsers(appDb: AppDatabase, query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  return (await repo.listUsers(appDb))
    .map(serializeAdminUser)
    .filter((user): user is NonNullable<ReturnType<typeof serializeAdminUser>> => Boolean(user))
    .filter((user) => {
      if (!normalizedQuery) {
        return true;
      }
      return [
        user.email,
        user.role,
        user.status,
        String(user.quota)
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => left.email.localeCompare(right.email));
}

export async function listInviteCodes(appDb: AppDatabase, query: { q?: string; status?: "all" | "active" | "used" | "destroyed" } = {}) {
  const normalizedQuery = (query.q ?? "").trim().toLowerCase();
  const status = query.status ?? "all";
  const serialized = await Promise.all((await repo.listInvites(appDb))
    .map((invite) => serializeInviteCode(appDb, invite)));
  return serialized
    .filter((invite): invite is NonNullable<Awaited<ReturnType<typeof serializeInviteCode>>> => Boolean(invite))
    .filter((invite) => status === "all" || invite.status === status)
    .filter((invite) => {
      if (!normalizedQuery) {
        return true;
      }
      return [
        invite.code,
        invite.status,
        invite.createdByEmail ?? "",
        invite.usedByEmail ?? ""
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export async function serializeInviteCode(
  appDb: AppDatabase,
  invite: repo.InviteRecord | undefined
) {
  if (!invite) {
    return undefined;
  }
  return {
    id: invite.id,
    code: invite.code,
    status: invite.status,
    createdByEmail: await getUserEmailById(appDb, invite.createdBy),
    usedByEmail: await getUserEmailById(appDb, invite.usedBy),
    createdAt: invite.createdAt.toISOString(),
    usedAt: invite.usedAt?.toISOString() ?? null,
    destroyedAt: invite.destroyedAt?.toISOString() ?? null
  };
}

export async function getUserEmailById(appDb: AppDatabase, userId: string | null) {
  if (!userId) {
    return null;
  }
  return (await repo.findUserById(appDb, userId))?.email ?? null;
}

export function createInviteCodeValue() {
  return `PT-${nanoid(INVITE_CODE_RANDOM_LENGTH)}`;
}

const INVITE_CODE_RANDOM_LENGTH = 32;
