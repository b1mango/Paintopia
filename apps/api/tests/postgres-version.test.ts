import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ create: vi.fn(), migrate: vi.fn(async (_client: unknown) => {}) }));
vi.mock("postgres", () => ({ default: mock.create }));
vi.mock("../src/db/migratePostgres.js", () => ({ migratePostgres: mock.migrate }));
import { createAppDatabase, SCHEMA_VERSION } from "../src/db/database.js";

afterEach(() => { vi.clearAllMocks(); });
function database(metadata: Record<string, string> | undefined) {
  let table = metadata;
  let tail = Promise.resolve();
  const unsafe = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === "SELECT key, value FROM schema_meta") {
      if (!table) throw Object.assign(new Error("missing table"), {code:"42P01"});
      return Object.entries(table).map(([key,value])=>({key,value}));
    }
    if(sql.startsWith("CREATE TABLE IF NOT EXISTS schema_meta"))table ??= {};
    if(sql.startsWith("INSERT INTO schema_meta")) {
      if(sql.includes("'schema_version'"))table!.schema_version=String(params[0]);
      else table![String(params[0])]=String(params[1]);
    }
    return Object.assign([], {count:1});
  });
  const transaction = {unsafe};
  const client = {
    unsafe,
    begin:vi.fn(async (work:(tx:typeof transaction)=>Promise<unknown>)=>{
      const previous=tail;let release!:()=>void;
      tail=new Promise(resolve=>{release=resolve;});await previous;
      const before=table?{...table}:undefined;
      try{return await work(transaction);}catch(error){table=before;throw error;}finally{release();}
    }),
    end:vi.fn(async()=>{})
  };
  mock.create.mockReturnValue(client);
  return {client,transaction};
}
const options={dataDir:"/unused",databaseUrl:"postgres://fixture.invalid/not-connected",bootstrapEmail:"unused",bootstrapPassword:"unused",skipBootstrap:true};

it("does exactly one SELECT and no transaction, DDL or seeds for a matching Postgres version",async()=>{
  const {client}=database({schema_version:SCHEMA_VERSION,owner_user_id:"owner"});
  const initialize=vi.fn(async()=>({}));
  const db=await createAppDatabase({...options,initialize});
  expect(client.unsafe.mock.calls.map(([sql])=>sql)).toEqual(["SELECT key, value FROM schema_meta"]);
  expect(client.begin).not.toHaveBeenCalled();expect(mock.migrate).not.toHaveBeenCalled();expect(initialize).not.toHaveBeenCalled();
  expect(db.startupMetadata.owner_user_id).toBe("owner");await db.close();
});

it("serializes concurrent new Postgres instances with a transaction advisory lock and rechecks the version",async()=>{
  const {client,transaction}=database(undefined);
  const initialize=vi.fn(async()=>({owner_user_id:"owner"}));
  const [first,second]=await Promise.all([createAppDatabase({...options,initialize}),createAppDatabase({...options,initialize})]);
  expect(client.begin).toHaveBeenCalledTimes(2);expect(mock.migrate).toHaveBeenCalledTimes(1);expect(initialize).toHaveBeenCalledTimes(1);
  expect(mock.migrate).toHaveBeenCalledWith(transaction);
  expect(client.unsafe.mock.calls.filter(([sql])=>sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
  const statements=client.unsafe.mock.calls.map(([sql])=>sql);
  expect(statements.indexOf("SELECT pg_advisory_xact_lock(73491822)")).toBeLessThan(statements.findIndex(sql=>sql.startsWith("CREATE TABLE")));
  expect(first.startupMetadata).toEqual(second.startupMetadata);
  expect(first.startupMetadata.schema_version).toBe(SCHEMA_VERSION);
  await first.close();await second.close();
});

it("does not record a new Postgres version when initialization fails",async()=>{
  const {client}=database({schema_version:"old"});
  await expect(createAppDatabase({...options,initialize:async()=>{throw new Error("seed failed");}})).rejects.toThrow("seed failed");
  expect(client.unsafe.mock.calls.some(([sql])=>sql.includes("VALUES ('schema_version'"))).toBe(false);
  expect(client.end).toHaveBeenCalledTimes(1);
});
