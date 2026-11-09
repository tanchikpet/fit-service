const PAGE_SIZE=100;
export const normalizeCard=(c,spaceId)=>{
 if(!Number.isSafeInteger(Number(c?.id)))return null;
 const members=Array.isArray(c.members)?c.members.map(m=>typeof m==="object"?m?.id:m).filter(x=>Number.isSafeInteger(Number(x))).map(Number):[];
 return {id:Number(c.id),spaceId,updated:c.updated||null,title:String(c.title||""),boardId:c.board_id??c.board?.id??null,columnId:c.column_id??c.column?.id??null,laneId:c.lane_id??c.lane?.id??null,status:c.state??null,archived:Boolean(c.archived),assigneeIds:members,ownerId:c.owner_id??null,estimateRaw:c.size??null,estimateUnit:c.size_unit??null,estimateText:c.size_text??null,spentRaw:c.time_spent_sum??null,childrenCount:c.children_count??0,childrenDone:c.children_done??0,raw:c};
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
