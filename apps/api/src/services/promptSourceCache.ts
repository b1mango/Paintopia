import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import type { SourcedPrompt } from '@paintopia/shared';
import { createPromptLibraryService, EXTERNAL_PROMPT_SOURCES, PROMPT_SOURCE_UPDATE_INTERVAL_MS } from './promptSources.js';

type SnapshotMetadata = { source_id: string; fetched_at: number | string; retry_at: number | string; has_snapshot: number | boolean };
type Snapshot = SnapshotMetadata & { items_json: string | null };
const searchTexts = new WeakMap<SourcedPrompt, string>();
export function promptSearchText(item: SourcedPrompt): string {
  let text = searchTexts.get(item);
  if (text === undefined) {
    text = [item.title, item.text, item.description, item.author, ...item.tags].join('\n').toLowerCase();
    searchTexts.set(item, text);
  }
  return text;
}

/** Durable snapshots; the database lease coordinates concurrent cold starts. */
export async function initializePromptSourceTables(db: AppDatabase) {
  await db.execute('CREATE TABLE IF NOT EXISTS prompt_source_cache (' +
    'source_id TEXT PRIMARY KEY, items_json TEXT, fetched_at BIGINT NOT NULL DEFAULT 0,' +
    'retry_at BIGINT NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0, lease_token TEXT)');
  for (const source of EXTERNAL_PROMPT_SOURCES) await db.execute('INSERT INTO prompt_source_cache(source_id) VALUES (?) ON CONFLICT(source_id) DO NOTHING', [source.id]);
  await db.execute('CREATE TABLE IF NOT EXISTS sourced_prompt_favorites (' +
    'user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,' +
    'prompt_id TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (user_id, prompt_id))');
}

export async function createPersistentPromptLibrary(db: AppDatabase, fetcher: typeof fetch = fetch, now = Date.now) {
  // Keep one latest version per source; consult the database on every request.
  const parsed = new Map<string, { version: number; items: SourcedPrompt[]; fetchedAt: string }>();
  const fields = 'source_id, fetched_at, retry_at, (items_json IS NOT NULL) AS has_snapshot';
  function decode(row: Snapshot) {
    const version = Number(row.fetched_at);
    let cached = parsed.get(row.source_id);
    if (!cached || cached.version !== version) {
      const items = JSON.parse(row.items_json!) as SourcedPrompt[];
      items.forEach(promptSearchText);
      cached = { version, items, fetchedAt: new Date(version).toISOString() };
      parsed.set(row.source_id, cached);
    }
    return cached;
  }
  function snapshot(row: SnapshotMetadata) {
    const cached = parsed.get(row.source_id)!;
    return {
      items: cached.items, fetchedAt: cached.fetchedAt, stale: Number(row.retry_at) > 0,
      refreshNeeded: Number(row.fetched_at) + PROMPT_SOURCE_UPDATE_INTERVAL_MS <= now() && Number(row.retry_at) <= now()
    };
  }
  async function readMetadata(ids: string[]) {
    const rows = await db.query<SnapshotMetadata>('SELECT ' + fields + ' FROM prompt_source_cache WHERE source_id IN (' + ids.map(() => '?').join(',') + ')', ids);
    const missing = rows.filter(row => row.has_snapshot && parsed.get(row.source_id)?.version !== Number(row.fetched_at)).map(row => row.source_id);
    if (missing.length) {
      const snapshots = await db.query<Snapshot>('SELECT ' + fields + ', items_json FROM prompt_source_cache WHERE source_id IN (' + missing.map(() => '?').join(',') + ')', missing);
      for (const row of snapshots) {
        if (row.has_snapshot) decode(row);
        // A refresh can commit between the metadata and payload queries.
        rows[rows.findIndex(meta => meta.source_id === row.source_id)] = row;
      }
    }
    return rows;
  }
  async function readCurrent(id: string) {
    const row = (await db.queryOne<Snapshot>('SELECT ' + fields + ', items_json FROM prompt_source_cache WHERE source_id = ?', [id]))!;
    if (!row.has_snapshot) throw new Error('来源正在更新，请稍后重试');
    decode(row);
    return snapshot(row);
  }
  async function source(row: SnapshotMetadata, refresh: boolean) {
    const id = row.source_id;
    if (row.has_snapshot && (!refresh || Number(row.fetched_at) + PROMPT_SOURCE_UPDATE_INTERVAL_MS > now())) return snapshot(row);
    if (Number(row.retry_at) > now()) {
      if (row.has_snapshot) return { ...snapshot(row), refreshNeeded: false };
      throw new Error('来源暂不可用');
    }
    const token = randomUUID();
    const acquired = await db.execute('UPDATE prompt_source_cache SET lease_until = ?, lease_token = ? ' +
      'WHERE source_id = ? AND lease_until <= ? AND retry_at <= ? AND (items_json IS NULL OR fetched_at <= ?)',
      [now() + 60000, token, id, now(), now(), now() - PROMPT_SOURCE_UPDATE_INTERVAL_MS]);
    if (!acquired) return readCurrent(id);
    try {
      const result = await createPromptLibraryService(fetcher, now).listSource(id);
      const fetchedAt = Math.max(Date.parse(result.fetchedAt), Number(row.fetched_at) + 1);
      const changed = await db.execute('UPDATE prompt_source_cache SET items_json = ?, fetched_at = ?, retry_at = 0, ' +
        'lease_until = 0, lease_token = NULL WHERE source_id = ? AND lease_token = ?', [JSON.stringify(result.items), fetchedAt, id, token]);
      if (!changed) return readCurrent(id);
      result.items.forEach(promptSearchText);
      parsed.set(id, { version: fetchedAt, items: result.items, fetchedAt: new Date(fetchedAt).toISOString() });
      return snapshot({ source_id: id, fetched_at: fetchedAt, retry_at: 0, has_snapshot: true });
    } catch {
      await db.execute('UPDATE prompt_source_cache SET retry_at = ?, lease_until = 0, lease_token = NULL WHERE source_id = ? AND lease_token = ?', [now() + 30000, id, token]);
      return readCurrent(id);
    }
  }
  async function list(refresh = false) {
    const rows = await readMetadata(EXTERNAL_PROMPT_SOURCES.map(entry => entry.id));
    const results = await Promise.allSettled(EXTERNAL_PROMPT_SOURCES.map(entry => source(rows.find(row => row.source_id === entry.id)!, refresh)));
    const items: SourcedPrompt[] = [], times: string[] = [], sourceErrors: { sourceId: string; message: string }[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') { items.push(...result.value.items); times.push(result.value.fetchedAt); }
      if (result.status === 'rejected' || result.value.stale) sourceErrors.push({ sourceId: EXTERNAL_PROMPT_SOURCES[index].id, message: '来源更新暂不可用，已有内容仍可浏览' });
    });
    const refreshNeeded = results.some(result => result.status === 'fulfilled' && result.value.refreshNeeded);
    return { items, fetchedAt: times.sort()[0] ?? null, sourceErrors, refreshNeeded };
  }
  return {
    list: () => list(), refresh: () => list(true),
    async listSource(id: string) {
      if (!EXTERNAL_PROMPT_SOURCES.some(source => source.id === id)) throw new Error('未知提示词来源');
      return source((await readMetadata([id]))[0], false);
    }
  };
}
