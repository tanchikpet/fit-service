import {loadConfig} from "./config.js";
import {makeDb,setupEnrichment} from "./db.js";
import {runEnrichment} from "./enrichment.js";

const [command,...args]=process.argv.slice(2);
const options=new Map(args.map(arg=>arg.split("=")));
const limit=Number(options.get("--limit")??25);
const cardId=options.get("--card")??null;
if (!["--migrate","dictionaries","initial","pending","property-428033"].includes(command) ||
 args.length!==options.size || args.some(arg=>!/^--(?:card|limit)=\d+$/.test(arg)) ||
 (!["initial","pending"].includes(command)&&args.length) || !Number.isInteger(limit)||limit<1||limit>100 ||
 cardId!==null&&!/^[1-9]\d{0,17}$/.test(cardId)) {
 console.error("Usage: npm run enrichment -- --migrate | dictionaries | initial | pending | property-428033 [--limit=25] [--card=ID]");
 process.exitCode=2;
} else {
 let pool;
 try {
  if (command==="--migrate") {
   if (!process.env.DATABASE_URL) throw new Error("Missing database");
   pool=makeDb(process.env.DATABASE_URL);
   await setupEnrichment(pool);
   console.info("Enrichment schema ready");
  } else {
   const config=loadConfig();
   pool=makeDb(config.databaseUrl);
   if (command==="property-428033") {
    const {rows}=await pool.query(`SELECT source,entity_id,value FROM kaiten_dictionary_versions
     WHERE space_id=$1 AND replaced_at IS NULL AND ((source='properties' AND entity_id='428033')
      OR source IN ('property:428033','select-values:428033','catalog-values:428033')) ORDER BY source,entity_id`,[config.spaceId]);
    console.info(JSON.stringify(rows.map(row=>({source:row.source,id:row.entity_id,
     name:row.value.name??row.value.title??null,type:row.value.type??null,value:row.value.value??null}))));
   } else {
    const result=await runEnrichment({pool,config,mode:command,limit,cardId});
    console.info(result);
    if (result.skipped||result.error||result.forbidden||result.not_found) process.exitCode=1;
   }
  }
 } catch(error) {
  console.error("Enrichment stopped.",error.status ? "Kaiten HTTP "+error.status : error.budget ? "Safety limit reached." : "Check configuration and source schema.");
  process.exitCode=1;
 } finally {await pool?.end();}
}
