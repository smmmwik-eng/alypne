import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  Bug,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  Circle,
  Copy,
  Eye,
  EyeOff,
  FileStack,
  Flag,
  Image as ImageIcon,
  Link2,
  Lock,
  Package,
  Paperclip,
  Plus,
  Repeat,
  Rocket,
  Share2,
  SlidersHorizontal,
  Tag,
  ThumbsUp,
  Trash2,
  Users,
  X,
  Milestone,
} from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useCard } from '@/lib/hooks';
import type { BoardData, CardDetail } from '@/lib/types';
import { cn, fullDate, relativeTime, shortDate } from '@/lib/format';
import { LABEL_COLORS, PRIORITY_META, boardRoleAtLeast } from '@shared/constants';
import { Avatar, Button, ColorSwatches, ConfirmDialog, InlineEdit, Popover, Select, Skeleton, usePopover, useToast, Field, Input } from '@/components/ui';
import { DatesEditor, LabelPicker, MemberPicker, MoveTargetPicker, PopoverTitle, PriorityPicker } from '../pickers';
import { DueBadge } from '../CardTile';
import { AddChecklistPanel, AddLinkPanel, AddRelationPanel, AssetLinkPanel, AssetsSection, AttachmentsSection, BugSection, ChecklistsSection, CustomFieldsSection, DescriptionSection, LinksSection, RelationsSection } from './CardSections';
import { CardActivity } from './CardActivity';

type PanelKind = 'members' | 'labels' | 'dates' | 'priority' | 'checklist' | 'cover' | 'move' | 'copy' | 'release' | 'recurrence' | 'link' | 'relation' | 'assets' | 'template' | 'milestone';

