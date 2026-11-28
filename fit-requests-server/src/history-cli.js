import {loadConfig} from "./config.js";
import {makeDb, setupHistory} from "./db.js";
import {refreshHistory} from "./history.js";

const args = process.argv.slice(2);
const migrate = args.length === 1 && args[0] === "--migrate";
const authors = args.length === 1 && args[0] === "--authors";
const all = args.length === 1 && args[0] === "--all";
const ids = args.filter(arg => /^--card=[1-9]\d{0,17}$/.test(arg)).map(arg => arg.slice(7));
if (args.length && !migrate && !all && !authors && ids.length !== args.length) {
 console.error("Usage: npm run history -- [--migrate | --all | --authors | --card=ID ...]");
 process.exitCode = 2;
} else {
 let pool;
 try {
  if (migrate) {
   if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL");
   pool = makeDb(process.env.DATABASE_URL);
   await setupHistory(pool);
   console.info("History schema ready");
  } else {
   const config = loadConfig();
   pool = makeDb(config.databaseUrl);
   const totals = await refreshHistory({pool,config,mode:all ? "all" : authors ? "authors" : "pending",ids});
   console.info(totals);
   if (totals.error || totals.forbidden || totals.not_found || totals.skipped) process.exitCode = 1;
  }
 } catch {
  console.error("History command failed. Check configuration and database schema.");
  process.exitCode = 1;
 } finally {
  await pool?.end();
 }
}
