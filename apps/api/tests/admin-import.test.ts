import {it,expect} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {createServer} from "../src/createServer.js";
import type {AppDatabase} from "../src/db/database.js";
import type {AssetStorage} from "../src/services/assetStorage.js";
it.each([true,false])("authorizes import, keeps balances and passwords and applies the owner policy (%s)",async(isOwner)=>{
 const dir=await mkdtemp(path.join(tmpdir(),"import-test-"));
 const app=await createServer({dataDir:dir,bootstrapEmail:"admin",ownerEmail:isOwner?"admin":"owner",bootstrapPassword:"password",webOrigin:"http://localhost:5173",sessionSecret:"secret",providerEncryptionKey:"encryption"});
 try{
 const db=(app as any).paintopiaDb as AppDatabase;
 const storage=(app as any).paintopiaStorage as AssetStorage;
 const objects=new Map<string,Buffer>();let key="";
 storage.createUploadUrl=async k=>{key=k;return "https://bucket.example/upload"};storage.head=async k=>objects.has(k)?{sizeBytes:objects.get(k)!.length}:undefined;storage.read=async k=>objects.get(k)!;storage.put=async(k,b)=>{objects.set(k,b)};
 const login=await app.inject({method:"POST",url:"/api/auth/login",payload:{email:"admin",password:"password"}});const cookie=String(login.headers["set-cookie"]);
 const before=await db.queryOne<any>("SELECT * FROM users WHERE email='admin'");
 expect((await app.inject({method:"POST",url:"/api/admin/import/upload",payload:{}})).statusCode).toBe(401);
 const data={version:1,providers:[{id:"p",kind:"image",name:"provider",base_url:"https://example.com",api_key:"private-key",model:"test",mode:"generations",max_concurrency:1,enabled:1,sort_order:0,config_json:"{}",created_at:1,updated_at:1}],jobs:[{id:"j",provider_id:"p",status:"succeeded",prompt:"lake",params_json:"{}",error:null,created_at:1,updated_at:1}],assets:[{id:"a",job_id:"j",prompt:"lake",params:{},created_at:1,base64:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="}]};
 const bytes=Buffer.from(JSON.stringify(data));const sha256=createHash("sha256").update(bytes).digest("hex");
 const upload=await app.inject({method:"POST",url:"/api/admin/import/upload",headers:{cookie},payload:{sha256,size:bytes.length}});expect(upload.statusCode).toBe(200);const ticket=upload.json().ticket;
 objects.set(key,Buffer.from("broken"));expect((await app.inject({method:"POST",url:"/api/admin/import/review",headers:{cookie},payload:{ticket}})).statusCode).toBe(400);objects.set(key,bytes);
 const preview=await app.inject({method:"POST",url:"/api/admin/import/review",headers:{cookie},payload:{ticket}});expect(preview.json()).toMatchObject({assets:1,jobs:1});expect(await db.query("SELECT * FROM assets")).toHaveLength(0);
 expect((await app.inject({url:"/api/image-capabilities",headers:{cookie}})).json().models).toEqual([]);
 const applied=await app.inject({method:"POST",url:"/api/admin/import/apply",headers:{cookie},payload:{ticket}});expect(applied.statusCode,applied.body).toBe(200);expect(applied.json().completed).toBe(true);
 expect((await app.inject({url:"/api/image-capabilities",headers:{cookie}})).json().models).toEqual([expect.objectContaining({providerId:"p",resolutions:["1K"]})]);
 expect(JSON.parse((await db.queryOne<any>("SELECT params_json FROM assets WHERE id='a'"))!.params_json)).toMatchObject({actualWidth:1,actualHeight:1});
 expect(await db.queryOne("SELECT * FROM users WHERE email='admin'")).toEqual(before);
 expect(await db.query("SELECT * FROM usage_ledger")).toHaveLength(0);
 expect((await db.queryOne<any>("SELECT api_key FROM provider_configs WHERE id='p'"))!.api_key).toMatch(/^enc:v1:/);
 expect((await app.inject({method:"POST",url:"/api/admin/import/apply",headers:{cookie},payload:{ticket}})).json()).toMatchObject({assets:0,jobs:0});
 expect(await db.query("SELECT * FROM assets")).toHaveLength(1);
 const imported=await db.queryOne<any>("SELECT original_path,expires_at FROM assets WHERE id='a'");
 expect(imported.original_path.startsWith(isOwner?"permanent/":"temporary/")).toBe(true);
 if(isOwner)expect(imported.expires_at).toBeNull();else expect(Number(imported.expires_at)).toBeGreaterThan(Date.now()+6*86400000);
 await db.execute("UPDATE users SET role='user' WHERE id=?",[before.id]);expect((await app.inject({method:"POST",url:"/api/admin/import/apply",headers:{cookie},payload:{ticket}})).statusCode).toBe(403);
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
