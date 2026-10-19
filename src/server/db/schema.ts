import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  doublePrecision,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  bigint,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ users */

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    avatarUrl: text('avatar_url'),
    bio: text('bio').notNull().default(''),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    timezone: text('timezone').notNull().default('UTC'),
    theme: text('theme').notNull().default('dark'),
    notificationPrefs: jsonb('notification_prefs').$type<Record<string, { inApp: boolean; email: boolean }>>().notNull().default({}),
    calendarToken: text('calendar_token'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`), uniqueIndex('users_username_uq').on(sql`lower(${t.username})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

/** One-time tokens: email verification, password reset. Only hashes are stored. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // verify_email | reset_password
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('auth_tokens_hash_uq').on(t.tokenHash)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    prefix: text('prefix').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default(['read', 'write']),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('api_tokens_hash_uq').on(t.tokenHash)],
);

/** Linked external identities (Roblox). */
export const externalAccounts = pgTable(
  'external_accounts',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // roblox
    providerUserId: text('provider_user_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull().default(''),
    avatarUrl: text('avatar_url'),
    verificationMethod: text('verification_method').notNull(), // oauth | profile_code
    verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('external_accounts_provider_uq').on(t.provider, t.providerUserId),
    uniqueIndex('external_accounts_user_provider_uq').on(t.userId, t.provider),
  ],
);

/** Pending Roblox profile-code verifications and OAuth state. */
export const verificationChallenges = pgTable('verification_challenges', {
  id: id(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // roblox_profile_code | roblox_oauth_state
  subject: text('subject').notNull().default(''),
  code: text('code').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------ workspaces */

export const workspaces = pgTable(
  'workspaces',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    logoUrl: text('logo_url'),
    color: text('color').notNull().default('#7c6cf2'),
    settings: jsonb('settings')
      .$type<{ defaultBoardVisibility?: 'private' | 'workspace'; membersCanCreateBoards?: boolean; membersCanInvite?: boolean }>()
      .notNull()
      .default({}),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('workspaces_slug_uq').on(t.slug)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // owner | admin | member | viewer
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('workspace_members_user_idx').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email'),
    role: text('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedById: text('invited_by_id').references(() => users.id, { onDelete: 'set null' }),
    maxUses: integer('max_uses').notNull().default(1),
    uses: integer('uses').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invitations_token_uq').on(t.tokenHash), index('invitations_ws_idx').on(t.workspaceId)],
);

/** Configurable team specialisations (Scripter, Builder, ...). */
export const specialisations = pgTable('specialisations', {
  id: id(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#7c6cf2'),
  position: doublePrecision('position').notNull().default(0),
});

export const memberSpecialisations = pgTable(
  'member_specialisations',
  {
    specialisationId: text('specialisation_id').notNull().references(() => specialisations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.specialisationId, t.userId] })],
);

/** User-defined workflow stages; lists may map onto a stage. */
export const workflowStages = pgTable(
  'workflow_stages',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category').notNull(), // todo | in_progress | done
    color: text('color').notNull().default('#6b7280'),
    position: doublePrecision('position').notNull().default(0),
  },
  (t) => [index('workflow_stages_ws_idx').on(t.workspaceId)],
);

/* -------------------------------------------------------------- projects */

export const projects = pgTable(
  'projects',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    universeId: text('universe_id'),
    placeId: text('place_id'),
    thumbnailUrl: text('thumbnail_url'),
    robloxMeta: jsonb('roblox_meta').$type<Record<string, unknown> | null>(),
    stage: text('stage').notNull().default('concept'), // concept | prototype | alpha | beta | live | maintenance
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('projects_ws_idx').on(t.workspaceId)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default(''),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

export const releases = pgTable(
  'releases',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    version: text('version').notNull().default(''),
    description: text('description').notNull().default(''),
    notes: text('notes').notNull().default(''),
    status: text('status').notNull().default('planning'), // planning | in_progress | testing | released | cancelled
    plannedDate: timestamp('planned_date', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('releases_ws_idx').on(t.workspaceId)],
);

export const milestones = pgTable(
  'milestones',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    releaseId: text('release_id').references(() => releases.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    date: timestamp('date', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('milestones_ws_idx').on(t.workspaceId)],
);

export const assets = pgTable(
  'assets',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    category: text('category').notNull(), // model | mesh | animation | audio | image | script | ui | other
    robloxAssetId: text('roblox_asset_id'),
    url: text('url'),
    description: text('description').notNull().default(''),
    status: text('status').notNull().default('in_progress'), // planned | in_progress | review | approved | deprecated
    ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('assets_ws_idx').on(t.workspaceId)],
);

/* ----------------------------------------------------------------- boards */

export const boards = pgTable(
  'boards',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    key: text('key').notNull(), // short card prefix, e.g. GAME
    description: text('description').notNull().default(''),
    background: text('background').notNull().default('slate'),
    visibility: text('visibility').notNull().default('workspace'), // private | workspace | public
    nextCardNumber: integer('next_card_number').notNull().default(1),
    settings: jsonb('settings')
      .$type<{ cardCovers?: boolean; showCompleted?: boolean; commentPermission?: 'members' | 'observers'; votingEnabled?: boolean }>()
      .notNull()
      .default({}),
    importSource: text('import_source'),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('boards_ws_idx').on(t.workspaceId), uniqueIndex('boards_import_uq').on(t.workspaceId, t.importSource)],
);

export const boardMembers = pgTable(
  'board_members',
  {
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // admin | member | observer
    notificationLevel: text('notification_level').notNull().default('participating'), // all | participating | none
  },
  (t) => [primaryKey({ columns: [t.boardId, t.userId] }), index('board_members_user_idx').on(t.userId)],
);

export const boardFavorites = pgTable(
  'board_favorites',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.boardId] })],
);