function SideButton({ icon, children, onClick, anchor, active, disabled }: { icon: ReactNode; children: ReactNode; onClick: () => void; anchor?: React.Ref<any>; active?: boolean; disabled?: boolean }) {
  return (
    <button ref={anchor} disabled={disabled} onClick={onClick} className={cn('flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium transition-colors focus-ring disabled:opacity-40', active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-fg hover:bg-surface-3')}>
      <span className="text-muted [&>svg]:size-3.5">{icon}</span>
      <span className="truncate">{children}</span>
    </button>
  );
}

export function CardModal({ cardId, board, onClose }: { cardId: string; board: BoardData; onClose: () => void }) {
  const q = useCard(cardId);
  const qc = useQueryClient();
  const toast = useToast();
  const [panel, setPanel] = useState<PanelKind | null>(null);
  const anchors = useRef<Record<string, HTMLElement | null>>({});
  const pop = usePopover();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pop.open && !document.querySelector('[role=dialog][aria-modal=true] [role=dialog]')) {
        const t = e.target as HTMLElement;
        if (t.closest('textarea,input') && (t as HTMLInputElement).value) return;
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const prev = document.activeElement as HTMLElement | null;
    window.setTimeout(() => dialogRef.current?.focus(), 10);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [onClose, pop.open]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['card', cardId] });
    qc.invalidateQueries({ queryKey: ['board', board.board.id] });
  };
  const open = (kind: PanelKind) => {
    pop.anchorRef.current = anchors.current[kind] ?? null;
    setPanel(kind);
    pop.setOpen(true);
  };
  const closePanel = () => {
    pop.close();
    setPanel(null);
  };
  const patch = async (body: Record<string, unknown>, msg?: string) => {
    try {
      await api.patch(`/cards/${cardId}`, body);
      if (msg) toast.success(msg);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    refresh();
  };

  const d = q.data;
  const canEdit = !!d && boardRoleAtLeast(d.role, 'member') && !board.board.archivedAt;
  const card = d?.card;

  const body = !d || !card ? (
    q.isError ? (
      <div className="p-10 text-center">
        <p className="font-medium">This card isn't available</p>
        <p className="mt-1 text-sm text-muted">It may have been deleted, moved to a board you can't access, or the link is wrong.</p>
        <Button className="mt-4" onClick={onClose}>
          Back to board
        </Button>
      </div>
    ) : (
      <div className="space-y-4 p-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  ) : (
    <>
      {(card.coverColor || (card.coverAttachmentId && board.coverUrls[card.coverAttachmentId])) && (
        <div className="relative overflow-hidden rounded-t-2xl" style={{ background: card.coverColor ?? '#0006' }}>
          {card.coverAttachmentId && board.coverUrls[card.coverAttachmentId] ? <img src={board.coverUrls[card.coverAttachmentId]} alt="" className="mx-auto max-h-56 object-contain" /> : <div className="h-20" />}
        </div>
      )}
      <div className="flex items-start gap-3 px-5 pt-5 pb-2 md:px-6">
        <button
          disabled={!canEdit}
          onClick={() => patch({ completed: !card.completedAt })}
          className={cn('mt-1 shrink-0 rounded-full focus-ring', card.completedAt ? 'text-success' : 'text-faint hover:text-fg')}
          aria-label={card.completedAt ? 'Mark incomplete' : 'Mark complete'}
          title={card.completedAt ? 'Mark incomplete' : 'Mark complete'}
        >
          {card.completedAt ? <CheckCircle2 className="size-5" /> : <Circle className="size-5" />}
        </button>
        <div className="min-w-0 flex-1">
          <InlineEdit
            value={card.title}
            disabled={!canEdit}
            multiline
            onSave={(title) => patch({ title, version: card.version })}
            className="w-full px-1 text-lg leading-snug font-semibold"
            inputClassName="text-lg font-semibold"
            ariaLabel="card title"
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[12px] text-muted">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(card.key);
                toast.success(`Copied ${card.key}`);
              }}
              className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-fg hover:bg-line-strong"
              title="Copy card key (use it in commit messages and PR titles)"
            >
              {card.key}
            </button>
            <span>
              in list{' '}
              <button ref={(el) => void (anchors.current.move = el)} disabled={!canEdit} onClick={() => open('move')} className="font-medium text-fg underline-offset-2 hover:underline">
                {card.listName}
              </button>
            </span>
            {card.type === 'bug' && (
              <span className="inline-flex items-center gap-1 text-danger">
                <Bug className="size-3" /> Bug
              </span>
            )}
            {card.archivedAt && <span className="rounded bg-warning-soft px-1.5 py-0.5 text-warning">Archived</span>}
            {card.blockedByCount > 0 && (
              <span className="inline-flex items-center gap-1 text-danger">
                <Lock className="size-3" /> Blocked
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close card">
          <X className="size-4" />
        </Button>
      </div>

      <div className="grid gap-6 px-5 pb-6 md:grid-cols-[1fr_188px] md:px-6">
        <div className="min-w-0 space-y-6">
          <Properties d={d} board={board} canEdit={canEdit} onOpen={open} anchors={anchors} />
          <DescriptionSection detail={d} board={board} canEdit={canEdit} onSaved={refresh} />
          <BugSection detail={d} canEdit={canEdit} onChanged={refresh} />
          <CustomFieldsSection detail={d} board={board} canEdit={canEdit} onChanged={refresh} />
          <ChecklistsSection detail={d} board={board} canEdit={canEdit} onChanged={refresh} />
          <AttachmentsSection detail={d} canEdit={canEdit} onChanged={refresh} uploadRef={uploadRef} />
          <LinksSection detail={d} canEdit={canEdit} onChanged={refresh} />
          <RelationsSection detail={d} canEdit={canEdit} onChanged={refresh} />
          <AssetsSection detail={d} />
          <CardActivity detail={d} board={board} onChanged={refresh} />
          <p className="pl-6 text-[11px] text-faint">
            Created {relativeTime(card.createdAt)}
            {d.creator ? ` by ${d.creator.displayName}` : ''} · updated <span title={fullDate(card.updatedAt)}>{relativeTime(card.updatedAt)}</span>
          </p>
        </div>

        <aside className="space-y-4" aria-label="Card actions">
          {canEdit && (
            <div className="space-y-1">
              <div className="pb-0.5 text-[11px] font-medium tracking-wide text-faint uppercase">Add to card</div>
              <SideButton icon={<Users />} anchor={(el: any) => void (anchors.current.members = el)} onClick={() => open('members')}>
                Members
              </SideButton>
              <SideButton icon={<Tag />} anchor={(el: any) => void (anchors.current.labels = el)} onClick={() => open('labels')}>
                Labels
              </SideButton>
              <SideButton icon={<CheckSquare />} anchor={(el: any) => void (anchors.current.checklist = el)} onClick={() => open('checklist')}>
                Checklist
              </SideButton>
              <SideButton icon={<CalendarDays />} anchor={(el: any) => void (anchors.current.dates = el)} onClick={() => open('dates')}>
                Dates
              </SideButton>
              <SideButton icon={<Flag />} anchor={(el: any) => void (anchors.current.priority = el)} onClick={() => open('priority')}>
                Priority
              </SideButton>
              <SideButton icon={<Paperclip />} onClick={() => uploadRef.current?.click()}>
                Attachment
              </SideButton>
              <SideButton icon={<ImageIcon />} anchor={(el: any) => void (anchors.current.cover = el)} onClick={() => open('cover')}>
                Cover
              </SideButton>
              <SideButton icon={<Link2 />} anchor={(el: any) => void (anchors.current.link = el)} onClick={() => open('link')}>
                Dev link
              </SideButton>
              <SideButton icon={<Lock />} anchor={(el: any) => void (anchors.current.relation = el)} onClick={() => open('relation')}>
                Dependency
              </SideButton>
              {board.customFields.length > 0 && (
                <SideButton icon={<SlidersHorizontal />} onClick={() => document.getElementById('custom-fields')?.scrollIntoView({ behavior: 'smooth' })}>
                  Custom fields
                </SideButton>
              )}
            </div>
          )}
          {canEdit && (
            <div className="space-y-1">
              <div className="pb-0.5 text-[11px] font-medium tracking-wide text-faint uppercase">Roblox & release</div>
              <SideButton icon={<Rocket />} anchor={(el: any) => void (anchors.current.release = el)} onClick={() => open('release')}>
                Release
              </SideButton>
              <SideButton icon={<Milestone />} anchor={(el: any) => void (anchors.current.milestone = el)} onClick={() => open('milestone')}>
                Milestone
              </SideButton>
              <SideButton icon={<Bug />} active={card.type === 'bug'} onClick={async () => {
                try {
                  await api.patch(`/cards/${cardId}/bug`, card.type === 'bug' ? { isBug: false } : {});
                } catch (e) {
                  toast.error(errorMessage(e));
                }
                refresh();
              }}>
                {card.type === 'bug' ? 'Convert to task' : 'Mark as bug'}
              </SideButton>
              <SideButton icon={<Package />} anchor={(el: any) => void (anchors.current.assets = el)} onClick={() => open('assets')}>
                Assets
              </SideButton>
            </div>
          )}
          <div className="space-y-1">
            <div className="pb-0.5 text-[11px] font-medium tracking-wide text-faint uppercase">Actions</div>
            <SideButton icon={d.watching ? <EyeOff /> : <Eye />} active={d.watching} onClick={async () => {
              await api.post(`/cards/${cardId}/watch`, { watching: !d.watching }).catch((e) => toast.error(errorMessage(e)));
              refresh();
            }}>
              {d.watching ? 'Watching' : 'Watch'}
            </SideButton>
            {board.board.settings.votingEnabled && (
              <SideButton icon={<ThumbsUp />} active={d.voted} onClick={async () => {
                await api.post(`/cards/${cardId}/vote`, { vote: !d.voted }).catch((e) => toast.error(errorMessage(e)));
                refresh();
              }}>
                {d.voted ? 'Voted' : 'Vote'} {d.voteCount > 0 && `(${d.voteCount})`}
              </SideButton>
            )}
            {canEdit && (
              <>
                <SideButton icon={<ArrowRightLeft />} anchor={(el: any) => void (anchors.current.moveSide = el)} onClick={() => ((anchors.current.move = anchors.current.moveSide), open('move'))}>
                  Move
                </SideButton>
                <SideButton icon={<Copy />} anchor={(el: any) => void (anchors.current.copy = el)} onClick={() => open('copy')}>
                  Copy
                </SideButton>
                <SideButton icon={<Repeat />} active={!!card.recurrence} anchor={(el: any) => void (anchors.current.recurrence = el)} onClick={() => open('recurrence')}>
                  {card.recurrence ? 'Recurring' : 'Make recurring'}
                </SideButton>
                <SideButton icon={<FileStack />} anchor={(el: any) => void (anchors.current.template = el)} onClick={() => open('template')}>
                  Save as template
                </SideButton>
              </>
            )}
            <SideButton icon={<Share2 />} onClick={() => {
              navigator.clipboard?.writeText(`${location.origin}/b/${board.board.id}/c/${cardId}`);
              toast.success('Link copied');
            }}>
              Copy link
            </SideButton>
            {canEdit && (
              <>
                {card.archivedAt ? (
                  <SideButton icon={<ArchiveRestore />} onClick={async () => {
                    await api.post(`/cards/${cardId}/archive`, { archived: false }).catch((e) => toast.error(errorMessage(e)));
                    refresh();
                  }}>
                    Restore
                  </SideButton>
                ) : (
                  <SideButton icon={<Archive />} onClick={async () => {
                    await api.post(`/cards/${cardId}/archive`, { archived: true }).catch((e) => toast.error(errorMessage(e)));
                    toast.success('Card archived', { label: 'Undo', onClick: () => api.post(`/cards/${cardId}/archive`, { archived: false }).then(refresh) });
                    refresh();
                  }}>
                    Archive
                  </SideButton>
                )}
                {card.archivedAt && (
                  <button onClick={() => setConfirmDelete(true)} className="flex h-8 w-full items-center gap-2 rounded-lg bg-danger-soft px-2.5 text-[13px] font-medium text-danger hover:opacity-90">
                    <Trash2 className="size-3.5" /> Delete
                  </button>
                )}
              </>
            )}
          </div>
        </aside>
      </div>

      <Popover open={pop.open} onClose={closePanel} anchor={pop.anchorRef} align="start" width={panel === 'move' || panel === 'copy' || panel === 'relation' ? 320 : 272}>
        {panel === 'members' && (
          <>
            <PopoverTitle onClose={closePanel}>Members</PopoverTitle>
            <MemberPicker board={board} selected={card.assigneeIds} onToggle={async (id) => {
              await (card.assigneeIds.includes(id) ? api.del(`/cards/${cardId}/assignees/${id}`) : api.post(`/cards/${cardId}/assignees`, { userId: id })).catch((e) => toast.error(errorMessage(e)));
              refresh();
            }} />
          </>
        )}
        {panel === 'labels' && (
          <>
            <PopoverTitle onClose={closePanel}>Labels</PopoverTitle>
            <LabelPicker board={board} selected={card.labelIds} canManage={canEdit} onToggle={async (id) => {
              await (card.labelIds.includes(id) ? api.del(`/cards/${cardId}/labels/${id}`) : api.post(`/cards/${cardId}/labels`, { labelId: id })).catch((e) => toast.error(errorMessage(e)));
              refresh();
            }} />
          </>
        )}
        {panel === 'dates' && (
          <>
            <PopoverTitle onClose={closePanel}>Dates</PopoverTitle>
            <DatesEditor startAt={card.startAt} dueAt={card.dueAt} reminderMinutes={card.reminderMinutes} onSave={(v) => patch(v)} onClose={closePanel} />
          </>
        )}
        {panel === 'priority' && (
          <>
            <PopoverTitle onClose={closePanel}>Priority</PopoverTitle>
            <PriorityPicker value={card.priority} onChange={(p) => (closePanel(), patch({ priority: p }))} />
          </>
        )}
        {panel === 'checklist' && (
          <>
            <PopoverTitle onClose={closePanel}>Add checklist</PopoverTitle>
            <AddChecklistPanel cardId={cardId} workspaceId={board.board.workspaceId} onDone={() => (closePanel(), refresh())} />
          </>
        )}
        {panel === 'cover' && (
          <div className="space-y-3 p-1">
            <PopoverTitle onClose={closePanel}>Cover</PopoverTitle>
            <ColorSwatches colors={LABEL_COLORS} value={card.coverColor} onChange={(c) => patch({ coverColor: c, coverAttachmentId: null })} size={28} />
            <p className="text-[11px] text-faint">To use an image, upload it as an attachment and choose “Make cover”.</p>
            {(card.coverColor || card.coverAttachmentId) && (
              <Button size="sm" className="w-full justify-center" onClick={() => (closePanel(), patch({ coverColor: null, coverAttachmentId: null }))}>
                Remove cover
              </Button>
            )}
          </div>
        )}
        {(panel === 'move' || panel === 'copy') && (
          <>
            <PopoverTitle onClose={closePanel}>{panel === 'move' ? 'Move card' : 'Copy card'}</PopoverTitle>
            <MoveTargetPicker board={board} card={card} mode={panel} onDone={refresh} onClose={closePanel} />
          </>
        )}
        {panel === 'release' && (
          <div className="p-1">
            <PopoverTitle onClose={closePanel}>Release</PopoverTitle>
            <Select value={card.releaseId ?? ''} onChange={(e) => (closePanel(), patch({ releaseId: e.target.value || null }))}>
              <option value="">No release</option>
              {board.releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} {r.version} · {r.status.replace('_', ' ')}
                </option>
              ))}
            </Select>
            {!board.releases.length && <p className="mt-2 text-[11px] text-faint">Create releases from the Releases page in the sidebar.</p>}
          </div>
        )}
        {panel === 'milestone' && (
          <div className="p-1">
            <PopoverTitle onClose={closePanel}>Milestone</PopoverTitle>
            <Select value={card.milestoneId ?? ''} onChange={(e) => (closePanel(), patch({ milestoneId: e.target.value || null }))}>
              <option value="">No milestone</option>
              {board.milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {shortDate(m.date)}
                </option>
              ))}
            </Select>
            {!board.milestones.length && <p className="mt-2 text-[11px] text-faint">Add milestones on a game project or release.</p>}
          </div>
        )}
        {panel === 'recurrence' && <RecurrencePanel d={d} onSave={(r) => (closePanel(), patch({ recurrence: r }, r ? 'Recurrence saved' : 'Recurrence removed'))} onClose={closePanel} />}
        {panel === 'link' && (
          <>
            <PopoverTitle onClose={closePanel}>Attach a link</PopoverTitle>
            <AddLinkPanel cardId={cardId} onDone={() => (closePanel(), refresh())} />
          </>
        )}
        {panel === 'relation' && (
          <>
            <PopoverTitle onClose={closePanel}>Add dependency or related card</PopoverTitle>
            <AddRelationPanel detail={d} onDone={() => (closePanel(), refresh())} />
          </>
        )}
        {panel === 'assets' && (
          <>
            <PopoverTitle onClose={closePanel}>Linked assets</PopoverTitle>
            <AssetLinkPanel detail={d} workspaceId={board.board.workspaceId} onDone={() => (closePanel(), refresh())} />
          </>
        )}
        {panel === 'template' && <SaveTemplatePanel cardId={cardId} title={card.title} onClose={closePanel} />}
      </Popover>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this card permanently?"
        description="All comments, checklists and attachments on the card will be deleted. This cannot be undone."
        danger
        confirmLabel="Delete card"
        onConfirm={async () => {
          setConfirmDelete(false);
          try {
            await api.del(`/cards/${cardId}`);
            toast.success('Card deleted');
            qc.invalidateQueries({ queryKey: ['board', board.board.id] });
            onClose();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      />
    </>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto" role="presentation">
      <div className="fixed inset-0 bg-[var(--overlay)] animate-fade-in" onClick={onClose} aria-hidden="true" />
      <div className="relative flex min-h-full items-start justify-center p-0 sm:p-4 md:py-[5vh]">
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={card ? `Card ${card.title}` : 'Card'} className="relative w-full max-w-[880px] rounded-none border-line bg-surface shadow-pop outline-none animate-pop-in sm:rounded-2xl sm:border">
          {body}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Properties({ d, board, canEdit, onOpen, anchors }: { d: CardDetail; board: BoardData; canEdit: boolean; onOpen: (k: PanelKind) => void; anchors: React.MutableRefObject<Record<string, HTMLElement | null>> }) {
  const card = d.card;
  const people = board.members.filter((m) => card.assigneeIds.includes(m.id));
  const labels = board.labels.filter((l) => card.labelIds.includes(l.id));
  const release = board.releases.find((r) => r.id === card.releaseId);
  const milestone = board.milestones.find((m) => m.id === card.milestoneId);
  const Prop = ({ label, children }: { label: string; children: ReactNode }) => (
    <div>
      <div className="mb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{label}</div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
  const AddBtn = ({ kind, label }: { kind: PanelKind; label: string }) =>
    canEdit ? (
      <button ref={(el) => void (anchors.current[`p-${kind}`] = el)} onClick={() => ((anchors.current[kind] = anchors.current[`p-${kind}`]), onOpen(kind))} aria-label={label} className="flex size-7 items-center justify-center rounded-full bg-surface-2 text-muted hover:bg-surface-3 hover:text-fg focus-ring">
        <Plus className="size-3.5" />
      </button>
    ) : null;
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-4 pl-6">
      <Prop label="Members">
        {people.map((p) => (
          <Avatar key={p.id} name={p.displayName} src={p.avatarUrl} size={28} title={`${p.displayName} (@${p.username})`} />
        ))}
        <AddBtn kind="members" label="Add member" />
      </Prop>
      <Prop label="Labels">
        {labels.map((l) => (
          <button key={l.id} disabled={!canEdit} onClick={() => ((anchors.current.labels = anchors.current['p-labels']), onOpen('labels'))} className="h-7 rounded-md px-2.5 text-[12px] font-semibold text-black/75" style={{ background: l.color }}>
            {l.name || ' '}
          </button>
        ))}
        <AddBtn kind="labels" label="Add label" />
      </Prop>
      <Prop label="Priority">
        <button ref={(el) => void (anchors.current['p-priority'] = el)} disabled={!canEdit} onClick={() => ((anchors.current.priority = anchors.current['p-priority']), onOpen('priority'))} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-[12px] font-medium hover:bg-surface-3">
          <span className="size-2 rounded-full" style={{ background: PRIORITY_META[card.priority].color }} />
          {PRIORITY_META[card.priority].label}
        </button>
      </Prop>
      {(card.startAt || card.dueAt) && (
        <Prop label="Dates">
          <button ref={(el) => void (anchors.current['p-dates'] = el)} disabled={!canEdit} onClick={() => ((anchors.current.dates = anchors.current['p-dates']), onOpen('dates'))} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-[12px] font-medium hover:bg-surface-3">
            {card.startAt && <span className="text-muted">{shortDate(card.startAt)} →</span>}
            {card.dueAt ? <DueBadge dueAt={card.dueAt} completedAt={card.completedAt} className="px-0" /> : <span>No due date</span>}
            {card.dueAt && <span className="text-faint">{new Date(card.dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
          </button>
        </Prop>
      )}
      {release && (
        <Prop label="Release">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-[12px] font-medium">
            <Rocket className="size-3 text-accent" />
            {release.name} {release.version}
          </span>
        </Prop>
      )}
      {milestone && (
        <Prop label="Milestone">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-[12px] font-medium">
            <Milestone className="size-3" />
            {milestone.name}
          </span>
        </Prop>
      )}
      {card.recurrence && (
        <Prop label="Repeats">
          <span className="inline-flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-[12px] font-medium">
            <Repeat className="size-3" />
            Every {card.recurrence.interval > 1 ? `${card.recurrence.interval} ` : ''}
            {card.recurrence.freq === 'daily' ? 'day' : card.recurrence.freq === 'weekly' ? 'week' : 'month'}
            {card.recurrence.interval > 1 ? 's' : ''} · next {shortDate(card.recurrence.nextAt)}
          </span>
        </Prop>
      )}
      {d.watcherCount > 0 && (
        <Prop label="Watchers">
          <span className="inline-flex h-7 items-center gap-1 text-[12px] text-muted">
            <Eye className="size-3.5" /> {d.watcherCount}
          </span>
        </Prop>
      )}
    </div>
  );
}

function RecurrencePanel({ d, onSave, onClose }: { d: CardDetail; onSave: (r: { freq: string; interval: number } | null) => void; onClose: () => void }) {
  const [freq, setFreq] = useState(d.card.recurrence?.freq ?? 'weekly');
  const [interval, setInterval] = useState(d.card.recurrence?.interval ?? 1);
  return (
    <div className="space-y-3 p-1.5">
      <PopoverTitle onClose={onClose}>Recurring card</PopoverTitle>
      <p className="text-[12px] text-muted">When the card comes due, Alypne creates a fresh copy (labels, members and checklists reset) in the same list with the next due date.</p>
      <div className="grid grid-cols-[80px_1fr] gap-2">
        <Field label="Every">
          <Input type="number" min={1} max={365} value={interval} onChange={(e) => setInterval(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label="Period">
          <Select value={freq} onChange={(e) => setFreq(e.target.value)}>
            <option value="daily">Day(s)</option>
            <option value="weekly">Week(s)</option>
            <option value="monthly">Month(s)</option>
          </Select>
        </Field>
      </div>
      {!d.card.dueAt && <p className="text-[11px] text-warning">Tip: set a due date first — the schedule starts from it.</p>}
      <div className="flex justify-between">
        {d.card.recurrence ? (
          <Button size="sm" variant="ghost" onClick={() => onSave(null)}>
            Stop repeating
          </Button>
        ) : (
          <span />
        )}
        <Button size="sm" variant="primary" onClick={() => onSave({ freq, interval })}>
          Save
        </Button>
      </div>
    </div>
  );
}

function SaveTemplatePanel({ cardId, title, onClose }: { cardId: string; title: string; onClose: () => void }) {
  const [name, setName] = useState(title);
  const toast = useToast();
  return (
    <form
      className="space-y-2 p-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post(`/cards/${cardId}/save-as-template`, { name });
          toast.success('Saved as a card template');
          onClose();
        } catch (err) {
          toast.error(errorMessage(err));
        }
      }}
    >
      <PopoverTitle onClose={onClose}>Save as card template</PopoverTitle>
      <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <p className="text-[11px] text-faint">Saves the description, priority, labels and checklists so new cards can start from it.</p>
      <Button type="submit" size="sm" variant="primary" className="w-full justify-center" disabled={!name.trim()}>
        Save template
      </Button>
    </form>
  );
}
