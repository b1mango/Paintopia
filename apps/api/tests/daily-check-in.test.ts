import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "../src/createServer.js";
import { createAppDatabase, type AppDatabase } from "../src/db/database.js";
import { createDailyCheckInService } from "../src/services/dailyCheckIn.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function options() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paintopia-check-in-")); dirs.push(dataDir);
  return { dataDir, bootstrapEmail: "admin", bootstrapPassword: "test-password", inviteCode: "signup-test", webOrigin: "http://localhost", sessionSecret: "test" };
}
async function fixture() {
  const config = await options();
  const db = await createAppDatabase({ ...config, skipBootstrap: true });
  for (const id of ["alice", "bob"]) await db.execute("INSERT INTO users (id,email,password_hash,quota,created_at,updated_at) VALUES (?,?,'unused',66,0,0)", [id,id]);
  return { db, config };
}

it("registers with 66, authenticates check-in, rejects forged rewards and credits only once", async () => {
  const app = await createServer(await options());
  const db = (app as unknown as { paintopiaDb: AppDatabase }).paintopiaDb;
  try {
    for (const method of ["GET", "POST"] as const) expect((await app.inject({method,url:"/api/check-in"})).statusCode).toBe(401);
    const signup = await app.inject({method:"POST",url:"/api/auth/register",payload:{email:"new-artist",password:"test-password",inviteCode:"signup-test",quota:9999}});
    expect(signup.statusCode).toBe(200);
    expect(signup.json().quota).toBe(66);
    const cookie = String(signup.headers["set-cookie"]).split(";")[0];
    const headers = { cookie };
    const initial = await app.inject({url:"/api/check-in",headers});
    expect(initial.json()).toMatchObject({checkedIn:false,reward:5,remainingQuota:66,timeZone:"Asia/Shanghai"});
    const forged = await app.inject({method:"POST",url:"/api/check-in",headers,payload:{userId:"admin",reward:999,day:"2100-01-01"}});
    expect(forged.statusCode).toBe(400);
    expect(await db.query("SELECT * FROM usage_ledger")).toHaveLength(0);
    const claimed = await app.inject({method:"POST",url:"/api/check-in",headers,payload:{}});
    expect(claimed.json()).toMatchObject({credited:true,checkedIn:true,remainingQuota:71});
    expect(claimed.headers["cache-control"]).toBe("private, no-store");
    const duplicate = await app.inject({method:"POST",url:"/api/check-in",headers,payload:{}});
    expect(duplicate.json()).toMatchObject({credited:false,checkedIn:true,remainingQuota:71});
    expect((await app.inject({url:"/api/auth/me",headers})).json().quota).toBe(71);
    expect((await app.inject({url:"/api/check-in",headers})).json().checkedIn).toBe(true);
    const ledger = await db.query<{user_id:string;amount:number;action:string}>("SELECT user_id, amount, action FROM usage_ledger");
    expect(ledger).toEqual([{user_id:signup.json().id,amount:5,action:"daily_check_in"}]);
    for (let i=0;i<10;i++) await app.inject({method:"POST",url:"/api/check-in",headers,payload:{}});
    expect((await app.inject({method:"POST",url:"/api/check-in",headers,payload:{}})).statusCode).toBe(429);
    await db.execute("UPDATE users SET status='disabled' WHERE id=?",[signup.json().id]);
    expect((await app.inject({method:"POST",url:"/api/check-in",headers,payload:{}})).statusCode).toBe(401);
  } finally { await app.close(); }
});

it("deduplicates concurrent claims across service instances and keeps accounts separate", async () => {
  const {db} = await fixture();
  try {
    const first = createDailyCheckInService(db), second = createDailyCheckInService(db);
    const results = await Promise.all(Array.from({length:10},(_,i)=>(i%2?first:second).claim("alice")));
    expect(results.filter(result=>result.credited)).toHaveLength(1);
    expect(results.every(result=>result.remainingQuota===71)).toBe(true);
    expect(await second.status("bob")).toMatchObject({checkedIn:false,remainingQuota:66});
    expect(await second.claim("bob")).toMatchObject({credited:true,remainingQuota:71});
    expect(await db.query("SELECT * FROM usage_ledger")).toHaveLength(2);
  } finally { await db.close(); }
});

it("resets at Beijing midnight and persists the claimed day across restarts", async () => {
  const {db,config} = await fixture();
  let now = Date.parse("2026-11-03T15:59:59.999Z");
  const service = createDailyCheckInService(db,()=>now);
  expect(await service.claim("alice")).toMatchObject({day:"2026-11-03",credited:true,remainingQuota:71,nextResetAt:"2026-11-03T16:00:00.000Z"});
  now++;
  expect(await service.status("alice")).toMatchObject({day:"2026-11-04",checkedIn:false});
  expect(await service.claim("alice")).toMatchObject({day:"2026-11-04",credited:true,remainingQuota:76});
  await db.close();
  const restarted = await createAppDatabase({...config,skipBootstrap:true});
  try {
    const next = createDailyCheckInService(restarted,()=>now);
    expect(await next.claim("alice")).toMatchObject({credited:false,checkedIn:true,remainingQuota:76});
    expect(await restarted.query("SELECT * FROM usage_ledger WHERE user_id='alice'")).toHaveLength(2);
  } finally { await restarted.close(); }
});

it("rolls back the reward record and balance together if the credit fails", async () => {
  const {db} = await fixture();
  try {
    const original = db.transaction.bind(db);
    vi.spyOn(db,"transaction").mockImplementation(work => original(tx=>work({...tx,execute:async(sql,params)=>{
      if(sql.startsWith("UPDATE users SET quota")) throw new Error("controlled write failure");
      return tx.execute(sql,params);
    }})));
    await expect(createDailyCheckInService(db).claim("alice")).rejects.toThrow("controlled write failure");
    expect(await db.query("SELECT * FROM usage_ledger")).toHaveLength(0);
    expect((await db.queryOne<{quota:number}>("SELECT quota FROM users WHERE id='alice'"))?.quota).toBe(66);
    vi.restoreAllMocks();
    expect(await createDailyCheckInService(db).claim("alice")).toMatchObject({credited:true,remainingQuota:71});
  } finally { await db.close(); }
});
