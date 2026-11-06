import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdir, readFile, stat, unlink, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";

export type R2StorageConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type StoredObjectInfo = {
  sizeBytes: number;
  contentType?: string;
};

export type AssetStorage = {
  backend: "local" | "r2";
  put: (key: string, bytes: Buffer, contentType: string) => Promise<void>;
  read: (key: string) => Promise<Buffer>;
  copy: (sourceKey: string, targetKey: string, contentType?: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
  head: (key: string) => Promise<StoredObjectInfo | undefined>;
  createUploadUrl: (key: string, contentType: string, expiresInSeconds?: number) => Promise<string | null>;
  createDownloadUrl: (
    key: string,
    expiresInSeconds?: number,
    downloadFileName?: string
  ) => Promise<string | null>;
};

export function createAssetStorage(dataDir: string, r2?: R2StorageConfig): AssetStorage {
  return r2 ? createR2Storage(r2) : createLocalStorage(dataDir);
}

function createLocalStorage(dataDir: string): AssetStorage {
  const root = path.resolve(dataDir, "objects");
  const resolveKey = (key: string) => {
    const resolved = path.resolve(root, key);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("Invalid asset storage key");
    }
    return resolved;
  };

  return {
    backend: "local",
    put: async (key, bytes) => {
      const target = resolveKey(key);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
    read: (key) => readFile(resolveKey(key)),
    copy: async (sourceKey, targetKey) => {
      const target = resolveKey(targetKey);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(resolveKey(sourceKey), target);
    },
    delete: async (key) => {
      await unlink(resolveKey(key)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
    head: async (key) => {
      try {
        const info = await stat(resolveKey(key));
        return { sizeBytes: info.size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    createUploadUrl: async () => null,
    createDownloadUrl: async () => null
  };
}

function createR2Storage(config: R2StorageConfig): AssetStorage {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });

  return {
    backend: "r2",
    put: async (key, bytes, contentType) => {
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType
      }));
    },
    read: async (key) => {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      if (!result.Body) throw new Error("Stored image has no response body");
      return Buffer.from(await result.Body.transformToByteArray());
    },
    copy: async (sourceKey, targetKey, contentType) => {
      await client.send(new CopyObjectCommand({
        Bucket: config.bucket,
        Key: targetKey,
        CopySource: encodeURIComponent(`${config.bucket}/${sourceKey}`).replaceAll("%2F", "/"),
        ContentType: contentType,
        MetadataDirective: contentType ? "REPLACE" : "COPY"
      }));
    },
    delete: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
    head: async (key) => {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return {
          sizeBytes: Number(result.ContentLength ?? 0),
          contentType: result.ContentType
        };
      } catch (error) {
        const statusCode = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (statusCode === 404) return undefined;
        throw error;
      }
    },
    createUploadUrl: (key, contentType, expiresInSeconds = 300) => getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: contentType
      }),
      { expiresIn: expiresInSeconds }
    ),
    createDownloadUrl: (key, expiresInSeconds = 300, downloadFileName) => getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentDisposition: downloadFileName
          ? 'attachment; filename="' + downloadFileName.replace(/[^A-Za-z0-9._-]/g, "_") + '"'
          : undefined
      }),
      { expiresIn: expiresInSeconds }
    )
  };
}
