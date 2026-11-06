import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import type { AppDatabase, DatabaseValue } from "../src/db/database.js";
import type { AssetStorage } from "../src/services/assetStorage.js";
import * as repo from "../src/db/repository.js";
import { createSession } from "../src/services/authService.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive:true,force:true}))); });
async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "performance-api-")); dirs.push(dataDir);
  const app = await createServer({dataDir,bootstrapEmail:"admin",bootstrapPassword:"test-password",webOrigin:"http://localhost",sessionSecret:"test"});
  const { paintopiaDb: db, paintopiaStorage: storage } = app as unknown as {paintopiaDb:AppDatabase;paintopiaStorage:AssetStorage};
  const admin = (await db.query<{id:string}>("SELECT id FROM users WHERE email='admin'"))[0];
  const headers = {cookie:`paintopia_session=${await createSession(db,admin.id)}`};
  const provider = {kind:"image",name:"Image",baseUrl:"https://provider.example.test",apiKey:"fixture-key",model:"image-model",mode:"generations",imageCapabilities:{supportsStreaming:false}};
  return {app,db,storage,headers,provider,admin};
}

it("uses only dimensions metadata and shares pending and cached capability queries", async () => {
  const { app, db, storage, headers, provider, admin } = await setup();
  try {
    const created = await app.inject({method:"POST",url:"/api/admin/providers",headers,payload:provider});
    const providerId = created.json().id;
    await db.execute("INSERT INTO generation_jobs (id,user_id,provider_id,status,prompt,params_json,created_at,updated_at) VALUES ('job',?,?,'succeeded','lake','{}',1,1)",[admin.id,providerId]);
    for (const [id, paramsJson] of [["legacy","{}"],["known",'{"actualWidth":2048,"actualHeight":2048}']]) {
      await repo.insertAsset(db,{id,userId:admin.id,jobId:"job",originalPath:`permanent/owner/${id}.png`,thumbPath:null,storageBackend:"r2",mimeType:"image/png",sizeBytes:100,status:"ready",expiresAt:null,prompt:"lake",paramsJson,createdAt:new Date()});
    }
    const read = vi.spyOn(storage,"read"); const head = vi.spyOn(storage,"head");
    let release!:()=>void;
    const gate = new Promise<void>(resolve => {release=resolve;});
    const original = db.query.bind(db);
    const query = vi.spyOn(db,"query").mockImplementation(async <T>(sql:string, params:DatabaseValue[]=[]) => {
      if (sql.includes("LIMIT 512")) await gate;
      return original<T>(sql,params);
    });
    const requests = Array.from({length:4},()=>app.inject({url:"/api/image-capabilities",headers}));
    const pending = Promise.all(requests);
    await vi.waitFor(()=>expect(query.mock.calls.filter(([sql])=>sql.includes("LIMIT 512"))).toHaveLength(1));
    release();
    const results = await pending;
    for (const result of results) expect(result.json().models[0].resolutions).toEqual(["1K","2K"]);
    await app.inject({url:"/api/image-capabilities",headers});
    expect(query.mock.calls.filter(([sql])=>sql.includes("LIMIT 512"))).toHaveLength(1);
    expect(read).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled();
    const patched = await app.inject({method:"PATCH",url:`/api/admin/providers/${providerId}`,headers,payload:{...provider,name:"Updated",apiKey:""}});
    expect(patched.statusCode).toBe(200);
    expect((await app.inject({url:"/api/image-capabilities",headers})).json().models[0].providerName).toBe("Updated");
    expect(query.mock.calls.filter(([sql])=>sql.includes("LIMIT 512"))).toHaveLength(2);
    await app.inject({method:"POST",url:"/api/admin/providers",headers,payload:{...provider,name:"Second"}});
    expect((await app.inject({url:"/api/image-capabilities",headers})).json().models).toHaveLength(2);
    await app.inject({method:"DELETE",url:`/api/admin/providers/${providerId}`,headers});
    expect((await app.inject({url:"/api/image-capabilities",headers})).json().models).toHaveLength(1);
    const clock = vi.spyOn(Date,"now"); const now = Date.now(); clock.mockReturnValue(now+60001);
    await app.inject({url:"/api/image-capabilities",headers});
    expect(query.mock.calls.filter(([sql])=>sql.includes("LIMIT 512"))).toHaveLength(5);
  } finally { await app.close(); }
});

it("invalidates observed sizes after new images finish generation", async () => {
  const { app, headers, provider } = await setup();
  try {
    await app.inject({method:"POST",url:"/api/admin/providers",headers,payload:provider});
    expect((await app.inject({url:"/api/image-capabilities",headers})).json().models[0].resolutions).toEqual(["1K"]);
    const image = await sharp({create:{width:2048,height:2048,channels:3,background:"white"}}).webp().toBuffer();
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({data:[{b64_json:image.toString("base64")}]}))));
    const generated = await app.inject({method:"POST",url:"/api/generate",headers,payload:{prompt:"lake",params:{quality:"low"}}});
    expect(generated.statusCode).toBe(200);
    expect(generated.json().assets[0].params).toMatchObject({actualWidth:2048,actualHeight:2048});
    expect((await app.inject({url:"/api/image-capabilities",headers})).json().models[0].resolutions).toEqual(["1K","2K"]);
  } finally { await app.close(); }
});

