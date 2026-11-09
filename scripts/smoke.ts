import {boundedHttp,isMain,webhookSecret} from './http-ops.ts';
export type SmokeEnv={SMOKE_URL?:string;WEBHOOK_SECRET?:string};
export type SmokeResult={ok:boolean;health:boolean;unauthorized:boolean;malformed?:boolean};
export async function smoke(env:SmokeEnv):Promise<SmokeResult>{
 try{
  const url=new URL(env.SMOKE_URL??'');
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(loopback&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('INVALID_CONFIG');
  const health=await boundedHttp(new URL('/health',url));
  const parsed=JSON.parse(health.body);const healthOk=health.status===200&&parsed?.ok===true&&Object.keys(parsed).length===1;
  const unauthorized=await boundedHttp(new URL('/webhook',url),{method:'POST',body:'not-json'});
  const result:SmokeResult={ok:false,health:healthOk,unauthorized:unauthorized.status===403};
  if(env.WEBHOOK_SECRET){const malformed=await boundedHttp(new URL('/webhook',url),{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':webhookSecret(env.WEBHOOK_SECRET)},body:'not-json'});result.malformed=malformed.status===400;}
  result.ok=result.health&&result.unauthorized&&(result.malformed??true);return result;
 }catch{throw Error('SMOKE_FAILED');}
}
if(isMain(import.meta.url)){
 try{const result=await smoke(process.env);console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;}catch{console.log(JSON.stringify({ok:false,code:'SMOKE_FAILED'}));process.exitCode=1;}
}
