export const STAGES = ['applied', 'screening', 'assessment', 'written_test', 'ai_interview', 'interview_1', 'interview_2', 'interview_3', 'interview', 'offer', 'rejected', 'other'] as const;
export const STATUSES = ['invited', 'scheduling', 'scheduled', 'completed', 'passed', 'failed', 'cancelled', 'received', 'unknown'] as const;
export const CLASSIFICATIONS = ['recruitment', 'promotion', 'unrelated', 'uncertain', 'skipped'] as const;

export type Stage = typeof STAGES[number];
export type StageStatus = typeof STATUSES[number];
export type Classification = typeof CLASSIFICATIONS[number];

export const STAGE_LABELS: Record<Stage,string> = {
  applied:'投递',screening:'简历筛选',assessment:'测评',written_test:'笔试',ai_interview:'AI 面试',
  interview_1:'一面',interview_2:'二面',interview_3:'三面',interview:'面试',offer:'Offer',rejected:'流程结束',other:'其他',
};
export const STATUS_LABELS: Record<StageStatus,string> = {
  invited:'已邀请',scheduling:'待预约',scheduled:'已预约',completed:'已完成',passed:'已通过',
  failed:'未通过',cancelled:'已取消',received:'已收到',unknown:'待确认',
};

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
