import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

export type ProviderSecretCodec = {
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
};

export function createProviderSecretCodec(secret?: string): ProviderSecretCodec {
  if (!secret) {
    return {
      encrypt: (value) => value,
      decrypt: (value) => value
    };
  }

  const key = decodeKey(secret);
  return {
    encrypt: (value) => {
      if (!value || value.startsWith(PREFIX)) return value;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
    },
    decrypt: (value) => {
      if (!value.startsWith(PREFIX)) return value;
      const [ivValue, tagValue, encryptedValue] = value.slice(PREFIX.length).split(".");
      if (!ivValue || !tagValue || !encryptedValue) {
        throw new Error("Invalid encrypted provider key");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64url")),
        decipher.final()
      ]).toString("utf8");
    }
  };
}

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[a-f\d]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to a deterministic 32-byte digest for legacy secrets.
  }
  return createHash("sha256").update(trimmed, "utf8").digest();
}
