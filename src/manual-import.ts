import { createHash } from 'node:crypto';
import { type Stage, type StageStatus } from './types.js';

export interface ManualProgressRow {
  key: string;
  line: number;
  company: string;
  position: string;
  stage: Stage | null;
  status: StageStatus | null;
  note: string;
  warning: string | null;
}

const PHASES: Array<[RegExp, Stage]> = [
  [/offer|录用/i, 'offer'], [/三面|第三轮/, 'interview_3'], [/二面|第二轮/, 'interview_2'],
  [/一面|第一轮/, 'interview_1'], [/AI\s*面试/i, 'ai_interview'], [/笔试|在线考试/, 'written_test'],
  [/测评/, 'assessment'], [/简历筛选/, 'screening'], [/投递/, 'applied'],
];
const META = /^(已更新简历|简历已更新|已完成简历更新|\d{1,2}\/\d{1,2}无合适岗位)$/;
const noRole = /^(\d+个志愿已投|三个志愿|全是社招岗位|已开|无合适岗位|待确认)$/;
const hasManyRoles = /、|，|,|\s+\/\s+|\//;

function phase(value: string): Stage | null {
  return PHASES.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

function key(value: string): string { return value.normalize('NFKC').replace(/\s+/g, '').toLowerCase(); }

export function parseManualProgress(text: string): ManualProgressRow[] {
  const result: ManualProgressRow[] = [];
  let currentCompany = '';
  let pending: { cells: string[]; meta: string[][]; line: number; company: string } | null = null;
  function finish(): void {
    if (!pending) return;
    const {cells,meta,line,company} = pending;
    const position = (cells[1] ?? '').trim();
    const progress = cells.slice(2,8);
    const latest = progress.map((value,index) => ({ stage:phase(value), index })).filter(item => item.stage).at(-1);
    let stage = latest?.stage ?? null;
    const noteParts = [cells.slice(8).join(' '), ...meta.map(row => row.filter(Boolean).join(' '))].filter(Boolean);
    const note = noteParts.join(' · ').slice(0,600);
    const joined = [...progress,note].join(' ');
    const rejected = /(?:简历|一面|二面|三面|笔试|测评)(?:挂|未通过)|淘汰|拒绝|拒信/.test(joined);
    if (rejected) stage = 'rejected';
    const next = /待\s*(AI\s*面试|笔试|测评|一面|二面|三面)/i.exec(joined);
    if (!rejected && next) stage = phase(next[1]);
    const metaStage = meta.map(row=>row.slice(2,8).map(phase).filter(Boolean).at(-1)).filter(Boolean).at(-1);
    if (!rejected && metaStage && stage && PHASES.findIndex(([,value])=>value===metaStage)<PHASES.findIndex(([,value])=>value===stage)) stage=metaStage;
    if (!stage) { pending = null; return; }
    const matchingMeta = latest ? meta.map(row => row[latest.index+2] ?? '').filter(Boolean).join(' ') : '';
    const conflicting=/待\s*(?:AI\s*面试|笔试|测评|一面|二面|三面)/i.test(note)&&/已完成|完成/.test(matchingMeta);
    const status: StageStatus = rejected ? 'failed' : next ? 'invited' : /已完成|完成/.test(matchingMeta) ? 'completed' :
      /待|预约|邀请/.test([progress.at(-1),note].join(' ')) ? 'invited' :
      stage === 'applied' ? 'received' : 'unknown';
    const warning = !position || noRole.test(position) ? '岗位不明确，请补全后导入' :
      hasManyRoles.test(position) ? '包含多个岗位，请拆分或选择一个岗位' :
      conflicting ? '“待处理”和“已完成”同时出现，请确认真实状态' :
      rejected && /[一二三]\s*志愿/.test(joined) ? '只有部分志愿被淘汰，请确认这个岗位是否结束' :
      status==='unknown' ? '完成情况不明确，请确认状态' : null;
    result.push({
      key:createHash('sha256').update([line,company,position,progress.join('|'),note].join('\n')).digest('hex').slice(0,20),
      line,company,position,stage,status,note,warning,
    });
    pending = null;
  }
  const lines = text.replace(/^\uFEFF/,'').split(/\r?\n/);
  for (let index=0; index<lines.length; index++) {
    const cells = lines[index].split('\t').map(value => value.trim());
    if (cells.every(value => !value)) { finish(); continue; }
    const first = cells[0] ?? '';
    if (index===0 && first==='企业') continue;
    if (first && !META.test(first)) {
      finish(); currentCompany = first;
      pending = { cells, meta:[], line:index+1, company:first };
    } else if (!first && cells[1] && cells[3]==='投递' && currentCompany) {
      finish(); pending = { cells, meta:[], line:index+1, company:currentCompany };
    } else if (pending) pending.meta.push(cells);
  }
  finish();
  // Identical pasted lines can occur in exported sheets; show one preview entry.
  return [...new Map(result.map(row => [key(row.company)+'|'+key(row.position)+'|'+row.stage+'|'+row.status+'|'+key(row.note),row])).values()];
}
