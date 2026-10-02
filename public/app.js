import {groupProgressRows} from './sorting.js';

const STAGE={applied:'投递',screening:'简历筛选',assessment:'测评',written_test:'笔试',ai_interview:'AI 面试',interview_1:'一面',interview_2:'二面',interview_3:'三面',offer:'Offer',rejected:'流程结束'};
const LEGACY_STAGE={interview:'轮次待核对',other:'阶段待核对'};
const STATUS={invited:'已邀请',scheduling:'待预约',scheduled:'已预约',completed:'已完成',passed:'已通过',failed:'未通过',cancelled:'已取消',received:'已收到',unknown:'待确认'};
function stageLabel(stage){return STAGE[stage]||LEGACY_STAGE[stage]||'阶段待核对';}
function statusLabel(stage,status,detailed=false){
  if(stage==='interview')return !detailed&&['invited','scheduling','scheduled'].includes(status)?'待确认轮次':STATUS[status]||status;
  if(stage==='other')return STATUS[status]||status;
  if(STAGE[stage]&&['invited','scheduling','scheduled'].includes(status))return `待${STAGE[stage].replace('AI 面试','AI面试')}${detailed?`（${STATUS[status]}）`:''}`;
  if(stage==='applied'&&status==='received')return '已投递';
  if(stage==='offer'&&status==='received')return '已收到 Offer';
  return STATUS[status]||status;
}
const $=id=>document.getElementById(id);
let state={applications:[],todos:[],events:[],reviews:[],failures:[],version:-1};
let toastTimer;
let todoView='pending';
let choiceMenu=null,choiceTrigger=null;

