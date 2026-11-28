import {listKaitenCards,normalizeCard} from "./kaiten.js";
import {upsertCards} from "./db.js";
const LOCK_ID=332384501; // a fixed process-wide PostgreSQL advisory lock id
export function makeSync({pool,config,fetcher=fetch}){
 let pending=false;
 async function run(reason="scheduled"){
  const client=await pool.connect();
  let locked=false;
  try{
   const lk=await client.query("SELECT pg_try_advisory_lock($1) AS acquired",[LOCK_ID]);
   if(!lk.rows[0].acquired)return {skipped:"another sync is running"};
   locked=true;
   const state=await client.query("SELECT last_success_at FROM kaiten_sync_state WHERE space_id=$1",[config.spaceId]);
   // Overlap 2 minutes, to allow for delayed records or clock skew.
   const last=state.rows[0]?.last_success_at;
   const since=last?new Date(new Date(last).getTime()-120000).toISOString():null;
   const started=new Date();
   const result=await listKaitenCards({base:config.kaitenBase,token:config.kaitenToken,spaceId:config.spaceId,updatedAfter:since,fetcher});
   const normalized=result.cards.map(c=>normalizeCard(c,config.spaceId)).filter(Boolean);
   await client.query("BEGIN");
   try{
    await upsertCards(client,normalized);
    await client.query(`INSERT INTO kaiten_sync_state(space_id,last_success_at,last_started_at,last_error,cards_seen,pages_seen)
      VALUES($1,$2,$3,NULL,$4,$5)
      ON CONFLICT(space_id) DO UPDATE SET last_success_at=EXCLUDED.last_success_at,last_started_at=EXCLUDED.last_started_at,last_error=NULL,cards_seen=EXCLUDED.cards_seen,pages_seen=EXCLUDED.pages_seen`,
     [config.spaceId,started,started,result.cards.length,result.pages]);
    await client.query("COMMIT");
   }catch(e){await client.query("ROLLBACK");throw e}
   console.info("Kaiten sync completed",{reason,cards:normalized.length,pages:result.pages});
   return {cards:normalized.length,pages:result.pages};
  }catch(error){
   // Do not log raw webhook payloads, credentials or full request URLs.
   console.error("Kaiten sync failed:",error.message);
   try{await client.query(`INSERT INTO kaiten_sync_state(space_id,last_started_at,last_error) VALUES($1,now(),$2)
      ON CONFLICT(space_id) DO UPDATE SET last_started_at=now(),last_error=EXCLUDED.last_error`,[config.spaceId,String(error.message).slice(0,200)])}catch{}
   throw error;
  }finally{if(locked)await client.query("SELECT pg_advisory_unlock($1)",[LOCK_ID]).catch(()=>{});client.release()}
 }
 function schedule(){if(pending)return;pending=true;setTimeout(()=>{pending=false;run("webhook").catch(()=>{})},5000).unref?.()}
 return {run,schedule};
}
