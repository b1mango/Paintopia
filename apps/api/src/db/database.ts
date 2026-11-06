import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import postgres from "postgres";
import * as dbSchema from "./schema.js";
import { schema } from "./schema.js";
import { migrate } from "./migrate.js";
import { migratePostgres } from "./migratePostgres.js";
import { bootstrapAdmin } from "../services/authService.js";
import { initializePromptSourceTables } from "../services/promptSourceCache.js";

// Increment whenever migrations or startup seeds change.
export const SCHEMA_VERSION = "2026-11-06.1";

export type DatabaseValue = string | number | boolean | Date | Buffer | null;

export type DatabaseExecutor = {
  query: <T>(sql: string, params?: DatabaseValue[]) => Promise<T[]>;
  queryOne: <T>(sql: string, params?: DatabaseValue[]) => Promise<T | undefined>;
  execute: (sql: string, params?: DatabaseValue[]) => Promise<number>;
};

export type AppDatabase = DatabaseExecutor & {
  dialect: "sqlite" | "postgres";
  schema: typeof schema;
  dataDir: string;
  startupMetadata: Record<string, string>;
  sqlite?: {
    db: BetterSQLite3Database<typeof dbSchema>;
    raw: Database.Database;
  };
  transaction: <T>(work: (tx: DatabaseExecutor) => Promise<T>) => Promise<T>;
  bootstrap: () => Promise<void>;
  close: () => Promise<void>;
};

export type AppDatabaseOptions = {
  dataDir: string;
  databaseUrl?: string;
  bootstrapEmail: string;
  bootstrapPassword: string;
  skipBootstrap?: boolean;
  initialize?: (database: AppDatabase) => Promise<Record<string, string>>;
};

export async function createAppDatabase(options: AppDatabaseOptions): Promise<AppDatabase> {
  const database = options.databaseUrl
    ? await createPostgresDatabase(options)
    : await createSqliteDatabase(options);
  return database;
}

