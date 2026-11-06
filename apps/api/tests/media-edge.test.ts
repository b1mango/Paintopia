import {afterEach, expect, it, vi} from "vitest";
import {createMediaEdgeUrl} from "../src/services/mediaEdge.js";
// @ts-expect-error Worker is a standalone ES module deployed outside the API build.
import worker from "../../../infra/cloudflare/media-worker/worker.mjs";

/** The API hands out same-origin `/edge?…`; the web domain forwards it to the worker unchanged. */
const atWorker=(...args:Parameters<typeof createMediaEdgeUrl>)=>new URL(createMediaEdgeUrl(...args)!,"https://media.example.test").toString();
afterEach(()=> {vi.unstubAllEnvs();vi.unstubAllGlobals();});
it("authenticates before edge cache access, including warm cache, and bounds browser caching",async()=>{
  vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL","https://media.example.test");
  vi.stubEnv("PAINTOPIA_MEDIA_SIGNING_KEY","test-only-signing-key");
  const match=vi.fn(async()=>new Response("thumb",{headers:{"Content-Type":"image/webp"}}));
  vi.stubGlobal("caches",{default:{match}});
  const env={MEDIA_SIGNING_KEY:"test-only-signing-key"};
  const url=atWorker("thumbnails/a-320.webp");
  expect(createMediaEdgeUrl("thumbnails/a-320.webp")).toMatch(/^\/edge\?key=thumbnails%2Fa-320\.webp&expires=\d+&signature=[0-9a-f]{64}$/);
  expect((await worker.fetch(new Request(url),env,{})).status).toBe(200);
  expect(match).toHaveBeenCalledTimes(1);
  expect((await worker.fetch(new Request(url.replace("a-320","b-320")),env,{})).status).toBe(403);
  const expired=atWorker("thumbnails/a-320.webp",Date.now()-300_000);
  expect((await worker.fetch(new Request(expired),env,{})).status).toBe(403);
  expect((await worker.fetch(new Request("https://media.example.test?key=thumbnails/a.webp"),env,{})).status).toBe(403);
  expect(match).toHaveBeenCalledTimes(1);
  expect(createMediaEdgeUrl("temporary/config.json")).toBeNull();
  const response=await worker.fetch(new Request(url),env,{});
  const maxAge=Number(/max-age=(\d+)/.exec(response.headers.get("cache-control")!)![1]);
  expect(maxAge).toBeGreaterThanOrEqual(110);
  expect(maxAge).toBeLessThanOrEqual(240);
});
it("keeps one signed URL per object within a two-minute window so browsers can reuse cached bytes",()=>{
  vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL","https://media.example.test");
  vi.stubEnv("PAINTOPIA_MEDIA_SIGNING_KEY","test-only-signing-key");
  const windowStart=Math.floor(Date.now()/120_000)*120_000;
  const first=createMediaEdgeUrl("thumbnails/a.webp",windowStart+1_000)!;
  expect(createMediaEdgeUrl("thumbnails/a.webp",windowStart+119_000)).toBe(first);
  expect(createMediaEdgeUrl("thumbnails/a.webp",windowStart+121_000)).not.toBe(first);
  for(const offset of [0,60_000,119_999]){
    const now=windowStart+offset, expires=Number(new URL(atWorker("thumbnails/a.webp",now)).searchParams.get("expires"));
    expect(expires-now/1000).toBeGreaterThan(120);
    expect(expires-now/1000).toBeLessThanOrEqual(240);
  }
});
it("streams original downloads, signs filenames, supports ranges and never caches partial bodies",async()=>{
  vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL","https://media.example.test");vi.stubEnv("PAINTOPIA_MEDIA_SIGNING_KEY","test-only-signing-key");
  const put=vi.fn(async()=>{}),get=vi.fn(async(_key,options)=>({size:4,httpEtag:'"test"',httpMetadata:{contentType:"image/png"},body:options?new Uint8Array([2,3]):new Uint8Array([1,2,3,4])}));
  vi.stubGlobal("caches",{default:{match:vi.fn(async()=>undefined),put}});
  const env={MEDIA_SIGNING_KEY:"test-only-signing-key",ASSETS:{head:vi.fn(async()=>({size:4,httpEtag:'"test"',httpMetadata:{contentType:"image/png"}})),get}};
  const tasks:Promise<unknown>[]=[];const ctx={waitUntil:(p:Promise<unknown>)=>tasks.push(p)};
  const url=atWorker("permanent/user/image.png",Date.now(),"paintopia-image.png");
  const full=await worker.fetch(new Request(url),env,ctx);
  expect(full.status).toBe(200);expect(full.headers.get("content-disposition")).toContain("paintopia-image.png");expect(full.headers.get("content-length")).toBe("4");
  expect(get).toHaveBeenCalledTimes(1);expect(env.ASSETS.head).not.toHaveBeenCalled();
  expect(await full.arrayBuffer()).toHaveProperty("byteLength",4);await Promise.all(tasks);expect(put).toHaveBeenCalledTimes(1);
  const range=await worker.fetch(new Request(url,{headers:{Range:"bytes=1-2"}}),env,ctx);
  expect(range.status).toBe(206);expect(range.headers.get("content-range")).toBe("bytes 1-2/4");expect(await range.arrayBuffer()).toHaveProperty("byteLength",2);expect(get).toHaveBeenLastCalledWith("permanent/user/image.png",{range:{offset:1,length:2}});expect(put).toHaveBeenCalledTimes(1);
  expect((await worker.fetch(new Request(url,{headers:{Range:"bytes=9-10"}}),env,ctx)).status).toBe(416);
  const calls=get.mock.calls.length;expect((await worker.fetch(new Request(url,{method:"HEAD"}),env,ctx)).status).toBe(200);expect(get).toHaveBeenCalledTimes(calls);
  expect((await worker.fetch(new Request(url.replace("paintopia-image.png","other.png")),env,ctx)).status).toBe(403);
  expect(createMediaEdgeUrl("temporary/user/config.json")).toBeNull();
});

