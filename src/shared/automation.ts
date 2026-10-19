/**
 * Automation catalogue shared by the visual rule builder (client) and the rule
 * validator / engine (server). Each parameter describes how the builder renders it.
 */

export type ParamKind = 'list' | 'label' | 'member' | 'priority' | 'text' | 'number' | 'customField' | 'customFieldValue' | 'board' | 'releaseStatus' | 'release' | 'time' | 'weekdays' | 'stageCategory' | 'notifyTarget';

export interface ParamDef {
  key: string;
  label: string;
  kind: ParamKind;
  optional?: boolean;
}

export interface CatalogEntry {
  type: string;
  label: string;
  description: string;
  params: ParamDef[];
}

export const TRIGGERS: CatalogEntry[] = [
  { type: 'card.created', label: 'Card created', description: 'When a card is added to the board', params: [{ key: 'listId', label: 'in list', kind: 'list', optional: true }] },
  { type: 'card.moved', label: 'Card moved', description: 'When a card is moved into a list', params: [{ key: 'toListId', label: 'into list', kind: 'list', optional: true }] },
  { type: 'card.archived', label: 'Card archived', description: 'When a card is archived', params: [] },
  { type: 'label.added', label: 'Label added', description: 'When a label is added to a card', params: [{ key: 'labelId', label: 'label', kind: 'label', optional: true }] },
  { type: 'label.removed', label: 'Label removed', description: 'When a label is removed from a card', params: [{ key: 'labelId', label: 'label', kind: 'label', optional: true }] },
  { type: 'member.assigned', label: 'Member assigned', description: 'When someone is assigned to a card', params: [{ key: 'userId', label: 'member', kind: 'member', optional: true }] },
  { type: 'member.removed', label: 'Member removed', description: 'When someone is unassigned from a card', params: [{ key: 'userId', label: 'member', kind: 'member', optional: true }] },
  { type: 'due.approaching', label: 'Due date approaching', description: 'Hours before a card is due', params: [{ key: 'hours', label: 'hours before', kind: 'number' }] },
  { type: 'due.passed', label: 'Due date passed', description: 'When an incomplete card becomes overdue', params: [] },
  { type: 'checklist.completed', label: 'Checklist completed', description: 'When every item in a checklist is done', params: [] },
  { type: 'customField.changed', label: 'Custom field changed', description: 'When a custom field value changes', params: [{ key: 'fieldId', label: 'field', kind: 'customField', optional: true }] },
  { type: 'schedule', label: 'Scheduled time', description: 'At a time of day on chosen weekdays', params: [{ key: 'time', label: 'at', kind: 'time' }, { key: 'weekdays', label: 'on', kind: 'weekdays' }] },
  { type: 'release.statusChanged', label: 'Release status changed', description: 'When a release in this workspace changes status', params: [{ key: 'status', label: 'to status', kind: 'releaseStatus', optional: true }] },
];

export const CONDITIONS: CatalogEntry[] = [
  { type: 'inList', label: 'Card is in list', description: '', params: [{ key: 'listId', label: 'list', kind: 'list' }] },
  { type: 'hasLabel', label: 'Card has label', description: '', params: [{ key: 'labelId', label: 'label', kind: 'label' }] },
  { type: 'notHasLabel', label: 'Card does not have label', description: '', params: [{ key: 'labelId', label: 'label', kind: 'label' }] },
  { type: 'assignedTo', label: 'Card is assigned to', description: '', params: [{ key: 'userId', label: 'member', kind: 'member' }] },
  { type: 'unassigned', label: 'Card has no assignees', description: '', params: [] },
  { type: 'priorityIs', label: 'Priority is', description: '', params: [{ key: 'priority', label: 'priority', kind: 'priority' }] },
  { type: 'dueWithin', label: 'Due within', description: '', params: [{ key: 'days', label: 'days', kind: 'number' }] },
  { type: 'hasNoDueDate', label: 'Card has no due date', description: '', params: [] },
  { type: 'customFieldEquals', label: 'Custom field equals', description: '', params: [{ key: 'fieldId', label: 'field', kind: 'customField' }, { key: 'value', label: 'value', kind: 'customFieldValue' }] },
  { type: 'statusIs', label: 'Task status is', description: '', params: [{ key: 'category', label: 'status', kind: 'stageCategory' }] },
  { type: 'titleContains', label: 'Title contains', description: '', params: [{ key: 'text', label: 'text', kind: 'text' }] },
];

export const ACTIONS: CatalogEntry[] = [
  { type: 'moveCard', label: 'Move card to list', description: '', params: [{ key: 'listId', label: 'list', kind: 'list' }] },
  { type: 'createCard', label: 'Create a card', description: '', params: [{ key: 'listId', label: 'in list', kind: 'list' }, { key: 'title', label: 'titled', kind: 'text' }] },
  { type: 'assignMember', label: 'Assign member', description: '', params: [{ key: 'userId', label: 'member', kind: 'member' }] },
  { type: 'unassignMember', label: 'Remove member', description: '', params: [{ key: 'userId', label: 'member', kind: 'member' }] },
  { type: 'addLabel', label: 'Add label', description: '', params: [{ key: 'labelId', label: 'label', kind: 'label' }] },
  { type: 'removeLabel', label: 'Remove label', description: '', params: [{ key: 'labelId', label: 'label', kind: 'label' }] },
  { type: 'setPriority', label: 'Set priority', description: '', params: [{ key: 'priority', label: 'priority', kind: 'priority' }] },
  { type: 'setCustomField', label: 'Set custom field', description: '', params: [{ key: 'fieldId', label: 'field', kind: 'customField' }, { key: 'value', label: 'value', kind: 'customFieldValue' }] },
  { type: 'addChecklist', label: 'Add checklist', description: '', params: [{ key: 'title', label: 'title', kind: 'text' }, { key: 'items', label: 'items (one per line)', kind: 'text', optional: true }] },
  { type: 'addComment', label: 'Add comment', description: '', params: [{ key: 'text', label: 'comment', kind: 'text' }] },
  { type: 'notify', label: 'Send notification', description: '', params: [{ key: 'target', label: 'to', kind: 'notifyTarget' }, { key: 'message', label: 'message', kind: 'text' }] },
  { type: 'markComplete', label: 'Mark card complete', description: '', params: [] },
  { type: 'archiveCard', label: 'Archive card', description: '', params: [] },
  { type: 'setReleaseStatus', label: 'Change release status', description: '', params: [{ key: 'releaseId', label: 'release', kind: 'release' }, { key: 'status', label: 'to', kind: 'releaseStatus' }] },
];

export const TRIGGER_TYPES = TRIGGERS.map((t) => t.type);
export const CONDITION_TYPES = CONDITIONS.map((t) => t.type);
export const ACTION_TYPES = ACTIONS.map((t) => t.type);

/** Triggers that are not tied to a specific card. Card-scoped actions are unavailable for them. */
export const CARDLESS_TRIGGERS = new Set(['schedule', 'release.statusChanged']);
export const CARDLESS_ACTIONS = new Set(['createCard', 'notify', 'setReleaseStatus']);

export function describeStep(catalog: CatalogEntry[], type: string): string {
  return catalog.find((c) => c.type === type)?.label ?? type;
}
