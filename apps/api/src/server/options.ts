import {
  type TextProviderMode
} from "@paintopia/shared";
import { type R2StorageConfig } from "../services/assetStorage.js";

export type CreateServerOptions = {
  dataDir: string;
  bootstrapEmail: string;
  bootstrapPassword: string;
  ownerEmail?: string;
  inviteCode?: string;
  webOrigin: string;
  sessionSecret: string;
  databaseUrl?: string;
  providerEncryptionKey?: string;
  production?: boolean;
  assetRetentionDays?: number;
  pendingGalleryRetentionDays?: number;
  cronSecret?: string;
  prohibitedTerms?: string[];
  r2?: R2StorageConfig;
  defaultTextProvider?: {
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    mode: TextProviderMode;
  };
};
