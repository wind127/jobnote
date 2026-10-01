import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { AiReviewService } from '../ai-review.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'jobnote-ai-'));
  const store=new Store(dir),ai=new AiReviewService(store);
  return {store,ai,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('AI queue accepts a pasted table once and requires a grounded decision',()=>{
  const ctx=fixture();
  try{
    const text='企业\t部门\t\t进度1\t进度2\n示例科技\t后端工程师\t\t投递\t待笔试\n\t上海\t\t8月6日\t待完成\n';
    assert.deepEqual(ctx.ai.queueManual(text),{queued:1,already_queued:0,already_imported:0});
    assert.deepEqual(ctx.ai.queueManual(text),{queued:0,already_queued:1,already_imported:0});
    assert.deepEqual(ctx.ai.queueManual(text.replace('示例科技','\n示例科技')),{queued:0,already_queued:1,already_imported:0});
    const batch=ctx.ai.batch();
    assert.equal(batch.items.length,1);
    const item=batch.items[0] as {id:string;source_text:string};
    const base={kind:'manual',id:item.id,decision:'resolve',reason:'表格明确写出后端工程师及待完成笔试',updates:[{company:'示例科技',position:'后端工程师',stage:'written_test',status:'invited'}]};
    assert.equal(ctx.ai.submit([{...base,evidence_quote:'不存在的证据'}]).accepted,0);
    assert.equal(ctx.ai.submit([{...base,evidence_quote:'后端工程师'}]).accepted,1);
    assert.equal(ctx.ai.batch().items.length,0);
    const dashboard=ctx.store.dashboard() as {applications:Array<{stage:string;position:string}>};
    assert.equal(dashboard.applications.length,1);
    assert.equal(dashboard.applications[0].stage,'written_test');
    assert.deepEqual(ctx.ai.queueManual(text),{queued:0,already_queued:0,already_imported:1});
  }finally{ctx.close();}
});

test('AI can mark a source as insufficient without inventing a position',()=>{
  const ctx=fixture();
  try{
    ctx.ai.queueManual('企业\t部门\t\t进度1\n示例科技\t岗位待确认\t\t投递\n');
    const item=ctx.ai.batch().items[0] as {id:string};
    const result=ctx.ai.submit([{kind:'manual',id:item.id,decision:'insufficient',reason:'原表没有写出可唯一识别的具体岗位',evidence_quote:'岗位待确认'}]);
    assert.equal(result.accepted,1);
    assert.equal(ctx.ai.batch().items.length,0);
    assert.equal(ctx.ai.batch().waiting,1);
    assert.equal((ctx.store.dashboard() as {applications:unknown[]}).applications.length,0);
  }finally{ctx.close();}
});

test('unrecognized progress remains available for AI review',()=>{
  const ctx=fixture();
  try{
    const result=ctx.ai.queueManual('企业\t部门\t\t进度1\n示例科技\t后端工程师\t\t等待通知\n');
    assert.equal(result.queued,1);
    const item=ctx.ai.batch().items[0] as {stage:null;source_text:string};
    assert.equal(item.stage,null);
    assert.match(item.source_text,/等待通知/);
  }finally{ctx.close();}
});

test('AI resolves an uncertain mail only with a quote from that mail',()=>{
  process.env.EXMAIL_ACCOUNT='fixture@example.com';
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun(new Date('2026-09-30T00:00:00Z'));
    const body='示例科技后端工程师邀请你参加一面，请留意短信。';
    const batch=ctx.store.savePage(String(run.id),{uidValidity:9,upperUid:1,pageEnd:1,items:[{uid:1,messageId:'<ai-review@example.test>',subject:'一面邀请',sender:'示例科技招聘',receivedAt:'2026-09-30T04:00:00.000Z',text:body,contentHash:'ai-review-1',error:null}]})!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:[{source_key:ctx.store.sourceKey(9,1),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'interview_1',status:'invited',evidence:'示例科技后端工程师邀请你参加一面',needs_review:true}]}]});
    const item=ctx.ai.batch().items[0] as {id:string;kind:string};
    assert.equal(item.kind,'mail');
    const base={kind:'mail',id:item.id,decision:'resolve',company:'示例科技',position:'后端工程师',stage:'interview_1',status:'invited',reason:'邮件明确写出公司、岗位和一面轮次'};
    assert.equal(ctx.ai.submit([{...base,evidence_quote:'不存在的面试通知'}]).accepted,0);
    assert.equal(ctx.ai.submit([{...base,evidence_quote:'示例科技后端工程师邀请你参加一面'}]).accepted,1);
    assert.equal(ctx.ai.batch().items.length,0);
    const dashboard=ctx.store.dashboard() as {applications:Array<{stage:string}>;reviews:unknown[]};
    assert.equal(dashboard.applications[0].stage,'interview_1');
    assert.equal(dashboard.reviews.length,0);
  }finally{ctx.close();}
});

test('a waiting mail is reconsidered when a matching application later appears',()=>{
  process.env.EXMAIL_ACCOUNT='fixture@example.com';
  const ctx=fixture();
  try{
    const run=ctx.store.beginRun(new Date('2026-09-30T00:00:00Z'));
    const body='示例科技邀请你参加后端工程师笔试。';
    const batch=ctx.store.savePage(String(run.id),{uidValidity:10,upperUid:1,pageEnd:1,items:[{uid:1,messageId:'<waiting@example.test>',subject:'笔试邀请',sender:'示例科技招聘',receivedAt:'2026-09-30T04:00:00.000Z',text:body,contentHash:'waiting-1',error:null}]})!;
    ctx.store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:[{source_key:ctx.store.sourceKey(10,1),classification:'recruitment',updates:[{company:'示例科技',position:'后端工程师',stage:'written_test',status:'invited',evidence:'邀请你参加后端工程师笔试',needs_review:true}]}]});
    const item=ctx.ai.batch().items[0] as {id:string};
    assert.equal(ctx.ai.submit([{kind:'mail',id:item.id,decision:'insufficient',reason:'目前尚无可核实的岗位记录用于归属',evidence_quote:'后端工程师笔试'}]).accepted,1);
    assert.equal(ctx.ai.batch().waiting,1);
    ctx.store.applyManualProgress([{company:'示例科技',position:'后端工程师',stage:'applied',status:'received',note:'已投递',create_new:true}]);
    assert.equal(ctx.store.reconcileReviews().notifications,1);
    const dashboard=ctx.store.dashboard() as {reviews:unknown[];applications:Array<{stage:string}>};
    assert.equal(dashboard.reviews.length,0);
    assert.equal(dashboard.applications[0].stage,'written_test');
  }finally{ctx.close();}
});
