import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AppError, type MailItem, type MailPage } from './types.js';

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
type AnyRecord = Record<string, any>;

function loadSkill(): { Imap: any; simpleParser: (input: Buffer) => Promise<AnyRecord> } {
  const directory = process.env.QQEXMAIL_SKILL_DIR;
  if (!directory) throw new AppError('SKILL_CONFIG', '需要设置 QQEXMAIL_SKILL_DIR，指向已安装的 qqexmail 技能。');
  const root = resolve(directory);
  const manifest = join(root, 'package.json');
  if (!existsSync(join(root, 'SKILL.md')) || !existsSync(manifest)) throw new AppError('SKILL_NOT_FOUND', 'qqexmail 技能目录缺少 SKILL.md 或 package.json。');
  const requireSkill = createRequire(manifest);
  try {
    return { Imap: requireSkill('imap'), simpleParser: requireSkill('mailparser').simpleParser };
  } catch {
    throw new AppError('SKILL_DEPENDENCIES', 'qqexmail 依赖尚未安装，请在技能目录运行 npm install。');
  }
}

function stripHtml(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function imapCall<T>(invoke: (callback: (error: Error | null, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => invoke((error, result) => error ? reject(error) : resolve(result)));
}

interface Fetched { uid: number; date: Date | null; size: number; raw: Buffer; }

function fetchMany(conn: any, uids: number[], bodies: string): Promise<Map<number, Fetched>> {
  if (!uids.length) return Promise.resolve(new Map());
  return new Promise((resolve, reject) => {
    const result = new Map<number, Fetched>();
    const waiting: Promise<void>[] = [];
    let failed = false;
    const fetcher = conn.fetch(uids, { bodies, size: true, markSeen: false });
    fetcher.on('message', (message: any) => {
      let attributes: AnyRecord | null = null;
      const parts: Buffer[] = [];
      const streams: Promise<void>[] = [];
      message.once('attributes', (attrs: AnyRecord) => { attributes = attrs; });
      message.on('body', (stream: any) => {
        streams.push(new Promise<void>((done, fail) => {
          let total = 0;
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total <= MAX_MESSAGE_BYTES + 1024) parts.push(chunk);
          });
          stream.once('end', done);
          stream.once('error', fail);
        }));
      });
      waiting.push(new Promise<void>((done, fail) => {
        message.once('end', () => {
          Promise.all(streams).then(() => {
            const attrs = attributes as AnyRecord | null;
            if (attrs?.uid && Number.isSafeInteger(Number(attrs.uid))) {
              result.set(Number(attrs.uid), {
                uid: Number(attrs.uid), date: attrs.date instanceof Date ? attrs.date : null,
                size: Number(attrs.size ?? 0), raw: Buffer.concat(parts),
              });
            }
            done();
          }, fail);
        });
        message.once('error', fail);
      }));
    });
    fetcher.once('error', (error: Error) => { failed = true; reject(error); });
    fetcher.once('end', () => {
      if (!failed) Promise.all(waiting).then(() => resolve(result), reject);
    });
  });
}

function sinceDate(value: string): string {
  const date = new Date(value);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export async function readPage(lastUid: number, since: string, fixedUpper: number | null, limit = 100): Promise<MailPage> {
  if (!process.env.EXMAIL_ACCOUNT || !process.env.EXMAIL_AUTH_CODE) throw new AppError('MAIL_CONFIG', '需要在本地设置 EXMAIL_ACCOUNT 和 EXMAIL_AUTH_CODE。');
  const { Imap, simpleParser } = loadSkill();
  const conn = new Imap({
    user: process.env.EXMAIL_ACCOUNT,
    password: process.env.EXMAIL_AUTH_CODE,
    host: 'imap.exmail.qq.com', port: 993, tls: true,
    tlsOptions: { rejectUnauthorized: true, servername: 'imap.exmail.qq.com' },
    connTimeout: 30000, authTimeout: 30000,
  });
  const connected = new Promise<void>((resolve, reject) => {
    conn.once('ready', resolve);
    conn.once('error', reject);
    conn.connect();
  });
  try {
    await connected;
    const box = await imapCall<AnyRecord>(callback => conn.openBox('INBOX', true, callback));
    if (!box.readOnly) throw new AppError('MAIL_NOT_READ_ONLY','邮箱未以只读模式打开。');
    const uidValidity = Number(box.uidvalidity);
    const upperUid = fixedUpper === null ? Math.max(0, Number(box.uidnext) - 1) : fixedUpper;
    if (!Number.isSafeInteger(uidValidity) || !Number.isSafeInteger(upperUid)) throw new AppError('MAIL_METADATA','邮箱缺少可靠的 UID 元数据。');
    if (lastUid >= upperUid) return { uidValidity, upperUid, pageEnd: upperUid, items: [] };
    const criteria: any[] = [['UID', `${lastUid + 1}:${upperUid}`], ['SINCE', sinceDate(since)]];
    const found = await imapCall<number[]>(callback => conn.search(criteria, callback));
    const selected = found.filter(uid => uid > lastUid && uid <= upperUid).sort((a,b) => a-b).slice(0,limit);
    if (!selected.length) return { uidValidity, upperUid, pageEnd: upperUid, items: [] };
    const headers = await fetchMany(conn, selected, 'HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)');
    const eligible = selected.filter(uid => (headers.get(uid)?.size ?? MAX_MESSAGE_BYTES + 1) <= MAX_MESSAGE_BYTES);
    const full = await fetchMany(conn, eligible, '');
    const items: MailItem[] = [];
    for (const uid of selected) {
      const header = headers.get(uid);
      const item = full.get(uid);
      const base = { uid, messageId: null, subject: '', sender: '', receivedAt: (header?.date ?? new Date()).toISOString(), text: null, contentHash: null };
      if (!header) { items.push({ ...base, error: '邮件在读取时消失或无法取得属性' }); continue; }
      try {
        const headerParsed = await simpleParser(header.raw);
        base.subject = String(headerParsed.subject ?? '').slice(0, 300);
        base.sender = String(headerParsed.from?.text ?? '').slice(0,300);
        base.messageId = headerParsed.messageId ?? null;
      } catch { /* Header fallback stays visible as a failed source. */ }
      if (header.size > MAX_MESSAGE_BYTES) { items.push({ ...base, error: '邮件超过 2 MiB 读取上限' }); continue; }
      if (!item) { items.push({ ...base, error: '邮件正文在读取时消失' }); continue; }
      try {
        const parsed = await simpleParser(item.raw);
        const text = String(parsed.text ?? stripHtml(parsed.html)).trim();
        if (!text) { items.push({ ...base, error: '邮件没有可读取的文本正文' }); continue; }
        items.push({ ...base,
          messageId: parsed.messageId ?? base.messageId,
          subject: String(parsed.subject ?? base.subject).slice(0,300),
          sender: String(parsed.from?.text ?? base.sender).slice(0,300),
          text, contentHash: createHash('sha256').update(item.raw).digest('hex'), error: null,
        });
      } catch { items.push({ ...base, error: '邮件正文解析失败' }); }
    }
    return { uidValidity, upperUid, pageEnd: selected.at(-1)!, items };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('MAIL_READ_FAILED', `邮箱读取失败：${error instanceof Error ? error.message : '未知错误'}`);
  } finally {
    try { conn.end(); } catch { /* Connection may already be closed. */ }
  }
}
