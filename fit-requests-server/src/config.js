export function loadConfig(env=process.env){
  const required=["DATABASE_URL","KAITEN_API_TOKEN","ADMIN_API_TOKEN","KAITEN_WEBHOOK_SECRET"];
  for(const key of required){if(!env[key])throw Error("Missing required environment variable: "+key)}
  for(const key of ["ADMIN_API_TOKEN","KAITEN_WEBHOOK_SECRET"]){if(env[key].length<32||env[key].includes("put-")||env[key].includes("generate-"))throw Error(key+" must be a unique random secret of at least 32 characters")}
  if(env.ADMIN_API_TOKEN===env.KAITEN_WEBHOOK_SECRET||env.ADMIN_API_TOKEN===env.KAITEN_API_TOKEN||env.KAITEN_WEBHOOK_SECRET===env.KAITEN_API_TOKEN)throw Error("Use independent secrets for API, admin and webhook");
  const base=env.KAITEN_BASE_URL||"https://rossko.kaiten.ru";
  const url=new URL(base);
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/"||!url.hostname.endsWith(".kaiten.ru"))throw Error("KAITEN_BASE_URL must be a bare HTTPS Kaiten subdomain");
  const id=Number(env.KAITEN_SPACE_ID||332384);
  if(!Number.isSafeInteger(id)||id<1)throw Error("Invalid KAITEN_SPACE_ID");
  const interval=Number(env.SYNC_INTERVAL_MINUTES||15);
  if(!Number.isInteger(interval)||interval<1||interval>1440)throw Error("Invalid SYNC_INTERVAL_MINUTES");
  return Object.freeze({port:Number(env.PORT||3000),databaseUrl:env.DATABASE_URL,kaitenBase:base.replace(/\/$/,""),spaceId:id,kaitenToken:env.KAITEN_API_TOKEN,adminToken:env.ADMIN_API_TOKEN,webhookSecret:env.KAITEN_WEBHOOK_SECRET,intervalMs:interval*60000});
}
