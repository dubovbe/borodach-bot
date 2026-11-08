import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
// Kernel-owned IPC namespace: no TCP, PID guesses, age expiry or disk-lock deletion.
// Windows named pipes and Linux abstract sockets disappear when the owning process dies.
export async function operationLock(directory:string,scope:string):Promise<()=>Promise<void>>{
 const canonical=process.platform==='win32'?directory.toLowerCase():directory;
 const key=createHash('sha256').update(canonical+'\0'+scope).digest('hex');
 const address=process.platform==='win32'?`\\\\.\\pipe\\borodach-ops-${key}`:process.platform==='linux'?`\0borodach-ops-${key}`:null;
 if(!address)throw Error('OPS_FAILED');
 const server=createServer(socket=>socket.destroy());
 try{
  await new Promise<void>((accept,reject)=>{
   const timer=setTimeout(()=>{server.close();reject(Error('OPS_FAILED'));},5000);
   server.once('error',()=>{clearTimeout(timer);reject(Error('OPS_FAILED'));});
   server.listen(address,()=>{clearTimeout(timer);accept();});
  });
 }catch{if(server.listening)server.close();throw Error('OPS_FAILED');}
 let released=false;
 return async()=>{
  if(released)return;released=true;
  await new Promise<void>((accept,reject)=>{
   const timer=setTimeout(()=>reject(Error('OPS_FAILED')),1000);
   server.close(error=>{clearTimeout(timer);if(error)reject(Error('OPS_FAILED'));else accept();});
  });
 };
}
