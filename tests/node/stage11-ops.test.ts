import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
test('ops and HTTP helpers have import-safe explicit interfaces',async()=>{
 for(const file of ['scripts/backup.ps1','scripts/restore.ps1','scripts/backup-ops.ts','scripts/set-webhook.ts','scripts/smoke.ts'])assert.ok(existsSync(file),file+' interface missing');
 const result=spawnSync(process.execPath,['scripts/backup-ops.ts','backup'],{encoding:'utf8',timeout:5000,env:{...process.env,BACKUP_DATABASE_URL:'invalid-SENTINEL',BACKUP_SCHEMA:'public',BACKUP_DIR:process.cwd(),DATABASE_URL:'unused-SENTINEL'}});
 assert.equal(result.status,1);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),{ok:false,code:'BACKUP_FAILED'});assert.doesNotMatch(result.stdout,/SENTINEL/);
});
