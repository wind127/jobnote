import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, type MailPage, type Submission, STAGES, SELECTABLE_STAGES, STATUSES, CLASSIFICATIONS, type UpdateInput } from './types.js';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const clean = (value: unknown, max = 250) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const keyOf = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const asRows = (rows: unknown[]) => rows as Row[];

export class Store {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'jobnote.db'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scan_state (id INTEGER PRIMARY KEY CHECK(id=1), uid_validity INTEGER, last_uid INTEGER NOT NULL DEFAULT 0, first_since TEXT NOT NULL, last_success_at TEXT);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, slot INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, upper_uid INTEGER);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), uid_validity INTEGER NOT NULL, upper_uid INTEGER NOT NULL, page_end INTEGER NOT NULL, is_retry INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batch_messages (batch_id TEXT NOT NULL REFERENCES batches(id), source_key TEXT NOT NULL, uid INTEGER NOT NULL, message_id TEXT, subject TEXT NOT NULL, sender TEXT NOT NULL, received_at TEXT NOT NULL, body TEXT, content_hash TEXT, error TEXT, PRIMARY KEY(batch_id,source_key));
      CREATE TABLE IF NOT EXISTS failures (source_key TEXT PRIMARY KEY, uid INTEGER NOT NULL, subject TEXT, error TEXT NOT NULL, status TEXT NOT NULL, skip_reason TEXT, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_sources (source_key TEXT PRIMARY KEY, uid INTEGER NOT NULL, message_id TEXT, subject TEXT NOT NULL, sender TEXT NOT NULL, received_at TEXT NOT NULL, content_hash TEXT, classification TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, company TEXT NOT NULL, position TEXT NOT NULL, application_ref TEXT, stage TEXT NOT NULL, status TEXT NOT NULL, last_event_at TEXT NOT NULL, manual_stage INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source_key TEXT NOT NULL REFERENCES mail_sources(source_key), ordinal INTEGER NOT NULL, application_id TEXT REFERENCES applications(id), stage TEXT NOT NULL, status TEXT NOT NULL, round TEXT, occurred_at TEXT NOT NULL, evidence TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0, UNIQUE(source_key,ordinal));
      CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, application_id TEXT REFERENCES applications(id), event_id TEXT NOT NULL REFERENCES events(id), match_key TEXT NOT NULL, title TEXT NOT NULL, due_at TEXT, due_date TEXT, time_text TEXT, status TEXT NOT NULL DEFAULT 'open', manual_status INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, UNIQUE(application_id,match_key));
      CREATE TABLE IF NOT EXISTS digest_runs (slot INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, generated_at TEXT NOT NULL, event_cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS review_items (id TEXT PRIMARY KEY, source_key TEXT NOT NULL, ordinal INTEGER NOT NULL, reason TEXT NOT NULL, company TEXT, position TEXT, stage TEXT, status TEXT, evidence TEXT NOT NULL, todo_json TEXT, created_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open');
    `);
    for (const [table, column, definition] of [
      ['batches', 'is_retry', 'INTEGER NOT NULL DEFAULT 0'],
      ['review_items', 'todo_json', 'TEXT'],
    ]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    if (!this.db.prepare('SELECT id FROM scan_state WHERE id=1').get()) {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      this.db.prepare('INSERT INTO scan_state (id,first_since) VALUES (1,?)').run(since);
    }
  }

  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as Row | undefined)?.value as string ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
  }

  bumpVersion(): void { this.setSetting('version', String(Number(this.setting('version') ?? '0') + 1)); }

  scanState(): Row { return this.db.prepare('SELECT * FROM scan_state WHERE id=1').get() as Row; }

  beginRun(at = new Date()): Row {
    return this.transaction(() => {
      const active = this.db.prepare("SELECT * FROM runs WHERE status='active' LIMIT 1").get() as Row | undefined;
      if (active) return active;
      let anchor = this.setting('anchor_at');
      if (!anchor) { anchor = at.toISOString(); this.setSetting('anchor_at', anchor); }
      const slot = Math.max(0, Math.floor((at.getTime() - Date.parse(anchor)) / 14_400_000));
      const run = { id: randomUUID(), slot, status: 'active', started_at: at.toISOString(), upper_uid: null };
      this.db.prepare('INSERT INTO runs(id,slot,status,started_at) VALUES(?,?,?,?)').run(run.id,run.slot,run.status,run.started_at);
      return run;
    });
  }

  activeRun(): Row {
    const run = this.db.prepare("SELECT * FROM runs WHERE status='active' LIMIT 1").get() as Row | undefined;
    if (!run) throw new AppError('NO_ACTIVE_RUN', '先执行 begin 开始本轮任务。');
    return run;
  }

  activeBatch(runId: string): Row | null {
    return this.db.prepare("SELECT * FROM batches WHERE run_id=? AND status='open' LIMIT 1").get(runId) as Row | undefined ?? null;
  }

  sourceKey(uidValidity: number, uid: number): string {
    const account = process.env.EXMAIL_ACCOUNT;
    if (!account) throw new AppError('MAIL_CONFIG', '需要在本地设置 EXMAIL_ACCOUNT。');
    const mailbox = createHash('sha256').update(account.trim().toLowerCase()).digest('hex').slice(0,16);
    return `${mailbox}:INBOX:${uidValidity}:${uid}`;
  }

  savePage(runId: string, page: MailPage, isRetry = false): Row | null {
    const result = this.transaction((): Row | null | 'RESET' => {
      const run = this.activeRun();
      if (run.id !== runId) throw new AppError('RUN_MISMATCH', '本轮编号已经失效。');
      if (this.activeBatch(runId)) throw new AppError('BATCH_OPEN', '先处理当前批次。');
      const scan = this.scanState();
      if (scan.uid_validity !== null && Number(scan.uid_validity) !== page.uidValidity) {
        this.db.prepare('UPDATE scan_state SET uid_validity=?,last_uid=0,last_success_at=NULL WHERE id=1').run(page.uidValidity);
        this.db.prepare('UPDATE runs SET upper_uid=NULL WHERE id=?').run(runId);
        this.db.prepare("UPDATE failures SET status='stale',updated_at=? WHERE status IN ('pending','skipped')").run(nowIso());
        return 'RESET';
      }
      if (scan.uid_validity === null) this.db.prepare('UPDATE scan_state SET uid_validity=? WHERE id=1').run(page.uidValidity);
      if (run.upper_uid === null && !isRetry) this.db.prepare('UPDATE runs SET upper_uid=? WHERE id=?').run(page.upperUid,runId);
      if (page.items.length === 0) {
        if (!isRetry) this.db.prepare('UPDATE scan_state SET last_uid=?,last_success_at=? WHERE id=1').run(page.upperUid,nowIso());
        this.bumpVersion();
        return null;
      }
      const id = randomUUID();
      this.db.prepare('INSERT INTO batches(id,run_id,uid_validity,upper_uid,page_end,is_retry,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,runId,page.uidValidity,page.upperUid,page.pageEnd,isRetry?1:0,'open',nowIso());
      for (const item of page.items) {
        const source = this.sourceKey(page.uidValidity,item.uid);
        this.db.prepare('INSERT INTO batch_messages(batch_id,source_key,uid,message_id,subject,sender,received_at,body,content_hash,error) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,source,item.uid,item.messageId,item.subject,item.sender,item.receivedAt,item.text,item.contentHash,item.error);
        if (item.error) this.db.prepare(`INSERT INTO failures(source_key,uid,subject,error,status,first_seen_at,updated_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(source_key) DO UPDATE SET error=excluded.error,status=CASE WHEN failures.status='skipped' THEN 'skipped' ELSE 'pending' END,updated_at=excluded.updated_at`).run(source,item.uid,item.subject,item.error,'pending',nowIso(),nowIso());
      }
      this.bumpVersion();
      return this.db.prepare('SELECT * FROM batches WHERE id=?').get(id) as Row;
    });
    if (result === 'RESET') throw new AppError('UIDVALIDITY_CHANGED', '邮箱 UIDVALIDITY 已变化，已重置本地读取位置；请重新执行 batch。');
    return result;
  }

  batchView(batchId: string): object {
    const batch = this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId) as Row | undefined;
    if (!batch) throw new AppError('BATCH_NOT_FOUND','未找到批次。');
    const messages = asRows(this.db.prepare(`SELECT m.*,f.status AS failure_status FROM batch_messages m LEFT JOIN failures f ON f.source_key=m.source_key WHERE m.batch_id=? ORDER BY m.uid`).all(batchId));
    return { schema_version: '1', run_id: batch.run_id, batch_id: batch.id, page_end: batch.page_end, messages: messages.map(({source_key,subject,sender,received_at,body,error,failure_status}) => ({ source_key,subject,sender,received_at,body,error,failure_status })) };
  }

  oversizedFailures(batchId: string): Row[] {
    return asRows(this.db.prepare("SELECT source_key,uid FROM batch_messages WHERE batch_id=? AND error='邮件超过 2 MiB 读取上限'").all(batchId));
  }

  repairOpenBatchMessage(batchId: string, uidValidity: number, item: MailPage['items'][number]): void {
    if(item.error || !item.text || !item.contentHash)throw new AppError('REPAIR_FAILED','该邮件仍无可用正文。');
    this.transaction(()=>{
      const batch=this.db.prepare("SELECT run_id,uid_validity FROM batches WHERE id=? AND status='open'").get(batchId) as Row|undefined;
      if(!batch || Number(batch.uid_validity)!==uidValidity || this.activeRun().id!==batch.run_id)throw new AppError('BATCH_MISMATCH','待修复批次已失效。');
      const sourceKey=this.sourceKey(uidValidity,item.uid);
      const changed=this.db.prepare("UPDATE batch_messages SET message_id=?,subject=?,sender=?,received_at=?,body=?,content_hash=?,error=NULL WHERE batch_id=? AND source_key=? AND error='邮件超过 2 MiB 读取上限'").run(item.messageId,item.subject,item.sender,item.receivedAt,item.text,item.contentHash,batchId,sourceKey);
      if(!changed.changes)throw new AppError('REPAIR_FAILED','待修复邮件已变化。');
      this.db.prepare("UPDATE failures SET status='resolved',updated_at=? WHERE source_key=?").run(nowIso(),sourceKey);
      this.bumpVersion();
    });
  }

  skipFailure(sourceKey: string, reason: string): void {
    if (!clean(reason,500)) throw new AppError('REASON_REQUIRED','请输入跳过原因。');
    const result = this.db.prepare("UPDATE failures SET status='skipped',skip_reason=?,updated_at=? WHERE source_key=? AND status IN ('pending','retry_requested')").run(clean(reason,500),nowIso(),sourceKey);
    if (!result.changes) throw new AppError('FAILURE_NOT_FOUND','未找到待处理的单封失败邮件。');
    this.bumpVersion();
  }

  requestRetry(sourceKey: string): void {
    const result=this.db.prepare("UPDATE failures SET status='retry_requested',updated_at=? WHERE source_key=? AND status IN ('pending','skipped')").run(nowIso(),sourceKey);
    if(!result.changes)throw new AppError('FAILURE_NOT_FOUND','未找到可重试的失败邮件。');
    this.bumpVersion();
  }

  requestedRetry(): Row | null {
    return this.db.prepare("SELECT * FROM failures WHERE status='retry_requested' ORDER BY updated_at LIMIT 1").get() as Row | undefined ?? null;
  }

  retryMissing(sourceKey: string): void {
    this.db.prepare("UPDATE failures SET status='pending',error='原邮件已不在收件箱中',updated_at=? WHERE source_key=?").run(nowIso(),sourceKey);
    this.bumpVersion();
  }

  private validateUpdate(input: UpdateInput, body: string): void {
    if (!input || typeof input !== 'object' || !STAGES.includes(input.stage) || !STATUSES.includes(input.status)) throw new AppError('BAD_UPDATE','进展阶段或状态无效。');
    if (input.stage === 'interview' && !input.needs_review) throw new AppError('REVIEW_REQUIRED','未注明面试轮次时，请将进展标为待核对。');
    if (!clean(input.evidence,600) || !body.includes(input.evidence)) throw new AppError('BAD_EVIDENCE','证据原文不在本封邮件正文中。');
    if (input.company && input.company.length > 150 || input.position && input.position.length > 150) throw new AppError('BAD_UPDATE','公司或岗位名称过长。');
    if (input.occurred_at && !iso(input.occurred_at)) throw new AppError('BAD_TIME','事件时间无效。');
    if (input.todo) {
      if (!clean(input.todo.title,250)) throw new AppError('BAD_TODO','待办标题为空。');
      if (input.todo.due_at && !iso(input.todo.due_at)) throw new AppError('BAD_TIME','截止时间无效。');
      if (input.todo.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(input.todo.due_date)) throw new AppError('BAD_TIME','截止日期无效。');
    }
  }

  submit(payload: Submission): object {
    if (payload?.schema_version !== '1' || !Array.isArray(payload.messages)) throw new AppError('BAD_SCHEMA','整理结果格式不正确。');
    return this.transaction(() => {
      const batch = this.db.prepare("SELECT * FROM batches WHERE id=? AND status='open'").get(payload.batch_id) as Row | undefined;
      if (!batch || batch.run_id !== payload.run_id) throw new AppError('BATCH_MISMATCH','批次不存在或已提交。');
      if (this.activeRun().id !== payload.run_id) throw new AppError('RUN_MISMATCH','本轮任务已结束。');
      const expected = asRows(this.db.prepare('SELECT * FROM batch_messages WHERE batch_id=? ORDER BY uid').all(payload.batch_id));
      const byKey = new Map(expected.map(row => [String(row.source_key),row]));
      if (payload.messages.length !== expected.length || new Set(payload.messages.map(m=>m.source_key)).size !== expected.length || payload.messages.some(m=>!byKey.has(m.source_key))) throw new AppError('INCOMPLETE_BATCH','整理结果必须与本地邮件清单逐封对应。');
      for (const msg of payload.messages) {
        if (!CLASSIFICATIONS.includes(msg.classification) || !Array.isArray(msg.updates) || msg.updates.length > 50) throw new AppError('BAD_MESSAGE','邮件分类或进展数量无效。');
        const local = byKey.get(msg.source_key)!;
        const failure = this.db.prepare('SELECT status FROM failures WHERE source_key=?').get(msg.source_key) as Row | undefined;
        if (local.error) {
          if (failure?.status !== 'skipped' || msg.classification !== 'skipped' || msg.updates.length) throw new AppError('MAIL_UNRESOLVED','失败邮件仅能在用户明确跳过后继续。');
        } else {
          if (msg.classification === 'skipped') throw new AppError('SKIP_FORBIDDEN','模型不能自行跳过邮件。');
          if (msg.classification !== 'recruitment' && msg.updates.length) throw new AppError('BAD_MESSAGE','非招聘邮件不能产生进展。');
          if (msg.classification === 'recruitment' && !msg.updates.length) throw new AppError('BAD_MESSAGE','招聘邮件至少需要一条进展；不确定时使用待核对。');
          for (const update of msg.updates) this.validateUpdate(update,String(local.body ?? ''));
        }
      }
      let applied = 0, reviews = 0;
      for (const msg of payload.messages) {
        const local = byKey.get(msg.source_key)!;
        if (msg.classification === 'skipped') continue;
        const exists = this.db.prepare('SELECT source_key FROM mail_sources WHERE source_key=?').get(msg.source_key);
        if (exists) continue;
        this.db.prepare('INSERT INTO mail_sources(source_key,uid,message_id,subject,sender,received_at,content_hash,classification,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(String(local.source_key),Number(local.uid),local.message_id as string|null,String(local.subject),String(local.sender),String(local.received_at),local.content_hash as string|null,msg.classification,nowIso());
        for (const [ordinal,update] of msg.updates.entries()) {
          const company=clean(update.company,150), position=clean(update.position,150), appRef=clean(update.application_ref,100) || null;
          let app: Row | undefined;
          let needsReview=msg.classification==='uncertain' || !!update.needs_review || update.stage==='interview' || !company || !position;
          if (company && position) {
            const candidates=asRows(this.db.prepare('SELECT * FROM applications WHERE lower(company)=? AND lower(position)=?').all(keyOf(company),keyOf(position)));
            app=appRef ? candidates.find(row=>row.application_ref === appRef) : candidates.length===1 ? candidates[0] : undefined;
            if (!app && candidates.length > 0 && !appRef) needsReview=true;
            if (!app && !needsReview) {
              const id=randomUUID();
              this.db.prepare('INSERT INTO applications(id,company,position,application_ref,stage,status,last_event_at) VALUES(?,?,?,?,?,?,?)').run(id,company,position,appRef,update.stage,update.status,iso(update.occurred_at) ?? String(local.received_at));
              app=this.db.prepare('SELECT * FROM applications WHERE id=?').get(id) as Row;
            }
          }
          const eventId=randomUUID();
          this.db.prepare('INSERT INTO events(id,source_key,ordinal,application_id,stage,status,round,occurred_at,evidence,needs_review) VALUES(?,?,?,?,?,?,?,?,?,?)').run(eventId,msg.source_key,ordinal,app ? String(app.id) : null,update.stage,update.status,clean(update.round,80)||null,iso(update.occurred_at)??String(local.received_at),clean(update.evidence,600),needsReview?1:0);
          if (needsReview) {
            this.db.prepare('INSERT INTO review_items(id,source_key,ordinal,reason,company,position,stage,status,evidence,todo_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),msg.source_key,ordinal,(!company||!position)?'公司或岗位待核对':'归属或内容待核对',company||null,position||null,update.stage,update.status,clean(update.evidence,600),update.todo?JSON.stringify(update.todo):null,nowIso());
            reviews++;
          } else if (app) {
            applied++;
            if (!Number(app.manual_stage) && Date.parse(iso(update.occurred_at)??String(local.received_at)) >= Date.parse(String(app.last_event_at))) {
              this.db.prepare('UPDATE applications SET stage=?,status=?,last_event_at=?,version=version+1 WHERE id=?').run(update.stage,update.status,iso(update.occurred_at)??String(local.received_at),String(app.id));
            }
            if (update.todo) this.upsertTodo(String(app.id),eventId,update);
          }
        }
      }
      if (!Number(batch.is_retry)) this.db.prepare('UPDATE scan_state SET last_uid=?,last_success_at=? WHERE id=1').run(Number(batch.page_end),nowIso());
      this.db.prepare("UPDATE failures SET status='resolved',updated_at=? WHERE source_key IN (SELECT source_key FROM batch_messages WHERE batch_id=? AND error IS NULL)").run(nowIso(),String(batch.id));
      this.db.prepare("UPDATE batches SET status='submitted' WHERE id=?").run(String(batch.id));
      this.db.prepare('UPDATE batch_messages SET body=NULL WHERE batch_id=?').run(String(batch.id));
      this.bumpVersion();
      return { accepted: true, applied, reviews, last_uid: Number(batch.page_end) };
    });
  }

  private upsertTodo(appId: string, eventId: string, update: UpdateInput): void {
    const todo=update.todo!;
    const match=keyOf(`${update.stage}:${update.round ?? 'default'}:${todo.kind ?? 'participate'}`);
    const existing=this.db.prepare('SELECT * FROM todos WHERE application_id=? AND match_key=?').get(appId,match) as Row | undefined;
    if (existing) {
      if (!Number(existing.manual_status)) this.db.prepare('UPDATE todos SET event_id=?,title=?,due_at=?,due_date=?,time_text=?,status=?,version=version+1 WHERE id=?').run(eventId,clean(todo.title),iso(todo.due_at),clean(todo.due_date,10)||null,clean(todo.time_text,250)||null,update.status==='cancelled'?'cancelled':'open',String(existing.id));
    } else {
      this.db.prepare('INSERT INTO todos(id,application_id,event_id,match_key,title,due_at,due_date,time_text,status) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),appId,eventId,match,clean(todo.title),iso(todo.due_at),clean(todo.due_date,10)||null,clean(todo.time_text,250)||null,update.status==='cancelled'?'cancelled':'open');
    }
  }

  setTodo(id: string, status: 'open'|'done', expectedVersion: number): void {
    const result=this.db.prepare('UPDATE todos SET status=?,manual_status=1,version=version+1 WHERE id=? AND version=?').run(status,id,expectedVersion);
    if (!result.changes) throw new AppError('VERSION_CONFLICT','待办已变化，请刷新页面。');
    this.bumpVersion();
  }

  editApplication(id: string, fields: {company?:string;position?:string;stage?:string;status?:string;expected_version:number}): void {
    const current=this.db.prepare('SELECT * FROM applications WHERE id=?').get(id) as Row|undefined;
    if(!current || Number(current.version)!==fields.expected_version)throw new AppError('VERSION_CONFLICT','岗位信息已变化，请刷新页面。');
    const company=clean(fields.company??current.company,150),position=clean(fields.position??current.position,150);
    const stage=fields.stage??String(current.stage),status=fields.status??String(current.status);
    if(!company||!position||!SELECTABLE_STAGES.includes(stage as typeof SELECTABLE_STAGES[number])||!STATUSES.includes(status as typeof STATUSES[number]))throw new AppError('BAD_APPLICATION','公司、岗位、阶段或状态无效。');
    this.db.prepare('UPDATE applications SET company=?,position=?,stage=?,status=?,manual_stage=1,version=version+1 WHERE id=?').run(company,position,stage,status,id);
    this.bumpVersion();
  }

  resolveReview(id: string, company: string, position: string, applicationId?: string, stage?: string, status?: string): void {
    this.transaction(() => {
      const review=this.db.prepare("SELECT * FROM review_items WHERE id=? AND state='open'").get(id) as Row|undefined;
      if(!review)throw new AppError('REVIEW_NOT_FOUND','待核对事项不存在。');
      const name=clean(company,150),role=clean(position,150);
      if(!name||!role)throw new AppError('BAD_APPLICATION','请填写公司和岗位。');
      const phase=stage??String(review.stage),result=status??String(review.status);
      if(!SELECTABLE_STAGES.includes(phase as typeof SELECTABLE_STAGES[number])||!STATUSES.includes(result as typeof STATUSES[number]))throw new AppError('BAD_APPLICATION','进展阶段或状态无效。');
      const event=this.db.prepare('SELECT * FROM events WHERE source_key=? AND ordinal=?').get(String(review.source_key),Number(review.ordinal)) as Row|undefined;
      if(!event)throw new AppError('EVENT_NOT_FOUND','对应邮件进展不存在。');
      let app:Row|undefined;
      let created=false;
      if(applicationId){
        app=this.db.prepare('SELECT * FROM applications WHERE id=?').get(applicationId) as Row|undefined;
        if(!app)throw new AppError('APPLICATION_NOT_FOUND','所选岗位不存在。');
      }else{
        const matches=this.db.prepare('SELECT * FROM applications WHERE lower(company)=? AND lower(position)=?').all(keyOf(name),keyOf(role)) as Row[];
        if(matches.length>1)throw new AppError('AMBIGUOUS_APPLICATION','有多个同名岗位，请明确选择。');
        app=matches[0];
        if(!app){
          const appId=randomUUID();
          this.db.prepare('INSERT INTO applications(id,company,position,stage,status,last_event_at) VALUES(?,?,?,?,?,?)').run(appId,name,role,phase,result,String(event.occurred_at));
          app=this.db.prepare('SELECT * FROM applications WHERE id=?').get(appId) as Row;
          created=true;
        }
      }
      this.db.prepare('UPDATE events SET application_id=?,stage=?,status=?,needs_review=0 WHERE id=?').run(String(app.id),phase,result,String(event.id));
      if(!created&&!Number(app.manual_stage)&&Date.parse(String(event.occurred_at))>=Date.parse(String(app.last_event_at))){
        this.db.prepare('UPDATE applications SET stage=?,status=?,last_event_at=?,version=version+1 WHERE id=?').run(phase,result,String(event.occurred_at),String(app.id));
      }
      if(review.todo_json){
        this.upsertTodo(String(app.id),String(event.id),{stage:phase as UpdateInput['stage'],status:result as UpdateInput['status'],round:event.round as string|null,todo:JSON.parse(String(review.todo_json)),evidence:String(event.evidence),company:name,position:role});
      }
      this.db.prepare("UPDATE review_items SET state='resolved' WHERE id=?").run(id);
      this.bumpVersion();
    });
  }

  ignoreReview(id: string): void {
    const result=this.db.prepare("UPDATE review_items SET state='ignored' WHERE id=? AND state='open'").run(id);
    if(!result.changes)throw new AppError('REVIEW_NOT_FOUND','待核对事项不存在。');
    this.bumpVersion();
  }

  dashboard(): object {
    const applications=asRows(this.db.prepare('SELECT * FROM applications ORDER BY last_event_at DESC').all());
    const todos=asRows(this.db.prepare('SELECT * FROM todos ORDER BY COALESCE(due_at,due_date) ASC').all());
    const events=asRows(this.db.prepare('SELECT e.*,m.subject,m.sender,m.received_at FROM events e JOIN mail_sources m ON m.source_key=e.source_key ORDER BY e.occurred_at DESC').all());
    const reviews=asRows(this.db.prepare("SELECT * FROM review_items WHERE state='open' ORDER BY created_at DESC").all());
    const failures=asRows(this.db.prepare("SELECT source_key,uid,subject,error,status,skip_reason,updated_at FROM failures WHERE status IN ('pending','skipped','retry_requested') ORDER BY updated_at DESC").all());
    const scan=this.scanState();
    const active=this.db.prepare("SELECT upper_uid FROM runs WHERE status='active' LIMIT 1").get() as Row | undefined;
    const scanIncomplete=!!active && (active.upper_uid===null || Number(scan.last_uid)<Number(active.upper_uid));
    return { version:Number(this.setting('version')??'0'), demo_mode:this.setting('demo_mode')==='true', first_since:scan.first_since, last_success_at:scan.last_success_at, scan_incomplete:scanIncomplete, applications,todos,events,reviews,failures };
  }
}
