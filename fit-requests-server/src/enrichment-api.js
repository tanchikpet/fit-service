import {setTimeout as delay} from "node:timers/promises";

export const apiId = value => ((typeof value==="string" && /^[1-9]\d{0,18}$/.test(value)) ||
 (Number.isSafeInteger(value) && value>0)) ? String(value) : null;

export function requireId(value) {
 const id=apiId(value);
 if (!id) throw new Error("Invalid Kaiten identifier");
 return id;
}

export function apiError(status) {
 return Object.assign(new Error("Kaiten HTTP "+status),{status});
}

export function makeEnrichmentApi({config,fetcher=fetch,wait=delay,maxRequests=1500,signal}) {
 let count=0;
 let next=0;
 async function get(path,query={}) {
  const url=new URL(config.kaitenBase+"/api/latest"+path);
  for (const [key,value] of Object.entries(query)) url.searchParams.set(key,String(value));
  for (let attempt=0; attempt<3; attempt++) {
   signal?.throwIfAborted();
   if (count>=maxRequests) throw Object.assign(new Error("API request budget exhausted"),{budget:true});
   await wait(Math.max(0,next-performance.now()),undefined,{signal});
   next=performance.now()+250;
   count++;
   const timeout=AbortSignal.timeout(15000);
   const requestSignal=signal ? AbortSignal.any([signal,timeout]) : timeout;
   let response;
   try {
    response=await fetcher(url,{method:"GET",redirect:"error",signal:requestSignal,
     headers:{Authorization:"Bearer "+config.kaitenToken,Accept:"application/json"}});
   } catch {
    signal?.throwIfAborted();
    if (attempt===2) throw new Error("Kaiten connection failed");
   }
   if (response?.ok) {
    const reader=response.body.getReader();
    const pieces=[];
    let bytes=0;
    try {
     while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      bytes+=value.byteLength;
      if (bytes>8*1024*1024) throw new Error("API response too large");
      pieces.push(value);
     }
     const data=JSON.parse(Buffer.concat(pieces).toString("utf8"));
     return {data,headers:response.headers,status:response.status};
    } finally {await reader.cancel().catch(()=>{});}
   }
   const code=response?.status;
   const retryAfter=response?.headers.get("retry-after");
   const retryMs=retryAfter===null || retryAfter===undefined ? 0 :
    /^\d+$/.test(retryAfter) ? Number(retryAfter)*1000 : Math.max(0,Date.parse(retryAfter)-Date.now())||0;
   const resetMs=code===429 ? Math.max(0,Number(response.headers.get("x-ratelimit-reset")||0)*1000-Date.now()) : 0;
   const backoff=Math.max(retryMs,resetMs,code===429 ? 1200 : 500*2**attempt);
   await response?.body?.cancel().catch(()=>{});
   if (attempt===2 || code && code!==408 && code!==429 && code<500 || backoff>30000) throw apiError(code);
   await wait(backoff,undefined,{signal});
  }
 }
 async function list(path,mode="single",query={}) {
  const rows=[];
  const seen=new Set();
  let offset=0, after=null;
  for (let page=0;page<100;page++) {
   const params=mode==="single" ? query :
    {...query,limit:100,...(mode==="offset"?{offset}:after?{last_user_id:after}:{})};
   const {data,headers}=await get(path,params);
   if (!Array.isArray(data)) throw new Error("Expected an array from Kaiten");
   if (mode==="single") {
    if (!headers.has("x-pagination-limit")) return data;
    mode="offset";
   }
   const pageSize=Number(headers.get("x-pagination-limit")||100);
   if (!Number.isInteger(pageSize)||pageSize<1||pageSize>500||data.length>pageSize) throw new Error("Invalid Kaiten page size");
   for (const item of data) {
    const key=requireId(item.id ?? item.user_id);
    if (seen.has(key)) throw new Error("Pagination repeated a record");
    seen.add(key);
    rows.push(item);
   }
   if (data.length<pageSize) return rows;
   offset+=pageSize;
   if (mode==="user") {
    const greatest=data.map(x=>BigInt(requireId(x.id ?? x.user_id))).reduce((a,b)=>a>b?a:b);
    if (after!==null && greatest<=BigInt(after)) throw new Error("Kaiten user pagination did not advance");
    after=String(greatest);
   }
  }
  throw new Error("Kaiten page limit reached");
 }
 return {get,list,count:()=>count};
}
