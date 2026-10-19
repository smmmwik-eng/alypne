import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Plug } from 'lucide-react';
import type { Activity } from '@/lib/types';
import { Avatar } from './ui';
import { relativeTime, fullDate, shortDate } from '@/lib/format';

const q = (s: unknown) => <strong className="font-medium text-fg">{String(s ?? '')}</strong>;

/** Human-readable description of an activity event. `withCard` includes the card title. */
export function describeActivity(a: Activity, withCard = true): ReactNode {
  const d = a.data ?? {};
  const card = withCard && d.cardTitle ? <> on {q(d.cardTitle)}</> : null;
  switch (a.type) {
    case 'card.created':
      return <>added {withCard ? q(d.cardTitle) : 'this card'} to {q(d.listName)}</>;
    case 'bug.created':
      return <>reported bug {withCard ? q(d.cardTitle) : ''}</>;
    case 'card.moved':
      return <>moved {withCard ? q(d.cardTitle) : 'this card'} from {q(d.fromListName)} to {q(d.toListName)}</>;
    case 'card.completed':
      return <>marked {withCard ? q(d.cardTitle) : 'this card'} complete</>;
    case 'card.reopened':
      return <>marked {withCard ? q(d.cardTitle) : 'this card'} incomplete</>;
    case 'card.archived':
      return <>archived {withCard ? q(d.cardTitle) : 'this card'}</>;
    case 'card.restored':
      return <>restored {withCard ? q(d.cardTitle) : 'this card'}</>;
    case 'card.deleted':
      return <>deleted card {q(d.cardTitle)}</>;
    case 'card.updated': {
      const keys = Object.keys(d.changes ?? {});
      const nice: Record<string, string> = { title: 'the title', description: 'the description', priority: 'priority', startAt: 'the start date', coverColor: 'the cover', coverAttachmentId: 'the cover', releaseId: 'the release', milestoneId: 'the milestone', reminderMinutes: 'the reminder', recurrence: 'recurrence' };
      if (keys.length === 1 && keys[0] === 'priority') return <>set priority to {q(d.changes.priority.to)}{card}</>;
      if (keys.length === 1 && keys[0] === 'title') return <>renamed {q(d.changes.title.from)} to {q(d.changes.title.to)}</>;
      return <>updated {keys.map((k) => nice[k] ?? k).join(', ')}{card}</>;
    }
    case 'due.changed':
      return d.to ? <>set the due date to {q(shortDate(d.to, true))}{card}</> : <>removed the due date{card}</>;
    case 'label.added':
      return <>added label {q(d.labelName || 'unnamed')}{card}</>;
    case 'label.removed':
      return <>removed label {q(d.labelName || 'unnamed')}{card}</>;
    case 'member.assigned':
      return <>assigned {q(d.userName)}{card}</>;
    case 'member.removed':
      return <>removed {q(d.userName)}{card}</>;
    case 'comment.added':
      return <>commented{card}{d.excerpt ? <>: <span className="text-muted">“{d.excerpt}”</span></> : null}</>;
    case 'checklist.added':
      return <>added checklist {q(d.checklistTitle)}{card}</>;
    case 'checklist.completed':
      return <>completed checklist {q(d.checklistTitle)}{card}</>;
    case 'checklist.deleted':
      return <>removed checklist {q(d.checklistTitle)}{card}</>;
    case 'attachment.added':
      return <>attached {q(d.fileName)}{card}</>;
    case 'attachment.removed':
      return <>removed attachment {q(d.fileName)}{card}</>;
    case 'customField.changed':
      return <>changed {q(d.fieldName)}{card}</>;
    case 'card.relationAdded':
      return <>linked {q(d.otherTitle)} ({String(d.kind).replace('_', ' ')}){card}</>;
    case 'card.linkAdded':
      return <>linked {q(d.ref)} from {d.provider}{card}</>;
    case 'github.activity':
    case 'gitlab.activity':
      return <>{d.summary}{card}</>;
    case 'list.created':
      return <>added list {q(d.listName)}</>;
    case 'list.renamed':
      return <>renamed list {q(d.from)} to {q(d.to)}</>;
    case 'list.archived':
      return <>archived list {q(d.listName)}</>;
    case 'list.restored':
      return <>restored list {q(d.listName)}</>;
    case 'list.deleted':
      return <>deleted list {q(d.listName)}</>;
    case 'list.copied':
      return <>copied list {q(d.listName)} as {q(d.newName)}</>;
    case 'list.moved':
      return <>moved list {q(d.listName)} to another board</>;
    case 'list.movedIn':
      return <>moved list {q(d.listName)} here from another board</>;
    case 'board.created':
      return <>created board {q(d.name)}</>;
    case 'board.archived':
      return <>closed board {q(d.name)}</>;
    case 'board.restored':
      return <>reopened board {q(d.name)}</>;
    case 'board.deleted':
      return <>deleted board {q(d.name)}</>;
    case 'board.imported':
      return <>imported {d.cards} card{d.cards === 1 ? '' : 's'} from {String(d.source).toUpperCase()}</>;
    case 'board.member.added':
      return <>added a member to the board</>;
    case 'board.member.removed':
      return <>removed a member from the board</>;
    case 'workspace.created':
      return <>created the workspace</>;
    case 'workspace.member.joined':
      return <>{q(d.userName)} joined as {d.role}</>;
    case 'workspace.member.left':
      return <>left the workspace</>;
    case 'workspace.member.removed':
      return <>removed a member</>;
    case 'workspace.member.roleChanged':
      return <>changed a member's role to {q(d.to)}</>;
    case 'release.created':
      return <>created release {q(d.releaseName)}</>;
    case 'release.statusChanged':
      return <>moved release {q(d.releaseName)} to {q(String(d.to).replace('_', ' '))}</>;
    case 'project.created':
      return <>created game project {q(d.name)}</>;
    default:
      return <>{a.type.replace(/[._]/g, ' ')}{card}</>;
  }
}

export function ActivityRow({ a, withCard = true, boardLink }: { a: Activity; withCard?: boolean; boardLink?: boolean }) {
  const name = a.actor?.displayName ?? (a.actorType === 'automation' ? 'Automation' : a.actorType === 'integration' ? 'Integration' : 'Alypne');
  const href = a.boardId && a.cardId ? `/b/${a.boardId}/c/${a.cardId}` : a.boardId ? `/b/${a.boardId}` : null;
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      {a.actor ? (
        <Avatar name={a.actor.displayName} src={a.actor.avatarUrl} size={24} />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted">{a.actorType === 'integration' ? <Plug className="size-3.5" /> : <Bot className="size-3.5" />}</span>
      )}
      <div className="min-w-0 flex-1 text-[13px] leading-snug text-muted">
        <span className="font-medium text-fg">{name}</span> {describeActivity(a, withCard)}
        <div className="mt-0.5 text-[11px] text-faint" title={fullDate(a.createdAt)}>
          {relativeTime(a.createdAt)}
          {boardLink && a.boardName && href && (
            <>
              {' · '}
              <Link to={href} className="hover:text-muted hover:underline">
                {a.boardName}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
