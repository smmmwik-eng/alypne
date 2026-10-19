import { memo, useState } from 'react';
import { AlignLeft, Bug, CheckSquare, Clock, Copy, Lock, MessageSquare, MoreHorizontal, Paperclip, Repeat, ThumbsUp, Archive, ArrowRightLeft, CalendarDays, CheckCircle2, Circle, Tag, Users, ExternalLink } from 'lucide-react';
import type { BoardData, CardSummary } from '@/lib/types';
import { cn, dueState, shortDate } from '@/lib/format';
import { PRIORITY_META } from '@shared/constants';
import { AvatarStack, MenuItem, MenuSeparator, Popover, usePopover } from '@/components/ui';
import type { BoardActions } from './useBoardActions';
import { DatesEditor, LabelPicker, MemberPicker, MoveTargetPicker, PopoverTitle } from './pickers';

const dueTone: Record<string, string> = {
  overdue: 'bg-danger-soft text-danger',
  today: 'bg-warning-soft text-warning',
  soon: 'bg-warning-soft text-warning',
  done: 'bg-success-soft text-success',
  later: 'text-muted',
  none: '',
};

/** Keep Enter/Space on inner buttons from starting a keyboard drag on the sortable wrapper. */
const stopDragKeys = (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
};

export const SEVERITY_COLOR: Record<string, string> = { trivial: '#94a3b8', minor: '#38bdf8', major: '#fb923c', critical: '#f43f5e', blocker: '#e11d48' };

export function DueBadge({ dueAt, completedAt, className }: { dueAt: string | null; completedAt: string | null; className?: string }) {
  if (!dueAt) return null;
  const s = dueState(dueAt, completedAt);
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium', dueTone[s], className)} title={`Due ${new Date(dueAt).toLocaleString()}`}>
      {s === 'done' ? <CheckCircle2 className="size-3" /> : <Clock className="size-3" />}
      {shortDate(dueAt)}
    </span>
  );
}

interface Props {
  card: CardSummary;
  board: BoardData;
  onOpen: (c: CardSummary) => void;
  actions?: BoardActions;
  canEdit: boolean;
  dragging?: boolean;
  overlay?: boolean;
}

