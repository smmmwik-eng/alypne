/** Values shared by the API and the web client. Keep this file dependency-free. */

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const BOARD_ROLES = ['admin', 'member', 'observer'] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const BOARD_VISIBILITIES = ['private', 'workspace', 'public'] as const;
export type BoardVisibility = (typeof BOARD_VISIBILITIES)[number];

const WS_RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const BOARD_RANK: Record<BoardRole, number> = { observer: 0, member: 1, admin: 2 };

export function workspaceRoleAtLeast(role: WorkspaceRole | null | undefined, min: WorkspaceRole): boolean {
  return !!role && WS_RANK[role] >= WS_RANK[min];
}
export function boardRoleAtLeast(role: BoardRole | null | undefined, min: BoardRole): boolean {
  return !!role && BOARD_RANK[role] >= BOARD_RANK[min];
}

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_META: Record<Priority, { label: string; color: string; rank: number }> = {
  none: { label: 'No priority', color: '#6b7280', rank: 0 },
  low: { label: 'Low', color: '#38bdf8', rank: 1 },
  medium: { label: 'Medium', color: '#facc15', rank: 2 },
  high: { label: 'High', color: '#fb923c', rank: 3 },
  urgent: { label: 'Urgent', color: '#f43f5e', rank: 4 },
};

export const STAGE_CATEGORIES = ['todo', 'in_progress', 'done'] as const;
export type StageCategory = (typeof STAGE_CATEGORIES)[number];

export const DEFAULT_WORKFLOW: { name: string; category: StageCategory; color: string }[] = [
  { name: 'Backlog', category: 'todo', color: '#6b7280' },
  { name: 'Planned', category: 'todo', color: '#818cf8' },
  { name: 'In Progress', category: 'in_progress', color: '#38bdf8' },
  { name: 'Code Review', category: 'in_progress', color: '#c084fc' },
  { name: 'Testing', category: 'in_progress', color: '#facc15' },
  { name: 'Ready for Release', category: 'in_progress', color: '#fb923c' },
  { name: 'Completed', category: 'done', color: '#34d399' },
];

export const LABEL_COLORS = [
  '#34d399', '#a3e635', '#facc15', '#fb923c', '#f43f5e', '#e879f9',
  '#a78bfa', '#818cf8', '#38bdf8', '#2dd4bf', '#94a3b8', '#f472b6',
] as const;

export const BOARD_BACKGROUNDS: Record<string, { label: string; css: string }> = {
  slate: { label: 'Slate', css: 'linear-gradient(160deg,#1a1b22 0%,#121318 100%)' },
  violet: { label: 'Violet', css: 'linear-gradient(160deg,#2a2445 0%,#15131f 100%)' },
  ocean: { label: 'Ocean', css: 'linear-gradient(160deg,#10304a 0%,#0e1520 100%)' },
  forest: { label: 'Forest', css: 'linear-gradient(160deg,#143628 0%,#0f1613 100%)' },
  ember: { label: 'Ember', css: 'linear-gradient(160deg,#47201a 0%,#181210 100%)' },
  rose: { label: 'Rose', css: 'linear-gradient(160deg,#43182e 0%,#171015 100%)' },
  sand: { label: 'Sand', css: 'linear-gradient(160deg,#3d3420 0%,#17150f 100%)' },
  mono: { label: 'Mono', css: '#101014' },
};

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'checkbox', 'dropdown', 'url', 'user'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const BUG_SEVERITIES = ['trivial', 'minor', 'major', 'critical', 'blocker'] as const;
export const BUG_REPRO = ['unconfirmed', 'reproducible', 'intermittent', 'cannot_reproduce'] as const;
export const BUG_RESOLUTIONS = ['unresolved', 'fixed', 'wont_fix', 'duplicate', 'by_design'] as const;
export const PLATFORMS = ['PC', 'Mac', 'Mobile (iOS)', 'Mobile (Android)', 'Tablet', 'Console', 'VR'] as const;

export const RELEASE_STATUSES = ['planning', 'in_progress', 'testing', 'released', 'cancelled'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export const PROJECT_STAGES = ['concept', 'prototype', 'alpha', 'beta', 'live', 'maintenance'] as const;

export const ASSET_CATEGORIES = ['model', 'mesh', 'animation', 'audio', 'image', 'script', 'ui', 'other'] as const;
export const ASSET_STATUSES = ['planned', 'in_progress', 'review', 'approved', 'deprecated'] as const;

export const DEFAULT_SPECIALISATIONS: { name: string; color: string }[] = [
  { name: 'Scripter', color: '#38bdf8' },
  { name: 'Builder', color: '#34d399' },
  { name: 'UI Designer', color: '#e879f9' },
  { name: 'Animator', color: '#fb923c' },
  { name: 'Modeler', color: '#a3e635' },
  { name: 'Tester', color: '#facc15' },
  { name: 'Project Manager', color: '#a78bfa' },
  { name: 'Community & Ops', color: '#f472b6' },
];

export const NOTIFICATION_TYPES = {
  assigned: 'Assigned to a task',
  mentioned: 'Mentioned in a comment',
  comment_reply: 'Replies to your comments',
  watched_update: 'Updates on watched cards',
  due_soon: 'Due date reminders',
  overdue: 'Overdue tasks',
  invitation: 'Workspace invitations',
  board_change: 'Board membership changes',
  workspace_change: 'Workspace membership changes',
  automation: 'Automation results',
  release: 'Release updates',
} as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const LIMITS = {
  titleMax: 512,
  descriptionMax: 50_000,
  commentMax: 10_000,
  nameMax: 120,
  checklistItemsPerBulk: 200,
  automationActionsMax: 10,
  automationConditionsMax: 10,
  automationDepthMax: 3,
  automationRunsPerRulePerHour: 200,
} as const;
