// Only signed image objects are accessible; authenticate even on a warm cache.
const imageKey = /^(?:thumbnails\/[\w-]+\.webp|(?:temporary|pending|permanent)\/[\w-]+\/[\w-]+\.(?:png|jpe?g|webp)|gallery\/[\w-]+\.(?:png|jpe?g|webp))$/;
export default {
  async fetch(request, env, ctx) {
    if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405});
    const url=new URL(request.url), key=url.searchParams.get('key')||'', expires=url.searchParams.get('expires')||'', signature=url.searchParams.get('signature')||'', download=url.searchParams.get('download')||'';
    const now=Math.floor(Date.now()/1000);
    if(!imageKey.test(key)||!/^\d+$/.test(expires)||Number(expires)<now||Number(expires)>now+300||!/^[a-f0-9]{64}$/.test(signature)||!env.MEDIA_SIGNING_KEY|| (download&&!/^[\w.-]{1,150}$/.test(download)))return new Response(null,{status:403});
    const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.MEDIA_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const bytes=Uint8Array.from(signature.match(/../g),hex=>parseInt(hex,16));
    const payload=`${key}\n${expires}${download?`\n${download}`:''}`;
    if(!await crypto.subtle.verify('HMAC',signingKey,bytes,new TextEncoder().encode(payload)))return new Response(null,{status:403});
    const headers=new Headers({'Cache-Control':`private,max-age=${Math.min(300,Math.max(0,Number(expires)-now))}`,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Accept-Ranges':'bytes'});
    if(download)headers.set('Content-Disposition',`attachment; filename="${download}"`);
    const cache=caches.default, cacheKey=new Request(`${url.origin}/objects/${key}`);
    let range=request.headers.get('Range');
    const ifRange=request.headers.get('If-Range');
    // Cloudflare cache serves byte ranges from complete cached objects.
    const cached=await cache.match(new Request(cacheKey,{headers:range?{Range:range}:{}}));
    if(cached && (!ifRange || ifRange===cached.headers.get("ETag")) && (!range||cached.status===206)) {
      for(const name of ['Content-Type','Content-Length','Content-Range','ETag'])if(cached.headers.has(name))headers.set(name,cached.headers.get(name));
      headers.set('X-Paintopia-Cache','HIT');
      return new Response(request.method==='HEAD'?null:cached.body,{status:cached.status,headers});
    }
    const fullGet=request.method==='GET'&&!range;
    const completeObject=fullGet?await env.ASSETS.get(key):null;
    const metadata=fullGet?completeObject:await env.ASSETS.head(key);
    if(!metadata)return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}});
    headers.set('Content-Type',metadata.httpMetadata?.contentType||({'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp'}[key.split('.').pop()]));
    headers.set('ETag',metadata.httpEtag);
    headers.set('X-Paintopia-Cache','MISS');
    if(ifRange && ifRange!==metadata.httpEtag)range=null;
    let offset=0,length=metadata.size,status=200;
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${metadata.size}`}});
      const start=match[1]?Number(match[1]):Math.max(0,metadata.size-Number(match[2]));
      const end=match[1]?(match[2]?Math.min(Number(match[2]),metadata.size-1):metadata.size-1):metadata.size-1;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=metadata.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${metadata.size}`}});
      offset=start;length=end-start+1;status=206;headers.set('Content-Range',`bytes ${start}-${end}/${metadata.size}`);
    }
    headers.set('Content-Length',String(length));
    if(request.method==='HEAD')return new Response(null,{status,headers});
    const object=fullGet?completeObject:await env.ASSETS.get(key,status===206?{range:{offset,length}}:undefined);
    if(!object)return new Response(null,{status:404});
    const response=new Response(object.body,{status,headers});
    if(status===200){
      const copy=response.clone(),cacheHeaders=new Headers(headers);
      cacheHeaders.set('Cache-Control','public,max-age=86400');cacheHeaders.delete('Content-Disposition');cacheHeaders.delete('X-Paintopia-Cache');
      ctx.waitUntil(cache.put(cacheKey,new Response(copy.body,{headers:cacheHeaders})).catch(()=>{}));
    }
    return response;
  }
};
