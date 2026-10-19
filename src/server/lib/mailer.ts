import { env } from '../env.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Messages sent while no SMTP transport is configured (dev/test). Never used in production paths for delivery. */
export const devOutbox: MailMessage[] = [];

let transport: { sendMail(m: MailMessage & { from: string }): Promise<unknown> } | null | undefined;

async function getTransport() {
  if (transport !== undefined) return transport;
  if (!env.smtpUrl) {
    transport = null;
    return transport;
  }
  const nodemailer = await import('nodemailer');
  transport = nodemailer.default.createTransport(env.smtpUrl);
  return transport;
}

export function mailConfigured(): boolean {
  return !!env.smtpUrl;
}

export async function sendMail(msg: MailMessage): Promise<{ delivered: boolean }> {
  const t = await getTransport();
  if (!t) {
    devOutbox.push(msg);
    if (devOutbox.length > 200) devOutbox.shift();
    if (!env.isTest) console.info(`[alypne:mail] (SMTP not configured — not delivered) to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`);
    return { delivered: false };
  }
  await t.sendMail({ ...msg, from: env.mailFrom });
  return { delivered: true };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Branded, table-based email layout that renders in common clients. */
export function emailLayout(opts: { heading: string; body: string; actionLabel?: string; actionUrl?: string; footer?: string }): { html: string; text: string } {
  const button = opts.actionUrl
    ? `<tr><td style="padding:8px 0 24px"><a href="${esc(opts.actionUrl)}" style="display:inline-block;background:#f4f4f6;color:#0c0c10;text-decoration:none;font-weight:600;padding:11px 20px;border-radius:999px;font-size:14px">${esc(opts.actionLabel ?? 'Open Alypne')}</a></td></tr>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#0c0c10;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e7e7ec">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#15151b;border:1px solid #26262f;border-radius:16px;padding:28px">
<tr><td style="padding-bottom:20px"><span style="display:inline-block;width:22px;height:22px;border-radius:7px;background:#8b7cf6;vertical-align:middle"></span>
<span style="font-weight:700;font-size:16px;letter-spacing:-0.01em;vertical-align:middle;margin-left:8px;color:#fff">alypne</span></td></tr>
<tr><td style="font-size:20px;font-weight:650;color:#fff;padding-bottom:12px">${esc(opts.heading)}</td></tr>
<tr><td style="font-size:14px;line-height:1.6;color:#b4b4c0;padding-bottom:20px">${esc(opts.body).replace(/\n/g, '<br>')}</td></tr>
${button}
<tr><td style="font-size:12px;color:#6f6f7d;border-top:1px solid #26262f;padding-top:16px">${esc(opts.footer ?? 'You received this email because of activity on your Alypne account.')}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${opts.heading}\n\n${opts.body}\n\n${opts.actionUrl ? `${opts.actionLabel ?? 'Open'}: ${opts.actionUrl}\n\n` : ''}— Alypne`;
  return { html, text };
}
