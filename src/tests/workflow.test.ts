import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { finishAndNotify } from '../notify.js';
import { AppError, type MailPage, type Submission } from '../types.js';

process.env.EXMAIL_ACCOUNT='fixture@example.com';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'jobnote-test-'));
  const store=new Store(dir);
  return {store,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

function page(items:MailPage['items'], upperUid:number):MailPage {
  return {uidValidity:17,upperUid,pageEnd:items.at(-1)?.uid??upperUid,items};
}

function message(uid:number,text='示例科技邀请你参加后端工程师笔试，请在十月八日前完成。'){
  return {uid,messageId:`<${uid}@example.test>`,subject:'笔试邀请',sender:'招聘团队',receivedAt:'2026-09-30T04:00:00.000Z',text,contentHash:`hash-${uid}`,error:null};
}

function submission(store:Store,runId:string,batchId:string,uids:number[]):Submission{
  return {schema_version:'1',run_id:runId,batch_id:batchId,messages:uids.map(uid=>({
    source_key:store.sourceKey(17,uid),classification:'recruitment',updates:[{
      company:'示例科技',position:'后端工程师',application_ref:'APP-1',stage:'written_test',status:'invited',round:null,
      evidence:'邀请你参加后端工程师笔试',todo:{title:'完成笔试',due_date:'2026-10-08',time_text:'十月八日前'},
    }],
  }))};
}

test('batch coverage is exact and a replay cannot duplicate progress',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun(new Date('2026-09-30T00:00:00Z'));
    const batch=ctx.store.savePage(String(run.id),page([message(1),message(2),message(3)],3))!;
    const incomplete=submission(ctx.store,String(run.id),String(batch.id),[1,2]);
    assert.throws(()=>ctx.store.submit(incomplete),(error:unknown)=>error instanceof AppError&&error.code==='INCOMPLETE_BATCH');
    assert.equal(ctx.store.scanState().last_uid,0);
    const duplicated=submission(ctx.store,String(run.id),String(batch.id),[1,2,2]);
    assert.throws(()=>ctx.store.submit(duplicated),(error:unknown)=>error instanceof AppError&&error.code==='INCOMPLETE_BATCH');
    const complete=submission(ctx.store,String(run.id),String(batch.id),[1,2,3]);
    assert.deepEqual(ctx.store.submit(complete),{accepted:true,applied:3,reviews:0,last_uid:3});
    assert.equal(ctx.store.scanState().last_uid,3);
    assert.equal((ctx.store.dashboard() as {events:unknown[]}).events.length,3);
    assert.throws(()=>ctx.store.submit(complete),(error:unknown)=>error instanceof AppError&&error.code==='BATCH_MISMATCH');
  }finally{ctx.close();}
});

test('failed message blocks the page until the user skips it; later retry keeps the checkpoint',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun(new Date('2026-09-30T00:00:00Z'));
    const bad={...message(2),text:null,contentHash:null,error:'邮件没有可读取的文本正文'};
    const batch=ctx.store.savePage(String(run.id),page([message(1),bad,message(3)],3))!;
    const input=submission(ctx.store,String(run.id),String(batch.id),[1,2,3]);
    assert.throws(()=>ctx.store.submit(input),(error:unknown)=>error instanceof AppError&&error.code==='MAIL_UNRESOLVED');
    assert.equal(ctx.store.scanState().last_uid,0);
    ctx.store.skipFailure(ctx.store.sourceKey(17,2),'只有损坏附件');
    input.messages[1]={source_key:ctx.store.sourceKey(17,2),classification:'skipped',updates:[]};
    ctx.store.submit(input);
    assert.equal(ctx.store.scanState().last_uid,3);
    assert.equal((ctx.store.dashboard() as {failures:unknown[]}).failures.length,1);
    ctx.store.requestRetry(ctx.store.sourceKey(17,2));
    const retry=ctx.store.savePage(String(run.id),page([message(2)],2),true)!;
    ctx.store.submit(submission(ctx.store,String(run.id),String(retry.id),[2]));
    assert.equal(ctx.store.scanState().last_uid,3);
    assert.equal((ctx.store.dashboard() as {failures:unknown[]}).failures.length,0);
  }finally{ctx.close();}
});

test('one time slot can only send once and a lost response is not retried',async()=>{
  const ctx=fixture();
  const original=process.env.SERVERCHAN_SENDKEY;
  process.env.SERVERCHAN_SENDKEY='SCT0123456789abcdefghi';
  try{
    const date=new Date('2026-09-30T00:00:00Z');
    const run=ctx.store.beginRun(date);
    const batch=ctx.store.savePage(String(run.id),page([message(1)],1))!;
    ctx.store.submit(submission(ctx.store,String(run.id),String(batch.id),[1]));
    let sends=0;
    const sender=(async()=>{sends++;return new Response(JSON.stringify({code:0}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
    const sent=await finishAndNotify(ctx.store,sender,date);
    assert.deepEqual(sent,{slot:0,status:'accepted'});
    const nextRun=ctx.store.beginRun(new Date(date.getTime()+60_000));
    ctx.store.savePage(String(nextRun.id),page([],1));
    const repeated=await finishAndNotify(ctx.store,sender,new Date(date.getTime()+60_000));
    assert.deepEqual(repeated,{slot:0,status:'accepted'});
    assert.equal(sends,1);
    const later=new Date(date.getTime()+14_400_000);
    const third=ctx.store.beginRun(later);
    ctx.store.savePage(String(third.id),page([],1));
    const uncertain=await finishAndNotify(ctx.store,(async()=>{sends++;throw Error('network lost');}) as typeof fetch,later);
    assert.deepEqual(uncertain,{slot:1,status:'unknown'});
    assert.equal(sends,2);
  }finally{
    if(original===undefined)delete process.env.SERVERCHAN_SENDKEY;else process.env.SERVERCHAN_SENDKEY=original;
    ctx.close();
  }
});

test('mailbox UID reset persists a fresh checkpoint',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const batch=ctx.store.savePage(String(run.id),page([message(1)],1))!;
    ctx.store.submit(submission(ctx.store,String(run.id),String(batch.id),[1]));
    assert.throws(()=>ctx.store.savePage(String(run.id),{uidValidity:18,upperUid:2,pageEnd:2,items:[message(2)]}),(error:unknown)=>error instanceof AppError&&error.code==='UIDVALIDITY_CHANGED');
    assert.equal(ctx.store.scanState().uid_validity,18);
    assert.equal(ctx.store.scanState().last_uid,0);
  }finally{ctx.close();}
});
