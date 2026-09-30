import { resolve } from 'node:path';
import { Store } from '../dist/store.js';
import { startWeb } from '../dist/web.js';

process.env.EXMAIL_ACCOUNT='demo@example.test';
const dir=resolve(process.env.JOBNOTE_DEMO_DATA_DIR ?? 'data/demo-v2');
const port=Number(process.env.JOBNOTE_DEMO_PORT ?? 3211);
const store=new Store(dir);
store.setSetting('demo_mode','true');
if(Number(store.scanState().last_uid)===0){
  const run=store.beginRun();
  const now=Date.now();
  const samples=[
    {uid:1,company:'澄光科技',position:'后端开发实习生',stage:'written_test',status:'invited',ref:'D-104',text:'澄光科技邀请你参加后端开发实习生在线笔试。请在48小时内完成。',todo:{title:'完成在线笔试',due_at:new Date(now+36*3600_000).toISOString(),kind:'participate'}},
    {uid:2,company:'木序网络',position:'产品设计师',stage:'interview_1',status:'scheduled',ref:'M-39',text:'木序网络产品设计师一面已预约，期待与你交流。',todo:{title:'参加产品设计师一面',due_at:new Date(now+68*3600_000).toISOString(),kind:'participate'}},
    {uid:3,company:'青屿智能',position:'算法工程师',stage:'offer',status:'received',ref:'Q-23',text:'青屿智能算法工程师岗位的 Offer 已发送，请确认回复。',todo:{title:'回复 Offer',due_at:new Date(now+6*3600_000).toISOString(),kind:'reply'}},
  ];
  const items=samples.map(({uid,text})=>({uid,messageId:`<demo-${uid}@example.test>`,subject:'招聘进展通知',sender:'招聘团队 <recruitment@example.test>',receivedAt:new Date(now-3600_000).toISOString(),text,contentHash:`demo-${uid}`,error:null}));
  const batch=store.savePage(String(run.id),{uidValidity:1,upperUid:3,pageEnd:3,items});
  store.submit({schema_version:'1',run_id:String(run.id),batch_id:String(batch.id),messages:samples.map(sample=>({source_key:store.sourceKey(1,sample.uid),classification:'recruitment',updates:[{company:sample.company,position:sample.position,application_ref:sample.ref,stage:sample.stage,status:sample.status,evidence:sample.text,todo:sample.todo}]}))});
}
console.log(`示例数据与真实邮箱分开存放在 ${dir}。`);
await startWeb(store,port);
