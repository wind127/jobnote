// Display priority is an editable product choice, not a claim about company quality.
export const STAGE_PROGRESS={applied:1,screening:2,assessment:3,written_test:4,ai_interview:5,interview:5.5,interview_1:6,interview_2:7,interview_3:8,offer:9,rejected:0};

// Recognizable employers appear first within a stage. Add aliases here as needed.
const COMPANY_TIERS=[
  ['腾讯','阿里巴巴','阿里云','字节跳动','华为','微软','google','谷歌','apple','苹果','amazon','亚马逊','meta'],
  ['百度','美团','京东','拼多多','蚂蚁集团','网易','小米','快手','大疆','特斯拉','比亚迪','宁德时代','deepseek','招商银行','招银网络科技','中国银行','工商银行','建设银行','农业银行','交通银行'],
  ['滴滴','小红书','携程','哔哩哔哩','bilibili','360集团','理想汽车','蔚来','联想','科大讯飞'],
];

const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g,'');

export function companyPriority(company){
  const name=normalize(company);
  for(let index=0;index<COMPANY_TIERS.length;index++){
    if(COMPANY_TIERS[index].some(alias=>name.includes(normalize(alias))))return COMPANY_TIERS.length-index;
  }
  return 0;
}

export function compareProgressRows(a,b){
  const first=a.record,second=b.record;
  const timestamp=record=>{
    const value=Date.parse(record.last_event_at??record.occurred_at??record.created_at??'');
    return Number.isFinite(value)?value:0;
  };
  return (STAGE_PROGRESS[second.stage]??-1)-(STAGE_PROGRESS[first.stage]??-1)
    ||companyPriority(second.company)-companyPriority(first.company)
    ||Number(a.review)-Number(b.review)
    ||timestamp(second)-timestamp(first)
    ||String(first.company??'').localeCompare(String(second.company??''),'zh-CN')
    ||String(first.position??'').localeCompare(String(second.position??''),'zh-CN');
}

// A cluster is a visual inbox for uncertain notices from the same employer and
// stage. Members keep their own IDs and actions; no applications are merged.
export function groupProgressRows(applications,reviews){
  const buckets=new Map();
  for(const review of reviews){
    const company=normalize(review.company);
    const key=company?`${company}|${review.stage}`:`${review.id}`;
    const group=buckets.get(key)??[];
    group.push(review);
    buckets.set(key,group);
  }
  const pending=[...buckets.values()].map(group=>{
    group.sort((a,b)=>compareProgressRows({record:a,review:true},{record:b,review:true}));
    return {record:group[0],review:true,cluster:group.length>1?group:null};
  });
  return [...applications.map(record=>({record,review:false,cluster:null})),...pending].sort(compareProgressRows);
}
