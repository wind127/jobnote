import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { readPage } from './mail.js';
import { finishAndNotify, makeDigest } from './notify.js';
import { startWeb } from './web.js';
import { AppError, type Submission } from './types.js';

const command=process.argv[2]??'help';
const dataDir=resolve(process.env.JOBNOTE_DATA_DIR??'./data');

async function stdinText():Promise<string>{
  let value='';
  for await(const chunk of process.stdin){value+=String(chunk);if(value.length>8_000_000)throw new AppError('INPUT_TOO_LARGE','整理结果超过输入上限。');}
  return value;
}

async function main():Promise<void>{
  if(command==='help'){
    console.log(`求职记命令\n\n  serve                   启动本地网页\n  begin                   开始或恢复本轮\n  batch [--limit 20]      取得下一批邮件 JSON（默认 100 封）\n  submit <file|->         提交与批次逐封对应的整理结果\n  finish                  完成本轮并推送一份微信摘要\n  digest                  预览当前摘要，不推送\n  abort-run --confirm-stopped   确认旧任务停止后中止当前运行\n  doctor                  检查本地配置（不连接邮箱）`);
    return;
  }
  const store=new Store(dataDir);
  if(command==='serve'){
    await startWeb(store,Number(process.env.JOBNOTE_PORT??3210));
    return;
  }
  try{
    let result:unknown;
    if(command==='begin')result=store.beginRun();
    else if(command==='batch'){
      const requestedLimit=process.argv[3]==='--limit'?Number(process.argv[4]):100;
      if(!Number.isSafeInteger(requestedLimit)||requestedLimit<1||requestedLimit>100)throw new AppError('BAD_LIMIT','单批邮件数量应为 1 到 100。');
      const run=store.activeRun();
      const open=store.activeBatch(String(run.id));
      if(open)result=store.batchView(String(open.id));
      else{
        const retry=store.requestedRetry();
        const scan=store.scanState();
        if(retry){
          const source=String(retry.source_key).split(':');
          const uv=Number(source.at(-2)),uid=Number(source.at(-1));
          if(store.sourceKey(uv,uid)!==retry.source_key)throw new AppError('RETRY_IDENTITY','重试来源与当前邮箱不一致。');
          const page=await readPage(uid-1,String(scan.first_since),uid,1);
          if(page.uidValidity!==uv)throw new AppError('UIDVALIDITY_CHANGED','邮箱 UIDVALIDITY 已变化，该来源无法按旧 UID 重试。');
          if(!page.items.length){store.retryMissing(String(retry.source_key));result={retry_failed:'原邮件已不在收件箱',source_key:retry.source_key};}
          else{
            const batch=store.savePage(String(run.id),page,true);
            result=batch?store.batchView(String(batch.id)):{retry_failed:'邮件不可读取'};
          }
        }else{
          const page=await readPage(Number(scan.last_uid),String(scan.first_since),run.upper_uid===null?null:Number(run.upper_uid),requestedLimit);
          const batch=store.savePage(String(run.id),page);
          result=batch?store.batchView(String(batch.id)):{no_more:true,last_uid:page.upperUid};
        }
      }
    }else if(command==='submit'){
      const path=process.argv[3];
      if(!path)throw new AppError('FILE_REQUIRED','请提供 JSON 文件路径或 -。');
      const text=path==='-'?await stdinText():await readFile(resolve(path),'utf8');
      let payload:Submission;
      try{payload=JSON.parse(text) as Submission;}catch{throw new AppError('BAD_JSON','整理结果不是有效 JSON。');}
      result=store.submit(payload);
    }else if(command==='finish')result=await finishAndNotify(store);
    else if(command==='digest')result=makeDigest(store);
    else if(command==='doctor'){
      const skill=process.env.QQEXMAIL_SKILL_DIR??'';
      const account=process.env.EXMAIL_ACCOUNT??'';
      const auth=process.env.EXMAIL_AUTH_CODE??'';
      const sendKey=process.env.SERVERCHAN_SENDKEY??'';
      result={
        node:process.version,
        skill_dir_configured:!!skill && existsSync(join(skill,'SKILL.md')) && existsSync(join(skill,'package.json')),
        mail_account_configured:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account) && !/your-|example|placeholder/i.test(account),
        mail_auth_configured:auth.length>=6 && !/your-|example|placeholder/i.test(auth),
        wechat_configured:/^SCT[A-Za-z0-9_-]{10,}$/.test(sendKey),
        data_dir:dataDir,
      };
    }
    else if(command==='abort-run'){
      if(process.argv[3]!=='--confirm-stopped')throw new AppError('CONFIRM_STOPPED','请先确认旧任务已经停止，再使用 --confirm-stopped。');
      result=store.transaction(()=>{
        const run=store.activeRun();
        store.db.prepare("UPDATE runs SET status='aborted',finished_at=? WHERE id=?").run(new Date().toISOString(),String(run.id));
        store.db.prepare("UPDATE batches SET status='aborted' WHERE run_id=? AND status='open'").run(String(run.id));
        store.db.prepare('UPDATE batch_messages SET body=NULL WHERE batch_id IN (SELECT id FROM batches WHERE run_id=?)').run(String(run.id));
        store.bumpVersion();
        return {aborted:true,run_id:run.id};
      });
    }else throw new AppError('UNKNOWN_COMMAND','未知命令，请运行 help。');
    console.log(JSON.stringify(result,null,2));
  }finally{store.close();}
}

main().catch(error=>{
  if(error instanceof AppError)console.error(JSON.stringify({error:error.code,message:error.message}));
  else console.error(JSON.stringify({error:'UNEXPECTED',message:error instanceof Error?error.message:'未知错误'}));
  process.exitCode=1;
});