it("keeps HEAD, If-Range, missing objects and attachment cache metadata semantics",async()=>{
  vi.stubEnv("PAINTOPIA_MEDIA_EDGE_URL","https://media.example.test");vi.stubEnv("PAINTOPIA_MEDIA_SIGNING_KEY","test-only-signing-key");
  const metadata={size:4,httpEtag:'"version"',httpMetadata:{contentType:"image/webp"}};
  const head=vi.fn(async()=>metadata);
  const get=vi.fn(async(_key:string,options?:{range:{offset:number;length:number}})=>({...metadata,body:new Uint8Array(options?options.range.length:4)}));
  const put=vi.fn(async()=>{});
  vi.stubGlobal("caches",{default:{match:vi.fn(async()=>undefined),put}});
  const env={MEDIA_SIGNING_KEY:"test-only-signing-key",ASSETS:{head,get}};
  const tasks:Promise<unknown>[]=[];const ctx={waitUntil:(p:Promise<unknown>)=>tasks.push(p)};
  const url=atWorker("thumbnails/a-320.webp",Date.now(),"image.webp");
  const full=await worker.fetch(new Request(url),env,ctx);
  expect(head).not.toHaveBeenCalled();expect(get).toHaveBeenCalledTimes(1);
  expect(full.headers.get("etag")).toBe('"version"');expect(full.headers.get("content-type")).toBe("image/webp");
  await full.arrayBuffer();await Promise.all(tasks);
  const cached=put.mock.calls[0] as unknown as [Request,Response];
  expect(cached[1].headers.get("cache-control")).toBe("public,max-age=86400");
  expect(cached[1].headers.has("content-disposition")).toBe(false);
  const partial=await worker.fetch(new Request(url,{headers:{Range:"bytes=-2","If-Range":'"version"'}}),env,ctx);
  expect(partial.status).toBe(206);expect(partial.headers.get("content-range")).toBe("bytes 2-3/4");
  expect(get).toHaveBeenLastCalledWith("thumbnails/a-320.webp",{range:{offset:2,length:2}});
  const mismatch=await worker.fetch(new Request(url,{headers:{Range:"bytes=1-2","If-Range":'"old"'}}),env,ctx);
  expect(mismatch.status).toBe(200);expect(get).toHaveBeenLastCalledWith("thumbnails/a-320.webp",undefined);
  const getCalls=get.mock.calls.length;
  const headResponse=await worker.fetch(new Request(url,{method:"HEAD",headers:{Range:"bytes=1-2"}}),env,ctx);
  expect(headResponse.status).toBe(206);expect(headResponse.headers.get("content-length")).toBe("2");
  expect(await headResponse.text()).toBe("");expect(get).toHaveBeenCalledTimes(getCalls);
  for(const range of ["bytes=","bytes=8-9","bytes=1-2,3-4"]){
    expect((await worker.fetch(new Request(url,{headers:{Range:range}}),env,ctx)).status).toBe(416);
  }
  get.mockResolvedValueOnce(null as never);
  const missing=await worker.fetch(new Request(url),env,ctx);
  expect(missing.status).toBe(404);expect(missing.headers.get("cache-control")).toBe("no-store");
  await Promise.all(tasks);
});
