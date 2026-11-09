import {boundedHttp,isMain,webhookSecret,webhookUrl} from './http-ops.ts';
export type WebhookEnv={BOT_TOKEN?:string;WEBHOOK_SECRET?:string;WEBHOOK_URL?:string};
export async function setWebhook(env:WebhookEnv):Promise<void>{
 try{
  const url=webhookUrl(env.WEBHOOK_URL);const secret=webhookSecret(env.WEBHOOK_SECRET);
  if(!env.BOT_TOKEN||!/^\d+:[A-Za-z0-9_-]+$/.test(env.BOT_TOKEN))throw Error('INVALID_CONFIG');
  const response=await boundedHttp(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:url.href,secret_token:secret,allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false})});
  const body=JSON.parse(response.body);if(response.status!==200||body?.ok!==true||body.result!==true)throw Error('WEBHOOK_FAILED');
 }catch{throw Error('WEBHOOK_FAILED');}
}
if(isMain(import.meta.url)){
 try{await setWebhook(process.env);console.log(JSON.stringify({ok:true,webhook:true}));}catch{console.log(JSON.stringify({ok:false,code:'WEBHOOK_FAILED'}));process.exitCode=1;}
}
