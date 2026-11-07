// Model one webhook redelivery after a transaction failed before acknowledgement.
// Callers retain the exact command and update ID; production retries are not changed.
export async function redeliverOnceOnLockTimeout<T>(deliver:()=>Promise<T>):Promise<T>{
  try{return await deliver();}
  catch(error){
    if(!error||typeof error!=='object'||!('code' in error)||error.code!=='55P03')throw error;
    return deliver();
  }
}
