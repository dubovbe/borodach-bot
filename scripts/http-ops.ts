import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function isMain(meta:string):boolean {
 if(!process.argv[1])return false;
 const normalize=(p:string)=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p);
 return normalize(fileURLToPath(meta))===normalize(process.argv[1]);
}
export function webhookUrl(value:string|undefined):URL{
 const url=new URL(value??'');
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/webhook'))throw Error('INVALID_CONFIG');
 return url;
}
export function webhookSecret(value:string|undefined):string{
 if(!value||!/^[A-Za-z0-9_-]{1,256}$/.test(value))throw Error('INVALID_CONFIG');return value;
}
// Deadline covers headers AND the body; never return provider response text to callers.
export async function boundedHttp(url:URL|string,init:RequestInit={}):Promise<{status:number;body:string}>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
 try{
  const response=await fetch(url,{...init,redirect:'error',signal:controller.signal});
  const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader){try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16384){await reader.cancel();throw Error('HTTP_FAILED');}chunks.push(part.value);}}finally{reader.releaseLock();}}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return {status:response.status,body:new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)};
 }catch{throw Error('HTTP_FAILED');}finally{clearTimeout(timer);}
}
