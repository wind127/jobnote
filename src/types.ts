export const STAGES = ['applied', 'screening', 'assessment', 'written_test', 'ai_interview', 'interview_1', 'interview_2', 'interview_3', 'interview', 'offer', 'rejected'] as const;
export const SELECTABLE_STAGES = STAGES.filter(stage => stage !== 'interview');
export const STATUSES = ['invited', 'scheduling', 'scheduled', 'completed', 'passed', 'failed', 'cancelled', 'received', 'unknown'] as const;
export const CLASSIFICATIONS = ['recruitment', 'promotion', 'unrelated', 'uncertain', 'skipped'] as const;

export type Stage = typeof STAGES[number];
export type StageStatus = typeof STATUSES[number];
export type Classification = typeof CLASSIFICATIONS[number];

export const STAGE_LABELS: Record<Stage,string> = {
  applied:'投递',screening:'简历筛选',assessment:'测评',written_test:'笔试',ai_interview:'AI 面试',
  interview_1:'一面',interview_2:'二面',interview_3:'三面',interview:'轮次待核对',offer:'Offer',rejected:'流程结束',
};
export const STATUS_LABELS: Record<StageStatus,string> = {
  invited:'已邀请',scheduling:'待预约',scheduled:'已预约',completed:'已完成',passed:'已通过',
  failed:'未通过',cancelled:'已取消',received:'已收到',unknown:'待确认',
};

export function progressStatusLabel(stage: string, status: string, detailed = false): string {
  if (stage === 'interview') return !detailed && ['invited','scheduling','scheduled'].includes(status) ? '待确认轮次' : STATUS_LABELS[status as StageStatus] ?? status;
  if (stage === 'other') return STATUS_LABELS[status as StageStatus] ?? status;
  const label = STAGE_LABELS[stage as Stage];
  if (label && ['invited','scheduling','scheduled'].includes(status)) {
    const pending = `待${label.replace('AI 面试','AI面试')}`;
    return detailed ? `${pending}（${STATUS_LABELS[status as StageStatus]}）` : pending;
  }
  if (stage === 'applied' && status === 'received') return '已投递';
  if (stage === 'offer' && status === 'received') return '已收到 Offer';
  return STATUS_LABELS[status as StageStatus] ?? status;
}

export interface UpdateInput {
  company: string | null;
  position: string | null;
  application_ref?: string | null;
  stage: Stage;
  status: StageStatus;
  round?: string | null;
  occurred_at?: string | null;
  evidence: string;
  needs_review?: boolean;
  todo?: {
    title: string;
    due_at?: string | null;
    due_date?: string | null;
    time_text?: string | null;
    kind?: string | null;
  } | null;
}

export interface MessageInput {
  source_key: string;
  classification: Classification;
  updates: UpdateInput[];
}

export interface Submission {
  schema_version: '1';
  run_id: string;
  batch_id: string;
  messages: MessageInput[];
}

export interface MailItem {
  uid: number;
  messageId: string | null;
  subject: string;
  sender: string;
  receivedAt: string;
  text: string | null;
  contentHash: string | null;
  error: string | null;
}

export interface MailPage {
  uidValidity: number;
  upperUid: number;
  pageEnd: number;
  items: MailItem[];
}

export class AppError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
