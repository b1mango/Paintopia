import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import postgres from "postgres";
import { loadConfig } from "../apps/api/src/config/env.js";
import { createAppDatabase } from "../apps/api/src/db/database.js";
import { findAsset, findGalleryByAsset } from "../apps/api/src/db/repository.js";
import { createAssetStorage } from "../apps/api/src/services/assetStorage.js";
import { preservePermanentAsset } from "../apps/api/src/services/assetRetention.js";

// Dry run does not initialize/migrate the application database or mutate object storage.
const config = loadConfig();
const apply = process.argv.includes("--apply");
const local = config.databaseUrl ? undefined : new Database(path.join(config.dataDir, "paintopia.sqlite"), { readonly: true });
const remote = config.databaseUrl ? postgres(config.databaseUrl, { max: 1, prepare: false }) : undefined;
const sql = `SELECT a.id, a.user_id, a.original_path, a.storage_backend, a.expires_at,
  g.id AS gallery_id, g.status AS gallery_status, g.object_key AS gallery_object_key
  FROM assets a JOIN users u ON u.id = a.user_id LEFT JOIN gallery_items g ON g.asset_id = a.id
  WHERE (u.email = ? OR g.status = 'approved') AND a.status = 'ready' ORDER BY a.id`;
const rows = remote
  ? await remote.unsafe(sql.replace("?", "$1"), [config.ownerEmail.trim().toLowerCase()])
  : local!.prepare(sql).all(config.ownerEmail.trim().toLowerCase()) as Record<string, unknown>[];
local?.close();
await remote?.end();

if (!apply) {
  process.stdout.write(JSON.stringify({ mode: "dry-run", assets: rows, count: rows.length }, null, 2) + "\n");
} else {
  // Record reversible database references before writing any image or pointer.
  const reportDir = path.join(config.dataDir, "logs");
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `asset-retention-before-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify({ createdAt: new Date().toISOString(), assets: rows }, null, 2), { flag: "wx", mode: 0o600 });
  const db = await createAppDatabase({ ...config, skipBootstrap: true });
  const storage = createAssetStorage(config.dataDir, config.r2);
  const results: { id: string; ok: boolean }[] = [];
  try {
    for (const row of rows) {
      const id = String(row.id);
      try {
        const asset = await findAsset(db, id);
        if (!asset) throw new Error("Asset no longer exists");
        const gallery = await findGalleryByAsset(db, id);
        // Refuse stale dry-run candidates whose gallery membership or ownership changed.
        const owner = await db.queryOne<{ email: string }>("SELECT email FROM users WHERE id = ?", [asset.userId]);
        if (owner?.email !== config.ownerEmail.trim().toLowerCase() && gallery?.status !== "approved") throw new Error("Retention eligibility changed");
        await preservePermanentAsset(db, storage, asset, gallery);
        results.push({ id, ok: true });
      } catch {
        // No original is removed, including failures or absent legacy objects.
        results.push({ id, ok: false });
      }
    }
  } finally {
    await db.close();
  }
  await writeFile(reportPath.replace("-before-", "-results-"), JSON.stringify({ results }, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(JSON.stringify({ mode: "apply", reportPath, preserved: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).map(row => row.id) }, null, 2) + "\n");
  if (results.some(row => !row.ok)) process.exitCode = 1;
}
