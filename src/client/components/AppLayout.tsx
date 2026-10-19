import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Bug,
  CalendarClock,
  ChevronsUpDown,
  FolderKanban,
  Gamepad2,
  Home,
  Inbox,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Package,
  Plug,
  Plus,
  Rocket,
  Search,
  Settings,
  Star,
  Sun,
  Users,
  Workflow,
  X,
  Activity as ActivityIcon,
  BarChart3,
  FileStack,
  Upload,
  Clock,
  Keyboard,
  Check,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useMe, useUnreadCount, useWorkspaces } from '@/lib/hooks';
import { useUserRealtime } from '@/lib/realtime';
import { useTheme } from '@/lib/theme';
import { cn, modKey } from '@/lib/format';
import { Avatar, Button, DropdownMenu, MenuItem, MenuLabel, MenuSeparator, Kbd, Modal } from './ui';
import { Logo, LogoMark } from './Logo';
import { CommandPalette } from './CommandPalette';
import { NotificationsPopover } from './NotificationsPopover';
import { CreateWorkspaceDialog, CreateBoardDialog } from './CreateDialogs';
import { BOARD_BACKGROUNDS } from '@shared/constants';

/* ------------------------------------------------- current workspace */

const WsCtx = createContext<{ workspaceId: string | null; setWorkspaceId: (id: string | null) => void }>({ workspaceId: null, setWorkspaceId: () => {} });
export const useCurrentWorkspace = () => useContext(WsCtx);

/** Pages call this so the sidebar follows the workspace being viewed. */
export function useSyncWorkspace(id: string | undefined | null) {
  const { setWorkspaceId } = useCurrentWorkspace();
  useEffect(() => {
    if (id) setWorkspaceId(id);
  }, [id, setWorkspaceId]);
}

export function boardBackground(bg: string): string {
  return BOARD_BACKGROUNDS[bg]?.css ?? (bg.startsWith('#') ? bg : BOARD_BACKGROUNDS.slate.css);
}

/* --------------------------------------------------------------- shell */

