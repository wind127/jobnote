import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { parseManualProgress } from '../manual-import.js';
import { AppError } from '../types.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'jobnote-manual-'));
  const store=new Store(dir);
  return {store,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('pasted two-line rows keep metadata with the right position and read the last stage',()=>{
  const text='企业\t部门\t\t进度1\t进度2\t进度3\t进度4\t备注\n'
    +'汇川\t通用AI算法工程师\t\t投递\t测评\t一面\t二面\t三面\n'
    +'简历已更新\t南京市 / 苏州市\t\t8月17日\t已完成\t9-10 16:45\t9/16 9:30\t9/22 9:30\n'
    +'长鑫存储\tAI 全栈开发、IT服务AI开发\t\t投递\t测评\n'
    +'\t合肥\t\t9月25日\tAI面试 10/2 23:59\n';
  const rows=parseManualProgress(text);
  assert.equal(rows.length,2);
  assert.equal(rows[0].stage,'interview_3');
  assert.equal(rows[1].stage,'ai_interview');
  assert.match(rows[1].warning??'',/多个岗位/);
  assert.match(rows[1].note,/合肥/);
});

test('manual import updates one application, keeps provenance, and is repeatable',()=>{
  const ctx=fixture();
  try{
    const text='企业\t部门\t\t进度1\t进度2\t进度3\n示例科技\t后端工程师\t\t投递\t笔试\t一面\n已更新简历\t上海\t\t8月6日\t已完成\t9/22 11:00\n';
    const preview=ctx.store.previewManualProgress(text) as {rows:Array<Record<string,unknown>>};
    assert.equal(preview.rows.length,1);
    const row=preview.rows[0];
    const input={company:row.company,position:row.position,stage:row.stage,status:'scheduled',note:row.note,create_new:true};
    assert.deepEqual(ctx.store.applyManualProgress([input]),{created:1,updated:0,unchanged:0});
    assert.deepEqual(ctx.store.applyManualProgress([input]),{created:0,updated:0,unchanged:1});
    const dashboard=ctx.store.dashboard() as {applications:Array<Record<string,unknown>>;manual_updates:Array<Record<string,unknown>>};
    assert.equal(dashboard.applications.length,1);
    assert.equal(dashboard.applications[0].stage,'interview_1');
    assert.equal(dashboard.applications[0].manual_stage,0);
    assert.equal(dashboard.manual_updates.length,1);
    const second={...input,stage:'interview_2',status:'scheduled',create_new:false};
    assert.deepEqual(ctx.store.applyManualProgress([second]),{created:0,updated:1,unchanged:0});
    assert.equal((ctx.store.dashboard() as typeof dashboard).applications.length,1);
    assert.equal((ctx.store.dashboard() as typeof dashboard).manual_updates.length,2);
  }finally{ctx.close();}
});

test('an ambiguous company cannot silently create another position',()=>{
  const ctx=fixture();
  try{
    ctx.store.applyManualProgress([{company:'示例科技',position:'后端工程师',stage:'applied',status:'received',note:'已投递',create_new:true}]);
    assert.throws(()=>ctx.store.applyManualProgress([{company:'示例科技',position:'后端工程师',stage:'written_test',status:'invited',note:'待笔试',create_new:true}]),
      (error:unknown)=>error instanceof AppError&&error.code==='DUPLICATE_APPLICATION');
    assert.throws(()=>ctx.store.applyManualProgress([{company:'示例科技',position:'算法工程师',stage:'written_test',status:'invited',note:'待笔试'}]),
      (error:unknown)=>error instanceof AppError&&error.code==='AMBIGUOUS_APPLICATION');
    assert.throws(()=>ctx.store.applyManualProgress([{company:'示例科技',position:'后端工程师',stage:'interview_1',status:'unknown',note:'日期不明确'}]),
      (error:unknown)=>error instanceof AppError&&error.code==='BAD_IMPORT');
    assert.equal((ctx.store.dashboard() as {applications:unknown[]}).applications.length,1);
  }finally{ctx.close();}
});

test('every repeated company and position requires review before importing',()=>{
  const ctx=fixture();
  try{
    const text='企业\t部门\t\t进度1\t进度2\n示例科技\t后端工程师\t\t投递\t笔试\n\t上海\t\t8月6日\t待完成\n示例科技\t后端工程师\t\t投递\t一面\n\t上海\t\t8月6日\t待完成\n';
    const preview=ctx.store.previewManualProgress(text) as {rows:Array<{warning:string|null}>;ready:number};
    assert.equal(preview.rows.length,2);
    assert.equal(preview.ready,0);
    assert.ok(preview.rows.every(row=>/多次/.test(row.warning??'')));
  }finally{ctx.close();}
});

test('older pasted progress is flagged when the existing application is further along',()=>{
  const ctx=fixture();
  try{
    ctx.store.applyManualProgress([{company:'示例科技',position:'后端工程师',stage:'interview_1',status:'scheduled',note:'一面预约',create_new:true}]);
    const text='企业\t部门\t\t进度1\t进度2\n示例科技\t后端工程师\t\t投递\t笔试\n\t上海\t\t8月6日\t待完成\n';
    const preview=ctx.store.previewManualProgress(text) as {rows:Array<{warning:string|null}>;ready:number};
    assert.equal(preview.ready,0);
    assert.match(preview.rows[0].warning??'',/已有进展/);
  }finally{ctx.close();}
});

test('already imported progress is left unchecked on the next preview',()=>{
  const ctx=fixture();
  try{
    const text='企业\t部门\t\t进度1\n示例科技\t后端工程师\t\t投递\n';
    const first=ctx.store.previewManualProgress(text) as {rows:Array<Record<string,unknown>>;ready:number};
    assert.equal(first.ready,1);
    const row=first.rows[0];
    ctx.store.applyManualProgress([{company:row.company,position:row.position,stage:row.stage,status:row.status,note:row.note,create_new:true}]);
    const second=ctx.store.previewManualProgress(text) as {rows:Array<{warning:string|null}>;ready:number};
    assert.equal(second.ready,0);
    assert.match(second.rows[0].warning??'',/已导入/);
  }finally{ctx.close();}
});
