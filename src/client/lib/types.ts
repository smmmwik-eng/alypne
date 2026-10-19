import type { BoardRole, Priority, WorkspaceRole } from '@shared/constants';

export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  emailVerifiedAt: string | null;
  timezone: string;
  theme: string;
}

export interface MemberLite {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  description: string;
  logoUrl: string | null;
  color: string;
  archivedAt: string | null;
  role: WorkspaceRole;
  memberCount: number;
}

export interface Stage {
  id: string;
  name: string;
  category: 'todo' | 'in_progress' | 'done';
  color: string;
  position: number;
}

export interface Specialisation {
  id: string;
  name: string;
  color: string;
}

export interface WorkspaceMember {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
  joinedAt: string;
  specialisationIds: string[];
  roblox: { username: string; providerUserId: string; avatarUrl: string | null } | null;
}

export interface WorkspaceDetail {
  workspace: {
    id: string;
    name: string;
    slug: string;
    description: string;
    logoUrl: string | null;
    color: string;
    archivedAt: string | null;
    settings: { defaultBoardVisibility?: 'private' | 'workspace'; membersCanCreateBoards?: boolean; membersCanInvite?: boolean };
  };
  role: WorkspaceRole;
  members: WorkspaceMember[];
  stages: Stage[];
  specialisations: Specialisation[];
}

export interface List {
  id: string;
  boardId: string;
  name: string;
  position: number;
  stageId: string | null;
  color: string | null;
  wipLimit: number | null;
  collapsed: boolean;
  archivedAt: string | null;
}

export interface Label {
  id: string;
  boardId: string;
  name: string;
  color: string;
}

export interface CustomField {
  id: string;
  boardId: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'checkbox' | 'dropdown' | 'url' | 'user';
  options: { id: string; label: string; color?: string }[];
  showOnCard: boolean;
  position: number;
}

export interface CardSummary {
  id: string;
  boardId: string;
  listId: string;
  number: number;
  type: 'task' | 'bug';
  title: string;
  position: number;
  priority: Priority;
  startAt: string | null;
  dueAt: string | null;
  completedAt: string | null;
  coverColor: string | null;
  coverAttachmentId: string | null;
  releaseId: string | null;
  milestoneId: string | null;
  archivedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  hasDescription: boolean;
  recurrence: { freq: string; interval: number; nextAt: string } | null;
  labelIds: string[];
  assigneeIds: string[];
  checklist: { total: number; done: number };
  commentCount: number;
  attachmentCount: number;
  voteCount: number;
  blockedByCount: number;
  customFields: Record<string, string | number | boolean | null>;
  bug: { severity: string; resolution: string } | null;
}

export interface BoardMember extends MemberLite {
  role: BoardRole;
  explicit: boolean;
  wsRole: WorkspaceRole;
}

export interface ReleaseLite {
  id: string;
  name: string;
  version: string;
  status: string;
  plannedDate: string | null;
}

export interface MilestoneLite {
  id: string;
  name: string;
  date: string;
  releaseId: string | null;
  completedAt: string | null;
}

export interface BoardData {
  board: {
    id: string;
    workspaceId: string;
    projectId: string | null;
    name: string;
    key: string;
    description: string;
    background: string;
    visibility: 'private' | 'workspace' | 'public';
    settings: { cardCovers?: boolean; showCompleted?: boolean; commentPermission?: 'members' | 'observers'; votingEnabled?: boolean };
    archivedAt: string | null;
    favorite: boolean;
    notificationLevel: string;
  };
  workspace: { id: string; name: string; color: string; logoUrl: string | null };
  project: { id: string; name: string } | null;
  role: BoardRole;
  lists: List[];
  cards: CardSummary[];
  labels: Label[];
  customFields: CustomField[];
  stages: Stage[];
  members: BoardMember[];
  releases: ReleaseLite[];
  milestones: MilestoneLite[];
  coverUrls: Record<string, string>;
  dependencies: { from: string; to: string }[];
}

export interface ChecklistItem {
  id: string;
  checklistId: string;
  text: string;
  position: number;
  completedAt: string | null;
  assigneeId: string | null;
  dueAt: string | null;
  version: number;
}

export interface Checklist {
  id: string;
  cardId: string;
  title: string;
  position: number;
  hideCompleted: boolean;
  items: ChecklistItem[];
}

export interface Comment {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  author: MemberLite | null;
}

export interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  isImage: boolean;
  createdAt: string;
  uploaderId: string | null;
  uploader: string | null;
  url: string;
}

export interface CardLink {
  id: string;
  provider: string;
  kind: string;
  url: string;
  title: string;
  ref: string;
  state: string | null;
}

export interface BugDetails {
  cardId: string;
  stepsToReproduce: string;
  expectedBehaviour: string;
  actualBehaviour: string;
  severity: string;
  platforms: string[];
  reproStatus: string;
  resolution: string;
  gameVersion: string;
}

export interface CardDetail {
  card: CardSummary & { description: string; key: string; boardName: string; listName: string; reminderMinutes: number | null };
  creator: MemberLite | null;
  checklists: Checklist[];
  comments: Comment[];
  attachments: Attachment[];
  relations: { id: string; fromCardId: string; toCardId: string; kind: string }[];
  relatedCards: { id: string; title: string; number: number; boardId: string; completedAt: string | null; boardKey: string }[];
  links: CardLink[];
  bug: BugDetails | null;
  watching: boolean;
  watcherCount: number;
  voted: boolean;
  voteCount: number;
  customFields: Record<string, string | number | boolean | null>;
  assets: { id: string; name: string; category: string; robloxAssetId: string | null }[];
  role: BoardRole;
}

export interface Activity {
  id: string;
  type: string;
  data: Record<string, any>;
  boardId?: string | null;
  cardId?: string | null;
  actorType: string;
  createdAt: string;
  actor: MemberLite | null;
  boardName?: string | null;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
  boardId: string | null;
  cardId: string | null;
  actor: { id: string | null; displayName: string | null; avatarUrl: string | null } | null;
}
