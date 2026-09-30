import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { chooseTextPart } from '../mail.js';
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

test('a large MIME message selects its text body and an open failed batch can recover',()=>{
  const structure=[
    {type:'mixed'},
    [{partID:'1',type:'text',subtype:'plain',size:120,encoding:'QUOTED-PRINTABLE',params:{charset:'UTF-8'}}],
    [{partID:'2',type:'application',subtype:'pdf',size:4_000_000,disposition:{type:'attachment'}}],
  ];
  assert.equal(chooseTextPart(structure)?.partID,'1');
  assert.equal(chooseTextPart([[{partID:'1',type:'text',subtype:'plain',size:120,disposition:{type:'attachment'}}]]),null);
  assert.equal(chooseTextPart([[{partID:'1',type:'text',subtype:'plain',size:120,params:{name:'notes.txt'}}]]),null);
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const bad={...message(1),text:null,contentHash:null,error:'邮件超过 2 MiB 读取上限'};
    const batch=ctx.store.savePage(String(run.id),page([bad],1))!;
    assert.equal(ctx.store.oversizedFailures(String(batch.id)).length,1);
    assert.throws(()=>ctx.store.submit(submission(ctx.store,String(run.id),String(batch.id),[1])),(error:unknown)=>error instanceof AppError&&error.code==='MAIL_UNRESOLVED');
    ctx.store.skipFailure(ctx.store.sourceKey(17,1),'旧读取上限导致暂时跳过');
    ctx.store.repairOpenBatchMessage(String(batch.id),17,message(1));
    assert.equal(ctx.store.oversizedFailures(String(batch.id)).length,0);
    assert.equal((ctx.store.dashboard() as {failures:unknown[]}).failures.length,0);
    assert.equal((ctx.store.submit(submission(ctx.store,String(run.id),String(batch.id),[1])) as {accepted:boolean}).accepted,true);
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
      {source_key:ctx.store.sourceKey(17,2),classification:'recruitment',updates:[{company:'示例科技',position:null,stage:'interview',status:'invited',evidence:'邀请参加面试',needs_review:true,todo:{title:'确认面试时间',due_date:'2026-10-02'}}]},
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

test('the project reconciles a missing role against one known application and keeps the task',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const mails=[message(1,'示例科技确认收到后端工程师申请。'),message(2,'示例科技邀请参加在线笔试。')];
    const batch=ctx.store.savePage(String(run.id),page(mails,2))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:[
      {source_key:ctx.store.sourceKey(17,1),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'applied',status:'received',evidence:'确认收到后端工程师申请'}]},
      {source_key:ctx.store.sourceKey(17,2),classification:'recruitment',updates:[{company:'示例科技',position:null,stage:'written_test',status:'invited',evidence:'邀请参加在线笔试',needs_review:true,todo:{title:'完成在线笔试',due_date:'2026-10-08'}}]},
    ]});
    const dashboard=ctx.store.dashboard() as {applications:Array<Record<string,unknown>>;reviews:unknown[];events:Array<Record<string,unknown>>;todos:Array<Record<string,unknown>>};
    assert.equal(dashboard.reviews.length,0);
    assert.equal(dashboard.applications.length,1);
    assert.equal(dashboard.applications[0].stage,'written_test');
    assert.equal(dashboard.events.find(event=>event.source_key===ctx.store.sourceKey(17,2))?.application_id,dashboard.applications[0].id);
    assert.equal(dashboard.todos.length,1);
    assert.equal((ctx.store.db.prepare("SELECT resolved_by FROM review_items WHERE source_key=?").get(ctx.store.sourceKey(17,2)) as {resolved_by:string}).resolved_by,'auto');
    assert.deepEqual(ctx.store.reconcileReviews(),{groups:0,notifications:0,unresolved:0});
  }finally{ctx.close();}
});

test('automatic reconciliation leaves multiple possible roles open but matches an explicit role',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const mails=[
      message(1,'示例科技确认收到后端工程师申请。'),
      message(2,'示例科技确认收到算法工程师申请。'),
      message(3,'示例科技邀请参加在线笔试。'),
      message(4,'示例科技邀请算法工程师参加在线笔试。'),
    ];
    const batch=ctx.store.savePage(String(run.id),page(mails,4))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:mails.map((mail,index)=>({
      source_key:ctx.store.sourceKey(17,mail.uid),classification:'recruitment',updates:[{
        company:'示例科技',position:index===0?'后端工程师':index===1||index===3?'算法工程师':null,
        stage:index<2?'applied':'written_test',status:index<2?'received':'invited',
        evidence:index===0?'确认收到后端工程师申请':index===1?'确认收到算法工程师申请':index===2?'邀请参加在线笔试':'邀请算法工程师参加在线笔试',
        needs_review:index>=2,
      }],
    }))});
    const dashboard=ctx.store.dashboard() as {applications:Array<Record<string,unknown>>;reviews:Array<Record<string,unknown>>;events:Array<Record<string,unknown>>};
    assert.equal(dashboard.reviews.length,1);
    assert.equal(dashboard.reviews[0].position,null);
    assert.equal(dashboard.reviews[0].reason,'同公司有多个岗位，邮件未写明归属');
    const algorithm=dashboard.applications.find(app=>app.position==='算法工程师')!;
    assert.equal(algorithm.stage,'written_test');
    assert.equal(dashboard.events.find(event=>event.source_key===ctx.store.sourceKey(17,4))?.application_id,algorithm.id);
    assert.equal(dashboard.events.find(event=>event.source_key===ctx.store.sourceKey(17,3))?.application_id,null);
  }finally{ctx.close();}
});

