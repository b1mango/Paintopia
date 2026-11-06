import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { createAppDatabase } from "./db/database.js";
import { registerAdminImportRoutes } from "./routes/adminImport.js";
import { registerAdminUsersRoutes } from "./routes/adminUsers.js";
import { registerAssetsRoutes } from "./routes/assets.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { requireAdmin, requireAuth } from "./routes/authHelpers.js";
import { registerCapabilitiesRoutes } from "./routes/capabilities.js";
import { registerCuratedPromptRoutes } from "./routes/curatedPrompts.js";
import { registerDailyCheckInRoutes } from "./routes/dailyCheckIn.js";
import { registerGalleryRoutes } from "./routes/gallery.js";
import { registerGenerationRoutes } from "./routes/generation.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { MAX_EDIT_REFERENCE_IMAGES, MAX_EDIT_REFERENCE_IMAGE_BYTES } from "./routes/imageEditInput.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerMediaFeed } from "./routes/mediaFeed.js";
import { registerPreferencesRoutes } from "./routes/preferences.js";
import { registerPromptSourceRoutes } from "./routes/promptSources.js";
import { registerPromptsRoutes } from "./routes/prompts.js";
import { registerProvidersRoutes } from "./routes/providers.js";
import { registerQuotaRoutes } from "./routes/quota.js";
import { registerTemplatesRoutes } from "./routes/templates.js";
import { registerThumbnailsRoutes } from "./routes/thumbnails.js";
import { bootstrapDefaultPromptTemplates, bootstrapDefaultTextProvider, bootstrapInviteCode, validateProductionConfig } from "./server/bootstrap.js";
import type { ServerContext } from "./server/context.js";
import type { CreateServerOptions } from "./server/options.js";
import { resolveAssetRetentionPolicy } from "./services/assetRetention.js";
import { createAssetStorage } from "./services/assetStorage.js";
import { copyAssetObject } from "./services/assets.js";
import { createContentSafetyMatcher } from "./services/contentSafety.js";
import type { ImageProviderHealth } from "./services/imageGeneration.js";
import { createProviderSecretCodec } from "./services/providerSecrets.js";
import { HttpRequestError } from "./services/requestError.js";
export type { CreateServerOptions } from "./server/options.js";

export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  validateProductionConfig(options);

  const providerSecrets = createProviderSecretCodec(options.providerEncryptionKey);

  const appDb = await createAppDatabase({
    dataDir: options.dataDir,
    databaseUrl: options.databaseUrl,
    bootstrapEmail: options.bootstrapEmail,
    bootstrapPassword: options.bootstrapPassword,
    initialize: async (database) => {
      const retention = await resolveAssetRetentionPolicy(database, options.ownerEmail ?? options.bootstrapEmail, options.assetRetentionDays ?? 7);
      await bootstrapDefaultTextProvider(database, providerSecrets, options.defaultTextProvider);
      await bootstrapInviteCode(database, options.inviteCode ?? "");
      await bootstrapDefaultPromptTemplates(database);
      return { owner_user_id: retention.ownerUserId ?? "" };
    }
  });

  const assetStorage = createAssetStorage(options.dataDir, options.r2);

  const assetRetention = { ownerUserId: appDb.startupMetadata.owner_user_id || null, days: options.assetRetentionDays ?? 7 };

  const imageProviderHealth = new Map<string, ImageProviderHealth>();

  const contentSafety = createContentSafetyMatcher(options.prohibitedTerms);

  const app = Fastify({
    logger: false,
    trustProxy: true
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "请求参数无效", details: error.issues.map(({ path, message, code }) => ({ path, message, code })) });
    }
    if (error instanceof HttpRequestError) return reply.code(error.statusCode).send({ error: error.message });
    // Preserve Fastify's normal status handling for other errors.
    return reply.send(error);
  });

  app.decorate("paintopiaDb", appDb);
  app.decorate("paintopiaStorage", assetStorage);

  app.addContentTypeParser(
    ["image/png", "image/jpeg", "image/webp"],
    { parseAs: "buffer", bodyLimit: MAX_EDIT_REFERENCE_IMAGE_BYTES },
    (_request, body, done) => done(null, body)
  );

  await app.register(cors, {
    origin: options.webOrigin,
    credentials: true
  });

  await app.register(cookie, {
    secret: options.sessionSecret
  });

  await app.register(multipart, {
    limits: {
      files: MAX_EDIT_REFERENCE_IMAGES,
      fileSize: MAX_EDIT_REFERENCE_IMAGE_BYTES,
      fields: 64
    }
  });

  app.addHook("onClose", async () => {
    await appDb.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-Request-Id", request.id);
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (options.production) {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
    if (!options.production || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (origin !== options.webOrigin) {
      return reply.code(403).send({ error: "请求来源不受信任" });
    }
  });

  const ctx: ServerContext = { db: appDb, storage: assetStorage, secrets: providerSecrets, config: options, assetRetention, imageProviderHealth, contentSafety, requireAuth: requireAuth(appDb), requireAdmin: requireAdmin(appDb) };
  registerMediaFeed(app, ctx.db, ctx.requireAuth);
  registerAdminImportRoutes(app, ctx);
  registerThumbnailsRoutes(app, ctx);
  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerHistoryRoutes(app, ctx);
  registerCapabilitiesRoutes(app, ctx);
  registerPreferencesRoutes(app, ctx);
  registerProvidersRoutes(app, ctx);
  registerTemplatesRoutes(app, ctx);
  registerQuotaRoutes(app, ctx);
  registerAdminUsersRoutes(app, ctx);
  registerPromptsRoutes(app, ctx);
  registerGenerationRoutes(app, ctx);
  registerAssetsRoutes(app, ctx);
  registerGalleryRoutes(app, ctx);
  registerInternalRoutes(app, ctx);
  registerCuratedPromptRoutes(app, {
    db: appDb, storage: assetStorage, requireAuth: ctx.requireAuth, requireAdmin: ctx.requireAdmin,
    copyAsset: (asset, key) => copyAssetObject(appDb, assetStorage, asset, key)
  });

  await registerPromptSourceRoutes(app, { db: appDb, requireAuth: ctx.requireAuth, cronSecret: options.cronSecret });

  registerDailyCheckInRoutes(app, ctx);

  return app;
}
