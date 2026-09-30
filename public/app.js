const STAGE={applied:'已投递',screening:'简历筛选',assessment:'测评',ai_interview:'AI 面试',written_test:'笔试',interview:'面试',offer:'Offer',rejected:'已结束',other:'其他'};
const STATUS={invited:'已邀请',scheduling:'待预约',scheduled:'已预约',completed:'已完成',passed:'已通过',failed:'未通过',cancelled:'已取消',received:'已收到',unknown:'待确认'};
const $=id=>document.getElementById(id);
let state={applications:[],todos:[],events:[],reviews:[],failures:[],version:-1};
let toastTimer;

function el(tag,className='',text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function shortDate(value){if(!value)return '时间待核对';const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):String(value);}
function calendarDate(value){if(!value)return '—';return shortDate(value);}
function showToast(message){const toast=$('toast');toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),4200);}
async function api(url,body){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.message||'操作失败，请刷新页面。');return result;}
async function refresh(silent=false){try{const response=await fetch('/api/dashboard',{cache:'no-store'});if(!response.ok)throw Error('无法读取进度。');const next=await response.json();if(next.version!==state.version){state=next;$('demo-banner').hidden=!state.demo_mode;render();}}catch(error){$('sync-led').classList.add('error');$('sync-status').textContent='无法读取最新数据，请确认本地服务正在运行。';if(!silent)showToast(error.message);}}
async function action(url,body,message){try{await api(url,body);showToast(message);await refresh();return true;}catch(error){showToast(error.message);return false;}}
function appendText(parent,tag,className,text){const child=el(tag,className,text);parent.append(child);return child;}
function emptyBox(title,detail){const box=el('div','empty-box');appendText(box,'strong','',title);appendText(box,'p','',detail);return box;}
function sortTodos(a,b){const tier=item=>{if(item.status!=='open')return 4;const due=item.due_at?Date.parse(item.due_at):item.due_date?Date.parse(`${item.due_date}T23:59:59+08:00`):NaN;if(!Number.isFinite(due))return 3;if(due<Date.now())return 0;if(due<Date.now()+48*3600_000)return 1;return 2;};return tier(a)-tier(b)||String(a.due_at||a.due_date||'').localeCompare(String(b.due_at||b.due_date||''));}
function todoTier(item){const due=item.due_at?Date.parse(item.due_at):item.due_date?Date.parse(`${item.due_date}T23:59:59+08:00`):NaN;if(!Number.isFinite(due))return {name:'时间待核对',className:'undated'};if(due<Date.now())return {name:'已逾期',className:'overdue'};if(due<Date.now()+48*3600_000)return {name:'未来 48 小时',className:'soon'};return {name:'之后',className:'later'};}
function renderTodoTable(container,items,completed=false){
  if(!items.length){if(!completed)container.append(emptyBox('眼下没有待办','新邮件整理后，测评、笔试和面试安排会出现在这里。'));return;}
  const scroll=el('div','table-scroll'),table=el('table','todos-table');
  appendText(table,'caption','sr-only',completed?'已完成待办表':'待办事项表');
  const head=el('thead'),headRow=el('tr');
  for(const name of ['紧急程度','公司','岗位','待办事项','截止时间','操作']){const cell=el('th','',name);cell.scope='col';headRow.append(cell);}
  head.append(headRow);table.append(head);
  const body=el('tbody');
  for(const todo of items){
    const app=state.applications.find(item=>item.id===todo.application_id),tier=todoTier(todo),row=el('tr',completed?'done':tier.className);
    const urgency=el('td');appendText(urgency,'span',`todo-priority ${completed?'done':tier.className}`,completed?'已完成':todo.review?`待核对 · ${tier.name}`:tier.name);row.append(urgency);
    appendText(row,'td','company-cell',app?.company||todo.company||'公司待核对');
    appendText(row,'td','position-cell',app?.position||todo.position||'岗位待核对');
    appendText(row,'td','todo-title-cell',todo.title);
    appendText(row,'td','date-cell',todo.due_at?shortDate(todo.due_at):todo.due_date?`${todo.due_date}（仅日期）`:todo.time_text||'时间待核对');
    const control=el('td'),button=el('button','text-action',todo.review?'先核对岗位':completed?'撤销完成':'标记完成');button.type='button';
    button.onclick=todo.review?()=>openReview(todo.review):()=>action(`/api/todos/${encodeURIComponent(todo.id)}/status`,{status:completed?'open':'done',expected_version:todo.version},completed?'待办已重新打开':'待办已完成');
    control.append(button);row.append(control);body.append(row);
  }
  table.append(body);scroll.append(table);container.append(scroll);
}
function renderTodos(){const list=$('todo-list'),completedList=$('completed-list');list.replaceChildren();completedList.replaceChildren();const pending=state.reviews.flatMap(review=>{if(!review.todo_json)return [];try{const todo=JSON.parse(review.todo_json);return [{...todo,review,company:review.company,position:review.position,status:'open'}];}catch{return [];}});const open=[...state.todos.filter(todo=>todo.status==='open'),...pending].sort(sortTodos),done=state.todos.filter(todo=>todo.status==='done');$('todo-count').textContent=open.length;$('urgent-count').textContent=open.filter(todo=>['overdue','soon'].includes(todoTier(todo).className)).length;renderTodoTable(list,open);renderTodoTable(completedList,done,true);$('completed-panel').hidden=!done.length;$('completed-heading').textContent=`已完成 ${done.length} 项`;}
function renderReview(){const panel=$('review-panel'),list=$('review-list');panel.hidden=!state.reviews.length;list.replaceChildren();$('review-panel-count').textContent=state.reviews.length;for(const review of state.reviews){const row=el('div','mini-row');appendText(row,'strong','',review.company||'公司待确认');appendText(row,'p','',`${review.position||'岗位待确认'} · ${review.reason}`);const controls=el('div','mini-actions');const fix=el('button','text-action','核对');fix.onclick=()=>openReview(review);const ignore=el('button','quiet-action','忽略');ignore.onclick=()=>action(`/api/reviews/${encodeURIComponent(review.id)}/ignore`,{},'已忽略这条建议');controls.append(fix,ignore);row.append(controls);list.append(row);}}
function renderFailures(){const panel=$('failure-panel'),list=$('failure-list');panel.hidden=!state.failures.length;list.replaceChildren();$('failure-panel-count').textContent=state.failures.length;for(const failure of state.failures){const row=el('div','mini-row');appendText(row,'strong','',failure.subject||`邮件 UID ${failure.uid}`);appendText(row,'p','',failure.error);appendText(row,'span','failure-state',failure.status==='skipped'?'已跳过，留待重试':failure.status==='retry_requested'?'等待下次任务重试':'等待处理');const controls=el('div','mini-actions');if(failure.status!=='retry_requested'){const retry=el('button','text-action','下轮重试');retry.onclick=()=>action(`/api/failures/${encodeURIComponent(failure.source_key)}/retry`,{},'已安排下轮重试');controls.append(retry);}if(failure.status!=='skipped'){const skip=el('button','quiet-action','跳过并继续');skip.onclick=()=>openSkip(failure);controls.append(skip);}row.append(controls);list.append(row);}}
function renderApplications(){
  const list=$('application-list');
  list.replaceChildren();
  const query=$('search').value.trim().toLocaleLowerCase(),stage=$('stage-filter').value;
  const apps=state.applications.filter(app=>(!query||`${app.company} ${app.position}`.toLocaleLowerCase().includes(query))&&(!stage||app.stage===stage));
  apps.sort((a,b)=>a.company.localeCompare(b.company,'zh-CN')||a.position.localeCompare(b.position,'zh-CN'));
  if(!apps.length){
    list.append(emptyBox(state.applications.length?'没有匹配的岗位':'这里还没有岗位进展',state.applications.length?'换个关键词或阶段再试。':'先在千问办公里运行一次读信整理任务，完成后会自动出现。'));
    return;
  }
  const scroll=el('div','table-scroll'),table=el('table','applications-table');
  appendText(table,'caption','sr-only','公司与岗位进展表');
  const head=el('thead'),headRow=el('tr');
  for(const name of ['公司','岗位','当前阶段','状态','下一步','截止时间','最近更新','操作']){
    const heading=el('th','',name);heading.scope='col';headRow.append(heading);
  }
  head.append(headRow);table.append(head);
  const body=el('tbody');
  for(const app of apps){
    const row=el('tr');
    const company=el('td','company-cell');appendText(company,'strong','',app.company);row.append(company);
    const position=el('td','position-cell');appendText(position,'strong','',app.position);row.append(position);
    const phase=el('td');appendText(phase,'span',`stage-badge stage-${app.stage}`,STAGE[app.stage]||app.stage);row.append(phase);
    appendText(row,'td','status-cell',STATUS[app.status]||app.status);
    const next=state.todos.find(todo=>todo.application_id===app.id&&todo.status==='open');
    appendText(row,'td',next?'next-cell':'muted-cell',next?.title||'—');
    appendText(row,'td','date-cell',next?.due_at?shortDate(next.due_at):next?.due_date?`${next.due_date}（仅日期）`:next?.time_text||'—');
    appendText(row,'td','date-cell',shortDate(app.last_event_at));
    const actionCell=el('td');const controls=el('div','table-actions');
    const view=el('button','outline-button','查看进展');view.type='button';view.onclick=()=>openDetail(app);
    const edit=el('button','icon-button','编辑');edit.type='button';edit.onclick=()=>openEdit(app);
    controls.append(view,edit);actionCell.append(controls);row.append(actionCell);body.append(row);
  }
  table.append(body);scroll.append(table);list.append(scroll);
}
function render(){$('workspace-label').textContent=state.demo_mode?'演示数据 · 本机工作区':'真实邮箱 · 本机工作区';const companies=new Set(state.applications.map(app=>app.company));$('company-count').textContent=companies.size;$('position-count').textContent=state.applications.length;$('review-count').textContent=state.reviews.length+state.failures.length;const last=state.last_success_at;const stale=!last||Date.now()-Date.parse(last)>4*3600_000;$('sync-led').classList.toggle('error',stale);$('sync-status').textContent=state.scan_incomplete?`首轮邮箱整理中 · 已确认 ${state.applications.length} 个岗位；还有历史邮件待处理`:last?`${stale?'邮件进度可能未更新 · ':''}上次成功读取 ${shortDate(last)}`:'尚未读取邮箱，先运行一次整理任务';$('update-time').textContent=state.scan_incomplete?'数据持续补充中':last?`最近更新 ${shortDate(last)}`:'等待第一次更新';const delivery=state.delivery;$('delivery-status').textContent=!delivery?'微信摘要尚未发送':`微信摘要：${({accepted:'平台已接受',failed:'发送失败',unknown:'结果待确认',sending:'发送中'})[delivery.status]||delivery.status}`;renderTodos();renderReview();renderFailures();renderApplications();}
function openDetail(app){const container=$('detail-content');container.replaceChildren();appendText(container,'p','eyebrow','岗位时间线');appendText(container,'h2','',app.position);appendText(container,'p','detail-company',app.company);const events=state.events.filter(item=>item.application_id===app.id);if(!events.length)container.append(emptyBox('尚无时间线','新邮件整理后会显示在这里。'));for(const event of events){const item=el('article','timeline-item');appendText(item,'span','timeline-date',shortDate(event.occurred_at));appendText(item,'h3','',`${STAGE[event.stage]||event.stage} · ${STATUS[event.status]||event.status}${event.round?` · ${event.round}`:''}`);appendText(item,'p','timeline-evidence',event.evidence);appendText(item,'small','',`来自：${event.subject||'无主题'} · ${event.sender||'未知发件人'}`);container.append(item);}$('detail-dialog').showModal();}
function openReview(review){$('review-id').value=review.id;$('review-company').value=review.company||'';$('review-position').value=review.position||'';const select=$('review-application');select.replaceChildren(new Option('自动匹配或新建',''));for(const app of state.applications)select.add(new Option(`${app.company} · ${app.position}`,app.id));$('review-dialog').showModal();}
function openEdit(app){$('edit-id').value=app.id;$('edit-version').value=app.version;$('edit-company').value=app.company;$('edit-position').value=app.position;for(const [id,data] of [['edit-stage',STAGE],['edit-status',STATUS]]){const select=$(id);select.replaceChildren();for(const [value,label] of Object.entries(data))select.add(new Option(label,value));} $('edit-stage').value=app.stage;$('edit-status').value=app.status;$('edit-dialog').showModal();}
function openSkip(failure){$('skip-key').value=failure.source_key;$('skip-reason').value='';$('skip-dialog').showModal();}
function bind(){ $('header-date').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());$('search').addEventListener('input',renderApplications);$('stage-filter').addEventListener('change',renderApplications);for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>$(button.dataset.close).close());$('review-form').addEventListener('submit',async event=>{event.preventDefault();if(await action(`/api/reviews/${encodeURIComponent($('review-id').value)}/resolve`,{company:$('review-company').value,position:$('review-position').value,application_id:$('review-application').value},'进展已确认'))$('review-dialog').close();});$('edit-form').addEventListener('submit',async event=>{event.preventDefault();if(await action(`/api/applications/${encodeURIComponent($('edit-id').value)}/edit`,{company:$('edit-company').value,position:$('edit-position').value,stage:$('edit-stage').value,status:$('edit-status').value,expected_version:Number($('edit-version').value)},'岗位信息已更新'))$('edit-dialog').close();});$('skip-form').addEventListener('submit',async event=>{event.preventDefault();if(await action(`/api/failures/${encodeURIComponent($('skip-key').value)}/skip`,{reason:$('skip-reason').value},'已记录跳过决定'))$('skip-dialog').close();});}
bind();refresh();setInterval(()=>refresh(true),30_000);
