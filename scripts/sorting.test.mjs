import test from 'node:test';
import assert from 'node:assert/strict';
import {STAGE_PROGRESS,companyPriority,compareProgressRows} from '../public/sorting.js';

test('all stages appear in reverse process order, with ended records last',()=>{
  const rows=Object.keys(STAGE_PROGRESS).map(stage=>({record:{company:'示例公司',stage},review:false}));
  rows.sort(compareProgressRows);
  assert.deepEqual(rows.map(item=>item.record.stage),[
    'offer','interview_3','interview_2','interview_1','interview','ai_interview',
    'written_test','assessment','screening','applied','rejected',
  ]);
});

test('later stages lead, and recognizable companies lead within a stage',()=>{
  const rows=[
    {record:{company:'示例小厂',stage:'written_test',last_event_at:'2026-09-30T00:00:00Z'},review:false},
    {record:{company:'阿里巴巴',stage:'applied',last_event_at:'2026-09-30T00:00:00Z'},review:false},
    {record:{company:'示例小厂',stage:'offer',last_event_at:'2026-09-01T00:00:00Z'},review:false},
    {record:{company:'百度在线网络技术（北京）有限公司',stage:'written_test',last_event_at:'2026-09-01T00:00:00Z'},review:false},
    {record:{company:'示例小厂',stage:'rejected',last_event_at:'2026-09-30T00:00:00Z'},review:false},
  ];
  rows.sort(compareProgressRows);
  assert.deepEqual(rows.map(item=>`${item.record.stage}:${item.record.company}`),[
    'offer:示例小厂','written_test:百度在线网络技术（北京）有限公司','written_test:示例小厂','applied:阿里巴巴','rejected:示例小厂',
  ]);
});

test('unlisted companies use recent activity and confirmed rows break exact ties',()=>{
  const rows=[
    {record:{company:'甲公司',stage:'assessment',last_event_at:'2026-09-01T00:00:00Z'},review:false},
    {record:{company:'乙公司',stage:'assessment',occurred_at:'2026-09-30T00:00:00Z'},review:true},
    {record:{company:'丙公司',stage:'assessment',last_event_at:'2026-09-30T00:00:00Z'},review:false},
  ];
  rows.sort(compareProgressRows);
  assert.deepEqual(rows.map(item=>item.record.company),['丙公司','甲公司','乙公司']);
  assert.ok(companyPriority('百度在线网络技术（北京）有限公司')>companyPriority('示例小厂'));
  assert.ok(companyPriority('招商银行·招银网络科技')>companyPriority('汇川技术'));
});
