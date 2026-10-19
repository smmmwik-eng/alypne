/** Small pure helpers shared by client and server. */

/** RFC 4180 CSV parser. Handles quoted fields, escaped quotes and CRLF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const text = input.replace(/^﻿/, '');
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new Error('Unterminated quoted field in CSV');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v === null || v === undefined ? '' : String(v);
          // Neutralise spreadsheet formula injection.
          const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
          return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
        })
        .join(','),
    )
    .join('\r\n');
}

/** Extract @username mentions from markdown text. */
export function extractMentions(text: string): string[] {
  const out = new Set<string>();
  const re = /(^|[^\w@`])@([a-zA-Z0-9_]{2,32})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[2].toLowerCase());
  return [...out];
}

/** Position helpers for fractional ordering (like Trello's `pos`). */
export const POSITION_STEP = 65536;
export function positionBetween(before: number | null | undefined, after: number | null | undefined): number {
  if (before == null && after == null) return POSITION_STEP;
  if (before == null) return (after as number) / 2;
  if (after == null) return before + POSITION_STEP;
  return (before + after) / 2;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 48) || 'workspace';
}

export function boardKeyFromName(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let key = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'TASK');
  key = key.slice(0, 5);
  return key.length >= 2 ? key : (key + 'TSK').slice(0, 3);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/** Parse GitHub / GitLab / Roblox URLs into structured references. */
export function parseDevLink(raw: string): { provider: string; kind: string; ref: string; title: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'github.com' && parts.length >= 4) {
    const repo = `${parts[0]}/${parts[1]}`;
    if (parts[2] === 'pull') return { provider: 'github', kind: 'pull_request', ref: `${repo}#${parts[3]}`, title: `PR ${repo}#${parts[3]}` };
    if (parts[2] === 'issues') return { provider: 'github', kind: 'issue', ref: `${repo}#${parts[3]}`, title: `Issue ${repo}#${parts[3]}` };
    if (parts[2] === 'commit') return { provider: 'github', kind: 'commit', ref: `${repo}@${parts[3].slice(0, 7)}`, title: `Commit ${repo}@${parts[3].slice(0, 7)}` };
  }
  if (url.hostname === 'gitlab.com') {
    const dash = parts.indexOf('-');
    if (dash > 0 && parts.length > dash + 2) {
      const repo = parts.slice(0, dash).join('/');
      const kind = parts[dash + 1];
      const num = parts[dash + 2];
      if (kind === 'merge_requests') return { provider: 'gitlab', kind: 'pull_request', ref: `${repo}!${num}`, title: `MR ${repo}!${num}` };
      if (kind === 'issues') return { provider: 'gitlab', kind: 'issue', ref: `${repo}#${num}`, title: `Issue ${repo}#${num}` };
      if (kind === 'commit') return { provider: 'gitlab', kind: 'commit', ref: `${repo}@${num.slice(0, 7)}`, title: `Commit ${repo}@${num.slice(0, 7)}` };
    }
  }
  if (url.hostname === 'www.roblox.com' || url.hostname === 'roblox.com' || url.hostname === 'create.roblox.com') {
    const gi = parts.indexOf('games');
    if (gi >= 0 && /^\d+$/.test(parts[gi + 1] ?? '')) return { provider: 'roblox', kind: 'experience', ref: parts[gi + 1], title: `Roblox place ${parts[gi + 1]}` };
    const num = parts.find((p) => /^\d{3,}$/.test(p));
    if (num && (parts.includes('catalog') || parts.includes('library') || parts.includes('store') || parts.includes('asset'))) {
      return { provider: 'roblox', kind: 'asset', ref: num, title: `Roblox asset ${num}` };
    }
  }
  return { provider: 'url', kind: 'link', ref: url.hostname, title: url.hostname + url.pathname };
}

export function cardKey(boardKey: string, n: number): string {
  return `${boardKey}-${n}`;
}
