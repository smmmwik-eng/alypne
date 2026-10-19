import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation, useRouteError, isRouteErrorResponse, Link } from 'react-router-dom';
import { useMe } from './lib/hooks';
import { Button, FullPageSpinner } from './components/ui';
import { Logo } from './components/Logo';

const lazyPage = (load: () => Promise<any>, name: string) => lazy(() => load().then((m) => ({ default: m[name] })));

// Public
const Landing = lazyPage(() => import('./pages/marketing/Landing'), 'Landing');
const FeaturesPage = lazyPage(() => import('./pages/marketing/Features'), 'FeaturesPage');
const RobloxPage = lazyPage(() => import('./pages/marketing/RobloxPage'), 'RobloxPage');
const DocsPage = lazyPage(() => import('./pages/marketing/Docs'), 'DocsPage');
const AboutPage = lazyPage(() => import('./pages/marketing/Legal'), 'AboutPage');
const PrivacyPage = lazyPage(() => import('./pages/marketing/Legal'), 'PrivacyPage');
const TermsPage = lazyPage(() => import('./pages/marketing/Legal'), 'TermsPage');
const ContactPage = lazyPage(() => import('./pages/marketing/Legal'), 'ContactPage');
// Auth
const SignIn = lazyPage(() => import('./pages/auth/AuthPages'), 'SignIn');
const SignUp = lazyPage(() => import('./pages/auth/AuthPages'), 'SignUp');
const ForgotPassword = lazyPage(() => import('./pages/auth/AuthPages'), 'ForgotPassword');
const ResetPassword = lazyPage(() => import('./pages/auth/AuthPages'), 'ResetPassword');
const VerifyEmail = lazyPage(() => import('./pages/auth/AuthPages'), 'VerifyEmail');
const InvitePage = lazyPage(() => import('./pages/auth/AuthPages'), 'InvitePage');
// App
const AppLayout = lazyPage(() => import('./components/AppLayout'), 'AppLayout');
const HomeRedirect = lazyPage(() => import('./pages/app/Home'), 'HomeRedirect');
const Onboarding = lazyPage(() => import('./pages/app/Home'), 'Onboarding');
const InboxPage = lazyPage(() => import('./pages/app/Inbox'), 'InboxPage');
const NotificationsPage = lazyPage(() => import('./pages/app/Notifications'), 'NotificationsPage');
const SearchPage = lazyPage(() => import('./pages/app/Search'), 'SearchPage');
const SettingsPage = lazyPage(() => import('./pages/app/Settings'), 'SettingsPage');
const BoardPage = lazyPage(() => import('./pages/board/BoardPage'), 'BoardPage');
const WorkspaceBoards = lazyPage(() => import('./pages/workspace/WorkspaceBoards'), 'WorkspaceBoards');
const WorkspaceDashboard = lazyPage(() => import('./pages/workspace/Dashboard'), 'WorkspaceDashboard');
const MembersPage = lazyPage(() => import('./pages/workspace/Members'), 'MembersPage');
const WorkspaceSettings = lazyPage(() => import('./pages/workspace/WorkspaceSettings'), 'WorkspaceSettings');
const ProjectsPage = lazyPage(() => import('./pages/studio/Projects'), 'ProjectsPage');
const ProjectDetail = lazyPage(() => import('./pages/studio/Projects'), 'ProjectDetail');
const BugsPage = lazyPage(() => import('./pages/studio/Bugs'), 'BugsPage');
const ReleasesPage = lazyPage(() => import('./pages/studio/Releases'), 'ReleasesPage');
const ReleaseDetail = lazyPage(() => import('./pages/studio/Releases'), 'ReleaseDetail');
const AssetsPage = lazyPage(() => import('./pages/studio/Assets'), 'AssetsPage');
const TemplatesPage = lazyPage(() => import('./pages/workspace/Templates'), 'TemplatesPage');
const AutomationsPage = lazyPage(() => import('./pages/workspace/Automations'), 'AutomationsPage');
const IntegrationsPage = lazyPage(() => import('./pages/workspace/Integrations'), 'IntegrationsPage');
const ReportsPage = lazyPage(() => import('./pages/workspace/Reports'), 'ReportsPage');
const ActivityPage = lazyPage(() => import('./pages/workspace/Activity'), 'ActivityPage');
const ImportPage = lazyPage(() => import('./pages/workspace/Import'), 'ImportPage');

export { FullPageSpinner };

function S({ children }: { children: ReactNode }) {
  return <Suspense fallback={<FullPageSpinner />}>{children}</Suspense>;
}

