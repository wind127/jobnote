import { Store } from './store.js';
import { AppError, STAGE_LABELS, progressStatusLabel, type Stage } from './types.js';

type Row = Record<string, unknown>;
const fourHours = 14_400_000;

export function currentSlot(anchor: string, at = new Date()): number {
  return Math.max(0, Math.floor((at.getTime() - Date.parse(anchor)) / fourHours));
}

function localTime(value: string | null): string {
  if (!value) return '时间待核对';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(parsed);
}

export function makeDigest(store: Store, at = new Date()): {title:string;body:string;eventCursor:number} {
  const todos=store.db.prepare(`SELECT t.*,a.company,a.position FROM todos t LEFT JOIN applications a ON a.id=t.application_id WHERE t.status='open'`).all() as Row[];
  const lastDigest=store.db.prepare('SELECT event_cursor FROM digest_runs ORDER BY slot DESC LIMIT 1').get() as Row | undefined;
  const eventCursor=Number((store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM events').get() as Row).cursor);
  const recent=store.db.prepare(`SELECT e.rowid,e.stage,e.status,a.company,a.position FROM events e LEFT JOIN applications a ON a.id=e.application_id WHERE e.rowid>? AND e.needs_review=0 ORDER BY e.rowid DESC LIMIT 20`).all(Number(lastDigest?.event_cursor ?? 0)) as Row[];
  const failed=store.db.prepare("SELECT COUNT(*) AS count FROM failures WHERE status IN ('pending','skipped','retry_requested')").get() as Row;
  const soon=at.getTime()+48*3600_000;
  const rank=(todo:Row): number => {
    const time=todo.due_at?Date.parse(String(todo.due_at)):todo.due_date?Date.parse(String(todo.due_date)+'T23:59:59+08:00'):null;
    if(time===null||!Number.isFinite(time)) return 3;
    if(time<at.getTime())return 0;
    if(time<=soon)return 1;
    return 2;
  };
  todos.sort((a,b)=>rank(a)-rank(b)||String(a.due_at??a.due_date??'').localeCompare(String(b.due_at??b.due_date??'')));
  const lines:string[]=[];
  if(todos.length){
    lines.push(`待办 ${todos.length} 项`);
    for(const todo of todos.slice(0,10)){
      const when=todo.due_at?localTime(String(todo.due_at)):todo.due_date?`${todo.due_date}（日期）`:String(todo.time_text??'时间待核对');
      const prefix=rank(todo)===0?'逾期':rank(todo)===1?'48 小时内':'待办';
      lines.push(`- [${prefix}] ${todo.company??'公司待核对'} · ${todo.position??'岗位待核对'}：${todo.title}（${when}）`);
    }
    if(todos.length>10) lines.push(`另有 ${todos.length-10} 项，请在网页查看。`);
  }else lines.push('目前没有未完成待办。');
  if(recent.length){
    lines.push('',`新进展 ${recent.length} 项`);
    for(const item of recent.slice(0,5))lines.push(`- ${item.company} · ${item.position}：${STAGE_LABELS[item.stage as Stage]??'阶段待核对'} · ${progressStatusLabel(String(item.stage),String(item.status))}`);
    if(recent.length>5)lines.push(`另有 ${recent.length-5} 项新进展。`);
  }
  if(Number(failed.count)>0)lines.push('',`有 ${failed.count} 封邮件未完整处理，请在网页检查。`);
  const scan=store.scanState();
  lines.push('',`邮箱最近成功读取：${scan.last_success_at?localTime(String(scan.last_success_at)):'尚未成功读取'}`);
  return {title:`求职记待办 · ${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'}).format(at)}`,body:lines.join('\n'),eventCursor};
}

export function finishRun(store: Store, at = new Date()): object {
  const anchor=store.setting('anchor_at');
  if(!anchor)throw new AppError('NO_RUN','先运行邮件整理。');
  const slot=currentSlot(anchor,at);
  return store.transaction(() => {
    const run=store.activeRun();
    if(store.activeBatch(String(run.id)))throw new AppError('BATCH_OPEN','当前批次尚未提交。');
    const scan=store.scanState();
    if(run.upper_uid===null || Number(scan.last_uid)<Number(run.upper_uid))throw new AppError('SCAN_INCOMPLETE','本轮还有未读取邮件，请继续执行 batch。');
    store.db.prepare("UPDATE runs SET status='complete',finished_at=? WHERE id=?").run(at.toISOString(),String(run.id));
    const existing=store.db.prepare('SELECT slot FROM digest_runs WHERE slot=?').get(slot) as Row|undefined;
    if(existing){store.bumpVersion();return {slot,should_send:false};}
    const digest=makeDigest(store,at);
    store.db.prepare('INSERT INTO digest_runs(slot,title,body,generated_at,event_cursor) VALUES(?,?,?,?,?)').run(slot,digest.title,digest.body,at.toISOString(),digest.eventCursor);
    store.bumpVersion();
    return {slot,should_send:true,title:digest.title,body:digest.body};
  });
}
