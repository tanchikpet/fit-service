const PAGE_SIZE=100;
export const normalizeCard=(c,spaceId)=>{
 if(!Number.isSafeInteger(Number(c?.id)))return null;
 const members=Array.isArray(c.members)?c.members.map(m=>typeof m==="object"?m?.id:m).filter(x=>Number.isSafeInteger(Number(x))).map(Number):[];
 return {id:Number(c.id),spaceId,updated:c.updated||null,title:String(c.title||""),boardId:c.board_id??c.board?.id??null,columnId:c.column_id??c.column?.id??null,laneId:c.lane_id??c.lane?.id??null,status:c.state===undefined||c.state===null?null:String(c.state),archived:Boolean(c.archived),assigneeIds:members,ownerId:c.owner_id??null,estimateRaw:c.size??null,estimateUnit:c.size_unit??null,estimateText:c.size_text??null,spentRaw:c.time_spent_sum??null,childrenCount:c.children_count??0,childrenDone:c.children_done??0,raw:c};
};
export async function listKaitenCards({base,token,spaceId,updatedAfter,fetcher=fetch,maxPages=300}){
 const cards=[];let pages=0;
 for(let offset=0;pages<maxPages;offset+=PAGE_SIZE){
  const url=new URL(base+"/api/latest/cards");url.searchParams.set("space_id",String(spaceId));url.searchParams.set("limit",String(PAGE_SIZE));url.searchParams.set("offset",String(offset));
  if(updatedAfter)url.searchParams.set("updated_after",updatedAfter);
  const res=await fetcher(url,{headers:{Authorization:"Bearer "+token,Accept:"application/json"},signal:AbortSignal.timeout(20000)});
  if(!res.ok)throw Error("Kaiten API HTTP "+res.status);
  const batch=await res.json();
  if(!Array.isArray(batch))throw Error("Unexpected Kaiten response: cards must be an array");
  pages++;cards.push(...batch);
  if(batch.length<PAGE_SIZE)return {cards,pages};
 }
 throw Error("Kaiten pagination safety limit exceeded: sync aborted; cursor not advanced");
}

const idPattern = /^[1-9][0-9]{0,18}$/;
function locationId(value, optional = false) {
 if (optional && value == null) return null;
 if ((typeof value !== "string" && !Number.isSafeInteger(value)) ||
     !idPattern.test(String(value)) || BigInt(value) > 9223372036854775807n) {
  throw new Error("Invalid ID in Kaiten location history");
 }
 return String(value);
}

export function kaitenTimestamp(value) {
 if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
 const date = new Date(value);
 return Number.isFinite(date.getTime()) ? date : null;
}

// The documented endpoint returns a single array, with no pagination parameters.
export async function listKaitenLocations({base, token, cardId, fetcher = fetch,
 wait = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
 const url = new URL(base + "/api/latest/cards/" + locationId(cardId) + "/location-history");
 for (let attempt = 0; ; attempt++) {
  let response;
  try {
   response = await fetcher(url, {
    headers: {Authorization: "Bearer " + token, Accept: "application/json"},
    signal: AbortSignal.timeout(20000), redirect: "error"
   });
  } catch {
   if (attempt === 3) throw new Error("Kaiten location history request failed");
  }
  if (response?.ok) {
   const data = await response.json();
   if (!Array.isArray(data) || response.status !== 200 || response.headers.has("content-range") ||
       /rel\s*=\s*"?next\b/i.test(response.headers.get("link") || "")) {
    throw new Error("Unexpected Kaiten location history response");
   }
   return data.map(event => {
    const changed = kaitenTimestamp(event?.changed);
    if (!changed || locationId(event.card_id) !== String(cardId) ||
        (event.condition != null && !Number.isInteger(event.condition))) {
     throw new Error("Invalid Kaiten location history event");
    }
    return {
     event_id: locationId(event.id), changed_at: event.changed,
     board_id: locationId(event.board_id, true), column_id: locationId(event.column_id, true),
     subcolumn_id: locationId(event.subcolumn_id, true), lane_id: locationId(event.lane_id, true),
     sprint_id: locationId(event.sprint_id, true), author_id: locationId(event.author_id, true), condition: event.condition ?? null
    };
   });
  }
  const status = response?.status;
  const temporary = !response || status === 408 || status === 429 || status >= 500;
  const retryAfter = response?.headers.get("retry-after");
  const retryDelay = retryAfter == null ? 0 : /^\d+$/.test(retryAfter)
   ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
  const reset = status === 429 ? Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now() : 0;
  const serverDelay = Math.max(0,retryDelay,reset || 0);
  await response?.body?.cancel();
  // Leave long throttling windows for a subsequent run.
  if (!temporary || attempt === 3 || serverDelay > 60000) {
   throw Object.assign(new Error("Kaiten location history HTTP " + status), {status});
  }
  await wait(Math.max(serverDelay, 500 * 2 ** attempt + Math.random() * 250));
 }
}
