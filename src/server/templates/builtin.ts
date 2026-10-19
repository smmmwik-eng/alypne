import type { BoardBlueprint } from '../services/boards.js';

/** Built-in templates for Roblox studios. Seeded idempotently by slug at startup. */

const L = {
  bug: { name: 'Bug', color: '#f43f5e' },
  feature: { name: 'Feature', color: '#a78bfa' },
  scripting: { name: 'Scripting', color: '#38bdf8' },
  building: { name: 'Building', color: '#34d399' },
  ui: { name: 'UI', color: '#e879f9' },
  blocked: { name: 'Blocked', color: '#fb923c' },
  audio: { name: 'Audio', color: '#facc15' },
  animation: { name: 'Animation', color: '#2dd4bf' },
  monetisation: { name: 'Monetisation', color: '#a3e635' },
  live: { name: 'Live ops', color: '#f472b6' },
};

const workflowLists = (extra: Partial<Record<string, BoardBlueprint['lists'][number]['cards']>> = {}): BoardBlueprint['lists'] => [
  { name: 'Backlog', stage: 'Backlog', cards: extra.Backlog ?? [] },
  { name: 'Planned', stage: 'Planned', cards: extra.Planned ?? [] },
  { name: 'In Progress', stage: 'In Progress', cards: extra['In Progress'] ?? [] },
  { name: 'Code Review', stage: 'Code Review', cards: extra['Code Review'] ?? [] },
  { name: 'Testing', stage: 'Testing', cards: extra.Testing ?? [] },
  { name: 'Ready for Release', stage: 'Ready for Release', cards: extra['Ready for Release'] ?? [] },
  { name: 'Completed', stage: 'Completed', cards: extra.Completed ?? [] },
];

export interface BuiltinTemplate {
  slug: string;
  kind: 'board' | 'card' | 'checklist' | 'workflow' | 'automation' | 'project' | 'release';
  name: string;
  description: string;
  category: string;
  data: Record<string, unknown>;
}