export const recentViews = pgTable(
  'recent_views',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(), // board | card
    entityId: text('entity_id').notNull(),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.entityType, t.entityId] })],
);

export const lists = pgTable(
  'lists',
  {
    id: id(),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: doublePrecision('position').notNull(),
    stageId: text('stage_id').references(() => workflowStages.id, { onDelete: 'set null' }),
    color: text('color'),
    wipLimit: integer('wip_limit'),
    collapsed: boolean('collapsed').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('lists_board_idx').on(t.boardId, t.position)],
);

export const labels = pgTable(
  'labels',
  {
    id: id(),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    color: text('color').notNull(),
    position: doublePrecision('position').notNull().default(0),
  },
  (t) => [index('labels_board_idx').on(t.boardId)],
);

export const cards = pgTable(
  'cards',
  {
    id: id(),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    listId: text('list_id').notNull().references(() => lists.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    type: text('type').notNull().default('task'), // task | bug
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    position: doublePrecision('position').notNull(),
    priority: text('priority').notNull().default('none'), // none | low | medium | high | urgent
    startAt: timestamp('start_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    reminderMinutes: integer('reminder_minutes'), // minutes before due
    completedAt: timestamp('completed_at', { withTimezone: true }),
    coverColor: text('cover_color'),
    coverAttachmentId: text('cover_attachment_id'),
    releaseId: text('release_id').references(() => releases.id, { onDelete: 'set null' }),
    milestoneId: text('milestone_id').references(() => milestones.id, { onDelete: 'set null' }),
    recurrence: jsonb('recurrence').$type<{ freq: 'daily' | 'weekly' | 'monthly'; interval: number; nextAt: string } | null>(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    importSource: text('import_source'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('cards_list_idx').on(t.listId, t.position),
    index('cards_board_idx').on(t.boardId),
    index('cards_due_idx').on(t.dueAt),
    uniqueIndex('cards_board_number_uq').on(t.boardId, t.number),
  ],
);

export const cardAssignees = pgTable(
  'card_assignees',
  {
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] }), index('card_assignees_user_idx').on(t.userId)],
);

export const cardLabels = pgTable(
  'card_labels',
  {
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    labelId: text('label_id').notNull().references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.labelId] }), index('card_labels_label_idx').on(t.labelId)],
);