test('an explicit interview round is reconciled without assigning it to an unnumbered notice',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const mails=[message(1,'示例科技确认收到后端工程师申请。'),message(2,'示例科技邀请参加面试。'),message(3,'示例科技邀请参加二面。')];
    const batch=ctx.store.savePage(String(run.id),page(mails,3))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:[
      {source_key:ctx.store.sourceKey(17,1),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'applied',status:'received',evidence:'确认收到后端工程师申请'}]},
      {source_key:ctx.store.sourceKey(17,2),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'interview',status:'invited',evidence:'邀请参加面试',needs_review:true}]},
      {source_key:ctx.store.sourceKey(17,3),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'interview',status:'invited',round:'二面',evidence:'邀请参加二面',needs_review:true}]},
    ]});
    const dashboard=ctx.store.dashboard() as {applications:Array<Record<string,unknown>>;reviews:Array<Record<string,unknown>>;events:Array<Record<string,unknown>>};
    assert.equal(dashboard.reviews.length,1);
    assert.equal(dashboard.reviews[0].reason,'邮件没有明确面试轮次');
    assert.equal(dashboard.applications[0].stage,'interview_2');
    assert.equal(dashboard.events.find(event=>event.source_key===ctx.store.sourceKey(17,2))?.needs_review,1);
    assert.equal(dashboard.events.find(event=>event.source_key===ctx.store.sourceKey(17,3))?.needs_review,0);
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

test('repeated notices share one review and the latest schedule; resolving keeps every source event',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const notices=[
      {...message(1,'示例科技邀请后端工程师面试。'),receivedAt:'2026-09-01T08:00:00.000Z'},
      {...message(2,'示例科技取消后端工程师面试。'),receivedAt:'2026-09-02T08:00:00.000Z'},
      {...message(3,'示例科技重新安排后端工程师面试。'),receivedAt:'2026-09-03T08:00:00.000Z'},
    ];
    const batch=ctx.store.savePage(String(run.id),page(notices,3))!;
    const statuses=['invited','cancelled','scheduled'] as const;
    const evidence=['邀请后端工程师面试','取消后端工程师面试','重新安排后端工程师面试'];
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:notices.map((notice,index)=>({
      source_key:ctx.store.sourceKey(17,notice.uid),classification:'recruitment',updates:[{
        company:'示例科技',position:'后端工程师',stage:'interview',status:statuses[index],needs_review:true,
        evidence:evidence[index],todo:index===1?null:{title:'参加面试',due_date:index===0?'2026-09-05':'2026-09-08',kind:'interview'},
      }],
    }))});
    const before=ctx.store.dashboard() as {reviews:Array<Record<string,unknown>>;events:Array<Record<string,unknown>>};
    assert.equal(before.reviews.length,1);
    assert.equal(before.reviews[0].mail_count,3);
    assert.equal(before.reviews[0].status,'scheduled');
    assert.equal(JSON.parse(String(before.reviews[0].todo_json)).due_date,'2026-09-08');
    assert.equal(before.events.length,3);
    ctx.store.resolveReview(String(before.reviews[0].id),'示例科技','后端工程师',undefined,'interview_1','scheduled');
    const after=ctx.store.dashboard() as {reviews:unknown[];events:Array<Record<string,unknown>>;applications:Array<Record<string,unknown>>;todos:Array<Record<string,unknown>>};
    assert.equal(after.reviews.length,0);
    assert.equal(after.applications.length,1);
    assert.equal(after.applications[0].status,'scheduled');
    assert.equal(after.events.filter(event=>event.application_id===after.applications[0].id).length,3);
    assert.equal(after.events.find(event=>event.status==='cancelled')?.stage,'interview_1');
    assert.equal(after.todos.length,1);
    assert.equal(after.todos[0].due_date,'2026-09-08');
  }finally{ctx.close();}
});

