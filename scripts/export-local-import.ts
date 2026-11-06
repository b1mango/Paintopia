import Database from "better-sqlite3";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import path from "node:path";
const root=path.resolve("data");
const db=new Database(path.join(root,"paintopia.sqlite"),{readonly:true});
try{
 const providers=db.prepare("SELECT * FROM provider_configs ORDER BY sort_order,id").all();
 const jobs=(db.prepare("SELECT * FROM generation_jobs ORDER BY created_at,id").all() as any[]).map(({user_id,...row})=>row);
 const assets=[];
 for(const a of db.prepare("SELECT * FROM assets ORDER BY created_at,id").all() as any[]){const file=path.resolve(root,"objects",a.original_path);if(!file.startsWith(root+path.sep))throw new Error("Invalid asset path");assets.push({id:a.id,job_id:a.job_id,prompt:a.prompt,params:JSON.parse(a.params_json),created_at:a.created_at,base64:(await readFile(file)).toString("base64")});}
 await mkdir(path.join(root,"exports"),{recursive:true});const file=path.join(root,"exports","paintopia-admin-import.json");await writeFile(file,JSON.stringify({version:1,providers,jobs,assets}),{mode:0o600});console.log(JSON.stringify({file,providers:providers.length,jobs:jobs.length,assets:assets.length}));
}finally{db.close();}
