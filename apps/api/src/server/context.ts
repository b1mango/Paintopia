import type { preHandlerAsyncHookHandler } from "fastify";
import type { AppDatabase } from "../db/database.js";
import type { AssetRetentionPolicy } from "../services/assetRetention.js";
import type { AssetStorage } from "../services/assetStorage.js";
import type { createContentSafetyMatcher } from "../services/contentSafety.js";
import type { ImageProviderHealth } from "../services/imageGeneration.js";
import type { ProviderSecretCodec } from "../services/providerSecrets.js";
import type { CreateServerOptions } from "./options.js";

export type ServerContext = {
  db: AppDatabase;
  storage: AssetStorage;
  secrets: ProviderSecretCodec;
  config: CreateServerOptions;
  assetRetention: AssetRetentionPolicy;
  imageProviderHealth: Map<string, ImageProviderHealth>;
  contentSafety: ReturnType<typeof createContentSafetyMatcher>;
  requireAuth: preHandlerAsyncHookHandler;
  requireAdmin: preHandlerAsyncHookHandler;
};
