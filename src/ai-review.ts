import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { AppError, SELECTABLE_STAGES, STATUSES } from './types.js';

type Row = Record<string, unknown>;
type ImportRow = Row & {key:string;company:string;position:string;stage:string|null;status:string|null;note:string;source_text:string;warning:string|null;already_imported:boolean};
type Decision = {kind?:unknown;id?:unknown;decision?:unknown;reason?:unknown;evidence_quote?:unknown;updates?:unknown;company?:unknown;position?:unknown;stage?:unknown;status?:unknown;application_id?:unknown};
const clean=(value:unknown,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';
const key=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
const companyHint=(value:string)=>key(value).replace(/(集团股份有限公司|股份有限公司|有限责任公司|有限公司|集团)$/,'');
const relatedCompany=(left:string,right:string)=>{
  const a=companyHint(left),b=companyHint(right);
  return a.length>=2&&b.length>=2&&(a===b||a.includes(b)||b.includes(a));
};

export class AiReviewService {
  constructor(private readonly store:Store) {}

  queueManual(text:string): {queued:number;already_queued:number;already_imported:number} {
    const preview=this.store.previewManualProgress(text) as {rows:ImportRow[]};
    let queued=0,already_queued=0,already_imported=0;
    this.store.transaction(()=>{
      for(const row of preview.rows){
        if(row.already_imported){already_imported++;continue;}
        if(this.store.db.prepare('SELECT id FROM manual_review_items WHERE company=? AND position=? AND source_text=? LIMIT 1').get(row.company,row.position,row.source_text)){already_queued++;continue;}
        const at=new Date().toISOString();
        const result=this.store.db.prepare(`INSERT OR IGNORE INTO manual_review_items
          (id,source_key,company,position,stage,status,note,source_text,reason,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),row.key,row.company,row.position,row.stage,row.status,row.note,row.source_text,row.warning??'请核对导入进度',at,at);
        if(result.changes)queued++;else already_queued++;
      }
      if(queued)this.store.bumpVersion();
    });
    return {queued,already_queued,already_imported};
  }

  batch(limit=20): {items:object[];no_more:boolean;waiting:number} {
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new AppError('BAD_LIMIT','AI 核对批次应为 1 到 50 条。');
    const dashboard=this.store.dashboard() as {applications:Row[];events:Row[];manual_updates:Row[];reviews:Row[]};
    const candidates=(company:string)=>dashboard.applications.filter(app=>relatedCompany(String(app.company),company)).slice(0,15).map(app=>({
      id:app.id,company:app.company,position:app.position,stage:app.stage,status:app.status,version:app.version,
      recent_evidence:[
        ...dashboard.events.filter(event=>event.application_id===app.id).map(event=>({at:event.occurred_at,stage:event.stage,status:event.status,text:event.evidence})),
        ...dashboard.manual_updates.filter(update=>update.application_id===app.id).map(update=>({at:update.created_at,stage:update.stage,status:update.status,text:update.note})),
      ].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,3),
    }));
    const allManual=this.store.db.prepare("SELECT * FROM manual_review_items WHERE state IN ('open','waiting') ORDER BY created_at,id").all() as Row[];
    const mail=dashboard.reviews.filter(review=>review.state==='open').map(review=>({kind:'mail',id:review.id,company:review.company,position:review.position,stage:review.stage,status:review.status,reason:review.reason,
      notices:review.notices,subject:review.subject,sender:review.sender,candidates:candidates(String(review.company??'')),
      related_manual:allManual.filter(row=>relatedCompany(String(row.company),String(review.company??''))).slice(0,6).map(row=>({id:row.id,position:row.position,stage:row.stage,status:row.status,source_text:row.source_text}))}));
    const manual=allManual.filter(row=>row.state==='open').map(row=>({
      kind:'manual',id:row.id,company:row.company,position:row.position,stage:row.stage,status:row.status,reason:row.reason,source_text:row.source_text,
      candidates:candidates(String(row.company)),related:(this.store.db.prepare("SELECT id,position,stage,status,source_text FROM manual_review_items WHERE company=? AND position=? AND id<>? ORDER BY created_at LIMIT 8").all(String(row.company),String(row.position),String(row.id)) as Row[]),
    }));
    const items=[...mail,...manual].slice(0,limit);
    const waiting=Number((this.store.db.prepare("SELECT COUNT(*) AS count FROM manual_review_items WHERE state='waiting'").get() as Row).count)+dashboard.reviews.filter(review=>review.state==='waiting').length;
    return {items,no_more:mail.length+manual.length<=limit,waiting};
  }

  submit(input:unknown): {accepted:number;errors:Array<{id:string;error:string}>} {
    if(!Array.isArray(input)||input.length<1||input.length>50)throw new AppError('BAD_AI_REVIEW','请提交 1 到 50 条核对决定。');
    let accepted=0;const errors:Array<{id:string;error:string}>=[];
    for(const raw of input){
      try{this.submitOne(raw as Decision);accepted++;}
      catch(error){errors.push({id:clean((raw as Decision)?.id,80),error:error instanceof Error?error.message:'无法处理'});}
    }
    return {accepted,errors};
  }

  private submitOne(raw:Decision):void {
    const kind=clean(raw.kind,20),id=clean(raw.id,100),decision=clean(raw.decision,30);
    const reason=clean(raw.reason,500),quote=clean(raw.evidence_quote,300);
    if(!['mail','manual'].includes(kind)||!id||!['resolve','insufficient','ignore'].includes(decision)||reason.length<6||quote.length<2)throw new AppError('BAD_AI_REVIEW','核对决定缺少来源、理由或证据原文。');
    if(this.store.db.prepare('SELECT id FROM ai_decisions WHERE kind=? AND item_id=?').get(kind,id))return;
    let source='';let item:Row|undefined;
    if(kind==='manual'){
      item=this.store.db.prepare("SELECT * FROM manual_review_items WHERE id=? AND state='open'").get(id) as Row|undefined;
      if(!item)throw new AppError('REVIEW_NOT_FOUND','导入记录已处理或不存在。');
      source=String(item.source_text);
    }else{
      const review=(this.store.dashboard() as {reviews:Row[]}).reviews.find(row=>row.id===id&&row.state==='open');
      if(!review)throw new AppError('REVIEW_NOT_FOUND','邮件记录已处理或不存在。');
      item=review;
      source=[review.subject,review.sender,...(review.notices as Row[]).map(row=>row.evidence)].join('\n');
    }
    if(!source.includes(quote))throw new AppError('BAD_EVIDENCE','引用文字必须出现在这条记录的原文中。');
    if(decision==='resolve'){
      if(kind==='mail'){
        const company=clean(raw.company,150),position=clean(raw.position,150),stage=clean(raw.stage,30),status=clean(raw.status,30),applicationId=clean(raw.application_id,100);
        if(!company||!position||!SELECTABLE_STAGES.includes(stage as typeof SELECTABLE_STAGES[number])||!STATUSES.includes(status as typeof STATUSES[number])||status==='unknown')throw new AppError('BAD_AI_REVIEW','请给出明确的公司、岗位、阶段和状态。');
        if(applicationId){
          const app=this.store.db.prepare('SELECT company,position FROM applications WHERE id=?').get(applicationId) as Row|undefined;
          if(!app||key(String(app.company))!==key(company)||key(String(app.position))!==key(position))throw new AppError('BAD_APPLICATION','关联岗位与 AI 判断不一致。');
        }else if(!source.includes(position)||!source.includes(company))throw new AppError('BAD_EVIDENCE','新建岗位的公司与岗位都必须有邮件原文依据。');
        this.store.resolveReview(id,company,position,applicationId||undefined,stage,status,'ai');
      }else{
        if(!Array.isArray(raw.updates)||raw.updates.length<1||raw.updates.length>4)throw new AppError('BAD_AI_REVIEW','导入记录需给出 1 到 4 个明确岗位。');
        const updates=raw.updates.map(value=>{
          const row=value as Row,company=clean(row.company,150),position=clean(row.position,150),stage=clean(row.stage,30),status=clean(row.status,30),applicationId=clean(row.application_id,100);
          if(!company||!position||!SELECTABLE_STAGES.includes(stage as typeof SELECTABLE_STAGES[number])||!STATUSES.includes(status as typeof STATUSES[number])||status==='unknown')throw new AppError('BAD_AI_REVIEW','导入岗位的公司、岗位、阶段或状态不明确。');
          const app=applicationId?this.store.db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId) as Row|undefined:undefined;
          if(applicationId&&(!app||key(String(app.company))!==key(company)||key(String(app.position))!==key(position)))throw new AppError('BAD_APPLICATION','关联岗位与 AI 判断不一致。');
          if(!app&&!source.includes(position)&&!String(item!.position).includes(position))throw new AppError('BAD_EVIDENCE','新岗位名称必须有表格原文依据。');
          if(!source.includes(company)&&key(company)!==key(String(item!.company)))throw new AppError('BAD_EVIDENCE','公司名称必须有表格原文依据。');
          return {company,position,stage,status,note:clean(item!.note,600),application_id:applicationId||undefined,expected_version:app?.version,create_new:!app};
        });
        this.store.applyManualProgress(updates);
        this.store.db.prepare("UPDATE manual_review_items SET state='resolved',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
      }
    }else if(kind==='mail'){
      if(decision==='ignore')this.store.ignoreReview(id);
      else this.store.deferReview(id,reason);
    }else this.store.db.prepare('UPDATE manual_review_items SET state=?,reason=?,updated_at=? WHERE id=?').run(decision==='ignore'?'ignored':'waiting',reason,new Date().toISOString(),id);
    this.store.db.prepare('INSERT INTO ai_decisions(id,kind,item_id,decision,reason,evidence_quote,output_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(),kind,id,decision,reason,quote,JSON.stringify(raw),new Date().toISOString());
    this.store.bumpVersion();
  }
}
