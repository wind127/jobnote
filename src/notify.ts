import { Store } from './store.js';
import { AppError } from './types.js';

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
  const lastAccepted=store.db.prepare("SELECT event_cursor FROM deliveries WHERE status='accepted' ORDER BY slot DESC LIMIT 1").get() as Row | undefined;
  const eventCursor=Number((store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS cursor FROM events').get() as Row).cursor);
  const recent=store.db.prepare(`SELECT e.rowid,e.stage,e.status,a.company,a.position FROM events e LEFT JOIN applications a ON a.id=e.application_id WHERE e.rowid>? AND e.needs_review=0 ORDER BY e.rowid DESC LIMIT 20`).all(Number(lastAccepted?.event_cursor ?? 0)) as Row[];
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
    for(const item of recent.slice(0,5))lines.push(`- ${item.company} · ${item.position}：${item.stage} / ${item.status}`);
    if(recent.length>5)lines.push(`另有 ${recent.length-5} 项新进展。`);
  }
  if(Number(failed.count)>0)lines.push('',`有 ${failed.count} 封邮件未完整处理，请在网页检查。`);
  const scan=store.scanState();
  lines.push('',`邮箱最近成功读取：${scan.last_success_at?localTime(String(scan.last_success_at)):'尚未成功读取'}`);
  return {title:`求职记待办 · ${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'}).format(at)}`,body:lines.join('\n'),eventCursor};
}

export async function finishAndNotify(store: Store, sender: typeof fetch = fetch, at = new Date()): Promise<object> {
  const anchor=store.setting('anchor_at');
  if(!anchor)throw new AppError('NO_RUN','先运行邮件整理。');
  const slot=currentSlot(anchor,at);
  const claim=store.transaction(() => {
    const run=store.activeRun();
    if(store.activeBatch(String(run.id)))throw new AppError('BATCH_OPEN','当前批次尚未提交。');
    const scan=store.scanState();
    if(run.upper_uid===null || Number(scan.last_uid)<Number(run.upper_uid))throw new AppError('SCAN_INCOMPLETE','本轮还有未读取邮件，请继续执行 batch。');
    store.db.prepare("UPDATE runs SET status='complete',finished_at=? WHERE id=?").run(at.toISOString(),String(run.id));
    const existing=store.db.prepare('SELECT slot,status FROM deliveries WHERE slot=?').get(slot) as Row|undefined;
    if(existing)return {send:false,status:String(existing.status),slot};
    const digest=makeDigest(store,at);
    store.db.prepare("INSERT INTO deliveries(slot,status,summary,attempted_at,event_cursor) VALUES(?,'sending',?,?,?)").run(slot,digest.title+'\n'+digest.body,at.toISOString(),digest.eventCursor);
    store.bumpVersion();
    return {send:true,slot,digest};
  });
  if(!claim.send)return {slot,status:claim.status};
  const digest=claim.digest!;
  const sendKey=process.env.SERVERCHAN_SENDKEY;
  if(!sendKey || !/^SCT[A-Za-z0-9_-]{10,}$/.test(sendKey)){
    store.db.prepare("UPDATE deliveries SET status='failed',result_code='CONFIG_MISSING' WHERE slot=?").run(slot);
    store.bumpVersion();
    return {slot,status:'failed',reason:'微信 SendKey 未配置或格式无效'};
  }
  try {
    const response=await sender(`https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`,{
      method:'POST',headers:{'content-type':'application/json'},redirect:'error',
      body:JSON.stringify({title:digest.title,desp:digest.body}),signal:AbortSignal.timeout(15000),
    });
    let reply:unknown;
    try{reply=await response.json();}catch{reply=null;}
    const code=reply && typeof reply==='object' && 'code' in reply ? (reply as {code:unknown}).code : null;
    const status=response.ok && code===0?'accepted':code!==null?'failed':'unknown';
    store.db.prepare('UPDATE deliveries SET status=?,result_code=? WHERE slot=?').run(status,typeof code==='number'?String(code):String(response.status),slot);
    store.bumpVersion();
    return {slot,status};
  }catch{
    store.db.prepare("UPDATE deliveries SET status='unknown',result_code='TRANSPORT_UNKNOWN' WHERE slot=?").run(slot);
    store.bumpVersion();
    return {slot,status:'unknown'};
  }
}
