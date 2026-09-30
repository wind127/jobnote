import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { finishRun, makeDigest } from '../notify.js';
import { AppError, progressStatusLabel, type MailPage, type Submission } from '../types.js';

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

test('one time slot only produces one digest and the next includes new progress',()=>{
  const ctx=fixture();
  try{
    const date=new Date('2026-09-30T00:00:00Z');
    const run=ctx.store.beginRun(date);
    const batch=ctx.store.savePage(String(run.id),page([message(1)],1))!;
    ctx.store.submit(submission(ctx.store,String(run.id),String(batch.id),[1]));
    const sent=finishRun(ctx.store,date) as {slot:number;should_send:boolean;title:string;body:string};
    assert.equal(sent.slot,0);
    assert.equal(sent.should_send,true);
    assert.match(sent.body,/示例科技/);
    const nextRun=ctx.store.beginRun(new Date(date.getTime()+60_000));
    ctx.store.savePage(String(nextRun.id),page([],1));
    const repeated=finishRun(ctx.store,new Date(date.getTime()+60_000));
    assert.deepEqual(repeated,{slot:0,should_send:false});
    const later=new Date(date.getTime()+14_400_000);
    const third=ctx.store.beginRun(later);
    const nextBatch=ctx.store.savePage(String(third.id),page([message(2)],2))!;
    ctx.store.submit(submission(ctx.store,String(third.id),String(nextBatch.id),[2]));
    const next=finishRun(ctx.store,later) as {slot:number;should_send:boolean;body:string};
    assert.equal(next.slot,1);
    assert.equal(next.should_send,true);
    assert.match(next.body,/新进展 1 项/);
  }finally{
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

test('reviewed interview rounds update the application and keep the task',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const first=message(1,'示例科技确认收到后端工程师申请。');
    const second=message(2,'示例科技邀请参加面试，请确认时间。');
    const batch=ctx.store.savePage(String(run.id),page([first,second],2))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:[
      {source_key:ctx.store.sourceKey(17,1),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'applied',status:'received',evidence:'确认收到后端工程师申请'}]},
      {source_key:ctx.store.sourceKey(17,2),classification:'recruitment',updates:[{company:'示例科技',position:null,stage:'interview_1',status:'invited',evidence:'邀请参加面试',needs_review:true,todo:{title:'确认面试时间',due_date:'2026-10-02'}}]},
    ]});
    const before=ctx.store.dashboard() as {applications:Array<Record<string,unknown>>;reviews:Array<Record<string,unknown>>};
    assert.equal(before.reviews.length,1);
    ctx.store.resolveReview(String(before.reviews[0].id),'示例科技','后端工程师',String(before.applications[0].id),'interview_2','scheduled');
    const after=ctx.store.dashboard() as {applications:Array<Record<string,unknown>>;reviews:unknown[];todos:Array<Record<string,unknown>>;events:Array<Record<string,unknown>>};
    assert.equal(after.reviews.length,0);
    assert.equal(after.applications[0].stage,'interview_2');
    assert.equal(after.applications[0].status,'scheduled');
    assert.equal(after.todos.length,1);
    assert.match(String(after.todos[0].match_key),/interview_2/);
    assert.equal(after.events.find(event=>event.source_key===ctx.store.sourceKey(17,2))?.stage,'interview_2');
    assert.match(makeDigest(ctx.store).body,/二面 · 待二面/);
    ctx.store.editApplication(String(after.applications[0].id),{stage:'interview_3',expected_version:Number(after.applications[0].version)});
    assert.equal((ctx.store.dashboard() as {applications:Array<Record<string,unknown>>}).applications[0].stage,'interview_3');
  }finally{ctx.close();}
});

test('pending labels follow the stage and unnumbered interviews require review',()=>{
  assert.equal(progressStatusLabel('assessment','invited'),'待测评');
  assert.equal(progressStatusLabel('written_test','scheduling'),'待笔试');
  assert.equal(progressStatusLabel('ai_interview','scheduled'),'待AI面试');
  assert.equal(progressStatusLabel('interview_1','invited'),'待一面');
  assert.equal(progressStatusLabel('interview','scheduling'),'待确认轮次');
  assert.equal(progressStatusLabel('interview','cancelled'),'已取消');
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const mail=message(1,'示例科技邀请你参加面试，请确认时间。');
    const batch=ctx.store.savePage(String(run.id),page([mail],1))!;
    const input:Submission={schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:[{
      source_key:ctx.store.sourceKey(17,1),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'interview',status:'invited',evidence:'邀请你参加面试'}],
    }]};
    input.messages[0].updates[0].stage='other' as Submission['messages'][number]['updates'][number]['stage'];
    assert.throws(()=>ctx.store.submit(input),(error:unknown)=>error instanceof AppError&&error.code==='BAD_UPDATE');
    input.messages[0].updates[0].stage='interview';
    assert.throws(()=>ctx.store.submit(input),(error:unknown)=>error instanceof AppError&&error.code==='REVIEW_REQUIRED');
    input.messages[0].updates[0].needs_review=true;
    ctx.store.submit(input);
    const dashboard=ctx.store.dashboard() as {applications:unknown[];reviews:Array<Record<string,unknown>>};
    assert.equal(dashboard.applications.length,0);
    assert.equal(dashboard.reviews.length,1);
    assert.throws(()=>ctx.store.resolveReview(String(dashboard.reviews[0].id),'示例科技','后端工程师',undefined,'interview','invited'),(error:unknown)=>error instanceof AppError&&error.code==='BAD_APPLICATION');
    ctx.store.resolveReview(String(dashboard.reviews[0].id),'示例科技','后端工程师',undefined,'interview_1','invited');
    assert.equal((ctx.store.dashboard() as {applications:Array<Record<string,unknown>>}).applications[0].stage,'interview_1');
  }finally{ctx.close();}
});