test('review grouping keeps missing roles and different application references separate',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const mails=[1,2,3,4].map(uid=>message(uid,`示例科技第${uid}封面试通知。`));
    const batch=ctx.store.savePage(String(run.id),page(mails,4))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:mails.map(mail=>({
      source_key:ctx.store.sourceKey(17,mail.uid),classification:'recruitment',updates:[{
        company:'示例科技',position:mail.uid<=2?null:'后端工程师',application_ref:mail.uid===3?'APP-A':'APP-B',
        stage:'interview',status:'invited',needs_review:true,evidence:`第${mail.uid}封面试通知`,
      }],
    }))});
    const dashboard=ctx.store.dashboard() as {reviews:Array<Record<string,unknown>>};
    assert.equal(dashboard.reviews.length,4);
    ctx.store.ignoreReview(String(dashboard.reviews[0].id));
    assert.equal((ctx.store.dashboard() as {reviews:unknown[]}).reviews.length,3);
    for(const review of (ctx.store.dashboard() as {reviews:Array<Record<string,unknown>>}).reviews.filter(row=>row.position==='后端工程师')){
      ctx.store.resolveReview(String(review.id),'示例科技','后端工程师',undefined,'interview_1','invited');
    }
    const apps=(ctx.store.dashboard() as {applications:Array<Record<string,unknown>>}).applications;
    assert.equal(apps.length,2);
    assert.deepEqual(apps.map(app=>app.application_ref).sort(),['APP-A','APP-B']);
  }finally{ctx.close();}
});

test('ignoring a grouped review closes every matching notice',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const mails=[message(1,'示例科技邀请后端工程师面试。'),message(2,'示例科技提醒后端工程师面试。')];
    const batch=ctx.store.savePage(String(run.id),page(mails,2))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:mails.map((mail,index)=>({
      source_key:ctx.store.sourceKey(17,mail.uid),classification:'recruitment',updates:[{
        company:'示例科技',position:'后端工程师',stage:'interview',status:'invited',needs_review:true,
        evidence:index?'提醒后端工程师面试':'邀请后端工程师面试',
      }],
    }))});
    const reviews=(ctx.store.dashboard() as {reviews:Array<Record<string,unknown>>}).reviews;
    assert.equal(reviews.length,1);
    ctx.store.ignoreReview(String(reviews[0].id));
    assert.equal((ctx.store.dashboard() as {reviews:unknown[]}).reviews.length,0);
    assert.equal((ctx.store.db.prepare("SELECT count(*) count FROM review_items WHERE state='ignored'").get() as {count:number}).count,2);
  }finally{ctx.close();}
});

test('identical nearby reminders with no role collapse, while later notices stay separate',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const text='示例科技邀请参加在线笔试。';
    const mails=[
      {...message(1,text),receivedAt:'2026-09-01T08:00:00.000Z'},
      {...message(2,text),receivedAt:'2026-09-02T08:00:00.000Z'},
      {...message(3,text),receivedAt:'2026-09-10T08:00:00.000Z'},
    ];
    const batch=ctx.store.savePage(String(run.id),page(mails,3))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:mails.map(mail=>({
      source_key:ctx.store.sourceKey(17,mail.uid),classification:'recruitment',updates:[{
        company:'示例科技',position:null,stage:'written_test',status:'invited',needs_review:true,evidence:'邀请参加在线笔试',
      }],
    }))});
    const reviews=(ctx.store.dashboard() as {reviews:Array<Record<string,unknown>>}).reviews;
    assert.equal(reviews.length,2);
    assert.deepEqual(reviews.map(review=>review.mail_count).sort(),[1,2]);
  }finally{ctx.close();}
});

test('matching dated tasks without a role collapse despite different mail wording',()=>{
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun();
    const mails=[
      {...message(1,'面试邀请'),receivedAt:'2026-09-10T08:00:00.000Z'},
      {...message(2,'面试提醒'),receivedAt:'2026-09-11T08:00:00.000Z'},
      {...message(3,'另一场面试'),receivedAt:'2026-09-11T09:00:00.000Z'},
      {...message(4,'另一申请的面试'),receivedAt:'2026-09-11T10:00:00.000Z'},
    ];
    const batch=ctx.store.savePage(String(run.id),page(mails,4))!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:mails.map((mail,index)=>( {
      source_key:ctx.store.sourceKey(17,mail.uid),classification:'recruitment',updates:[{
        company:'示例银行',position:null,stage:'interview_1',status:'scheduled',needs_review:true,
        application_ref:index===3?'OTHER':undefined,
        evidence:['面试邀请','面试提醒','另一场面试','另一申请的面试'][index],
        todo:{title:'参加视频面试',due_at:index===2?'2026-09-13T08:00:00.000Z':'2026-09-12T08:00:00.000Z'},
      }],
    }))});
    const before=ctx.store.dashboard() as {reviews:Array<Record<string,unknown>>;events:Array<Record<string,unknown>>};
    assert.equal(before.reviews.length,3);
    assert.deepEqual(before.reviews.map(review=>review.mail_count).sort(),[1,1,2]);
    assert.equal(before.events.length,4);
    const grouped=before.reviews.find(review=>review.mail_count===2)!;
    ctx.store.ignoreReview(String(grouped.id));
    assert.equal((ctx.store.dashboard() as {reviews:unknown[]}).reviews.length,2);
    assert.equal((ctx.store.db.prepare("SELECT count(*) count FROM review_items WHERE state='ignored'").get() as {count:number}).count,2);
  }finally{ctx.close();}
});
