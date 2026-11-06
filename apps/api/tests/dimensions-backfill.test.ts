import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { backfillAssetDimensions } from "../scripts/backfill-asset-dimensions.js";
import { createAppDatabase } from "../src/db/database.js";
import { createAssetStorage } from "../src/services/assetStorage.js";

it("bounds offline reads, skips known sizes and keeps dry-run free of writes",async()=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),"dimension-backfill-"));
  const db=await createAppDatabase({dataDir,bootstrapEmail:"admin",bootstrapPassword:"test",skipBootstrap:true});
  const storage=createAssetStorage(dataDir);
  try{
    await db.execute("INSERT INTO users(id,email,password_hash,role,status,quota,created_at,updated_at) VALUES ('u','user','unused','user','active',0,1,1)");
    const bytes=await sharp({create:{width:37,height:53,channels:3,background:"white"}}).png().toBuffer();
    for(const id of ["a","b","c","known","missing"]){
      await db.execute("INSERT INTO assets(id,user_id,original_path,storage_backend,mime_type,status,prompt,params_json,created_at) VALUES (?,'u',?,'local','image/png','ready','lake',?,1)",[id,`temporary/u/${id}.png`,id==="known"?'{"actualWidth":37,"actualHeight":53}':'{"quality":"high"}']);
      if(id!=="missing")await storage.put(`temporary/u/${id}.png`,bytes,"image/png");
    }
    const execute=vi.spyOn(db,"execute"),put=vi.spyOn(storage,"put");
    let active=0,maxActive=0;
    const original=storage.read;
    const read=vi.spyOn(storage,"read").mockImplementation(async key=>{
      active++;maxActive=Math.max(maxActive,active);
      try{return await original(key);}finally{active--;}
    });
    const dry=await backfillAssetDimensions(db,storage,{dataDir,concurrency:2,dryRun:true});
    expect(dry).toEqual({scanned:5,missing:4,decoded:3,updated:0,failed:["missing"]});
    expect(maxActive).toBeLessThanOrEqual(2);expect(read).toHaveBeenCalledTimes(4);
    expect(execute).not.toHaveBeenCalled();expect(put).not.toHaveBeenCalled();
    const applied=await backfillAssetDimensions(db,storage,{dataDir,concurrency:2,dryRun:false});
    expect(applied.updated).toBe(3);
    const row=await db.queryOne<{params_json:string}>("SELECT params_json FROM assets WHERE id='a'");
    expect(JSON.parse(row!.params_json)).toEqual({quality:"high",actualWidth:37,actualHeight:53});
    const repeated=await backfillAssetDimensions(db,storage,{dataDir,concurrency:2,dryRun:false});
    expect(repeated.updated).toBe(0);expect(repeated.missing).toBe(1);
  }finally{await db.close();await rm(dataDir,{recursive:true,force:true});}
});