export const CardTile = memo(function CardTile({ card, board, onOpen, actions, canEdit, dragging, overlay }: Props) {
  const labels = board.labels.filter((l) => card.labelIds.includes(l.id));
  const people = board.members.filter((m) => card.assigneeIds.includes(m.id));
  const fieldsOnCard = board.customFields.filter((f) => f.showOnCard && card.customFields[f.id] !== undefined && card.customFields[f.id] !== null && card.customFields[f.id] !== false);
  const coverUrl = card.coverAttachmentId ? board.coverUrls[card.coverAttachmentId] : null;
  const showCovers = board.board.settings.cardCovers !== false;
  const temp = card.id.startsWith('temp-');
  const menu = usePopover();
  const [panel, setPanel] = useState<null | 'labels' | 'members' | 'dates' | 'move' | 'copy'>(null);
  const closeMenu = () => {
    menu.close();
    setPanel(null);
  };

  return (
    <div
      className={cn(
        'group/card relative rounded-[var(--radius-card)] border border-line bg-card text-left shadow-soft transition-[background,border-color,box-shadow] duration-100',
        !overlay && 'hover:border-line-strong hover:bg-card-hover',
        dragging && 'opacity-40',
        overlay && 'rotate-[1.5deg] cursor-grabbing border-line-strong shadow-pop',
        temp && 'opacity-70',
      )}
    >
      {showCovers && (coverUrl || card.coverColor) && (
        <div className="overflow-hidden rounded-t-[calc(var(--radius-card)-1px)]" style={{ background: card.coverColor ?? undefined }}>
          {coverUrl ? <img src={coverUrl} alt="" className="max-h-40 w-full object-cover" loading="lazy" draggable={false} /> : <div className="h-8" />}
        </div>
      )}
      <button
        type="button"
        disabled={temp}
        onClick={() => onOpen(card)}
        onKeyDown={stopDragKeys}
        className="block w-full rounded-[var(--radius-card)] px-2.5 pt-2 pb-2 text-left focus-ring"
        aria-label={`${card.title}${card.completedAt ? ', completed' : ''}. Open card`}
      >
        {labels.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {labels.map((l) => (
              <span key={l.id} className="inline-flex h-[18px] max-w-full items-center truncate rounded px-1.5 text-[10.5px] font-semibold text-black/75" style={{ background: l.color }} title={l.name}>
                {l.name || '   '}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-start gap-1.5">
          {card.completedAt && <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />}
          {card.type === 'bug' && <Bug className="mt-0.5 size-3.5 shrink-0" style={{ color: SEVERITY_COLOR[card.bug?.severity ?? 'minor'] }} aria-label={`Bug, ${card.bug?.severity ?? ''}`} />}
          <span className={cn('min-w-0 flex-1 text-[13px] leading-snug break-words', card.completedAt && 'text-muted')}>{card.title}</span>
        </div>
        {fieldsOnCard.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {fieldsOnCard.map((f) => {
              const v = card.customFields[f.id];
              const text = f.type === 'dropdown' ? f.options.find((o) => o.id === v)?.label : f.type === 'checkbox' ? '✓' : f.type === 'date' ? shortDate(String(v)) : f.type === 'user' ? board.members.find((m) => m.id === v)?.displayName : f.type === 'url' ? 'link' : String(v);
              if (!text) return null;
              return (
                <span key={f.id} className="inline-flex max-w-full items-center gap-1 truncate rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] text-muted">
                  <span className="text-faint">{f.name}:</span> {text}
                </span>
              );
            })}
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-faint">
          <span className="font-mono text-[10px] tracking-tight text-faint">
            {board.board.key}-{card.number || '…'}
          </span>
          {card.priority !== 'none' && (
            <span className="inline-flex items-center gap-1 text-[11px]" title={`Priority: ${PRIORITY_META[card.priority].label}`}>
              <span className="size-1.5 rounded-full" style={{ background: PRIORITY_META[card.priority].color }} />
              <span className="text-muted">{PRIORITY_META[card.priority].label}</span>
            </span>
          )}
          <DueBadge dueAt={card.dueAt} completedAt={card.completedAt} />
          {card.blockedByCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-danger" title="Blocked by another card">
              <Lock className="size-3" />
              Blocked
            </span>
          )}
          {card.hasDescription && <AlignLeft className="size-3" aria-label="Has description" />}
          {card.recurrence && <Repeat className="size-3" aria-label="Recurring" />}
          {card.checklist.total > 0 && (
            <span className={cn('inline-flex items-center gap-0.5 rounded px-1 text-[11px]', card.checklist.done === card.checklist.total && 'bg-success-soft text-success')}>
              <CheckSquare className="size-3" />
              {card.checklist.done}/{card.checklist.total}
            </span>
          )}
          {card.commentCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px]">
              <MessageSquare className="size-3" />
              {card.commentCount}
            </span>
          )}
          {card.attachmentCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px]">
              <Paperclip className="size-3" />
              {card.attachmentCount}
            </span>
          )}
          {card.voteCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-[11px]">
              <ThumbsUp className="size-3" />
              {card.voteCount}
            </span>
          )}
          {people.length > 0 && (
            <span className="ml-auto">
              <AvatarStack people={people} size={20} max={3} />
            </span>
          )}
        </div>
      </button>
      {canEdit && actions && !overlay && !temp && (
        <>
          <button
            ref={menu.anchorRef as any}
            onClick={(e) => {
              e.stopPropagation();
              menu.toggle();
            }}
            onKeyDown={stopDragKeys}
            aria-label="Card actions"
            aria-haspopup="menu"
            className={cn('absolute top-1.5 right-1.5 rounded-md bg-surface-2/90 p-1 text-muted opacity-0 backdrop-blur transition-opacity hover:text-fg focus:opacity-100 group-hover/card:opacity-100 focus-ring', menu.open && 'opacity-100')}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
          <Popover open={menu.open} onClose={closeMenu} anchor={menu.anchorRef} align="start" width={panel === 'move' || panel === 'copy' ? 300 : 240}>
            {panel === null && (
              <div role="menu">
                <MenuItem icon={<ExternalLink />} onClick={() => (closeMenu(), onOpen(card))}>
                  Open card
                </MenuItem>
                <MenuItem icon={card.completedAt ? <Circle /> : <CheckCircle2 />} onClick={() => (closeMenu(), actions.toggleComplete(card))}>
                  {card.completedAt ? 'Mark incomplete' : 'Mark complete'}
                </MenuItem>
                <MenuItem icon={<Tag />} onClick={() => setPanel('labels')}>
                  Labels
                </MenuItem>
                <MenuItem icon={<Users />} onClick={() => setPanel('members')}>
                  Members
                </MenuItem>
                <MenuItem icon={<CalendarDays />} onClick={() => setPanel('dates')}>
                  Dates
                </MenuItem>
                <MenuItem icon={<ArrowRightLeft />} onClick={() => setPanel('move')}>
                  Move…
                </MenuItem>
                <MenuItem icon={<Copy />} onClick={() => setPanel('copy')}>
                  Copy…
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Archive />} onClick={() => (closeMenu(), actions.archiveCard(card.id))}>
                  Archive
                </MenuItem>
              </div>
            )}
            {panel === 'labels' && (
              <>
                <PopoverTitle onClose={closeMenu}>Labels</PopoverTitle>
                <LabelPicker board={board} selected={card.labelIds} onToggle={(id) => actions.toggleLabel(card, id)} canManage={canEdit} />
              </>
            )}
            {panel === 'members' && (
              <>
                <PopoverTitle onClose={closeMenu}>Members</PopoverTitle>
                <MemberPicker board={board} selected={card.assigneeIds} onToggle={(id) => actions.toggleAssignee(card, id)} />
              </>
            )}
            {panel === 'dates' && (
              <>
                <PopoverTitle onClose={closeMenu}>Dates</PopoverTitle>
                <DatesEditor startAt={card.startAt} dueAt={card.dueAt} onSave={(v) => actions.updateCard(card.id, v)} onClose={closeMenu} />
              </>
            )}
            {(panel === 'move' || panel === 'copy') && (
              <>
                <PopoverTitle onClose={closeMenu}>{panel === 'move' ? 'Move card' : 'Copy card'}</PopoverTitle>
                <MoveTargetPicker board={board} card={card} mode={panel} onDone={actions.refresh} onClose={closeMenu} />
              </>
            )}
          </Popover>
        </>
      )}
    </div>
  );
});
