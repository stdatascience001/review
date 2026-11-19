import { FileQuestion } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
import { Link, Route, Routes } from 'react-router';
import { GuestRoute, ProtectedRoute, RequireRole } from '@/components/auth/Guards';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Display';
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from '@/pages/auth/AccountPages';
import { LoginPage } from '@/pages/auth/LoginPage';

// Route-level code splitting: each page is its own chunk, fetched on first visit.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const DashboardPage = page(() => import('@/pages/DashboardPage'), 'DashboardPage');
const AnalyticsPage = page(() => import('@/pages/AnalyticsPage'), 'AnalyticsPage');
const AuditLogPage = page(() => import('@/pages/AuditLogPage'), 'AuditLogPage');
const AllTasksPage = page(() => import('@/pages/OtherPages'), 'AllTasksPage');
const MyTasksPage = page(() => import('@/pages/OtherPages'), 'MyTasksPage');
const CommentsPage = page(() => import('@/pages/OtherPages'), 'CommentsPage');
const NotificationsPage = page(() => import('@/pages/OtherPages'), 'NotificationsPage');
const SettingsPage = page(() => import('@/pages/OtherPages'), 'SettingsPage');
const UsersPage = page(() => import('@/pages/OtherPages'), 'UsersPage');
const ProjectDetailPage = page(() => import('@/pages/projects/ProjectDetailPage'), 'ProjectDetailPage');
const ProjectsPage = page(() => import('@/pages/projects/ProjectsPage'), 'ProjectsPage');
const TaskDetailPage = page(() => import('@/pages/tasks/TaskDetailPage'), 'TaskDetailPage');
const TeamPage = page(() => import('@/pages/team/TeamPage'), 'TeamPage');
const WebsiteDetailPage = page(() => import('@/pages/websites/WebsiteDetailPage'), 'WebsiteDetailPage');
const WebsitesPage = page(() => import('@/pages/websites/WebsitesPage'), 'WebsitesPage');

const NotFound = () => (
  <EmptyState
    icon={FileQuestion}
    title="Page not found"
    description="The page you're looking for doesn't exist."
    action={<Link to="/"><Button>Go to dashboard</Button></Link>}
    className="min-h-[60vh]"
  />
);

export const App = () => (
  <Routes>
    {/* Signed-out only */}
    <Route element={<GuestRoute />}>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
    </Route>

    {/* Public (token links from emails) */}
    <Route path="/reset-password" element={<ResetPasswordPage />} />
    <Route path="/verify-email" element={<VerifyEmailPage />} />
    <Route path="/accept-invite" element={<AcceptInvitePage />} />

    {/* Authenticated dashboard */}
    <Route element={<ProtectedRoute />}>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="audit-log" element={<RequireRole roles={['SUPER_ADMIN']}><AuditLogPage /></RequireRole>} />
        <Route path="websites" element={<WebsitesPage />} />
        <Route path="websites/:websiteId" element={<WebsiteDetailPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="tasks" element={<AllTasksPage />} />
        <Route path="tasks/mine" element={<MyTasksPage />} />
        <Route path="tasks/:taskId" element={<TaskDetailPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="comments" element={<CommentsPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Route>
  </Routes>
);
