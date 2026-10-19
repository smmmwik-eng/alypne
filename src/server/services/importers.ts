import { z } from 'zod';
import { parseCsv } from '../../shared/utils.js';
import { PRIORITIES, type Priority } from '../../shared/constants.js';

/* ================================================================ Trello */

const TRELLO_COLORS: Record<string, string> = {
  green: '#34d399', green_dark: '#059669', green_light: '#6ee7b7',
  yellow: '#facc15', yellow_dark: '#ca8a04', yellow_light: '#fde68a',
  orange: '#fb923c', orange_dark: '#ea580c', orange_light: '#fdba74',
  red: '#f43f5e', red_dark: '#be123c', red_light: '#fda4af',
  purple: '#a78bfa', purple_dark: '#7c3aed', purple_light: '#c4b5fd',
  blue: '#818cf8', blue_dark: '#4f46e5', blue_light: '#a5b4fc',
  sky: '#38bdf8', sky_dark: '#0284c7', sky_light: '#7dd3fc',
  lime: '#a3e635', lime_dark: '#65a30d', lime_light: '#d9f99d',
  pink: '#f472b6', pink_dark: '#db2777', pink_light: '#f9a8d4',
  black: '#94a3b8', black_dark: '#475569', black_light: '#cbd5e1',
};

const id = z.string().min(1).max(64);
const trelloSchema = z.object({
  id: id,
  name: z.string().max(512),
  desc: z.string().max(50000).optional().default(''),
  closed: z.boolean().optional(),
  labels: z.array(z.object({ id, name: z.string().nullable().optional(), color: z.string().nullable().optional() })).max(1000).default([]),
  lists: z.array(z.object({ id, name: z.string().max(512), closed: z.boolean().optional(), pos: z.number().optional() })).max(1000),
  cards: z
    .array(
      z.object({
        id,
        name: z.string().max(16384),
        desc: z.string().max(100000).optional().default(''),
        closed: z.boolean().optional(),
        idList: id,
        pos: z.number().optional(),
        due: z.string().nullable().optional(),
        start: z.string().nullable().optional(),
        dueComplete: z.boolean().optional(),
        idLabels: z.array(z.string()).optional().default([]),
        idMembers: z.array(z.string()).optional().default([]),
        attachments: z.array(z.object({ name: z.string().optional(), url: z.string().optional(), isUpload: z.boolean().optional() })).optional().default([]),
        customFieldItems: z.array(z.object({ idCustomField: z.string(), value: z.record(z.string(), z.unknown()).nullable().optional(), idValue: z.string().nullable().optional() })).optional().default([]),
        cover: z.unknown().optional(),
      }).passthrough(),
    )
    .max(20000),
  checklists: z
    .array(z.object({ id, idCard: id, name: z.string().max(512), pos: z.number().optional(), checkItems: z.array(z.object({ id, name: z.string().max(16384), state: z.string().optional(), pos: z.number().optional(), due: z.string().nullable().optional() })).default([]) }))
    .max(20000)
    .default([]),
  actions: z.array(z.object({ type: z.string(), date: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(), memberCreator: z.object({ username: z.string().optional(), fullName: z.string().optional() }).nullable().optional() })).max(100000).default([]),
  members: z.array(z.object({ id, username: z.string().optional(), fullName: z.string().optional() })).max(1000).default([]),
  customFields: z.array(z.object({ id, name: z.string().max(200), type: z.string(), options: z.array(z.object({ id, value: z.record(z.string(), z.unknown()).optional(), color: z.string().nullable().optional() })).optional().default([]) })).max(200).default([]),
}).passthrough();

export type TrelloBoard = z.infer<typeof trelloSchema>;

export interface ImportPreview {
  boardName: string;
  counts: { lists: number; archivedLists: number; cards: number; archivedCards: number; labels: number; checklists: number; checklistItems: number; comments: number; customFields: number; attachmentLinks: number; members: number };
  supported: string[];
  unsupported: string[];
  warnings: string[];
}

