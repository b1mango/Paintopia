import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAppDatabase } from '../src/db/database.js';
import { createPersistentPromptLibrary } from '../src/services/promptSourceCache.js';
import { EXTERNAL_PROMPT_SOURCES, PROMPT_SOURCE_UPDATE_INTERVAL_MS } from '../src/services/promptSources.js';

it('persists across service restarts, refreshes weekly and retains snapshots on failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prompt-cache-'));
  const db = await createAppDatabase({dataDir:dir, bootstrapEmail:'admin', bootstrapPassword:'test-password', skipBootstrap:true});
  let now = 1000;
  let failing = false;
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (failing) throw new Error('private upstream failure');
    return new Response(String(url).includes('catalog.json') ? '{"schema_version":2,"entries":[]}' : '[]');
  });
  try {
    const first = await createPersistentPromptLibrary(db, fetcher as typeof fetch, () => now);
    await first.list();
    expect(fetcher).toHaveBeenCalledTimes(4);
    const restarted = await createPersistentPromptLibrary(db, fetcher as typeof fetch, () => now);
    await restarted.list();
    now += PROMPT_SOURCE_UPDATE_INTERVAL_MS - 1;
    await restarted.refresh();
    expect(fetcher).toHaveBeenCalledTimes(4);
    now++;
    await Promise.all([first.refresh(), restarted.refresh()]);
    expect(fetcher).toHaveBeenCalledTimes(8);
    failing = true;
    now += PROMPT_SOURCE_UPDATE_INTERVAL_MS;
    const stale = await restarted.refresh();
    expect(stale.sourceErrors).toHaveLength(4);
    expect(stale.fetchedAt).toBe(new Date(1000 + PROMPT_SOURCE_UPDATE_INTERVAL_MS).toISOString());
    expect(JSON.stringify(stale)).not.toContain('private upstream failure');
    await restarted.list();
    expect(fetcher).toHaveBeenCalledTimes(12);
  } finally { await db.close(); await rm(dir, {recursive:true,force:true}); }
});

it('authenticates scheduled refresh before contacting any source', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerPromptSourceRoutes } = await import('../src/routes/promptSources.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'prompt-cron-'));
  const db = await createAppDatabase({dataDir:dir, bootstrapEmail:'admin', bootstrapPassword:'test-password', skipBootstrap:true});
  const app = Fastify();
  const list = vi.fn(async () => ({items:[],fetchedAt:new Date(0).toISOString(),sourceErrors:[]}));
  try {
    await registerPromptSourceRoutes(app, {db,requireAuth:async()=>{},cronSecret:'cron-test-secret',service:{list,listSource:async()=>({items:[],fetchedAt:new Date(0).toISOString()})}});
    expect((await app.inject({url:'/api/internal/refresh-prompt-sources'})).statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect((await app.inject({url:'/api/internal/refresh-prompt-sources',headers:{authorization:'Bearer cron-test-secret'}})).statusCode).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
  } finally { await app.close(); await db.close(); await rm(dir,{recursive:true,force:true}); }
});

it('returns expired durable snapshots immediately without fetching or acquiring a lease', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prompt-stale-'));
  const db = await createAppDatabase({dataDir:dir, bootstrapEmail:'admin', bootstrapPassword:'test-password', skipBootstrap:true});
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const now = PROMPT_SOURCE_UPDATE_INTERVAL_MS + 2000;
  try {
    await db.execute("UPDATE prompt_source_cache SET items_json = '[]', fetched_at = 1000");
    const execute = vi.spyOn(db, 'execute');
    const service = await createPersistentPromptLibrary(db, fetcher as typeof fetch, () => now);
    const result = await service.list();
    expect(result.fetchedAt).toBe(new Date(1000).toISOString());
    expect(result.sourceErrors).toEqual([]);
    expect(result.refreshNeeded).toBe(true);
    expect((await service.listSource('youmind-gpt-image-2')).items).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally { await db.close(); await rm(dir, {recursive:true,force:true}); }
});