async function createSqliteDatabase(options: AppDatabaseOptions): Promise<AppDatabase> {
  mkdirSync(options.dataDir, { recursive: true });
  mkdirSync(path.join(options.dataDir, "assets", "original"), { recursive: true });
  mkdirSync(path.join(options.dataDir, "thumbs"), { recursive: true });
  mkdirSync(path.join(options.dataDir, "uploads"), { recursive: true });
  mkdirSync(path.join(options.dataDir, "exports"), { recursive: true });
  mkdirSync(path.join(options.dataDir, "logs"), { recursive: true });

  const raw = new Database(path.join(options.dataDir, "paintopia.sqlite"));
  raw.pragma("foreign_keys = ON");
  const db = drizzle(raw, { schema: dbSchema });
  const executor = createSqliteExecutor(raw);

  let transactionTail: Promise<void> = Promise.resolve();
  const database: AppDatabase = {
    ...executor,
    dialect: "sqlite",
    schema,
    dataDir: options.dataDir,
    startupMetadata: {},
    sqlite: { db, raw },
    transaction: async (work) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        raw.exec("BEGIN IMMEDIATE");
        const result = await work(executor);
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (raw.inTransaction) raw.exec("ROLLBACK");
        throw error;
      } finally { release(); }
    },
    bootstrap: async () => bootstrapAdmin(database, options.bootstrapEmail, options.bootstrapPassword),
    close: async () => {
      raw.close();
    }
  };
  try {
    await initializeDatabase(database, options, async () => migrate(raw));
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

async function createPostgresDatabase(options: AppDatabaseOptions): Promise<AppDatabase> {
  const client = postgres(options.databaseUrl!, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15
  });
  const executor = createPostgresExecutor(client);

  const database: AppDatabase = {
    ...executor,
    dialect: "postgres",
    schema,
    dataDir: options.dataDir,
    startupMetadata: {},
    transaction: async (work) => client.begin(async (transactionClient) => (
      work(createPostgresExecutor(transactionClient))
    )) as Promise<Awaited<ReturnType<typeof work>>>,
    bootstrap: async () => bootstrapAdmin(database, options.bootstrapEmail, options.bootstrapPassword),
    close: async () => {
      await client.end({ timeout: 5 });
    }
  };
  try {
    const metadata = await readStartupMetadata(database);
    if (metadata.schema_version === startupVersion(options)) {
      database.startupMetadata = metadata;
    } else {
      // Transaction locks also work through Neon's transaction-pooled endpoint.
      await client.begin(async (connection) => {
        await connection.unsafe("SELECT pg_advisory_xact_lock(73491822)");
        await connection.unsafe("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        const executor = createPostgresExecutor(connection);
        const locked: AppDatabase = { ...database, ...executor, transaction: async work => work(executor) };
        await initializeDatabase(locked, options, () => migratePostgres(connection));
        database.startupMetadata = locked.startupMetadata;
      });
    }
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

function startupVersion(options: AppDatabaseOptions) {
  // Standalone database tools do not claim to have completed the server's seeds.
  return options.initialize ? SCHEMA_VERSION : `${SCHEMA_VERSION}:database${options.skipBootstrap ? ":unbootstrapped" : ""}`;
}

async function readStartupMetadata(database: DatabaseExecutor) {
  try {
    const rows = await database.query<{ key: string; value: string }>("SELECT key, value FROM schema_meta");
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  } catch (error) {
    const { code, message } = error as { code: string; message: string };
    if (code === "42P01" || (code === "SQLITE_ERROR" && message === "no such table: schema_meta")) return {};
    throw error;
  }
}

async function initializeDatabase(database: AppDatabase, options: AppDatabaseOptions, migrateSchema: () => Promise<void>) {
  const metadata = await readStartupMetadata(database);
  if (metadata.schema_version === startupVersion(options)) {
    database.startupMetadata = metadata;
    return;
  }
  await migrateSchema();
  await database.execute("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (!options.skipBootstrap) await bootstrapAdmin(database, options.bootstrapEmail, options.bootstrapPassword);
  await initializePromptSourceTables(database);
  const initialized = options.initialize ? await options.initialize(database) : {};
  for (const [key, value] of Object.entries(initialized)) {
    await database.execute("INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }
  await database.execute("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [startupVersion(options)]);
  database.startupMetadata = { ...metadata, ...initialized, schema_version: startupVersion(options) };
}

function createSqliteExecutor(raw: Database.Database): DatabaseExecutor {
  return {
    query: async <T>(sql: string, params: DatabaseValue[] = []) => (
      raw.prepare(sql).all(...params.map(normalizeSqliteValue)) as T[]
    ),
    queryOne: async <T>(sql: string, params: DatabaseValue[] = []) => (
      raw.prepare(sql).get(...params.map(normalizeSqliteValue)) as T | undefined
    ),
    execute: async (sql: string, params: DatabaseValue[] = []) => (
      raw.prepare(sql).run(...params.map(normalizeSqliteValue)).changes
    )
  };
}

function createPostgresExecutor(client: any): DatabaseExecutor {
  return {
    query: async <T>(sql: string, params: DatabaseValue[] = []) => (
      await client.unsafe(postgresPlaceholders(sql), params.map(normalizePostgresValue)) as T[]
    ),
    queryOne: async <T>(sql: string, params: DatabaseValue[] = []) => {
      const rows = await client.unsafe(postgresPlaceholders(sql), params.map(normalizePostgresValue)) as T[];
      return rows[0];
    },
    execute: async (sql: string, params: DatabaseValue[] = []) => {
      const result = await client.unsafe(postgresPlaceholders(sql), params.map(normalizePostgresValue)) as { count?: number };
      return Number(result.count ?? 0);
    }
  };
}

function postgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeSqliteValue(value: DatabaseValue): string | number | Buffer | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function normalizePostgresValue(value: DatabaseValue): string | number | Buffer | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