export const cardWatchers = pgTable(
  'card_watchers',
  {
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] })],
);

export const cardVotes = pgTable(
  'card_votes',
  {
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] })],
);

/** relates_to | blocks (fromCard blocks toCard) | duplicates */
export const cardRelations = pgTable(
  'card_relations',
  {
    id: id(),
    fromCardId: text('from_card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    toCardId: text('to_card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('card_relations_uq').on(t.fromCardId, t.toCardId, t.kind), index('card_relations_to_idx').on(t.toCardId)],
);

export const bugDetails = pgTable('bug_details', {
  cardId: text('card_id')
    .primaryKey()
    .references(() => cards.id, { onDelete: 'cascade' }),
  stepsToReproduce: text('steps_to_reproduce').notNull().default(''),
  expectedBehaviour: text('expected_behaviour').notNull().default(''),
  actualBehaviour: text('actual_behaviour').notNull().default(''),
  severity: text('severity').notNull().default('minor'), // trivial | minor | major | critical | blocker
  platforms: jsonb('platforms').$type<string[]>().notNull().default([]),
  reproStatus: text('repro_status').notNull().default('unconfirmed'), // unconfirmed | reproducible | intermittent | cannot_reproduce
  resolution: text('resolution').notNull().default('unresolved'), // unresolved | fixed | wont_fix | duplicate | by_design
  gameVersion: text('game_version').notNull().default(''),
});

export const cardLinks = pgTable(
  'card_links',
  {
    id: id(),
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // github | gitlab | roblox | url
    kind: text('kind').notNull(), // pull_request | issue | commit | asset | experience | link
    url: text('url').notNull(),
    title: text('title').notNull().default(''),
    ref: text('ref').notNull().default(''),
    state: text('state'),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('card_links_card_idx').on(t.cardId)],
);

export const assetCards = pgTable(
  'asset_cards',
  {
    assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.assetId, t.cardId] })],
);

/* ----------------------------------------------------------- custom fields */

