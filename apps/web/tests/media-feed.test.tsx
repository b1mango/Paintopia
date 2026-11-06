import {act, renderHook, waitFor} from "@testing-library/react";
import {afterEach, expect, it, vi} from "vitest";
import {apiClient, type GeneratedAsset} from "../src/lib/apiClient";
import {clearMediaCache, useMediaFeed} from "../src/lib/useMediaFeed";
const item=(id:string):GeneratedAsset=>({id,prompt:id,imageUrl:`/${id}`,createdAt:new Date().toISOString()});
afterEach(()=>{clearMediaCache();vi.restoreAllMocks();});
it("uses cursors and preserves a previous page when loading more fails",async()=>{
 const spy=vi.spyOn(apiClient,"listMediaFeed").mockResolvedValueOnce({items:[item("a")],nextCursor:"next"}).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({items:[item("b")],nextCursor:null});
 const {result}=renderHook(()=>useMediaFeed("assets","account1"));
 await waitFor(()=>expect(result.current.items).toHaveLength(1));
 await act(()=>result.current.loadMore());
 expect(result.current.items[0].id).toBe("a");expect(result.current.error).toBe("offline");
 await act(()=>result.current.loadMore());
 expect(result.current.items.map(i=>i.id)).toEqual(["a","b"]);
 expect(spy.mock.calls[1][1].get("cursor")).toBe("next");
});
it("ignores stale account responses and invalidates cached mutations",async()=>{
 let resolve!:(page:any)=>void;
 vi.spyOn(apiClient,"listMediaFeed").mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue({items:[item("second")],nextCursor:null});
 const {result,rerender,unmount}=renderHook(({account})=>useMediaFeed("assets",account),{initialProps:{account:"first"}});
 await waitFor(()=>expect(resolve).toBeDefined());
 rerender({account:"second"});await waitFor(()=>expect(result.current.items[0]?.id).toBe("second"));
 await act(async()=>resolve({items:[item("private-first")],nextCursor:null}));
 expect(result.current.items[0].id).toBe("second");
 act(()=>result.current.setItems([]));unmount();
 const next=renderHook(()=>useMediaFeed("assets","second"));
 expect(next.result.current.items).toEqual([]);
});
