import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import postgres from "postgres";
import sharp from "sharp";
import { z } from "zod";
import type { DatabaseExecutor, DatabaseValue } from "../src/db/database.js";
import { createAssetStorage, type AssetStorage } from "../src/services/assetStorage.js";

type AssetRow = { id: string; original_path: string; storage_backend: string; params_json: string };

export async function backfillAssetDimensions(
  db: Pick<DatabaseExecutor, "query" | "execute">,
  storage: AssetStorage,
  options: { dataDir: string; concurrency: number; dryRun: boolean }
) {
  const summary = { scanned: 0, missing: 0, decoded: 0, updated: 0, failed: [] as string[] };
  let cursor = "";
  while (true) {
    const rows = await db.query<AssetRow>(
      "SELECT id, original_path, storage_backend, params_json FROM assets WHERE status = 'ready' AND id > ? ORDER BY id LIMIT 100", [cursor]
    );
    if (!rows.length) break;
    summary.scanned += rows.length;
    let next = 0;
    await Promise.all(Array.from({ length: options.concurrency }, async () => {
      while (next < rows.length) {
        const row = rows[next++];
        try {
          const params = JSON.parse(row.params_json);
          if (Number.isInteger(params.actualWidth) && params.actualWidth > 0 && Number.isInteger(params.actualHeight) && params.actualHeight > 0) continue;
          summary.missing++;
          let bytes: Buffer;
          if (row.storage_backend === "local" && path.isAbsolute(row.original_path)) {
            const relative = path.relative(path.resolve(options.dataDir), row.original_path);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Asset path escapes data directory");
            bytes = await readFile(row.original_path);
          } else {
            if (row.storage_backend !== storage.backend) throw new Error("Asset storage backend does not match");
            bytes = await storage.read(row.original_path);
          }
          const { width, height } = await sharp(bytes).metadata();
          if (!width || !height) throw new Error("Image dimensions unavailable");
          summary.decoded++;
          if (!options.dryRun) summary.updated += await db.execute(
            "UPDATE assets SET params_json = ? WHERE id = ? AND params_json = ?",
            [JSON.stringify({ ...params, actualWidth: width, actualHeight: height }), row.id, row.params_json]
          );
        } catch {
          summary.failed.push(row.id);
        }
      }
    }));
    cursor = rows.at(-1)!.id;
  }
  return summary;
}

async function main() {
  const { values } = parseArgs({ options: {
    "data-dir": { type: "string" }, postgres: { type: "boolean" }, r2: { type: "boolean" },
    "dry-run": { type: "boolean" }, concurrency: { type: "string", default: "2" }
  } });
  const concurrency = z.coerce.number().int().min(1).max(8).parse(values.concurrency);
  if (!values.postgres && !values["data-dir"]) throw new Error("Specify --data-dir for SQLite or --postgres for DATABASE_URL");
  const dataDir = path.resolve(values["data-dir"] ?? ".");
  const dryRun = values["dry-run"] ?? false;
  // Use injected environment only; never load .env or run application migrations/seeds.
  const databaseUrl = values.postgres ? z.string().min(1).parse(process.env.DATABASE_URL) : undefined;
  const r2 = values.r2 ? z.object({ accountId: z.string().min(1), accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), bucket: z.string().min(1) }).parse({
    accountId: process.env.PAINTOPIA_R2_ACCOUNT_ID, accessKeyId: process.env.PAINTOPIA_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.PAINTOPIA_R2_SECRET_ACCESS_KEY, bucket: process.env.PAINTOPIA_R2_BUCKET
  }) : undefined;
  const local = databaseUrl ? undefined : new Database(path.join(dataDir, "paintopia.sqlite"), { readonly: dryRun, fileMustExist: true });
  const remote = databaseUrl ? postgres(databaseUrl, { max: concurrency, prepare: false }) : undefined;
  const placeholder = (sql: string) => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };
  const db: Pick<DatabaseExecutor, "query" | "execute"> = {
    query: async <T>(sql: string, params: DatabaseValue[] = []) => remote
      ? await remote.unsafe(placeholder(sql), params as postgres.ParameterOrJSON<never>[]) as T[]
      : local!.prepare(sql).all(...params) as T[],
    execute: async (sql, params = []) => remote
      ? (await remote.unsafe(placeholder(sql), params as postgres.ParameterOrJSON<never>[])).count
      : local!.prepare(sql).run(...params).changes
  };
  try {
    const summary = await backfillAssetDimensions(db, createAssetStorage(dataDir, r2), { dataDir, concurrency, dryRun });
    process.stdout.write(JSON.stringify({ dryRun, ...summary }) + "\n");
    if (summary.failed.length) process.exitCode = 1;
  } finally {
    local?.close();
    await remote?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write("Width/height backfill failed; check arguments, injected configuration and storage access.\n"); process.exitCode = 1; });
}