function closeChoiceMenu(restoreFocus=false){
  if(!choiceMenu)return;
  const trigger=choiceTrigger;choiceMenu.remove();choiceMenu=null;choiceTrigger=null;
  trigger?.setAttribute('aria-expanded','false');
  if(restoreFocus&&trigger?.isConnected)trigger.focus({preventScroll:true});
}
function inlineChoice(value,options,label,className,onChange){
  const trigger=el('button',`${className} inline-choice`,options.find(item=>item.value===value)?.label||value);
  trigger.type='button';trigger.dataset.value=value;trigger.setAttribute('aria-label',`${label}（当前：${trigger.textContent}）`);trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
  trigger.title='选择后自动保存';
  function open(){
    if(choiceTrigger===trigger){closeChoiceMenu();return;}
    closeChoiceMenu();choiceTrigger=trigger;choiceMenu=el('div','choice-menu');
    choiceMenu.id='progress-choice-menu';choiceMenu.setAttribute('role','menu');choiceMenu.setAttribute('aria-label',label);choiceMenu.setAttribute('popover','manual');
    trigger.setAttribute('aria-controls',choiceMenu.id);trigger.setAttribute('aria-expanded','true');
    const buttons=options.map(item=>{
      const option=el('button',`choice-option${item.stage?` stage-row-${item.value}`:''}`);option.type='button';option.setAttribute('role','menuitemradio');option.setAttribute('aria-checked',String(item.value===value));option.tabIndex=-1;
      if(item.stage){const dot=el('span','choice-swatch');dot.setAttribute('aria-hidden','true');option.append(dot);}
      appendText(option,'span','',item.label);const check=appendText(option,'span','choice-check',item.value===value?'✓':'');check.setAttribute('aria-hidden','true');
      option.onclick=()=>{closeChoiceMenu(true);if(item.value!==value)onChange(item.value,trigger);};
      choiceMenu.append(option);return option;
    });
    choiceMenu.addEventListener('keydown',event=>{
      const index=buttons.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeChoiceMenu(true);}
      else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();
      }else if(event.key==='Tab'){trigger.focus({preventScroll:true});closeChoiceMenu();}
    });
    document.body.append(choiceMenu);choiceMenu.showPopover?.();
    const rect=trigger.closest('.stage-select-wrap,.status-select-wrap').getBoundingClientRect(),width=Math.min(228,innerWidth-24);
    const below=innerHeight-rect.bottom-12,above=rect.top-12,placeBelow=below>=Math.min(choiceMenu.scrollHeight,360)||below>=above;
    choiceMenu.style.width=`${width}px`;choiceMenu.style.maxHeight=`${Math.min(360,Math.max(80,placeBelow?below:above))}px`;
    choiceMenu.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-width-12))}px`;
    choiceMenu.style.top=`${placeBelow?rect.bottom+6:Math.max(12,rect.top-choiceMenu.getBoundingClientRect().height-6)}px`;
    const selected=buttons[Math.max(0,options.findIndex(item=>item.value===value))];
    selected.focus({preventScroll:true});
    choiceMenu.scrollTop=Math.max(0,selected.offsetTop-choiceMenu.clientHeight/2+selected.offsetHeight/2);
  }
  trigger.onclick=open;trigger.onkeydown=event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open();}};
  return trigger;
}
document.addEventListener('pointerdown',event=>{if(choiceMenu&&!choiceMenu.contains(event.target)&&!choiceTrigger?.contains(event.target))closeChoiceMenu();});
window.addEventListener('resize',()=>closeChoiceMenu());
document.addEventListener('scroll',event=>{if(choiceMenu&&!choiceMenu.contains(event.target))closeChoiceMenu();},true);

function el(tag,className='',text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
function shortDate(value){if(!value)return '时间待核对';const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):String(value);}
function calendarDate(value){if(!value)return '—';return shortDate(value);}
function showToast(message){const toast=$('toast');toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),4200);}
async function api(url,body){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.message||'操作失败，请刷新页面。');return result;}
async function refresh(silent=false){try{const response=await fetch('/api/dashboard',{cache:'no-store'});if(!response.ok)throw Error('无法读取进度。');const next=await response.json();if(next.version!==state.version){state=next;$('demo-banner').hidden=!state.demo_mode;render();}else renderTodos();}catch(error){$('sync-led').classList.add('error');$('sync-status').textContent='无法读取最新数据，请确认本地服务正在运行。';if(!silent)showToast(error.message);}}
async function action(url,body,message){try{await api(url,body);showToast(message);await refresh();return true;}catch(error){showToast(error.message);return false;}}
function appendText(parent,tag,className,text){const child=el(tag,className,text);parent.append(child);return child;}
function emptyBox(title,detail){const box=el('div','empty-box');appendText(box,'strong','',title);appendText(box,'p','',detail);return box;}
function sortTodos(a,b){const ranks={overdue:0,critical:1,soon:2,later:3,undated:4};return ranks[todoTier(a).className]-ranks[todoTier(b).className]||String(a.due_at||a.due_date||'').localeCompare(String(b.due_at||b.due_date||''));}
function todoTier(item){const due=item.due_at?Date.parse(item.due_at):item.due_date?Date.parse(`${item.due_date}T23:59:59+08:00`):NaN;if(!Number.isFinite(due))return {name:'时间待定',className:'undated'};if(due<Date.now())return {name:'已逾期',className:'overdue'};if(due<Date.now()+24*3600_000)return {name:'24 小时内',className:'critical'};if(due<Date.now()+48*3600_000)return {name:'48 小时内',className:'soon'};return {name:'时间充裕',className:'later'};}
function reviewTodo(review){if(!review.todo_json)return null;try{return JSON.parse(review.todo_json);}catch{return null;}}
function renderTodoTable(container,items,completed=false){
  if(!items.length){container.append(emptyBox($('todo-search').value?'没有匹配的事项':completed?'暂无已完成事项':todoView==='overdue'?'没有逾期事项':'当前没有待处理事项',$('todo-search').value?'试试其他关键词。':todoView==='pending'?'新的测评、笔试和面试安排会显示在这里。':'切换其他分类查看任务。'));return;}
  const scroll=el('div','table-scroll'),table=el('table','todos-table');
  appendText(table,'caption','sr-only',completed?'已完成待办表':'待办事项表');
  const head=el('thead'),headRow=el('tr');
  for(const name of ['待办事项','公司 / 岗位','截止时间','操作']){const cell=el('th','',name);cell.scope='col';headRow.append(cell);}
  head.append(headRow);table.append(head);
  const body=el('tbody');
  for(const todo of items){
    const app=state.applications.find(item=>item.id===todo.application_id),tier=todoTier(todo),row=el('tr',completed?'done':tier.className);
    const task=el('td','todo-title-cell');appendText(task,'span','next-title',todo.title);
    if(!todo.due_at&&!todo.due_date&&todo.time_text)appendText(task,'small','next-sub',todo.time_text);
    row.append(task);
    const company=el('td','company-cell');
    appendText(company,'strong','company-name',app?.company||todo.company||'公司待确定');
    appendText(company,'span','role-name',app?.position||todo.position||'岗位待确定');row.append(company);
    const due=el('td','date-cell');due.append(todo.due_at||todo.due_date?deadlineContent(todo,!completed):el('span','muted-cell','未提供时间'));row.append(due);
    const control=el('td','action-cell'),actions=el('div','table-actions');
    const button=el('button','outline-button',completed?'撤销完成':'标记完成');button.type='button';
    button.onclick=async()=>{button.disabled=true;try{await action(`/api/todos/${encodeURIComponent(todo.id)}/status`,{status:completed?'open':'done',expected_version:todo.version},completed?'待办已恢复，可在待处理或已逾期中查看':'待办已完成，可在已完成中撤销');}finally{if(button.isConnected)button.disabled=false;}};actions.append(button);control.append(actions);
    for(const text of row.querySelectorAll('.company-name,.role-name,.next-title,.next-sub'))text.title=text.textContent;
    row.append(control);body.append(row);
  }
  table.append(body);scroll.append(table);container.append(scroll);
}
function renderTodos(){
  const open=state.todos.filter(todo=>todo.status==='open');
  const groups={pending:open.filter(todo=>todoTier(todo).className!=='overdue').sort(sortTodos),overdue:open.filter(todo=>todoTier(todo).className==='overdue').sort((a,b)=>sortTodos(b,a)),done:state.todos.filter(todo=>todo.status==='done')};
  for(const [key,items] of Object.entries(groups))$(`todo-${key}-count`).textContent=items.length;
  for(const tab of document.querySelectorAll('[data-todo-view]'))tab.setAttribute('aria-pressed',String(tab.dataset.todoView===todoView));
  $('nav-todo-count').textContent=open.length;$('pending-count').textContent=groups.pending.length;
  $('nav-todo-count').title=`${groups.pending.length} 项待处理，${groups.overdue.length} 项已逾期`;
  $('urgent-count').textContent=groups.pending.filter(todo=>['critical','soon'].includes(todoTier(todo).className)).length;
  const query=$('todo-search').value.trim().toLocaleLowerCase();
  const items=groups[todoView].filter(todo=>{const app=state.applications.find(item=>item.id===todo.application_id);return !query||`${todo.title} ${app?.company||''} ${app?.position||''}`.toLocaleLowerCase().includes(query);});
  $('todo-result-summary').textContent=`显示 ${items.length} 项`;
  $('todo-view-description').textContent=todoView==='done'?'误操作可撤销，恢复到原分类':todoView==='overdue'?'按最近截止排列 · 仅表示时间已过，不代表已完成':'按截止时间排列 · 未提供时间的事项排在最后';
  $('todo-list').replaceChildren();renderTodoTable($('todo-list'),items,todoView==='done');
}
function renderFailures(){const panel=$('failure-panel'),list=$('failure-list');panel.hidden=!state.failures.length;list.replaceChildren();$('failure-panel-count').textContent=state.failures.length;for(const failure of state.failures){const row=el('div','mini-row');appendText(row,'strong','',failure.subject||`邮件 UID ${failure.uid}`);appendText(row,'p','',failure.error);appendText(row,'span','failure-state',failure.status==='skipped'?'已跳过，留待重试':failure.status==='retry_requested'?'等待下次任务重试':'等待处理');const controls=el('div','mini-actions');if(failure.status!=='retry_requested'){const retry=el('button','text-action','下轮重试');retry.onclick=()=>action(`/api/failures/${encodeURIComponent(failure.source_key)}/retry`,{},'已安排下轮重试');controls.append(retry);}if(failure.status!=='skipped'){const skip=el('button','quiet-action','跳过并继续');skip.onclick=()=>openSkip(failure);controls.append(skip);}row.append(controls);list.append(row);}}
const PROGRESS=['applied','screening','assessment','written_test','ai_interview','interview_1','interview_2','interview_3','offer'];
const STAGE_ICONS={applied:'↗',screening:'▤',assessment:'✓',written_test:'✎',ai_interview:'AI',interview_1:'1',interview_2:'2',interview_3:'3',offer:'★',rejected:'–',interview:'?',other:'?'};
const STAGE_DEFAULT_STATUS={applied:'received',screening:'invited',assessment:'invited',written_test:'invited',ai_interview:'invited',interview_1:'invited',interview_2:'invited',interview_3:'invited',offer:'received',rejected:'failed'};
const STAGE_STATUSES={applied:['received','unknown','cancelled'],screening:['invited','passed','failed','cancelled','unknown'],offer:['received','completed','cancelled','unknown'],rejected:['failed','cancelled','completed'],default:['invited','scheduling','scheduled','completed','passed','failed','cancelled','unknown']};
function stageStatusChoices(phase,current){const choices=STAGE_STATUSES[phase]||STAGE_STATUSES.default;return choices.includes(current)?choices:[current,...choices];}
function inlineStatusLabel(phase,status){return status==='scheduling'?'待预约':status==='scheduled'?'已预约':statusLabel(phase,status);}
async function saveInlineProgress(entry,fields,control){
  const controlClass=control.classList.contains('stage-inline-select')?'stage-inline-select':'status-inline-select',view=activeNavigation;
  const controls=[...control.closest('tr').querySelectorAll('.stage-inline-select,.status-inline-select')];
  controls.forEach(select=>{select.disabled=true;});
  try{
    await api(`/api/applications/${encodeURIComponent(entry.id)}/edit`,{...fields,expected_version:entry.version});
    showToast('进展已保存');await refresh();
    if(activeNavigation===view){const row=document.querySelector(`[data-application-id="${entry.id}"]`);row?.querySelector(`.${controlClass}`)?.focus({preventScroll:true});}
  }catch(error){showToast(error.message);await refresh();renderApplications();}
  finally{controls.forEach(select=>{if(select.isConnected)select.disabled=false;});}
}
function stageProgress(entry,isReview=false){
  const phase=entry.stage,wrap=el('div','stage-progress');
  const badge=el('span','stage-select-wrap');appendText(badge,'span','stage-icon',STAGE_ICONS[phase]||'?');
  if(!isReview&&entry.id){
    const options=Object.entries(STAGE).map(([value,label])=>({value,label,stage:true}));
    if(!STAGE[phase])options.unshift({value:phase,label:stageLabel(phase),stage:true});
    const select=inlineChoice(phase,options,`${entry.company} · ${entry.position}：修改当前阶段`,'stage-inline-select',(stage,control)=>saveInlineProgress(entry,{stage,status:STAGE_DEFAULT_STATUS[stage]},control));
    badge.onclick=event=>{if(!select.contains(event.target))select.click();};
    badge.append(select,el('span','stage-chevron','⌄'));
  }else appendText(badge,'span','stage-static-name',stageLabel(phase));
  badge.classList.add(`phase-${phase}`);wrap.append(badge);
  const position=phase==='rejected'?-1:phase==='interview'?5:Math.max(0,PROGRESS.indexOf(phase));
  const track=el('div',`stage-track${phase==='rejected'?' ended':''}`);track.setAttribute('aria-label',`当前进度：${stageLabel(phase)}`);
  PROGRESS.forEach((_,index)=>track.append(el('i',index<position?'past':index===position?'current':'')));
  wrap.append(track);return wrap;
}
function deadlineContent(todo,showUrgency=true){
  const wrap=el('div','deadline-content');
  appendText(wrap,'strong','',todo?.due_at?shortDate(todo.due_at):todo?.due_date?`${todo.due_date}（仅日期）`:todo?.time_text||'—');
  if(showUrgency&&(todo?.due_at||todo?.due_date)){const tier=todoTier(todo);appendText(wrap,'span',`deadline-tier ${tier.className}`,tier.name);}
  wrap.title=todo?.due_at?new Date(todo.due_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):todo?.due_date||todo?.time_text||'';
  return wrap;
}
function statusChip(entry,isReview){
  if(!isReview&&entry.id){
    const wrap=el('span','status-select-wrap');
    const options=stageStatusChoices(entry.stage,entry.status).map(value=>({value,label:inlineStatusLabel(entry.stage,value)}));
    const select=inlineChoice(entry.status,options,`${entry.company} · ${entry.position}：修改${stageLabel(entry.stage)}状态`,'status-inline-select',(status,control)=>saveInlineProgress(entry,{status},control));
    wrap.onclick=event=>{if(!select.contains(event.target))select.click();};
    wrap.append(select,el('span','status-chevron','⌄'));return wrap;
  }
  const waiting=isReview&&entry.state==='waiting';
  const text=isReview?(waiting?'等待更多证据':'待 AI 核对'):statusLabel(entry.stage,entry.status);
  const chip=el('span',`status-chip ${waiting?'waiting':isReview?'review':entry.status==='completed'||entry.status==='passed'||entry.stage==='rejected'?'done':'active'}`,text);
  return chip;
}
function reviewEvidence(review){
  const container=$('detail-content');container.replaceChildren();appendText(container,'p','eyebrow','邮件依据');appendText(container,'h2','',review.company||'公司待确定');
  appendText(container,'p','detail-company',review.position||'岗位待确定');
  if(review.reason)appendText(container,'p','review-evidence',review.reason);
  for(const notice of review.notices||[]){const article=el('article','timeline-item');appendText(article,'span','timeline-date',shortDate(notice.occurred_at));appendText(article,'p','timeline-evidence',notice.evidence);container.append(article);}
  $('detail-dialog').showModal();
}
function rowActions(entry,isReview,clusterToggle){
  const wrap=el('div','table-actions');
  const primary=el('button','outline-button',clusterToggle?'展开邮件':isReview?'查看依据':'查看进展');primary.type='button';
  if(clusterToggle){primary.setAttribute('aria-expanded','false');primary.onclick=()=>clusterToggle(primary);}
  else primary.onclick=()=>isReview?reviewEvidence(entry):openDetail(entry);
  wrap.append(primary);
  if(!isReview){const menu=el('details','row-menu'),summary=el('summary','icon-button','⋯');summary.setAttribute('aria-label','更多操作');menu.append(summary);const edit=el('button','menu-action','编辑岗位');edit.type='button';edit.onclick=()=>{menu.open=false;openEdit(entry);};menu.append(edit);wrap.append(menu);}
  return wrap;
}
function applicationRow(item,extraClass='',detailIndex=-1){
  const entry=item.record,phase=entry.stage;
  const row=el('tr',`stage-row stage-row-${phase}${item.review?' review-row':''}${extraClass?` ${extraClass}`:''}`);
  if(!item.review)row.dataset.applicationId=entry.id;
  const company=el('td','company-cell');const name=appendText(company,'strong','company-name',detailIndex>=0?`通知 ${detailIndex+1}`:entry.company||'公司待确定');name.title=entry.company||'';
  const position=appendText(company,'span','role-name',entry.position||'岗位待确定');position.title=entry.position||'';
  if(item.review&&entry.reason)appendText(company,'span','review-reason',entry.reason);
  row.append(company);
  const stageCell=el('td','progress-cell');stageCell.append(stageProgress(entry,!!item.review));row.append(stageCell);
  const next=item.review?reviewTodo(entry):state.todos.find(todo=>todo.application_id===entry.id&&todo.status==='open');
  const nextCell=el('td','next-cell');appendText(nextCell,'strong','next-title',next?.title||'—');if(item.review&&Number(entry.mail_count)>1)appendText(nextCell,'small','next-sub',`${entry.mail_count} 封邮件`);row.append(nextCell);
  const dueCell=el('td','date-cell');dueCell.append(deadlineContent(next));row.append(dueCell);
  const statusCell=el('td','status-cell');statusCell.append(statusChip(entry,!!item.review));row.append(statusCell);
  const actionCell=el('td','action-cell');actionCell.append(rowActions(entry,!!item.review));
  row.append(actionCell);
  for(const text of row.querySelectorAll('.next-title,.review-reason'))text.title=text.textContent;
  return row;
}
function reviewClusterRows(item,firstInStage){
  const reviews=item.cluster,entry=item.record,phase=entry.stage;
  const row=el('tr',`stage-row stage-row-${phase} cluster-row${firstInStage?' stage-start':''}`);
  const company=el('td','company-cell');const name=appendText(company,'strong','company-name',entry.company||'公司待确定');name.title=entry.company||'';
  const mailCount=reviews.reduce((sum,review)=>sum+(Number(review.mail_count)||1),0);
  appendText(company,'span','role-name',`${reviews.length} 项核对记录 · ${mailCount} 封邮件`);row.append(company);
  const roles=[...new Set(reviews.map(review=>review.position).filter(Boolean))];
  if(roles.length===1)appendText(company,'small','review-reason',roles[0]);
  const stageCell=el('td','progress-cell');stageCell.append(stageProgress(entry,true));row.append(stageCell);
  const tasks=reviews.map(reviewTodo).filter(Boolean),titles=[...new Set(tasks.map(todo=>todo.title).filter(Boolean))];
  const nextCell=el('td','next-cell');appendText(nextCell,'strong','next-title',titles.length===1?titles[0]:titles.length>1?`${titles.length} 项不同安排`:'查看邮件进展');row.append(nextCell);
  const deadlines=[...new Set(tasks.map(todo=>todo.due_at||todo.due_date||todo.time_text).filter(Boolean))];
  const dueCell=el('td','date-cell');dueCell.append(deadlines.length===1?deadlineContent(tasks[0]):el('span','muted-cell',deadlines.length>1?'多个时间':'—'));row.append(dueCell);
  const statusCell=el('td','status-cell');statusCell.append(statusChip(entry,true));row.append(statusCell);
  const actionCell=el('td','action-cell');
  const details=reviews.map((review,index)=>{const detail=applicationRow({record:review,review:true},'cluster-detail',index);detail.hidden=true;return detail;});
  actionCell.append(rowActions(entry,true,button=>{const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));button.textContent=open?'收起邮件':'展开邮件';details.forEach(detail=>{detail.hidden=!open;});}));row.append(actionCell);
  return [row,...details];
}
function renderApplications(){
  closeChoiceMenu();
  const query=$('search').value.trim().toLocaleLowerCase(),stage=$('stage-filter').value;
  const apps=state.applications.filter(app=>(!query||`${app.company} ${app.position}`.toLocaleLowerCase().includes(query))&&(!stage||app.stage===stage));
  const rows=groupProgressRows(apps,[]);
  $('application-count').textContent=rows.length;
  $('result-summary').textContent=`显示 ${rows.length} 项 · 按阶段进度排列`;
  renderProgressTable($('application-list'),rows,'公司与岗位进展表',state.applications.length?'没有匹配的岗位':'暂无岗位记录',state.applications.length?'试试其他关键词或阶段。':'邮件整理完成后，已确定的岗位会显示在这里。');
}
function renderReviews(){
  const query=$('review-search').value.trim().toLocaleLowerCase(),status=$('review-filter').value;
  const reviews=state.reviews.filter(review=>(!query||`${review.company||''} ${review.position||''}`.toLocaleLowerCase().includes(query))&&(!status||review.state===status));
  const rows=groupProgressRows([],reviews);
  $('review-list-count').textContent=reviews.length;
  $('review-result-summary').textContent=`${reviews.length} 条核对记录 · 按公司与阶段归为 ${rows.length} 组`;
  renderProgressTable($('review-list'),rows,'邮件核对记录表',query||status?'没有匹配的核对记录':'暂无待核对邮件',query||status?'试试其他关键词或状态。':'需要进一步判断的邮件会在这里由 AI 处理。');
}
function renderProgressTable(list,rows,caption,emptyTitle,emptyDetail){
  list.replaceChildren();
  if(!rows.length){
    list.append(emptyBox(emptyTitle,emptyDetail));
    return;
  }
  const scroll=el('div','table-scroll'),table=el('table','applications-table');
  appendText(table,'caption','sr-only',caption);
  const head=el('thead'),headRow=el('tr');
  for(const name of ['公司 / 岗位','阶段进度','下一步','截止 / 紧急度','状态','操作']){
    const heading=el('th','',name);heading.scope='col';headRow.append(heading);
  }
  head.append(headRow);table.append(head);
  const body=el('tbody');let currentStage;
  for(const item of rows){
    const phase=item.record.stage,firstInStage=phase!==currentStage;
    currentStage=phase;
    if(item.cluster)body.append(...reviewClusterRows(item,firstInStage));
    else body.append(applicationRow(item,firstInStage?'stage-start':''));
  }
  table.append(body);scroll.append(table);list.append(scroll);
}
function render(){
  $('workspace-label').textContent=state.demo_mode?'演示数据':'真实邮箱 · 本机';
  const companies=new Set(state.applications.map(app=>app.company));
  $('company-count').textContent=companies.size;$('position-count').textContent=state.applications.length;
  const reviewCount=state.reviews.filter(review=>review.state==='open').length+(state.manual_review_open||0);
  const waitingCount=state.reviews.filter(review=>review.state==='waiting').length+(state.manual_review_waiting||0);
  $('review-count').textContent=reviewCount;$('nav-review-count').textContent=reviewCount+waitingCount;
  $('waiting-count').textContent=waitingCount;
  $('nav-review-count').title=`${reviewCount} 条待核对，${waitingCount} 条等待更多证据`;
  $('review-summary').textContent=waitingCount?`${waitingCount} 条等待更多证据，新邮件到达后继续核对。`:'根据邮件和已有记录自动核对。';
  $('ai-queue-banner').hidden=!state.manual_review_count;
  $('ai-queue-banner').textContent=state.manual_review_count?`已有进度表：${state.manual_review_open||0} 条待 AI 核对，${state.manual_review_waiting||0} 条等待更多证据。` :'';
  const last=state.last_success_at,stale=!last||Date.now()-Date.parse(last)>4*3600_000;
  $('sync-led').classList.toggle('error',stale);
  $('sync-status').textContent=state.scan_incomplete?'首轮整理未完成 · 仍有历史邮件待处理':last?`${stale?'邮件进度可能未更新 · ':''}上次成功读取 ${shortDate(last)}`:'尚未读取邮箱，请运行读信任务';
  $('sidebar-sync').textContent=last?`上次读取 ${shortDate(last)}`:'等待首次读取';
  $('update-time').textContent=state.scan_incomplete?'首轮未完成':last?`最近更新 ${shortDate(last)}`:'等待首次读取';
  renderTodos();renderFailures();renderApplications();renderReviews();
}
function openDetail(app){const container=$('detail-content');container.replaceChildren();appendText(container,'p','eyebrow','岗位时间线');appendText(container,'h2','',app.position);appendText(container,'p','detail-company',app.company);const events=state.events.filter(item=>item.application_id===app.id),manual=(state.manual_updates||[]).filter(item=>item.application_id===app.id);if(!events.length&&!manual.length)container.append(emptyBox('尚无时间线','新邮件整理后会显示在这里。'));for(const update of manual){const item=el('article','timeline-item');appendText(item,'span','timeline-date',shortDate(update.created_at));appendText(item,'h3','',`${stageLabel(update.stage)} · ${statusLabel(update.stage,update.status)}`);appendText(item,'p','timeline-evidence',update.note||'用户提供的进度信息');appendText(item,'small','',String(update.fingerprint||'').startsWith('web-edit:')?'来源：网页编辑':'来源：手动导入');container.append(item);}for(const event of events){const item=el('article','timeline-item');appendText(item,'span','timeline-date',shortDate(event.occurred_at));const round=event.round&&!/^interview_[123]$/.test(event.stage)?` · ${event.round}`:'';appendText(item,'h3','',`${stageLabel(event.stage)} · ${statusLabel(event.stage,event.status)}${round}`);appendText(item,'p','timeline-evidence',event.evidence);appendText(item,'small','',`来自：${event.subject||'无主题'} · ${event.sender||'未知发件人'}`);container.append(item);}$('detail-dialog').showModal();}
function fillStageOptions(id,selected){const select=$(id);select.replaceChildren();if(!STAGE[selected])select.add(new Option('请选择具体阶段',''));for(const [value,label] of Object.entries(STAGE))select.add(new Option(label,value));select.value=STAGE[selected]?selected:'';}
function fillStatusOptions(id,stage,selected){const select=$(id);select.replaceChildren();for(const value of Object.keys(STATUS))select.add(new Option(statusLabel(stage,value,true),value));select.value=selected;}
function openEdit(app){$('edit-id').value=app.id;$('edit-version').value=app.version;$('edit-company').value=app.company;$('edit-position').value=app.position;fillStageOptions('edit-stage',app.stage);fillStatusOptions('edit-status',app.stage,app.status);$('edit-dialog').showModal();}
function openSkip(failure){$('skip-key').value=failure.source_key;$('skip-reason').value='';$('skip-dialog').showModal();}
async function queueImport(){
  const text=$('import-text').value.trim();if(!text){showToast('请先粘贴或选择进度表');return;}
  try{const result=await api('/api/manual-progress/queue',{text});$('import-summary').textContent=`已交给 AI 核对 ${result.queued} 条；${result.already_queued} 条已在队列，${result.already_imported} 条此前已导入。定时任务处理后，网页会自动显示结果。`;showToast(`已加入 AI 核对队列：${result.queued} 条`);await refresh();}
  catch(error){showToast(error.message);}
}
function bind(){ $('header-date').textContent=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>$(button.dataset.close).close());$('edit-form').addEventListener('submit',async event=>{event.preventDefault();if(await action(`/api/applications/${encodeURIComponent($('edit-id').value)}/edit`,{company:$('edit-company').value,position:$('edit-position').value,stage:$('edit-stage').value,status:$('edit-status').value,expected_version:Number($('edit-version').value)},'岗位信息已更新'))$('edit-dialog').close();});$('skip-form').addEventListener('submit',async event=>{event.preventDefault();if(await action(`/api/failures/${encodeURIComponent($('skip-key').value)}/skip`,{reason:$('skip-reason').value},'已记录跳过决定'))$('skip-dialog').close();});}
bind();
$('open-import').addEventListener('click',()=>$('import-dialog').showModal());
const NAVIGATION={
  applications:{hash:'#applications',label:'岗位进展',description:'查看各公司的招聘进度，直接修改阶段与状态。'},
  review:{hash:'#review',label:'AI 核对',description:'由 AI 核对邮件和已有记录，证据不足时等待新信息。'},
  todos:{hash:'#todos',label:'待办事项',description:'先处理接下来的安排，逾期与已完成事项分别查看。'},
};
let activeNavigation='applications';
history.scrollRestoration='manual';
function navigationFromHash(hash){return Object.keys(NAVIGATION).find(key=>NAVIGATION[key].hash===hash)||({'#applications-heading':'applications','#ai-review':'review','#todo-heading':'todos'})[hash]||'applications';}
function viewFilters(){return {search:$('search').value,stage:$('stage-filter').value,reviewSearch:$('review-search').value,reviewStatus:$('review-filter').value,todoSearch:$('todo-search').value,todoView};}
function restoreFilters(filters){
  if(!filters)return;
  $('search').value=filters.search||'';$('review-search').value=filters.reviewSearch||'';$('todo-search').value=filters.todoSearch||'';
  $('stage-filter').value=STAGE[filters.stage]?filters.stage:'';
  $('review-filter').value=['open','waiting'].includes(filters.reviewStatus)?filters.reviewStatus:'';
  todoView=['pending','overdue','done'].includes(filters.todoView)?filters.todoView:'pending';
}
function saveNavigation(key,mode='replace'){
  const saved={...history.state,jobnote:{view:key,filters:viewFilters()}};
  const method=mode==='push'&&location.hash!==NAVIGATION[key].hash?'pushState':'replaceState';
  history[method](saved,'',NAVIGATION[key].hash);
}
function navigatePage(key,{historyMode='push',focus=true,restore}={}){
  closeChoiceMenu();
  if(historyMode==='push')saveNavigation(activeNavigation);
  restoreFilters(restore?.filters);
  activeNavigation=key;
  for(const page of document.querySelectorAll('[data-page]'))page.hidden=page.dataset.page!==key;
  for(const link of document.querySelectorAll('[data-nav]')){
    const active=link.dataset.nav===key;link.classList.toggle('active',active);
    if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
  }
  $('breadcrumb-current').textContent=NAVIGATION[key].label;
  $('page-heading').textContent=NAVIGATION[key].label;
  $('page-description').textContent=NAVIGATION[key].description;
  document.title=`求职记 · ${NAVIGATION[key].label}`;
  renderApplications();renderReviews();renderTodos();
  if(historyMode!=='none')saveNavigation(key,historyMode);
  window.scrollTo({top:0,behavior:'instant'});
  if(focus)$('page-heading').focus({preventScroll:true});
}
for(const link of document.querySelectorAll('[data-nav]'))link.addEventListener('click',event=>{
  if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();navigatePage(link.dataset.nav);
});
for(const [id,event,renderView] of [['search','input',renderApplications],['stage-filter','change',renderApplications],['review-search','input',renderReviews],['review-filter','change',renderReviews],['todo-search','input',renderTodos]])$(id).addEventListener(event,()=>{renderView();saveNavigation(activeNavigation);});
for(const button of document.querySelectorAll('[data-todo-view]'))button.addEventListener('click',()=>{todoView=button.dataset.todoView;renderTodos();saveNavigation(activeNavigation);});
function restoreNavigation(){if(location.hash==='#main-content')return;navigatePage(navigationFromHash(location.hash),{historyMode:'replace',restore:history.state?.jobnote});}
window.addEventListener('popstate',restoreNavigation);
window.addEventListener('hashchange',restoreNavigation);
$('import-file').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>200_000){showToast('文件不能超过 200 KB');return;}$('import-text').value=await file.text();$('import-summary').textContent=`已读取 ${file.name}，可以交给 AI 核对。`;});
$('queue-import').addEventListener('click',queueImport);
for(const prefix of ['edit'])$(prefix+'-stage').addEventListener('change',event=>{
  const status=$(prefix+'-status');fillStatusOptions(prefix+'-status',event.target.value,status.value);
});
navigatePage(navigationFromHash(location.hash),{historyMode:'replace',focus:false,restore:history.state?.jobnote});
refresh();
setInterval(()=>refresh(true),30_000);