it('refreshes expired snapshots through the authenticated page request and clears real failures after recovery', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerPromptSourceRoutes } = await import('../src/routes/promptSources.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'prompt-retry-'));
  const db = await createAppDatabase({dataDir:dir, bootstrapEmail:'admin', bootstrapPassword:'test-password', skipBootstrap:true});
  const app = Fastify();
  let now = PROMPT_SOURCE_UPDATE_INTERVAL_MS + 2000;
  let failing = true;
  const oldItems = EXTERNAL_PROMPT_SOURCES.map(source => ({id:source.id + ':saved', sourceId:source.id, title:'已缓存作品', text:'原始提示词', description:'', tags:[], author:'作者', sourceUrl:'https://x.com/example/status/1', model:source.model, favorite:false}));
  const fetcher = vi.fn(async () => {
    if (failing) throw new Error('private transport failure');
    return new Response(JSON.stringify([{id:'youmind-gpt-image-2:fresh',title:'更新后的作品',prompt:'最新提示词',sourceUrl:'https://x.com/example/status/2',imageModel:'gpt-image-2'}]));
  });
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', fetcher);
  const headers = {'x-test-user':'user-a'};
  try {
    await db.execute("INSERT INTO users (id,email,password_hash,role,status,quota,created_at,updated_at) VALUES ('user-a','a@test.local','test','user','active',100,0,0)");
    for (const item of oldItems) await db.execute('UPDATE prompt_source_cache SET items_json = ?, fetched_at = ? WHERE source_id = ?', [JSON.stringify([item]), item.sourceId !== 'youmind-gpt-image-2' ? now : 1000, item.sourceId]);
    await db.execute('INSERT INTO sourced_prompt_favorites (user_id,prompt_id,created_at) VALUES (?,?,?)', ['user-a',oldItems[1].id,now]);
    await registerPromptSourceRoutes(app, {db,requireAuth:async request => {
      if (request.headers['x-test-user']) Object.assign(request, {user:{id:'user-a'}});
    }});
    const list = await app.inject({url:'/api/prompt-library', headers});
    expect(list.json()).toMatchObject({refreshNeeded:true,sourceErrors:[]});
    expect(fetcher).not.toHaveBeenCalled();
    expect((await app.inject({url:'/api/prompt-library?refresh=true'})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/prompt-library?refresh=bad',headers})).statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();

    const failed = await app.inject({url:'/api/prompt-library?refresh=true',headers});
    expect(failed.statusCode).toBe(200);
    expect(failed.json().items).toHaveLength(4);
    expect(failed.json().sourceErrors).toEqual([{sourceId:'youmind-gpt-image-2',message:expect.any(String)}]);
    expect(failed.json().refreshNeeded).toBe(false);
    expect(failed.body).not.toContain('private transport failure');
    await app.inject({url:'/api/prompt-library?refresh=true',headers});
    expect(fetcher).toHaveBeenCalledTimes(1);

    now += 30000;
    const expiredBackoff = await app.inject({url:'/api/prompt-library',headers});
    expect(expiredBackoff.json()).toMatchObject({refreshNeeded:true,sourceErrors:[{sourceId:'youmind-gpt-image-2'}]});
    failing = false;
    const recovered = await app.inject({url:'/api/prompt-library?refresh=true',headers});
    expect(recovered.json()).toMatchObject({refreshNeeded:false,sourceErrors:[]});
    expect(recovered.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({id:'youmind-gpt-image-2:fresh',text:'最新提示词'}),
      expect.objectContaining({id:oldItems[1].id,favorite:true})
    ]));
    expect(recovered.headers['cache-control']).toBe('private, no-store');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const restarted = await createPersistentPromptLibrary(db, fetcher as typeof fetch, () => now);
    expect((await restarted.list()).sourceErrors).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    await app.close(); await db.close(); await rm(dir,{recursive:true,force:true});
  }
});
