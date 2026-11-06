import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { DatabaseExecutor, DatabaseValue } from "../db/database.js";
import { consumeRateLimit, writeAuditLog } from "../db/repository.js";
import type { ServerContext } from "../server/context.js";
import { personalAssetExpiry, personalAssetKey } from "../services/assetRetention.js";
import { invalidateImageCapabilities } from "../services/imageCapabilities.js";
import { createImageThumbnail } from "../services/imageThumbnail.js";
type AuthedRequest = FastifyRequest & { user: { id: string } };
type ExistingContent = { id: string; user_id: string; prompt: string };
type ExistingProvider = { id: string; kind: string; name: string; base_url: string };

const id = z.string().regex(/^[\w-]{1,80}$/);
const params = z.record(z.string(), z.unknown());
const stamp = z.number().int().nonnegative();
const manifest = z.object({ version: z.literal(1), providers: z.array(z.object({ id, kind: z.enum(["image", "text"]), name: z.string().min(1).max(120), base_url: z.string().url(), api_key: z.string().min(1).max(2000), model: z.string().min(1).max(4000), mode: z.enum(["generations", "edits", "responses", "chat_completions"]), max_concurrency: z.number().int().min(1).max(100), enabled: z.number().int().min(0).max(1), sort_order: z.number().int(), config_json: z.string().max(10000), created_at: stamp, updated_at: stamp })).max(100), jobs: z.array(z.object({ id, provider_id: id.nullable(), status: z.enum(["succeeded", "failed"]), prompt: z.string().max(100000), params_json: z.string().max(200000), error: z.string().max(20000).nullable(), created_at: stamp, updated_at: stamp })).max(1000), assets: z.array(z.object({ id, job_id: id.nullable(), prompt: z.string().max(100000), params: params, created_at: stamp, base64: z.string().max(45000000) })).max(100) });
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function registerAdminImportRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db, storage, secrets: codec, requireAdmin: guard, assetRetention: retention } = ctx;
  const secret = ctx.config.sessionSecret;
  const invalidateCapabilities = () => invalidateImageCapabilities(db);
  const sign = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
  const fail = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  const actor = (request: FastifyRequest) => String((request as AuthedRequest).user.id);
  app.post("/api/admin/import/upload", { preHandler: guard }, async (request, reply) => {
    if (!await consumeRateLimit(db, `import:${actor(request)}`, 10, 3600000)) return reply.code(429).send({ error: "导入过于频繁" });
    const body = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(1).max(64 * 1024 * 1024) }).parse(request.body);
    const key = `temporary/${actor(request)}/import-${body.sha256}.json`;
    const payload = Buffer.from(JSON.stringify({ key, actor: actor(request), hash: body.sha256, size: body.size, expires: Date.now() + 3600000 })).toString("base64url");
    const url = await storage.createUploadUrl(key, "application/json", 3600);
    if (!url) return reply.code(409).send({ error: "数据导入需要私有 R2 存储" });
    return { url, ticket: payload + "." + sign(payload) };
  });
  app.post("/api/admin/import/review", { preHandler: guard }, async (request) => run(request, false));
  app.post("/api/admin/import/apply", { preHandler: guard }, async (request) => run(request, true));
  async function run(request: FastifyRequest, apply: boolean) {
    if (!await consumeRateLimit(db, `import-run:${actor(request)}`, 30, 3600000)) throw Object.assign(new Error("导入过于频繁"), { statusCode: 429 });
    const { ticket } = z.object({ ticket: z.string().max(3000) }).parse(request.body);
    const [payload, sig] = ticket.split("."); const expected = sign(payload ?? "");
    if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw fail("导入凭证无效");
    const token = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (token.actor !== actor(request) || token.expires < Date.now()) throw fail("导入凭证已过期或不属于当前管理员");
    const info = await storage.head(token.key);
    if (!info || info.sizeBytes !== token.size || info.sizeBytes > 64 * 1024 * 1024) throw fail("导入文件大小不匹配");
    const bytes = await storage.read(token.key); if (hash(bytes) !== token.hash) throw fail("导入文件校验失败");
    const data = manifest.parse(JSON.parse(bytes.toString()));
    for (const rows of [data.providers, data.jobs, data.assets]) if (new Set(rows.map(r => r.id)).size !== rows.length) throw fail("文件包含重复 ID");
    for (const p of data.providers) { if (p.api_key.startsWith("enc:") || p.api_key.includes("****")) throw fail("导入接口须包含有效原始密钥"); JSON.parse(p.config_json); }
    for (const j of data.jobs) JSON.parse(j.params_json);
    const providers = await db.query<ExistingProvider>("SELECT * FROM provider_configs");
    const jobs = await db.query<ExistingContent>("SELECT id,user_id,prompt FROM generation_jobs");
    const assets = await db.query<ExistingContent>("SELECT id,user_id,prompt FROM assets");
    const mapping = new Map<string, string>();
    for (const p of data.providers) { const exact = providers.find(r => r.id === p.id); const match = exact ? [exact] : providers.filter(r => r.kind === p.kind && r.name === p.name && r.base_url === p.base_url); if (match.length > 1) throw fail("接口匹配不唯一：" + p.name); mapping.set(p.id, match[0]?.id ?? p.id); }
    if (new Set(mapping.values()).size !== mapping.size) throw fail("多个接口映射到同一记录");
    for (const [incoming, existing] of [[data.jobs, jobs], [data.assets, assets]] as const) { for (const item of incoming) { const old = existing.find((r: ExistingContent) => r.id === item.id); if (old && (old.user_id !== actor(request) || old.prompt !== item.prompt)) throw fail("同 ID 记录冲突，未执行导入"); } }
    const newJobs = data.jobs.filter(j => !jobs.some(r => r.id === j.id));
    const newAssets = data.assets.filter(a => !assets.some(r => r.id === a.id));
    for (const a of newAssets) if (a.job_id && !newJobs.some(j => j.id === a.job_id) && !jobs.some(j => j.id === a.job_id && j.user_id === actor(request))) throw fail("图片缺少所属创作记录");
    const result = { providers: data.providers.length, jobs: newJobs.length, assets: newAssets.length, skippedAssets: data.assets.length - newAssets.length };
    if (!apply) return result;
    const backup = `temporary/${actor(request)}/import-backup-${token.hash}-${Date.now()}.json`;
    await storage.put(backup, Buffer.from(JSON.stringify({ providers, importedIds: { jobs: newJobs.map(j => j.id), assets: newAssets.map(a => a.id) } })), "application/json");
    const prepared: Record<string, DatabaseValue>[] = [];
    for (const a of newAssets) {
      const image = Buffer.from(a.base64, "base64"); if (image.length > 32 * 1024 * 1024) throw fail("单张图片超过32MB"); const meta = await sharp(image, { limitInputPixels: 100000000 }).metadata(); if (!["png", "jpeg", "webp"].includes(meta.format ?? "")) throw fail("不支持的图片格式"); const key = personalAssetKey(retention, actor(request), `import-${token.hash}-${a.id}`, `image/${meta.format}`);
      const old = await storage.head(key); if (old) { if (hash(await storage.read(key)) !== hash(image)) throw fail("图片对象冲突"); } else { await storage.put(key, image, `image/${meta.format}`); if (hash(await storage.read(key)) !== hash(image)) throw fail("图片上传校验失败"); }
      const thumbPath = `thumbnails/${a.id}.webp`; const thumb = await createImageThumbnail(image); await storage.put(thumbPath, thumb, "image/webp"); await storage.put(`thumbnails/${a.id}-320.webp`, await createImageThumbnail(thumb, 320), "image/webp");
      prepared.push({ id: a.id, user_id: actor(request), job_id: a.job_id, original_path: key, thumb_path: thumbPath, storage_backend: storage.backend, mime_type: `image/${meta.format}`, size_bytes: image.length, status: "ready", expires_at: personalAssetExpiry(retention, actor(request), new Date())?.getTime() ?? null, prompt: a.prompt, params_json: JSON.stringify({ ...a.params, actualWidth: meta.width, actualHeight: meta.height }), created_at: a.created_at });
    }
    await db.transaction(async tx => {
      // Serialize imports, so retries cannot create duplicate records or race configuration writes.
      if (db.dialect === "postgres") await tx.query("SELECT pg_advisory_xact_lock(73491821)");
      for (const a of prepared) { const old = await tx.queryOne<ExistingContent>("SELECT user_id,prompt FROM assets WHERE id=?", [a.id]); if (old && (old.user_id !== actor(request) || old.prompt !== a.prompt)) throw fail("图片 ID 冲突"); }
      for (const j of newJobs) { const old = await tx.queryOne<ExistingContent>("SELECT user_id,prompt FROM generation_jobs WHERE id=?", [j.id]); if (old && (old.user_id !== actor(request) || old.prompt !== j.prompt)) throw fail("记录 ID 冲突"); }
      for (const p of data.providers) await insert(tx, "provider_configs", { ...p, id: mapping.get(p.id)!, api_key: codec.encrypt(p.api_key) }, true);
      for (const j of newJobs) await insert(tx, "generation_jobs", { ...j, user_id: actor(request), provider_id: mapping.get(j.provider_id ?? "") ?? null });
      for (const a of prepared) await insert(tx, "assets", a);
    });
    invalidateCapabilities();
    await writeAuditLog(db, { actorUserId: actor(request), action: "admin.import", targetType: "import", targetId: token.hash });
    // No user, balance, quota reservation, session or ledger writes.
    return { ...result, completed: true };
  }
}
async function insert(tx: DatabaseExecutor, table: string, row: Record<string, DatabaseValue>, update = false) { const columns = Object.keys(row); await tx.execute(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(id) ${update ? "DO UPDATE SET " + columns.filter(c => c !== "id" && c !== "created_at").map(c => c + "=excluded." + c).join(",") : "DO NOTHING"}`, columns.map(c => row[c])); }