export const customFields = pgTable(
  'custom_fields',
  {
    id: id(),
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(), // text | number | date | checkbox | dropdown | url | user
    options: jsonb('options').$type<{ id: string; label: string; color?: string }[]>().notNull().default([]),
    showOnCard: boolean('show_on_card').notNull().default(true),
    position: doublePrecision('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('custom_fields_board_idx').on(t.boardId)],
);

export const customFieldValues = pgTable(
  'custom_field_values',
  {
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    fieldId: text('field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
    value: jsonb('value').$type<string | number | boolean | null>(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.fieldId] })],
);

/* -------------------------------------------------------------- checklists */

export const checklists = pgTable(
  'checklists',
  {
    id: id(),
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    position: doublePrecision('position').notNull(),
    hideCompleted: boolean('hide_completed').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('checklists_card_idx').on(t.cardId)],
);

export const checklistItems = pgTable(
  'checklist_items',
  {
    id: id(),
    checklistId: text('checklist_id').notNull().references(() => checklists.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    position: doublePrecision('position').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedById: text('completed_by_id').references(() => users.id, { onDelete: 'set null' }),
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [index('checklist_items_cl_idx').on(t.checklistId, t.position)],
);

/* -------------------------------------------------------------- comments */

export const comments = pgTable(
  'comments',
  {
    id: id(),
    cardId: text('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('comments_card_idx').on(t.cardId, t.createdAt)],
);

/* ------------------------------------------------------------ attachments */

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    cardId: text('card_id').references(() => cards.id, { onDelete: 'cascade' }),
    uploaderId: text('uploader_id').references(() => users.id, { onDelete: 'set null' }),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull(),
    isImage: boolean('is_image').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('attachments_card_idx').on(t.cardId), index('attachments_ws_idx').on(t.workspaceId)],
);

/* --------------------------------------------------- activity & notifications */

export const activities = pgTable(
  'activities',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    cardId: text('card_id').references(() => cards.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorType: text('actor_type').notNull().default('user'), // user | automation | integration | system
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
  },
  (t) => [
    index('activities_board_idx').on(t.boardId, t.createdAt),
    index('activities_card_idx').on(t.cardId, t.createdAt),
    index('activities_ws_idx').on(t.workspaceId, t.createdAt),
    uniqueIndex('activities_dedupe_uq').on(t.dedupeKey),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link'),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    cardId: text('card_id').references(() => cards.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt), uniqueIndex('notifications_dedupe_uq').on(t.userId, t.dedupeKey)],
);

/* -------------------------------------------------------------- automation */

export const automationRules = pgTable(
  'automation_rules',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    trigger: jsonb('trigger').$type<{ type: string; params: Record<string, unknown> }>().notNull(),
    conditions: jsonb('conditions').$type<{ type: string; params: Record<string, unknown> }[]>().notNull().default([]),
    actions: jsonb('actions').$type<{ type: string; params: Record<string, unknown> }[]>().notNull().default([]),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('automation_rules_board_idx').on(t.boardId), index('automation_rules_next_idx').on(t.nextRunAt)],
);

export const automationExecutions = pgTable(
  'automation_executions',
  {
    id: id(),
    ruleId: text('rule_id').notNull().references(() => automationRules.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    status: text('status').notNull(), // success | skipped | failed
    cardId: text('card_id'),
    log: jsonb('log').$type<string[]>().notNull().default([]),
    error: text('error'),
    event: jsonb('event').$type<Record<string, unknown>>().notNull().default({}),
    attempt: integer('attempt').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('automation_exec_uq').on(t.ruleId, t.eventKey, t.attempt), index('automation_exec_rule_idx').on(t.ruleId, t.createdAt)],
);

/* --------------------------------------------------------------- templates */

export const templates = pgTable(
  'templates',
  {
    id: id(),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }), // null = built-in
    slug: text('slug'),
    kind: text('kind').notNull(), // board | card | checklist | workflow | automation | project | release
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default('general'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('templates_ws_idx').on(t.workspaceId), uniqueIndex('templates_slug_uq').on(t.slug)],
);

/* ------------------------------------------------------------- saved views */

export const savedViews = pgTable(
  'saved_views',
  {
    id: id(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    view: text('view').notNull(), // board | table | calendar | timeline | search
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('saved_views_user_idx').on(t.userId)],
);

/* ----------------------------------------------------------- integrations */

export const integrations = pgTable(
  'integrations',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // discord | github | gitlab | email
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secretEnc: text('secret_enc'),
    events: jsonb('events').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('active'), // active | error | disabled
    lastError: text('last_error'),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('integrations_ws_idx').on(t.workspaceId)],
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: id(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    boardId: text('board_id').references(() => boards.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(), // outgoing | incoming
    name: text('name').notNull(),
    url: text('url'),
    secretEnc: text('secret_enc'),
    tokenHash: text('token_hash'),
    targetListId: text('target_list_id').references(() => lists.id, { onDelete: 'set null' }),
    events: jsonb('events').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('webhooks_ws_idx').on(t.workspaceId), uniqueIndex('webhooks_token_uq').on(t.tokenHash)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookId: text('webhook_id'),
    integrationId: text('integration_id'),
    event: text('event').notNull(),
    status: text('status').notNull(), // pending | success | failed
    responseStatus: integer('response_status'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('webhook_deliveries_wh_idx').on(t.webhookId, t.createdAt), index('webhook_deliveries_int_idx').on(t.integrationId, t.createdAt)],
);

/* ------------------------------------------------------------ infra tables */

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'), // pending | running | done | failed
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lastError: text('last_error'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_pending_idx').on(t.status, t.runAt), uniqueIndex('jobs_dedupe_uq').on(t.dedupeKey)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    userId: text('user_id').notNull(),
    route: text('route').notNull(),
    status: integer('status').notNull(),
    body: jsonb('body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull().default(''),
    targetId: text('target_id').notNull().default(''),
    ip: text('ip').notNull().default(''),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_ws_idx').on(t.workspaceId, t.createdAt), index('audit_logs_user_idx').on(t.userId, t.createdAt)],
);
