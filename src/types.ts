export const STAGES = ['applied', 'screening', 'assessment', 'ai_interview', 'written_test', 'interview', 'offer', 'rejected', 'other'] as const;
export const STATUSES = ['invited', 'scheduling', 'scheduled', 'completed', 'passed', 'failed', 'cancelled', 'received', 'unknown'] as const;
export const CLASSIFICATIONS = ['recruitment', 'promotion', 'unrelated', 'uncertain', 'skipped'] as const;

export type Stage = typeof STAGES[number];
export type StageStatus = typeof STATUSES[number];
export type Classification = typeof CLASSIFICATIONS[number];

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
