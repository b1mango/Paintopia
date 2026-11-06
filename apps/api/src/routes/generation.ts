import { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { PassThrough } from "node:stream";
import { z } from "zod";
import * as repo from "../db/repository.js";
import {
  type ImageGenerationPartial
} from "../providers/imageProvider.js";
import type { ServerContext } from "../server/context.js";
import { cleanupTransientReferenceAssets } from "../services/assets.js";
import {
  type UserRecord
} from "../services/authService.js";
import { imageResolutionFromModelId } from "../services/imageCapabilities.js";
import { filterImageProvidersByResolution, formatImageProviderFailures, generateImagesWithProvider, getImageProviders, ImageGenerationStage, imageOutputMetrics, ImageProviderRunError, ImageProviderRunMetrics, imageRequestModel, InsufficientQuotaError, markImageProviderHealthy, markImageProviderUnhealthy, normalizeImageRequestParams, persistGeneratedImages, shouldCooldownImageProviderError, summarizeFailedImageRuns, withImageRuntimeMetrics } from "../services/imageGeneration.js";
import { getRequestedImageCount, imageRequestResolution } from "../services/imageParams.js";
import { calculateImageGenerationQuotaCost, consumeImageGenerationQuota, getUserQuota } from "../services/quota.js";
import { HttpRequestError } from "../services/requestError.js";
import { allowUserAction, AuthedRequest } from "./authHelpers.js";
import { ImageEditRequestInput, parseImageEditRequest } from "./imageEditInput.js";
import { generationSchema, IMAGE_GENERATION_RATE_LIMIT } from "./schemas.js";

export function registerGenerationRoutes(app: FastifyInstance, ctx: ServerContext) {
  const { db: appDb, storage: assetStorage, secrets: providerSecrets, assetRetention, imageProviderHealth, contentSafety } = ctx;
  const executeImageGeneration = async (
    user: UserRecord,
    body: z.infer<typeof generationSchema>,
    onPartialImage?: (partial: ImageGenerationPartial) => void,
    onStage?: (event: ImageGenerationStage) => void
  ) => {
    const requestedResolution = imageRequestResolution(body.params);
    if (!requestedResolution) {
      return { statusCode: 400, payload: { error: "分辨率必须是 1K、2K、4K 或 auto" } };
    }
    try { body.params = normalizeImageRequestParams(body.params, requestedResolution); }
    catch (error) { return { statusCode: 400, payload: { error: error instanceof Error ? error.message : "无效图片参数" } }; }

    const now = new Date();
    const jobId = nanoid();
    const requestedModel = imageRequestModel(body.params);
    const modelResolution = requestedModel ? imageResolutionFromModelId(requestedModel) : null;
    if (modelResolution && modelResolution !== requestedResolution) {
      return { statusCode: 400, payload: { error: `模型 ${requestedModel} 指定 ${modelResolution}，请将分辨率设为 ${modelResolution}` } };
    }
    const providerSelection = await getImageProviders(appDb, providerSecrets, body.providerId, imageProviderHealth, ["generations", "responses", "chat_completions"], requestedModel, requestedResolution);
    const resolutionSelection = await filterImageProvidersByResolution(providerSelection.providers, requestedResolution);
    providerSelection.skipped.push(...resolutionSelection.skipped);
    const providers = resolutionSelection.providers;
    body.params = { ...body.params, providerId: providers[0]?.id ?? null, providerName: providers[0]?.name ?? null, model: providers[0]?.model ?? requestedModel };
    const quotaCost = await calculateImageGenerationQuotaCost(appDb, body.params);

    if (providerSelection.providers.length > 0 && providers.length === 0) {
      return { statusCode: 400, payload: { error: `当前接口没有已验证支持 ${requestedResolution} 的配置` } };
    }
    if (providers.length === 0) {
      await repo.insertGenerationJob(appDb, {
        id: jobId,
        userId: user.id,
        providerId: body.providerId ?? null,
        status: "failed",
        prompt: body.prompt,
        paramsJson: JSON.stringify(body.params),
        error: "No enabled image provider is configured.",
        createdAt: now,
        updatedAt: now
      });

      return {
        statusCode: 503,
        payload: {
          jobId,
          error: providerSelection.skipped.length > 0
            ? `当前没有可用图像接口：${providerSelection.skipped.join("；")}`
            : "请先在管理员控制面板配置生图 Provider"
        }
      };
    }

    const currentQuota = await getUserQuota(appDb, user.id);
    if (currentQuota < quotaCost) {
      const error = new InsufficientQuotaError(quotaCost, currentQuota);
      await repo.insertGenerationJob(appDb, {
        id: jobId,
        userId: user.id,
        providerId: providers[0]?.id ?? null,
        status: "failed",
        prompt: body.prompt,
        paramsJson: JSON.stringify(body.params),
        error: error.message,
        createdAt: now,
        updatedAt: now
      });
      return {
        statusCode: 402,
        payload: { jobId, error: error.message, quotaCost, remainingQuota: currentQuota }
      };
    }

    await repo.insertGenerationJob(appDb, {
      id: jobId,
      userId: user.id,
      providerId: providers[0]?.id ?? null,
      status: "running",
      prompt: body.prompt,
      paramsJson: JSON.stringify(body.params),
      error: null,
      createdAt: now,
      updatedAt: now
    });

    const errors: string[] = [];
    const providerRunMetrics: ImageProviderRunMetrics[] = [];
    try {
      if (!await repo.reserveImageQuota(appDb, user.id, jobId, quotaCost)) throw new InsufficientQuotaError(quotaCost, await getUserQuota(appDb, user.id));
      for (const provider of providers) {
        let persistedAssets: Awaited<ReturnType<typeof persistGeneratedImages>> = [];
        let upstreamCompleted = false;
        try {
          const requestedImageCount = getRequestedImageCount(body.params);
          {
            const runStartedAt = Date.now();
            const run = await generateImagesWithProvider(
              provider,
              body.prompt,
              body.params,
              requestedImageCount,
              { onPartialImage, onStage }
            );
            upstreamCompleted = run.images.length > 0;
            providerRunMetrics.push(run.metrics);
            const selectedImages = run.images.slice(0, requestedImageCount);
            if (selectedImages.length === 0) {
              throw new Error("Image provider did not return a saveable image");
            }
            onStage?.({ type: "stage", stage: "saving", message: "已收到生成结果，正在保存图片", providerName: provider.name, model: provider.model });
            const persistStartedAt = Date.now();
            const assets = await persistGeneratedImages(
              appDb,
              assetStorage,
              assetRetention,
              user.id,
              jobId,
              body.prompt,
              { ...body.params, providerId: provider.id, providerName: provider.name, model: provider.model },
              selectedImages
            );
            persistedAssets = assets;
            const persistMs = Date.now() - persistStartedAt;
            const totalMs = Date.now() - runStartedAt;
            const settledCost = quotaCost / requestedImageCount * assets.length;
            const remainingQuota = await consumeImageGenerationQuota(appDb, user.id, jobId, settledCost, {
              quality: String(body.params.quality ?? "high"),
              imageCount: assets.length,
              mode: "generation"
            }, {
              providerId: provider.id,
              paramsJson: JSON.stringify(withImageRuntimeMetrics({ ...body.params, providerId: provider.id, providerName: provider.name, model: provider.model }, { ...run.metrics, attempts: providerRunMetrics.flatMap((entry) => entry.attempts) }, { persistMs, totalMs, outputs: imageOutputMetrics(assets) }))
            });

            markImageProviderHealthy(imageProviderHealth, provider.id);

            return {
              statusCode: 200,
              payload: {
                jobId,
                provider: {
                  id: provider.id,
                  name: provider.name
                },
                skippedProviders: providerSelection.skipped,
                quotaCost: settledCost,
                remainingQuota,
                assets
              }
            };
          }
        } catch (error) {
          if (persistedAssets.length > 0) {
            const warning = "图片已保存，但本站结算失败，本次不计费；请在我的资产查看。";
            await repo.updateGenerationJob(appDb, jobId, { status: "failed", error: warning });
            return { statusCode: 200, payload: { jobId, provider: { id: provider.id, name: provider.name }, quotaCost: 0, remainingQuota: await getUserQuota(appDb, user.id) + quotaCost, assets: persistedAssets.map(asset => ({ ...asset, params: { ...asset.params, resolutionWarning: warning } })) } };
          }
          if (upstreamCompleted) throw error;
          if (error instanceof InsufficientQuotaError) {
            throw error;
          }
          const message = error instanceof Error ? error.message : "Image generation failed";
          if (error instanceof ImageProviderRunError) {
            providerRunMetrics.push(error.metrics);
          }
          if (shouldCooldownImageProviderError(message)) {
            markImageProviderUnhealthy(imageProviderHealth, provider.id, message);
          }
          errors.push(`${provider.name}: ${message}`);
        }
      }

      throw new Error(formatImageProviderFailures(errors, providerSelection.skipped));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Image generation failed";
      await repo.updateGenerationJob(appDb, jobId, {
        status: "failed",
        paramsJson: JSON.stringify(withImageRuntimeMetrics(
          body.params,
          summarizeFailedImageRuns(providerRunMetrics, message),
          { failure: message }
        )),
        error: message
      });
      if (error instanceof InsufficientQuotaError) {
        return {
          statusCode: 402,
          payload: {
            jobId,
            error: message,
            quotaCost,
            remainingQuota: error.remainingQuota
          }
        };
      }
      return {
        statusCode: 502,
        payload: { jobId, error: message }
      };
    } finally { await repo.refundImageQuota(appDb, user.id, jobId); }
  };

  app.post("/api/generate", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!await allowUserAction(appDb, request, reply, "image-generation", IMAGE_GENERATION_RATE_LIMIT)) return;
    const body = generationSchema.parse(request.body);
    if (contentSafety.findMatch([body.prompt])) {
      return reply.code(422).send({ error: "提示词包含不允许的内容，请修改后重试" });
    }
    const result = await executeImageGeneration(user, body);
    return reply.code(result.statusCode).send(result.payload);
  });

  app.post("/api/generate/stream", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!await allowUserAction(appDb, request, reply, "image-generation", IMAGE_GENERATION_RATE_LIMIT)) return;
    const body = generationSchema.parse(request.body);
    if (contentSafety.findMatch([body.prompt])) {
      return reply.code(422).send({ error: "提示词包含不允许的内容，请修改后重试" });
    }
    const output = new PassThrough();
    const sendEvent = (event: Record<string, unknown>) => {
      if (!output.destroyed) {
        output.write(`${JSON.stringify(event)}\n`);
      }
    };

    void executeImageGeneration(user, body, (partial) => {
      sendEvent({
        type: "preview",
        b64Json: partial.b64Json,
        mimeType: partial.mimeType,
        partialImageIndex: partial.partialImageIndex
      });
    }, sendEvent).then((result) => {
      if (result.statusCode === 200) {
        sendEvent({ type: "completed", result: result.payload });
        return;
      }
      const error = "error" in result.payload ? String(result.payload.error) : "图像生成失败";
      sendEvent({ type: "error", statusCode: result.statusCode, error });
    }).catch((error) => {
      sendEvent({
        type: "error",
        statusCode: error instanceof HttpRequestError ? error.statusCode : 500,
        error: error instanceof Error ? error.message : "图像生成失败"
      });
    }).finally(() => {
      output.end();
    });

    return reply
      .header("Content-Type", "application/x-ndjson; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header("X-Accel-Buffering", "no")
      .send(output);
  });

  app.post("/api/generate/edit", { preHandler: ctx.requireAuth }, async (request, reply) => {
    const user = (request as AuthedRequest).user;
    if (!await allowUserAction(appDb, request, reply, "image-generation", IMAGE_GENERATION_RATE_LIMIT)) return;
    let editInput: ImageEditRequestInput;
    try {
      editInput = await parseImageEditRequest(appDb, assetStorage, request, user);
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      if (error instanceof HttpRequestError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      const message = error instanceof Error ? error.message : "图生图请求解析失败";
      return reply.code(400).send({ error: message });
    }
    if (contentSafety.findMatch([editInput.prompt])) {
      await cleanupTransientReferenceAssets(appDb, assetStorage, user.id, editInput.transientAssetIds);
      return reply.code(422).send({ error: "提示词包含不允许的内容，请修改后重试" });
    }

    try {
      const requestedResolution = imageRequestResolution(editInput.params);
      if (!requestedResolution) {
        return reply.code(400).send({ error: "分辨率必须是 1K、2K、4K 或 auto" });
      }
      editInput.params = normalizeImageRequestParams(editInput.params, requestedResolution);

      const now = new Date();
      const jobId = nanoid();
      const requestedModel = imageRequestModel(editInput.params);
      const modelResolution = requestedModel ? imageResolutionFromModelId(requestedModel) : null;
      if (modelResolution && modelResolution !== requestedResolution) {
        return reply.code(400).send({ error: `模型 ${requestedModel} 指定 ${modelResolution}，请将分辨率设为 ${modelResolution}` });
      }
      const providerSelection = await getImageProviders(appDb, providerSecrets, editInput.providerId, imageProviderHealth, ["edits", "generations", "responses", "chat_completions"], requestedModel, requestedResolution);
      const resolutionSelection = await filterImageProvidersByResolution(providerSelection.providers, requestedResolution);
      providerSelection.skipped.push(...resolutionSelection.skipped);
      const providers = [...resolutionSelection.providers].sort((a, b) => Number(a.mode === "generations") - Number(b.mode === "generations")).map(provider => provider.mode === "generations" ? { ...provider, mode: "edits" as const } : provider);
      const quotaCost = await calculateImageGenerationQuotaCost(appDb, editInput.params);

      if (providerSelection.providers.length > 0 && providers.length === 0) {
        return reply.code(400).send({ error: `当前接口没有已验证支持 ${requestedResolution} 的配置` });
      }
      const persistedParams = {
        ...editInput.params,
        providerId: providers[0]?.id ?? null,
        providerName: providers[0]?.name ?? null,
        model: providers[0]?.model ?? requestedModel,
        mode: "image-edit",
        referenceImageCount: editInput.images.length,
        referenceSources: editInput.referenceSources,
        assetIds: editInput.assetIds
      };

      if (providers.length === 0) {
        await repo.insertGenerationJob(appDb, {
          id: jobId,
          userId: user.id,
          providerId: editInput.providerId ?? null,
          status: "failed",
          prompt: editInput.prompt,
          paramsJson: JSON.stringify(persistedParams),
          error: "No enabled image edit provider is configured.",
          createdAt: now,
          updatedAt: now
        });

        return reply.code(503).send({
          jobId,
          error: providerSelection.skipped.length > 0
            ? `当前图生图接口都在自动冷却中：${providerSelection.skipped.join("；")}`
            : "请先在管理员控制面板配置支持 images/edits 的图像 Provider"
        });
      }

      const currentQuota = await getUserQuota(appDb, user.id);
      if (currentQuota < quotaCost) {
        const error = new InsufficientQuotaError(quotaCost, currentQuota);
        await repo.insertGenerationJob(appDb, {
          id: jobId,
          userId: user.id,
          providerId: providers[0]?.id ?? null,
          status: "failed",
          prompt: editInput.prompt,
          paramsJson: JSON.stringify(persistedParams),
          error: error.message,
          createdAt: now,
          updatedAt: now
        });
        return reply.code(402).send({ jobId, error: error.message, quotaCost, remainingQuota: currentQuota });
      }

      await repo.insertGenerationJob(appDb, {
        id: jobId,
        userId: user.id,
        providerId: providers[0]?.id ?? null,
        status: "running",
        prompt: editInput.prompt,
        paramsJson: JSON.stringify(persistedParams),
        error: null,
        createdAt: now,
        updatedAt: now
      });

      const errors: string[] = [];
      const providerRunMetrics: ImageProviderRunMetrics[] = [];
      try {
        if (!await repo.reserveImageQuota(appDb, user.id, jobId, quotaCost)) throw new InsufficientQuotaError(quotaCost, await getUserQuota(appDb, user.id));
        for (const provider of providers) {
          let persistedAssets: Awaited<ReturnType<typeof persistGeneratedImages>> = [];
          let upstreamCompleted = false;
          try {
            const requestedImageCount = getRequestedImageCount(editInput.params);
            {
              const runStartedAt = Date.now();
              const run = await generateImagesWithProvider(provider, editInput.prompt, {
                ...editInput.params,
                images: editInput.images,
                action: "edit"
              }, requestedImageCount);
              upstreamCompleted = run.images.length > 0;
              providerRunMetrics.push(run.metrics);
              const selectedImages = run.images.slice(0, requestedImageCount);
              if (selectedImages.length === 0) {
                throw new Error("Image edit provider did not return a saveable image");
              }
              const persistStartedAt = Date.now();
              const assets = await persistGeneratedImages(
                appDb,
                assetStorage,
                assetRetention,
                user.id,
                jobId,
                editInput.prompt,
                { ...persistedParams, providerId: provider.id, providerName: provider.name, model: provider.model },
                selectedImages
              );
              persistedAssets = assets;
              const persistMs = Date.now() - persistStartedAt;
              const totalMs = Date.now() - runStartedAt;
              const settledCost = quotaCost / requestedImageCount * assets.length;
              const remainingQuota = await consumeImageGenerationQuota(appDb, user.id, jobId, settledCost, {
                quality: String(editInput.params.quality ?? "high"),
                imageCount: assets.length,
                mode: "edit"
              }, {
                providerId: provider.id,
                paramsJson: JSON.stringify(withImageRuntimeMetrics({ ...persistedParams, providerId: provider.id, providerName: provider.name, model: provider.model }, { ...run.metrics, attempts: providerRunMetrics.flatMap((entry) => entry.attempts) }, { persistMs, totalMs, outputs: imageOutputMetrics(assets) }))
              });

              markImageProviderHealthy(imageProviderHealth, provider.id);

              return {
                jobId,
                provider: {
                  id: provider.id,
                  name: provider.name
                },
                skippedProviders: providerSelection.skipped,
                quotaCost: settledCost,
                remainingQuota,
                assets
              };
            }
          } catch (error) {
            if (persistedAssets.length > 0) {
              const warning = "图片已保存，但本站结算失败，本次不计费；请在我的资产查看。";
              await repo.updateGenerationJob(appDb, jobId, { status: "failed", error: warning });
              return { jobId, provider: { id: provider.id, name: provider.name }, quotaCost: 0, remainingQuota: await getUserQuota(appDb, user.id) + quotaCost, assets: persistedAssets.map(asset => ({ ...asset, params: { ...asset.params, resolutionWarning: warning } })) };
            }
            if (upstreamCompleted) throw error;
            if (error instanceof InsufficientQuotaError) {
              throw error;
            }
            const message = error instanceof Error ? error.message : "Image edit failed";
            if (error instanceof ImageProviderRunError) {
              providerRunMetrics.push(error.metrics);
            }
            if (shouldCooldownImageProviderError(message)) {
              markImageProviderUnhealthy(imageProviderHealth, provider.id, message);
            }
            errors.push(`${provider.name}: ${message}`);
          }
        }

        throw new Error(formatImageProviderFailures(errors, providerSelection.skipped));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Image edit failed";
        await repo.updateGenerationJob(appDb, jobId, {
          status: "failed",
          paramsJson: JSON.stringify(withImageRuntimeMetrics(
            persistedParams,
            summarizeFailedImageRuns(providerRunMetrics, message),
            { failure: message }
          )),
          error: message
        });
        if (error instanceof InsufficientQuotaError) {
          return reply.code(402).send({
            jobId,
            error: message,
            quotaCost,
            remainingQuota: error.remainingQuota
          });
        }
        return reply.code(502).send({ jobId, error: message });
      } finally { await repo.refundImageQuota(appDb, user.id, jobId); }
    } finally {
      await cleanupTransientReferenceAssets(appDb, assetStorage, user.id, editInput.transientAssetIds);
    }
  });
}