export function AppLayout() {
  const me = useMe();
  const user = me.data?.user ?? null;
  const [workspaceId, setWs] = useState<string | null>(() => {
    try {
      return localStorage.getItem('alypne-ws');
    } catch {
      return null;
    }
  });
  const setWorkspaceId = useMemo(
    () => (id: string | null) => {
      setWs(id);
      try {
        if (id) localStorage.setItem('alypne-ws', id);
      } catch {
        /* ignore */
      }
    },
    [],
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const loc = useLocation();
  useUserRealtime(!!user);
  useEffect(() => setMobileOpen(false), [loc.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.closest('input,textarea,select,[contenteditable=true]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (!typing && e.key === '?' && !e.metaKey && !e.ctrlKey) {
        setShortcutsOpen(true);
      } else if (!typing && e.key === '/' && user) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [user]);

  if (!user) {
    // Anonymous viewer of a public board.
    return (
      <div className="min-h-screen bg-canvas">
        <header className="flex h-12 items-center justify-between border-b border-line px-4">
          <Link to="/" aria-label="Alypne home">
            <Logo size={22} />
          </Link>
          <div className="flex gap-2">
            <Link to={`/signin?next=${encodeURIComponent(loc.pathname)}`}>
              <Button size="sm" variant="ghost">
                Sign in
              </Button>
            </Link>
            <Link to="/signup">
              <Button size="sm" variant="primary">
                Get started
              </Button>
            </Link>
          </div>
        </header>
        <Outlet />
      </div>
    );
  }

  return (
    <WsCtx.Provider value={{ workspaceId, setWorkspaceId }}>
      <div className="flex h-dvh overflow-hidden bg-canvas">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[90] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2">
          Skip to content
        </a>
        <aside className="hidden w-[252px] shrink-0 border-r border-line bg-sidebar md:flex md:flex-col">
          <Sidebar onSearch={() => setPaletteOpen(true)} />
        </aside>
        {mobileOpen && (
          <div className="fixed inset-0 z-40 md:hidden">
            <div className="absolute inset-0 bg-[var(--overlay)] animate-fade-in" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-line bg-sidebar animate-slide-up">
              <button className="absolute top-3 right-3 rounded-md p-1 text-muted hover:text-fg" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                <X className="size-4" />
              </button>
              <Sidebar onSearch={() => setPaletteOpen(true)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onMenu={() => setMobileOpen(true)} onSearch={() => setPaletteOpen(true)} onShortcuts={() => setShortcutsOpen(true)} />
          <main id="main" className="min-h-0 flex-1 overflow-auto">
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </WsCtx.Provider>
  );
}

/* ------------------------------------------------------------ sidebar */

function NavItem({ to, icon, children, end, badge }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean; badge?: number }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn('group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors focus-ring', isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg')
      }
    >
      <span className="flex size-4 items-center justify-center [&>svg]:size-4">{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {!!badge && <span className="rounded-full bg-accent px-1.5 text-[10px] leading-4 font-semibold text-accent-fg">{badge > 99 ? '99+' : badge}</span>}
    </NavLink>
  );
}

function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { workspaceId, setWorkspaceId } = useCurrentWorkspace();
  const workspaces = useWorkspaces();
  const navigate = useNavigate();
  const [createWs, setCreateWs] = useState(false);
  const [createBoard, setCreateBoard] = useState(false);
  const list = workspaces.data ?? [];
  const current = list.find((w) => w.id === workspaceId) ?? list[0];
  useEffect(() => {
    if (current && current.id !== workspaceId) setWorkspaceId(current.id);
  }, [current, workspaceId, setWorkspaceId]);
  const favorites = useQuery({ queryKey: ['favorites'], queryFn: () => api.get<{ boards: any[] }>('/me/favorites').then((r) => r.boards) });
  const recent = useQuery({ queryKey: ['recent'], queryFn: () => api.get<{ boards: any[] }>('/me/recent').then((r) => r.boards) });
  const unread = useUnreadCount(true);
  const ws = current?.id;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center px-3">
        <Link to="/app" aria-label="Alypne home" className="rounded-md focus-ring">
          <Logo size={22} />
        </Link>
      </div>
      <div className="px-3 pb-2">
        <DropdownMenu
          align="start"
          width={240}
          trigger={(p) => (
            <button {...p} className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-surface-2 focus-ring">
              {current ? <WorkspaceIcon name={current.name} color={current.color} logo={current.logoUrl} /> : <LogoMark size={22} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{current?.name ?? 'No workspace'}</span>
                <span className="block truncate text-[11px] text-faint capitalize">{current ? `${current.role} · ${current.memberCount} member${current.memberCount === 1 ? '' : 's'}` : 'Create one to start'}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-faint" />
            </button>
          )}
        >
          <MenuLabel>Workspaces</MenuLabel>
          {list.map((w) => (
            <MenuItem
              key={w.id}
              icon={<WorkspaceIcon name={w.name} color={w.color} logo={w.logoUrl} size={16} />}
              onClick={() => {
                setWorkspaceId(w.id);
                navigate(`/w/${w.id}`);
              }}
              active={w.id === current?.id}
            >
              <span className="flex items-center justify-between gap-2">
                {w.name}
                {w.id === current?.id && <Check className="size-3.5 text-accent" />}
              </span>
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon={<Plus />} onClick={() => setCreateWs(true)}>
            Create workspace
          </MenuItem>
        </DropdownMenu>
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-3 pb-4" aria-label="Main">
        <div className="space-y-0.5">
          <button onClick={onSearch} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2/60 hover:text-fg focus-ring">
            <Search className="size-4" />
            <span className="flex-1 text-left">Search</span>
            <Kbd>{modKey}K</Kbd>
          </button>
          <NavItem to="/app/inbox" icon={<Inbox />}>
            My tasks
          </NavItem>
          <NavItem to="/app/notifications" icon={<Bell />} badge={unread.data}>
            Notifications
          </NavItem>
        </div>
        {ws && (
          <div className="space-y-0.5">
            <div className="flex items-center justify-between px-2.5 pb-1">
              <span className="text-[11px] font-medium tracking-wide text-faint uppercase">Workspace</span>
              {current.role !== 'viewer' && (
                <button onClick={() => setCreateBoard(true)} className="rounded p-0.5 text-faint hover:bg-surface-2 hover:text-fg focus-ring" aria-label="Create board" title="Create board">
                  <Plus className="size-3.5" />
                </button>
              )}
            </div>
            <NavItem to={`/w/${ws}/dashboard`} icon={<Home />}>
              Dashboard
            </NavItem>
            <NavItem to={`/w/${ws}`} icon={<LayoutGrid />} end>
              Boards
            </NavItem>
            <NavItem to={`/w/${ws}/projects`} icon={<Gamepad2 />}>
              Game projects
            </NavItem>
            <NavItem to={`/w/${ws}/bugs`} icon={<Bug />}>
              Bug tracker
            </NavItem>
            <NavItem to={`/w/${ws}/releases`} icon={<Rocket />}>
              Releases
            </NavItem>
            <NavItem to={`/w/${ws}/assets`} icon={<Package />}>
              Assets
            </NavItem>
            <NavItem to={`/w/${ws}/reports`} icon={<BarChart3 />}>
              Reports
            </NavItem>
          </div>
        )}
        {ws && (
          <div className="space-y-0.5">
            <div className="px-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">Manage</div>
            <NavItem to={`/w/${ws}/templates`} icon={<FileStack />}>
              Templates
            </NavItem>
            <NavItem to={`/w/${ws}/automations`} icon={<Workflow />}>
              Automations
            </NavItem>
            <NavItem to={`/w/${ws}/integrations`} icon={<Plug />}>
              Integrations
            </NavItem>
            <NavItem to={`/w/${ws}/import`} icon={<Upload />}>
              Import & export
            </NavItem>
            <NavItem to={`/w/${ws}/activity`} icon={<ActivityIcon />}>
              Activity
            </NavItem>
            <NavItem to={`/w/${ws}/members`} icon={<Users />}>
              Members
            </NavItem>
            <NavItem to={`/w/${ws}/settings`} icon={<Settings />}>
              Settings
            </NavItem>
          </div>
        )}
        {!!favorites.data?.length && (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
              <Star className="size-3" /> Favourites
            </div>
            {favorites.data.map((b) => (
              <BoardLink key={b.id} board={b} />
            ))}
          </div>
        )}
        {!!recent.data?.length && (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
              <Clock className="size-3" /> Recent
            </div>
            {recent.data.slice(0, 5).map((b) => (
              <BoardLink key={b.id} board={b} />
            ))}
          </div>
        )}
      </nav>
      <UserMenu />
      <CreateWorkspaceDialog open={createWs} onClose={() => setCreateWs(false)} />
      {ws && <CreateBoardDialog open={createBoard} onClose={() => setCreateBoard(false)} workspaceId={ws} />}
    </div>
  );
}

function BoardLink({ board }: { board: { id: string; name: string; background: string } }) {
  return (
    <NavLink
      to={`/b/${board.id}`}
      className={({ isActive }) => cn('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors focus-ring', isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}
    >
      <span className="size-3.5 shrink-0 rounded border border-white/10" style={{ background: boardBackground(board.background) }} />
      <span className="truncate">{board.name}</span>
    </NavLink>
  );
}

export function WorkspaceIcon({ name, color, logo, size = 22 }: { name: string; color: string; logo?: string | null; size?: number }) {
  if (logo) return <img src={logo} alt="" className="shrink-0 rounded-md object-cover" style={{ width: size, height: size }} />;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-md font-semibold text-white" style={{ width: size, height: size, background: color, fontSize: size * 0.48 }}>
      {name.trim()[0]?.toUpperCase() ?? 'W'}
    </span>
  );
}

function UserMenu() {
  const me = useMe();
  const user = me.data?.user;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pref, setPref, resolved } = useTheme();
  if (!user) return null;
  const signOut = async () => {
    await api.post('/auth/signout').catch(() => undefined);
    qc.clear();
    navigate('/signin');
  };
  return (
    <div className="border-t border-line p-3">
      <DropdownMenu
        align="start"
        width={232}
        trigger={(p) => (
          <button {...p} className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-surface-2 focus-ring">
            <Avatar name={user.displayName} src={user.avatarUrl} size={28} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{user.displayName}</span>
              <span className="block truncate text-[11px] text-faint">@{user.username}</span>
            </span>
          </button>
        )}
      >
        <MenuItem icon={<Settings />} onClick={() => navigate('/app/settings/profile')}>
          Settings
        </MenuItem>
        <MenuItem icon={<Gamepad2 />} onClick={() => navigate('/app/settings/connections')}>
          Connected accounts
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        {(['dark', 'light', 'system'] as const).map((t) => (
          <MenuItem
            key={t}
            icon={t === 'dark' ? <Moon /> : t === 'light' ? <Sun /> : resolved === 'dark' ? <Moon /> : <Sun />}
            onClick={() => {
              setPref(t);
              api.patch('/me', { theme: t }).catch(() => undefined);
            }}
            active={pref === t}
          >
            <span className="capitalize">{t}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<LogOut />} onClick={signOut}>
          Sign out
        </MenuItem>
      </DropdownMenu>
    </div>
  );
}

/* ------------------------------------------------------------- top bar */

function TopBar({ onMenu, onSearch, onShortcuts }: { onMenu: () => void; onSearch: () => void; onShortcuts: () => void }) {
  const { workspaceId } = useCurrentWorkspace();
  const [createBoard, setCreateBoard] = useState(false);
  const [createWs, setCreateWs] = useState(false);
  const navigate = useNavigate();
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:px-4">
      <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={onMenu} aria-label="Open menu">
        <Menu className="size-4" />
      </Button>
      <Link to="/app" className="md:hidden" aria-label="Alypne home">
        <LogoMark size={22} />
      </Link>
      <button onClick={onSearch} className="ml-1 flex h-8 max-w-sm flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-faint transition-colors hover:border-line-strong hover:text-muted focus-ring md:ml-0">
        <Search className="size-3.5" />
        <span className="flex-1 truncate text-left">Search cards, boards, releases…</span>
        <span className="hidden sm:inline">
          <Kbd>{modKey}K</Kbd>
        </span>
      </button>
      <div className="ml-auto flex items-center gap-1">
        <DropdownMenu
          trigger={(p) => (
            <Button {...p} variant="primary" size="sm" icon={<Plus className="size-4" />} aria-label="Create">
              <span className="hidden sm:inline">Create</span>
            </Button>
          )}
        >
          {workspaceId && (
            <MenuItem icon={<FolderKanban />} onClick={() => setCreateBoard(true)}>
              Board
            </MenuItem>
          )}
          {workspaceId && (
            <MenuItem icon={<Gamepad2 />} onClick={() => navigate(`/w/${workspaceId}/projects?new=1`)}>
              Game project
            </MenuItem>
          )}
          {workspaceId && (
            <MenuItem icon={<Rocket />} onClick={() => navigate(`/w/${workspaceId}/releases?new=1`)}>
              Release
            </MenuItem>
          )}
          {workspaceId && (
            <MenuItem icon={<CalendarClock />} onClick={() => navigate(`/w/${workspaceId}/templates`)}>
              From template
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Users />} onClick={() => setCreateWs(true)}>
            Workspace
          </MenuItem>
        </DropdownMenu>
        <NotificationsPopover />
        <Button variant="ghost" size="icon-sm" onClick={onShortcuts} aria-label="Keyboard shortcuts" className="hidden sm:inline-flex">
          <Keyboard className="size-4" />
        </Button>
      </div>
      {workspaceId && <CreateBoardDialog open={createBoard} onClose={() => setCreateBoard(false)} workspaceId={workspaceId} />}
      <CreateWorkspaceDialog open={createWs} onClose={() => setCreateWs(false)} />
    </header>
  );
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups: [string, [string, string][]][] = [
    ['Anywhere', [[`${modKey} K`, 'Open command palette / search'], ['/', 'Search'], ['?', 'Show shortcuts']]],
    ['On a board', [['N', 'Add a card to the first list'], ['F', 'Toggle filters'], ['Q', 'Only my cards'], ['1 – 4', 'Switch view: board, table, calendar, timeline'], ['Esc', 'Close panel / clear filters']]],
    ['On a card', [['Enter / Space', 'Open the focused card'], ['Esc', 'Close the card'], ['Space (drag handle)', 'Pick up a card with the keyboard, arrows to move, Space to drop']]],
  ];
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <div className="space-y-5">
        {groups.map(([g, items]) => (
          <div key={g}>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-faint uppercase">{g}</h3>
            <div className="divide-y divide-line rounded-lg border border-line">
              {items.map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                  <span className="text-muted">{d}</span>
                  <span className="flex gap-1">
                    {k.split(' ').map((x) => (
                      <Kbd key={x}>{x}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