function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <FullPageSpinner />;
  if (!me.data?.user) return <Navigate to={`/signin?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

/** Boards may be public: render the app shell when signed in, or a minimal shell for anonymous viewers. */
function MaybeAuth() {
  const me = useMe();
  if (me.isLoading) return <FullPageSpinner />;
  return <Outlet />;
}

function GuestOnly() {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <FullPageSpinner />;
  if (me.data?.user) {
    const next = new URLSearchParams(loc.search).get('next');
    return <Navigate to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/app'} replace />;
  }
  return <Outlet />;
}

function RouteError({ forceNotFound }: { forceNotFound?: boolean }) {
  const err = useRouteError();
  const notFound = forceNotFound || (isRouteErrorResponse(err) && err.status === 404);
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo size={28} />
      <h1 className="text-lg font-semibold">{notFound ? 'Page not found' : 'Something went wrong'}</h1>
      <p className="max-w-md text-sm text-muted">{notFound ? 'The page you were looking for does not exist or you do not have access to it.' : 'An unexpected error occurred while loading this page. Reloading usually fixes it.'}</p>
      <div className="flex gap-2">
        <Button onClick={() => location.reload()}>Reload</Button>
        <Link to="/app">
          <Button variant="primary">Go to Alypne</Button>
        </Link>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <S><Landing /></S> },
      { path: '/features', element: <S><FeaturesPage /></S> },
      { path: '/roblox', element: <S><RobloxPage /></S> },
      { path: '/docs', element: <S><DocsPage /></S> },
      { path: '/docs/:section', element: <S><DocsPage /></S> },
      { path: '/about', element: <S><AboutPage /></S> },
      { path: '/privacy', element: <S><PrivacyPage /></S> },
      { path: '/terms', element: <S><TermsPage /></S> },
      { path: '/contact', element: <S><ContactPage /></S> },
      { path: '/reset-password', element: <S><ResetPassword /></S> },
      { path: '/verify-email', element: <S><VerifyEmail /></S> },
      { path: '/invite/:token', element: <S><InvitePage /></S> },
      {
        element: <GuestOnly />,
        children: [
          { path: '/signin', element: <S><SignIn /></S> },
          { path: '/signup', element: <S><SignUp /></S> },
          { path: '/forgot-password', element: <S><ForgotPassword /></S> },
        ],
      },
      {
        element: <MaybeAuth />,
        children: [
          {
            element: <S><AppLayout /></S>,
            children: [
              { path: '/b/:boardId', element: <S><BoardPage /></S> },
              { path: '/b/:boardId/c/:cardId', element: <S><BoardPage /></S> },
            ],
          },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          { path: '/app/onboarding', element: <S><Onboarding /></S> },
          {
            element: <S><AppLayout /></S>,
            children: [
              { path: '/app', element: <S><HomeRedirect /></S> },
              { path: '/app/inbox', element: <S><InboxPage /></S> },
              { path: '/app/notifications', element: <S><NotificationsPage /></S> },
              { path: '/app/search', element: <S><SearchPage /></S> },
              { path: '/app/settings', element: <Navigate to="/app/settings/profile" replace /> },
              { path: '/app/settings/:tab', element: <S><SettingsPage /></S> },
              { path: '/w/:wsId', element: <S><WorkspaceBoards /></S> },
              { path: '/w/:wsId/dashboard', element: <S><WorkspaceDashboard /></S> },
              { path: '/w/:wsId/members', element: <S><MembersPage /></S> },
              { path: '/w/:wsId/settings', element: <S><WorkspaceSettings /></S> },
              { path: '/w/:wsId/projects', element: <S><ProjectsPage /></S> },
              { path: '/w/:wsId/projects/:projectId', element: <S><ProjectDetail /></S> },
              { path: '/w/:wsId/bugs', element: <S><BugsPage /></S> },
              { path: '/w/:wsId/releases', element: <S><ReleasesPage /></S> },
              { path: '/w/:wsId/releases/:releaseId', element: <S><ReleaseDetail /></S> },
              { path: '/w/:wsId/assets', element: <S><AssetsPage /></S> },
              { path: '/w/:wsId/templates', element: <S><TemplatesPage /></S> },
              { path: '/w/:wsId/automations', element: <S><AutomationsPage /></S> },
              { path: '/w/:wsId/integrations', element: <S><IntegrationsPage /></S> },
              { path: '/w/:wsId/reports', element: <S><ReportsPage /></S> },
              { path: '/w/:wsId/activity', element: <S><ActivityPage /></S> },
              { path: '/w/:wsId/import', element: <S><ImportPage /></S> },
            ],
          },
        ],
      },
      { path: '*', element: <RouteError forceNotFound /> },
    ],
  },
]);
