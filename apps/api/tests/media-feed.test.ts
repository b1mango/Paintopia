import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import Fastify from "fastify";
import {it, expect} from "vitest";
import {createAppDatabase} from "../src/db/database.js";
import {registerMediaFeed} from "../src/routes/mediaFeed.js";

it("paginates equal timestamps without duplicates and isolates owners and pending gallery items", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "media-feed-"));
  const db = await createAppDatabase({dataDir:dir, bootstrapEmail:"admin@test.local",bootstrapPassword:"test-password"});
  const app = Fastify();
  let user = {id:"u1",role:"user"};
  registerMediaFeed(app, db, async request => { (request as any).user = user; });
  try {
    for (const id of ["u1","u2"]) await db.execute("INSERT INTO users (id,email,password_hash,role,status,quota,created_at,updated_at) VALUES (?,?,?,'user','active',0,?,1)",[id,`${id}@test.local`,"unused",1]);
    for (const [id,owner,prompt] of [["a","u1","portrait"],["b","u1","100% city"],["c","u2","secret"]]) {
      await db.execute("INSERT INTO assets (id,user_id,original_path,prompt,params_json,size_bytes,mime_type,status,created_at) VALUES (?,?,?,?,'{\"actualWidth\":1024,\"actualHeight\":2048,\"privateDebug\":\"omit\"}',10,'image/png','ready',100)",[id,owner,id,prompt]);
      await db.execute("INSERT INTO gallery_items (id,asset_id,user_id,title,prompt,status,created_at) VALUES (?,?,?,'title',?,'pending',100)",[id,id,owner,prompt]);
    }
    const get = async (url:string) => {const r=await app.inject(url); expect(r.statusCode).toBe(200);return r.json();};
    const first = await get("/api/media-feed/assets?limit=1");
    expect(first.items.map((i:any)=>i.id)).toEqual(["b"]);
    expect(first.items[0].width).toBe(1024);
    expect(JSON.stringify(first)).not.toContain("privateDebug");
    const second = await get(`/api/media-feed/assets?limit=1&cursor=${first.nextCursor}`);
    expect(second.items.map((i:any)=>i.id)).toEqual(["a"]);
    expect(second.nextCursor).toBeNull();
    expect((await get("/api/media-feed/assets?search=%25")).items.map((i:any)=>i.id)).toEqual(["b"]);
    expect((await get("/api/media-feed/gallery")).items.map((i:any)=>i.id)).toEqual(["b","a"]);
    user = {id:"u2",role:"user"};
    expect((await get("/api/media-feed/assets")).items.map((i:any)=>i.id)).toEqual(["c"]);
    user = {id:"u2",role:"admin"};
    expect((await get("/api/media-feed/gallery")).items).toHaveLength(3);
    expect((await get("/api/media-feed/assets")).items).toHaveLength(1);
    expect((await app.inject("/api/media-feed/assets?cursor=invalid")).statusCode).toBe(400);
  } finally {await app.close(); await db.close(); await rm(dir,{recursive:true,force:true});}
});
