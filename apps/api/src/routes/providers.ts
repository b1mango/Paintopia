import {
  normalizeImageProviderConfig,
  normalizeTextProviderConfig,
  type ImageProviderConfig,
  type TextProviderConfig
} from "@paintopia/shared";
import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import * as repo from "../db/repository.js";
import { callTextProvider } from "../providers/textProvider.js";
import type { ServerContext } from "../server/context.js";
import { invalidateImageCapabilities } from "../services/imageCapabilities.js";
import { clearImageProviderHealthForIds } from "../services/imageGeneration.js";
import { decryptProviderRecord, fetchProviderModels, listProviders, maskProvider, nextProviderSortOrderForConfig, queryProviderQuota, testImageProviderConnectivity } from "../services/providerConfig.js";
import { summarizeGenerationStats, summarizeTextToolStats, summarizeUserStats } from "../services/users.js";
import { AuthedRequest } from "./authHelpers.js";
import { idParamSchema, providerModelsSchema, providerOrderSchema, providerSchema, providerTestSchema, providerUpdateSchema } from "./schemas.js";

export function registerProvidersRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, secrets: providerSecrets, imageProviderHealth } = ctx;
  app.get("/api/admin/providers", { preHandler: ctx.requireAdmin }, async () => {
    return (await listProviders(appDb, providerSecrets)).map(maskProvider);
  });

  app.get("/api/admin/providers/quotas", { preHandler: ctx.requireAdmin }, async () => {
    const providers = (await listProviders(appDb, providerSecrets))
      .filter((provider) => provider.kind === "image");
    return Promise.all(providers.map(queryProviderQuota));
  });

  app.get("/api/admin/generation-stats", { preHandler: ctx.requireAdmin }, async () => {
    return {
      ...await summarizeGenerationStats(appDb),
      textStats: await summarizeTextToolStats(appDb),
      userStats: await summarizeUserStats(appDb)
    };
  });

  app.post("/api/admin/providers/models", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const body = providerModelsSchema.parse(request.body);
    const storedRecord = body.providerId ? await repo.findProvider(appDb, body.providerId) : undefined;
    const stored = storedRecord ? decryptProviderRecord(storedRecord, providerSecrets) : undefined;
    const apiKey = body.apiKey.trim() || stored?.apiKey || "";
    if (!apiKey) {
      return reply.code(400).send({ error: "请先填写或保存 API Key 后再获取模型" });
    }
    try {
      return { models: await fetchProviderModels(body.baseUrl, apiKey) };
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : "Failed to fetch provider models"
      });
    }
  });

  app.patch("/api/admin/providers/order", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const body = providerOrderSchema.parse(request.body);
    const uniqueProviderIds = Array.from(new Set(body.providerIds));
    if (uniqueProviderIds.length !== body.providerIds.length) {
      return reply.code(400).send({ error: "Provider order contains duplicate ids" });
    }

    const providersById = new Map((await repo.listProviders(appDb)).map((provider) => [provider.id, provider]));
    const invalidId = uniqueProviderIds.find((id) => providersById.get(id)?.kind !== body.kind);
    if (invalidId) {
      return reply.code(400).send({ error: "Provider order contains an unknown provider id" });
    }

    await repo.reorderProviders(appDb, uniqueProviderIds);
    invalidateImageCapabilities(appDb);
    clearImageProviderHealthForIds(imageProviderHealth, body.kind === "image" ? uniqueProviderIds : []);

    return (await listProviders(appDb, providerSecrets))
      .filter((provider) => provider.kind === body.kind)
      .map(maskProvider);
  });

  app.post("/api/admin/providers/test", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const body = providerTestSchema.parse(request.body);
    const storedRecord = body.providerId ? await repo.findProvider(appDb, body.providerId) : undefined;
    const stored = storedRecord ? decryptProviderRecord(storedRecord, providerSecrets) : undefined;
    const apiKey = body.apiKey?.trim() || stored?.apiKey || "";
    if (!apiKey) {
      return reply.code(400).send({ error: "请先填写或保存 API Key 后再测试连接" });
    }
    const startedAt = Date.now();
    try {
      if (body.kind === "image") {
        const provider = normalizeImageProviderConfig({
          id: "connectivity-test",
          name: body.name,
          baseUrl: body.baseUrl,
          apiKey,
          model: body.model,
          mode: body.mode as ImageProviderConfig["mode"],
          maxConcurrency: body.maxConcurrency ?? 1
        });
        await testImageProviderConnectivity(provider);
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          status: "connected",
          message: "OK"
        };
      }

      const provider = normalizeTextProviderConfig({
        id: "connectivity-test",
        name: body.name,
        baseUrl: body.baseUrl,
        apiKey,
        model: body.model,
        mode: body.mode as TextProviderConfig["mode"]
      });
      const result = await callTextProvider(provider, {
        systemPrompt: "Reply with OK only.",
        userPrompt: body.prompt ?? "OK"
      });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        status: "connected",
        totalTokens: result.usage.totalTokens,
        message: result.text || "OK"
      };
    } catch (error) {
      return reply.code(502).send({
        ok: false,
        latencyMs: Date.now() - startedAt,
        status: "failed",
        message: error instanceof Error ? error.message : "Provider connectivity test failed"
      });
    }
  });

  app.post("/api/admin/providers", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const parsed = providerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "无效渠道配置", details: parsed.error.issues });
    const body = parsed.data;
    const now = new Date();
    const providerId = nanoid();
    const normalized = body.kind === "image"
      ? normalizeImageProviderConfig({
        id: providerId,
        name: body.name,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        model: body.model,
        mode: body.mode as ImageProviderConfig["mode"],
        maxConcurrency: body.maxConcurrency ?? 1
      })
      : normalizeTextProviderConfig({
        id: providerId,
        name: body.name,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        model: body.model,
        mode: body.mode as TextProviderConfig["mode"]
      });

    const providerRecord: repo.ProviderRecord = {
      id: providerId,
      kind: body.kind,
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      apiKey: providerSecrets.encrypt(normalized.apiKey),
      model: normalized.model,
      mode: normalized.mode,
      maxConcurrency: body.kind === "image" ? (normalized as ImageProviderConfig).maxConcurrency : 1,
      imageCapabilities: body.imageCapabilities,
      enabled: body.enabled ?? true,
      sortOrder: await nextProviderSortOrderForConfig(appDb, {
        kind: body.kind,
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        model: normalized.model
      }),
      createdAt: now,
      updatedAt: now
    };
    await repo.insertProvider(appDb, providerRecord);
    invalidateImageCapabilities(appDb);
    await repo.writeAuditLog(appDb, {
      actorUserId: (request as AuthedRequest).user.id,
      action: "provider.create",
      targetType: "provider",
      targetId: providerId
    });

    clearImageProviderHealthForIds(imageProviderHealth, body.kind === "image" ? [providerId] : []);
    return reply.code(201).send(maskProvider(decryptProviderRecord(providerRecord, providerSecrets)));
  });

  app.patch("/api/admin/providers/:id", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const existingRecord = await repo.findProvider(appDb, params.id);
    const existing = existingRecord ? decryptProviderRecord(existingRecord, providerSecrets) : undefined;

    const parsed = providerUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "无效渠道配置", details: parsed.error.issues });
    const body = parsed.data;
    const apiKey = body.apiKey?.trim() || existing?.apiKey || "";
    const normalized = body.kind === "image"
      ? normalizeImageProviderConfig({
        id: params.id,
        name: body.name,
        baseUrl: body.baseUrl,
        apiKey,
        model: body.model,
        mode: body.mode as ImageProviderConfig["mode"],
        maxConcurrency: body.maxConcurrency ?? existing?.maxConcurrency ?? 1
      })
      : normalizeTextProviderConfig({
        id: params.id,
        name: body.name,
        baseUrl: body.baseUrl,
        apiKey,
        model: body.model,
        mode: body.mode as TextProviderConfig["mode"]
      });

    if (!existing) {
      const now = new Date();
      const providerRecord: repo.ProviderRecord = {
        id: params.id,
        kind: body.kind,
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        apiKey: providerSecrets.encrypt(normalized.apiKey),
        model: normalized.model,
        mode: normalized.mode,
        maxConcurrency: body.kind === "image" ? (normalized as ImageProviderConfig).maxConcurrency : 1,
        imageCapabilities: body.imageCapabilities,
        enabled: body.enabled ?? true,
        sortOrder: await nextProviderSortOrderForConfig(appDb, {
          kind: body.kind,
          name: normalized.name,
          baseUrl: normalized.baseUrl,
          model: normalized.model
        }),
        createdAt: now,
        updatedAt: now
      };
      await repo.insertProvider(appDb, providerRecord);
      invalidateImageCapabilities(appDb);

      clearImageProviderHealthForIds(imageProviderHealth, body.kind === "image" ? [params.id] : []);
      return reply.code(201).send(maskProvider(decryptProviderRecord(providerRecord, providerSecrets)));
    }

    const updatedRecord: repo.ProviderRecord = {
      ...existing,
      kind: body.kind,
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      apiKey: providerSecrets.encrypt(normalized.apiKey),
      model: normalized.model,
      mode: normalized.mode,
      maxConcurrency: body.kind === "image" ? (normalized as ImageProviderConfig).maxConcurrency : 1,
      imageCapabilities: body.imageCapabilities ?? existing.imageCapabilities,
      enabled: body.enabled ?? existing.enabled,
      updatedAt: new Date()
    };
    await repo.updateProvider(appDb, updatedRecord);
    invalidateImageCapabilities(appDb);
    await repo.writeAuditLog(appDb, {
      actorUserId: (request as AuthedRequest).user.id,
      action: "provider.update",
      targetType: "provider",
      targetId: params.id
    });

    clearImageProviderHealthForIds(imageProviderHealth, body.kind === "image" ? [params.id] : []);
    return maskProvider(decryptProviderRecord(updatedRecord, providerSecrets));
  });

  app.delete("/api/admin/providers/:id", { preHandler: ctx.requireAdmin }, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const existing = await repo.findProvider(appDb, params.id);
    if (!existing) {
      return reply.code(404).send({ error: "接口配置不存在" });
    }

    await repo.deleteProvider(appDb, params.id);
    invalidateImageCapabilities(appDb);
    await repo.writeAuditLog(appDb, {
      actorUserId: (request as AuthedRequest).user.id,
      action: "provider.delete",
      targetType: "provider",
      targetId: params.id
    });

    clearImageProviderHealthForIds(imageProviderHealth, existing.kind === "image" ? [params.id] : []);
    return reply.code(204).send();
  });
}