it("signs gallery and history thumbnails only after visibility checks without touching storage", async () => {
  vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL","https://media.example.test");
  vi.stubEnv("PAINTOPIA_MEDIA_SIGNING_KEY","fixture-signing-key");
  const { app, db, storage, headers, admin } = await setup();
  try {
    await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES ('other','other','unused','user','active',100,1,1)");
    const otherHeaders={cookie:`paintopia_session=${await createSession(db,"other")}`};
    for (const id of ["public","private","missing"]) {
      await repo.insertAsset(db,{id,userId:admin.id,jobId:null,originalPath:`permanent/owner/${id}.png`,thumbPath:`thumbnails/${id}.webp`,storageBackend:"local",mimeType:"image/png",sizeBytes:1,status:"ready",expiresAt:null,prompt:"lake",paramsJson:"{}",createdAt:new Date()});
      await storage.put(`thumbnails/${id}.webp`,Buffer.from("fixture"),"image/webp");
      if(id!=="missing")await storage.put(`thumbnails/${id}-320.webp`,Buffer.from("fixture"),"image/webp");
      await db.execute("INSERT INTO gallery_items(id,asset_id,user_id,title,prompt,status,created_at) VALUES (?,?,?,'lake','lake',?,1)",[id,id,admin.id,id==="public"?"approved":"pending"]);
    }
    const read=vi.spyOn(storage,"read"),put=vi.spyOn(storage,"put"),head=vi.spyOn(storage,"head");
    for(const url of ["/api/media-feed/gallery","/api/gallery"]){
      const response=await app.inject({url,headers:otherHeaders});expect(response.statusCode).toBe(200);
      const items=url.includes("media-feed")?response.json().items:response.json();
      expect(items.map((v:{id:string})=>v.id)).toEqual(["public"]);
      expect(new URL(items[0].thumbnailEdgeUrl,"https://paintopia.test").searchParams.get("key")).toBe("thumbnails/public.webp");
      expect(items[0].thumbnailEdgeExpiresAt).toBeGreaterThan(Date.now()+100000);
      expect(Number(new URL(items[0].thumbnailEdgeUrl,"https://paintopia.test").searchParams.get("expires"))*1000).toBeLessThanOrEqual(Date.now()+240000);
    }
    for(const url of ["/api/assets","/api/assets?scope=mine&page=1&pageSize=20"]){
      const response=await app.inject({url,headers});expect(response.statusCode).toBe(200);
      const items=Array.isArray(response.json())?response.json():response.json().items;
      expect(new URL(items.find((v:{id:string})=>v.id==="public").thumbnailEdgeUrl,"https://paintopia.test").searchParams.get("key")).toBe("thumbnails/public-320.webp");
      expect(new URL(items.find((v:{id:string})=>v.id==="missing").thumbnailEdgeUrl,"https://paintopia.test").searchParams.get("key")).toBe("thumbnails/missing-320.webp");
      expect(items.every((v:{thumbnailEdgeExpiresAt:number})=>v.thumbnailEdgeExpiresAt>Date.now()+100000)).toBe(true);
    }
    expect((await app.inject({url:"/api/assets",headers:otherHeaders})).json()).toEqual([]);
    await db.execute("UPDATE gallery_items SET status='pending' WHERE id='public'");
    expect((await app.inject({url:"/api/media-feed/gallery",headers:otherHeaders})).json().items).toEqual([]);
    expect((await app.inject({url:"/api/gallery",headers:otherHeaders})).json()).toEqual([]);
    expect((await app.inject({url:"/api/assets"})).statusCode).toBe(401);
    expect(read).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();expect(head).not.toHaveBeenCalled();
  } finally {await app.close();}
});

it("does not restore an obsolete in-flight capability result after a configuration write",async()=>{
  const {app,db,headers,provider}=await setup();
  try{
    const created=await app.inject({method:"POST",url:"/api/admin/providers",headers,payload:provider});
    const original=db.query.bind(db);
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const query=vi.spyOn(db,"query").mockImplementation(async <T>(sql:string,params:DatabaseValue[]=[])=>{
      if(sql.includes("LIMIT 512"))await gate;
      return original<T>(sql,params);
    });
    const pending=app.inject({url:"/api/image-capabilities",headers}).then(response=>response.json());
    await vi.waitFor(()=>expect(query.mock.calls.filter(([sql])=>sql.includes("LIMIT 512"))).toHaveLength(1));
    await app.inject({method:"PATCH",url:`/api/admin/providers/${created.json().id}`,headers,payload:{...provider,name:"Changed",apiKey:""}});
    release();expect((await pending).models[0].providerName).toBe("Image");
    expect((await app.inject({url:"/api/image-capabilities",headers})).json().models[0].providerName).toBe("Changed");
    expect(query.mock.calls.filter(([sql])=>sql.includes("LIMIT 512"))).toHaveLength(2);
  }finally{await app.close();}
});