export function parseTrello(raw: unknown): { board: TrelloBoard; preview: ImportPreview } {
  const result = trelloSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`This doesn't look like a Trello board export (${issue.path.join('.') || 'root'}: ${issue.message}). In Trello open the board menu → Print, export and share → Export as JSON.`);
  }
  const b = result.data;
  const comments = b.actions.filter((a) => a.type === 'commentCard');
  const unsupported = new Set<string>();
  const warnings: string[] = [];
  if (b.cards.some((c) => c.attachments.some((a) => a.isUpload))) unsupported.add('Uploaded attachment files (Trello requires sign-in to download them) — imported as links instead');
  if (Array.isArray((b as any).pluginData) && (b as any).pluginData.length) unsupported.add('Power-Up data');
  if (b.cards.some((c) => Array.isArray((c as any).stickers) && (c as any).stickers.length)) unsupported.add('Stickers');
  if (b.cards.some((c) => (c.cover as any)?.idAttachment)) unsupported.add('Image card covers (colour covers are imported)');
  if (b.actions.some((a) => a.type !== 'commentCard')) unsupported.add('Historical activity other than comments');
  if (b.members.length) warnings.push('Card members are assigned only when a workspace member has the same username as in Trello.');
  if (comments.length) warnings.push('Comments are imported with their original author and date noted in the text, posted under your account.');
  if (b.actions.length >= 1000) warnings.push('Trello exports include at most the most recent 1000 actions, so older comments may be missing from the file.');
  if (b.customFields.some((f) => !['text', 'number', 'date', 'checkbox', 'list'].includes(f.type))) unsupported.add('Unknown custom field types');
  const checklistItems = b.checklists.reduce((n, c) => n + c.checkItems.length, 0);
  return {
    board: b,
    preview: {
      boardName: b.name,
      counts: {
        lists: b.lists.filter((l) => !l.closed).length,
        archivedLists: b.lists.filter((l) => l.closed).length,
        cards: b.cards.filter((c) => !c.closed).length,
        archivedCards: b.cards.filter((c) => c.closed).length,
        labels: b.labels.length,
        checklists: b.checklists.length,
        checklistItems,
        comments: comments.length,
        customFields: b.customFields.length,
        attachmentLinks: b.cards.reduce((n, c) => n + c.attachments.filter((a) => a.url).length, 0),
        members: b.members.length,
      },
      supported: ['Board name & description', 'Lists (incl. archived)', 'Cards (incl. archived) with descriptions, positions, start & due dates, completion', 'Labels with colours', 'Checklists and item state', 'Comments (text)', 'Custom fields: text, number, date, checkbox, dropdown', 'Attachment links', 'Card members (matched by username)', 'Colour covers'],
      unsupported: [...unsupported],
      warnings,
    },
  };
}

export function trelloColor(color: string | null | undefined): string {
  return (color && TRELLO_COLORS[color]) || '#94a3b8';
}

/* =================================================================== CSV */

export interface CsvMapping {
  title: number;
  description?: number;
  list?: number;
  labels?: number;
  due?: number;
  start?: number;
  priority?: number;
  assignee?: number;
  type?: number;
}

const ALIASES: Record<keyof CsvMapping, string[]> = {
  title: ['title', 'name', 'card', 'task', 'summary', 'card name'],
  description: ['description', 'desc', 'details', 'body', 'notes'],
  list: ['list', 'status', 'column', 'stage', 'list name'],
  labels: ['labels', 'label', 'tags', 'tag'],
  due: ['due', 'due date', 'deadline', 'due at'],
  start: ['start', 'start date', 'starts'],
  priority: ['priority'],
  assignee: ['assignee', 'assignees', 'owner', 'members', 'assigned to'],
  type: ['type', 'kind', 'issue type'],
};

export function suggestMapping(header: string[]): Partial<CsvMapping> {
  const out: Partial<CsvMapping> = {};
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const [k, names] of Object.entries(ALIASES) as [keyof CsvMapping, string[]][]) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) out[k] = i;
  }
  return out;
}

export interface CsvRow {
  title: string;
  description: string;
  list: string | null;
  labels: string[];
  dueAt: Date | null;
  startAt: Date | null;
  priority: Priority;
  assignees: string[];
  type: 'task' | 'bug';
  errors: string[];
  line: number;
}

function parseDate(v: string): Date | null | 'invalid' {
  const s = v.trim();
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

export function parseCsvTasks(text: string, mapping?: Partial<CsvMapping>): { header: string[]; mapping: Partial<CsvMapping>; rows: CsvRow[] } {
  if (text.length > 5_000_000) throw new Error('CSV file is too large (max 5 MB)');
  const all = parseCsv(text);
  if (!all.length) throw new Error('The CSV file is empty');
  const header = all[0];
  const map = mapping ?? suggestMapping(header);
  if (map.title === undefined) throw new Error('Could not find a title column. Name a column "Title" or choose one in the mapping.');
  if (all.length - 1 > 5000) throw new Error('CSV imports are limited to 5000 rows at a time');
  const cell = (r: string[], i?: number) => (i === undefined ? '' : (r[i] ?? '').trim());
  const rows: CsvRow[] = all.slice(1).map((r, idx) => {
    const errors: string[] = [];
    const title = cell(r, map.title);
    if (!title) errors.push('Missing title');
    const due = parseDate(cell(r, map.due));
    const start = parseDate(cell(r, map.start));
    if (due === 'invalid') errors.push('Unrecognised due date');
    if (start === 'invalid') errors.push('Unrecognised start date');
    const p = cell(r, map.priority).toLowerCase();
    const priority = (PRIORITIES as readonly string[]).includes(p) ? (p as Priority) : 'none';
    if (p && priority === 'none' && p !== 'none') errors.push(`Unknown priority “${p}” (using none)`);
    const t = cell(r, map.type).toLowerCase();
    return {
      line: idx + 2,
      title: title.slice(0, 512),
      description: cell(r, map.description),
      list: cell(r, map.list) || null,
      labels: cell(r, map.labels).split(/[;,]/).map((s) => s.trim()).filter(Boolean),
      dueAt: due instanceof Date ? due : null,
      startAt: start instanceof Date ? start : null,
      priority,
      assignees: cell(r, map.assignee).split(/[;,]/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean),
      type: t === 'bug' ? 'bug' : 'task',
      errors,
    };
  });
  return { header, mapping: map, rows };
}