const boards: { slug: string; name: string; description: string; bp: BoardBlueprint }[] = [
  {
    slug: 'board-new-game',
    name: 'New game development',
    description: 'Take an experience from concept to launch with a full development pipeline.',
    bp: {
      background: 'violet',
      labels: [L.feature, L.bug, L.scripting, L.building, L.ui, L.blocked],
      customFields: [{ name: 'Estimate (hrs)', type: 'number' }, { name: 'Place', type: 'dropdown', options: [{ id: 'lobby', label: 'Lobby' }, { id: 'main', label: 'Main place' }, { id: 'test', label: 'Test place' }] }],
      lists: workflowLists({
        Backlog: [
          { title: 'Write the game design document', labels: ['Feature'], checklists: [{ title: 'GDD sections', items: ['Core loop', 'Progression', 'Monetisation', 'Target audience', 'Art direction'] }] },
          { title: 'Core gameplay loop prototype', labels: ['Scripting'] },
          { title: 'Greybox the main map', labels: ['Building'] },
          { title: 'Main menu and HUD wireframes', labels: ['UI'] },
          { title: 'DataStore save system', labels: ['Scripting'], description: 'Session locking, retries with backoff and versioned save data.' },
        ],
      }),
      automations: [
        { name: 'Mark complete when moved to Completed', trigger: { type: 'card.moved', params: { toListId: 'Completed' } }, conditions: [], actions: [{ type: 'markComplete', params: {} }] },
      ],
    },
  },
  {
    slug: 'board-bug-tracking',
    name: 'Bug tracking',
    description: 'Triage, reproduce and fix bugs with severity and platform tracking.',
    bp: {
      background: 'ember',
      labels: [{ name: 'Critical', color: '#f43f5e' }, { name: 'Major', color: '#fb923c' }, { name: 'Minor', color: '#facc15' }, { name: 'Mobile', color: '#38bdf8' }, { name: 'Console', color: '#a78bfa' }, { name: 'Exploit', color: '#e879f9' }],
      lists: [
        { name: 'Reported', stage: 'Backlog', cards: [{ title: 'Example: Players fall through floor near spawn', type: 'bug', labels: ['Major'] }] },
        { name: 'Triaged', stage: 'Planned' },
        { name: 'Reproducing', stage: 'In Progress' },
        { name: 'Fixing', stage: 'In Progress' },
        { name: 'Verifying', stage: 'Testing' },
        { name: 'Fixed', stage: 'Completed' },
        { name: "Won't fix", stage: 'Completed' },
      ],
      automations: [
        { name: 'Flag critical bugs as urgent', trigger: { type: 'label.added', params: { labelId: 'Critical' } }, conditions: [], actions: [{ type: 'setPriority', params: { priority: 'urgent' } }] },
      ],
    },
  },
  {
    slug: 'board-update-planning',
    name: 'Update planning',
    description: 'Plan, build and ship a content update on a fixed date.',
    bp: {
      background: 'ocean',
      labels: [L.feature, L.bug, L.live, L.monetisation, L.ui],
      lists: [
        { name: 'Ideas', stage: 'Backlog' },
        { name: 'This update', stage: 'Planned', cards: [{ title: 'Update trailer / thumbnail refresh', labels: ['Live ops'] }, { title: 'Patch notes draft', labels: ['Live ops'] }] },
        { name: 'Building', stage: 'In Progress' },
        { name: 'QA', stage: 'Testing' },
        { name: 'Shipped', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-scripting',
    name: 'Scripting tasks',
    description: 'Server/client systems with code review and testing stages.',
    bp: {
      background: 'slate',
      labels: [{ name: 'Server', color: '#38bdf8' }, { name: 'Client', color: '#a78bfa' }, { name: 'Shared', color: '#2dd4bf' }, { name: 'Refactor', color: '#94a3b8' }, L.bug, L.blocked],
      customFields: [{ name: 'Module path', type: 'text' }, { name: 'Pull request', type: 'url' }],
      lists: workflowLists({
        Backlog: [
          { title: 'Remote event rate limiting', labels: ['Server'], checklists: [{ title: 'Security', items: ['Validate all arguments server-side', 'Per-player rate limit', 'Log suspicious calls'] }] },
          { title: 'Client input controller', labels: ['Client'] },
        ],
      }),
    },
  },
  {
    slug: 'board-building',
    name: 'Building and modelling',
    description: 'Map areas, props and optimisation passes for builders and modelers.',
    bp: {
      background: 'forest',
      labels: [{ name: 'Map', color: '#34d399' }, { name: 'Props', color: '#a3e635' }, { name: 'Lighting', color: '#facc15' }, { name: 'Optimisation', color: '#38bdf8' }, { name: 'Mesh', color: '#a78bfa' }],
      customFields: [{ name: 'Part count', type: 'number' }, { name: 'Triangle budget', type: 'number' }],
      lists: [
        { name: 'Concepts', stage: 'Backlog' },
        { name: 'Blockout', stage: 'In Progress' },
        { name: 'Detailing', stage: 'In Progress' },
        { name: 'Lighting & polish', stage: 'Testing' },
        { name: 'Approved', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-ui',
    name: 'UI development',
    description: 'Design to implementation for interfaces across devices.',
    bp: {
      background: 'rose',
      labels: [{ name: 'Design', color: '#e879f9' }, { name: 'Implementation', color: '#38bdf8' }, { name: 'Mobile', color: '#fb923c' }, { name: 'Console', color: '#a78bfa' }, { name: 'Accessibility', color: '#34d399' }],
      lists: [
        { name: 'Requests', stage: 'Backlog' },
        { name: 'Designing', stage: 'In Progress', cards: [{ title: 'Shop UI mockups', labels: ['Design'], checklists: [{ title: 'Screens', items: ['Desktop', 'Mobile portrait', 'Mobile landscape', 'Console / gamepad'] }] }] },
        { name: 'Building', stage: 'In Progress' },
        { name: 'Device testing', stage: 'Testing' },
        { name: 'Done', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-animation',
    name: 'Animation',
    description: 'Track rigs, animations and their integration in game.',
    bp: {
      background: 'sand',
      labels: [{ name: 'R15', color: '#38bdf8' }, { name: 'Custom rig', color: '#a78bfa' }, { name: 'Combat', color: '#f43f5e' }, { name: 'Emote', color: '#facc15' }, { name: 'Cutscene', color: '#2dd4bf' }],
      customFields: [{ name: 'Animation ID', type: 'text' }, { name: 'Length (s)', type: 'number' }],
      lists: [
        { name: 'To animate', stage: 'Backlog' },
        { name: 'Blocking', stage: 'In Progress' },
        { name: 'Polish', stage: 'In Progress' },
        { name: 'Uploaded', stage: 'Testing' },
        { name: 'In game', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-qa',
    name: 'Quality assurance',
    description: 'Test passes per release with device coverage.',
    bp: {
      background: 'mono',
      labels: [{ name: 'Regression', color: '#94a3b8' }, { name: 'Smoke', color: '#38bdf8' }, { name: 'Mobile', color: '#fb923c' }, { name: 'Pass', color: '#34d399' }, { name: 'Fail', color: '#f43f5e' }],
      lists: [
        { name: 'Test plan', stage: 'Planned', cards: [{ title: 'Release smoke test', labels: ['Smoke'], checklists: [{ title: 'Smoke test', items: ['Join from home page', 'Tutorial completes', 'Purchases prompt correctly', 'Data saves on leave', 'Rejoin restores data', 'No errors in developer console'] }] }] },
        { name: 'Testing', stage: 'Testing' },
        { name: 'Failed', stage: 'In Progress' },
        { name: 'Passed', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-recruitment',
    name: 'Studio recruitment',
    description: 'Hire scripters, builders and artists with a clear pipeline.',
    bp: {
      background: 'violet',
      labels: [{ name: 'Scripter', color: '#38bdf8' }, { name: 'Builder', color: '#34d399' }, { name: 'UI', color: '#e879f9' }, { name: 'Animator', color: '#fb923c' }, { name: 'Commission', color: '#facc15' }, { name: 'Long term', color: '#a78bfa' }],
      customFields: [{ name: 'Portfolio', type: 'url' }, { name: 'Rate (Robux)', type: 'number' }, { name: 'Timezone', type: 'text' }],
      lists: [
        { name: 'Open roles', stage: 'Backlog' },
        { name: 'Applied', stage: 'Planned' },
        { name: 'Portfolio review', stage: 'In Progress' },
        { name: 'Trial task', stage: 'Testing' },
        { name: 'Offer', stage: 'Ready for Release' },
        { name: 'Hired', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-onboarding',
    name: 'Team onboarding',
    description: 'Get new team members productive in their first week.',
    bp: {
      background: 'ocean',
      labels: [{ name: 'Access', color: '#38bdf8' }, { name: 'Reading', color: '#a78bfa' }, { name: 'First task', color: '#34d399' }],
      lists: [
        { name: 'Day 1', stage: 'Planned', cards: [{ title: 'Grant Team Create / group role', labels: ['Access'] }, { title: 'Join the studio Discord', labels: ['Access'] }, { title: 'Read the style guide', labels: ['Reading'] }] },
        { name: 'Week 1', stage: 'In Progress', cards: [{ title: 'Pick up a starter task', labels: ['First task'] }] },
        { name: 'Done', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-events',
    name: 'Game events',
    description: 'Plan limited-time and holiday events end to end.',
    bp: {
      background: 'rose',
      labels: [L.live, L.monetisation, L.building, L.scripting, L.ui],
      customFields: [{ name: 'Event start', type: 'date' }, { name: 'Event end', type: 'date' }],
      lists: [
        { name: 'Event ideas', stage: 'Backlog' },
        { name: 'Content', stage: 'In Progress', cards: [{ title: 'Event map decorations', labels: ['Building'] }, { title: 'Event currency & shop', labels: ['Scripting', 'Monetisation'] }, { title: 'Event countdown UI', labels: ['UI'] }] },
        { name: 'Marketing', stage: 'In Progress', cards: [{ title: 'Event thumbnail & icon', labels: ['Live ops'] }, { title: 'Announcement post', labels: ['Live ops'] }] },
        { name: 'Live', stage: 'Ready for Release' },
        { name: 'Wrapped up', stage: 'Completed' },
      ],
    },
  },
  {
    slug: 'board-moderation',
    name: 'Moderation and operations',
    description: 'Handle reports, appeals and live operations for your community.',
    bp: {
      background: 'slate',
      labels: [{ name: 'Exploiter', color: '#f43f5e' }, { name: 'Harassment', color: '#fb923c' }, { name: 'Appeal', color: '#38bdf8' }, { name: 'Server issue', color: '#a78bfa' }, { name: 'Resolved', color: '#34d399' }],
      customFields: [{ name: 'Roblox user ID', type: 'text' }, { name: 'Evidence', type: 'url' }],
      lists: [
        { name: 'New reports', stage: 'Backlog' },
        { name: 'Investigating', stage: 'In Progress' },
        { name: 'Action taken', stage: 'Completed' },
        { name: 'Appeals', stage: 'Planned' },
      ],
    },
  },
];

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  ...boards.map((b) => ({ slug: b.slug, kind: 'board' as const, name: b.name, description: b.description, category: 'roblox', data: b.bp as unknown as Record<string, unknown> })),
  {
    slug: 'card-bug-report',
    kind: 'card',
    name: 'Bug report',
    description: 'Structured bug report with reproduction steps.',
    category: 'roblox',
    data: { type: 'bug', priority: 'medium', description: '**Summary**\n\n**Where it happens** (place / area)\n\n**Notes**', labels: ['Bug'], checklists: [{ title: 'Triage', items: ['Reproduced in Studio', 'Reproduced in live server', 'Root cause found', 'Fix verified'] }] },
  },
  {
    slug: 'card-feature',
    kind: 'card',
    name: 'Feature spec',
    description: 'Feature with goals, acceptance criteria and rollout.',
    category: 'general',
    data: { type: 'task', priority: 'medium', description: '## Goal\n\n## Acceptance criteria\n- [ ] \n\n## Out of scope\n', labels: ['Feature'], checklists: [{ title: 'Definition of done', items: ['Implemented', 'Code reviewed', 'Tested on mobile', 'Tested on desktop', 'Analytics events added'] }] },
  },
  {
    slug: 'checklist-release',
    kind: 'checklist',
    name: 'Release checklist',
    description: 'Steps before publishing an update to the live game.',
    category: 'roblox',
    data: { title: 'Release checklist', items: ['Publish to test place', 'Run smoke test', 'Check DataStore migrations', 'Update patch notes', 'Shut down old servers / migrate', 'Announce in community'] },
  },
  {
    slug: 'checklist-asset-upload',
    kind: 'checklist',
    name: 'Asset upload',
    description: 'Make sure assets are ready for production.',
    category: 'roblox',
    data: { title: 'Asset upload', items: ['Upload to group (not personal) inventory', 'Asset passes moderation', 'Record asset ID in Alypne', 'Set correct permissions', 'Test in game'] },
  },
  {
    slug: 'checklist-code-review',
    kind: 'checklist',
    name: 'Code review',
    description: 'Review checklist for Luau changes.',
    category: 'roblox',
    data: { title: 'Code review', items: ['Remote arguments validated on the server', 'No yielding in hot paths', 'Connections cleaned up', 'Types annotated (--!strict)', 'Tested with multiple players'] },
  },
  {
    slug: 'workflow-dev-pipeline',
    kind: 'workflow',
    name: 'Development pipeline',
    description: 'Backlog → Planned → In Progress → Code Review → Testing → Ready for Release → Completed.',
    category: 'roblox',
    data: {
      stages: [
        { name: 'Backlog', category: 'todo', color: '#6b7280' },
        { name: 'Planned', category: 'todo', color: '#818cf8' },
        { name: 'In Progress', category: 'in_progress', color: '#38bdf8' },
        { name: 'Code Review', category: 'in_progress', color: '#c084fc' },
        { name: 'Testing', category: 'in_progress', color: '#facc15' },
        { name: 'Ready for Release', category: 'in_progress', color: '#fb923c' },
        { name: 'Completed', category: 'done', color: '#34d399' },
      ],
    },
  },
  {
    slug: 'workflow-art',
    kind: 'workflow',
    name: 'Art pipeline',
    description: 'Concept → Blockout → Detailing → Review → Approved.',
    category: 'roblox',
    data: {
      stages: [
        { name: 'Concept', category: 'todo', color: '#6b7280' },
        { name: 'Blockout', category: 'in_progress', color: '#38bdf8' },
        { name: 'Detailing', category: 'in_progress', color: '#a78bfa' },
        { name: 'Art review', category: 'in_progress', color: '#facc15' },
        { name: 'Approved', category: 'done', color: '#34d399' },
      ],
    },
  },
  {
    slug: 'automation-complete-on-done',
    kind: 'automation',
    name: 'Complete cards in a done list',
    description: 'When a card moves into the chosen list, mark it complete.',
    category: 'general',
    data: { name: 'Complete when done', trigger: { type: 'card.moved', params: {} }, conditions: [], actions: [{ type: 'markComplete', params: {} }] },
  },
  {
    slug: 'automation-overdue-urgent',
    kind: 'automation',
    name: 'Escalate overdue cards',
    description: 'When a card becomes overdue, set urgent priority and notify assignees.',
    category: 'general',
    data: { name: 'Escalate overdue', trigger: { type: 'due.passed', params: {} }, conditions: [], actions: [{ type: 'setPriority', params: { priority: 'urgent' } }, { type: 'notify', params: { target: 'assignees', message: '{card} is overdue' } }] },
  },
  {
    slug: 'automation-weekly-standup',
    kind: 'automation',
    name: 'Weekly planning card',
    description: 'Every Monday at 10:00, create a planning card.',
    category: 'general',
    data: { name: 'Weekly planning', trigger: { type: 'schedule', params: { time: '10:00', weekdays: [1] } }, conditions: [], actions: [{ type: 'createCard', params: { listId: null, title: 'Weekly planning {date}' } }] },
  },
  {
    slug: 'project-new-experience',
    kind: 'project',
    name: 'New Roblox experience',
    description: 'A game project with development, bug and QA boards.',
    category: 'roblox',
    data: { stage: 'concept', boards: ['board-new-game', 'board-bug-tracking', 'board-qa'] },
  },
  {
    slug: 'release-content-update',
    kind: 'release',
    name: 'Content update',
    description: 'A release with the standard launch tasks.',
    category: 'roblox',
    data: { version: '1.0.0', description: 'Content update', tasks: ['Finalize patch notes', 'Smoke test on test place', 'Publish update', 'Post announcement', 'Monitor errors for 24 hours'] },
  },
];
