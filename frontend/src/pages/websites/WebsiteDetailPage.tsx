import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  Code2,
  Copy,
  ExternalLink,
  FolderKanban,
  Globe,
  KeyRound,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { projectsApi, websitesApi } from '@/api/resources';
import { TaskTable } from '@/components/tasks/TaskTable';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, ProgressBar, Skeleton } from '@/components/ui/Display';
import { Input, Select, Toggle } from '@/components/ui/Form';
import { useConfirm } from '@/components/ui/Modal';
import { getErrorMessage } from '@/lib/api';
import { PROJECT_STATUS, TASK_PRIORITY, WEBSITE_ROLE_LABEL, options } from '@/lib/labels';
import { cn, copyToClipboard, formatDate, formatDateTime } from '@/lib/utils';
import type { TaskPriority, VerifyDomainResult, WebsiteDetail } from '@/types/api';
import { AuditLogView } from '@/pages/AuditLogPage';
import { InstallGuide } from './InstallGuide';
import { WebsiteFormModal } from './WebsiteFormModal';
import { WebsiteLogo, canManageWebsite } from './WebsitesPage';

const CopyBlock = ({ label, value, testId }: { label: string; value: string; testId?: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          icon={copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
          onClick={async () => {
            if (await copyToClipboard(value)) {
              setCopied(true);
              toast.success(`${label} copied to clipboard`);
              setTimeout(() => setCopied(false), 2000);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre data-testid={testId} className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">
        {value}
      </pre>
    </div>
  );
};

const OverviewTab = ({ website }: { website: WebsiteDetail }) => {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const manage = canManageWebsite(website);
  const [result, setResult] = useState<VerifyDomainResult | null>(null);

  const regenerate = useMutation({
    mutationFn: () => websitesApi.regenerateSiteId(website.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['websites'] });
      toast.success('New Site ID generated. Update the embed script on your website.');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const verify = useMutation({
    mutationFn: () => websitesApi.verifyDomain(website.id),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ['websites'] });
      r.verified ? toast.success('Domain verified') : toast.error('Verification failed');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <section className="card p-5">
          <div className="mb-4 flex items-center gap-2">
            <Code2 className="h-5 w-5 text-brand-600" />
            <h2 className="font-semibold">Embed script</h2>
          </div>
          <p className="mb-4 text-sm text-slate-600">
            Add this snippet before the closing <code className="rounded bg-slate-100 px-1">&lt;/body&gt;</code> tag on every page where you want to collect
            feedback. It loads the Review button asynchronously and never blocks your page.
          </p>
          <CopyBlock label="Embed script" value={website.embedScript} testId="embed-script" />
          <InstallGuide embedScript={website.embedScript} siteId={website.siteId} />
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3">
            <div className="flex items-center gap-3">
              <KeyRound className="h-4 w-4 text-slate-400" />
              <div>
                <p className="text-xs text-slate-500">Site ID</p>
                <p className="font-mono text-sm" data-testid="site-id">{website.siteId}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={async () => (await copyToClipboard(website.siteId)) && toast.success('Site ID copied')}>
                Copy
              </Button>
              {manage && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={regenerate.isPending}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  onClick={async () =>
                    (await confirm({
                      title: 'Generate a new Site ID?',
                      message: 'The current embed script will stop working until you replace it with the new one on your website.',
                      confirmLabel: 'Generate new ID',
                      danger: true,
                    })) && regenerate.mutate()
                  }
                >
                  Regenerate
                </Button>
              )}
            </div>
          </div>
        </section>

        {manage && website.verification && (
          <section className="card p-5">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-5 w-5 text-brand-600" />
                <h2 className="font-semibold">Domain verification</h2>
              </div>
              {website.domainVerifiedAt ? (
                <Badge tone="green"><BadgeCheck className="h-3.5 w-3.5" /> Verified {formatDate(website.domainVerifiedAt)}</Badge>
              ) : (
                <Badge tone="amber">Not verified</Badge>
              )}
            </div>
            <p className="mb-4 text-sm text-slate-600">
              Prove you own <strong>{new URL(website.url).host}</strong>: add this meta tag to your home page's <code className="rounded bg-slate-100 px-1">&lt;head&gt;</code>{' '}
              <em>or</em> install the embed script above, then click Verify.
            </p>
            <CopyBlock label="Verification meta tag" value={website.verification.metaTag} testId="verification-meta" />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button loading={verify.isPending} icon={<ShieldCheck className="h-4 w-4" />} onClick={() => verify.mutate()}>
                Verify domain
              </Button>
              {result && (
                <div
                  role="status"
                  className={cn('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', result.verified ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700')}
                >
                  {result.verified ? <Check className="mt-0.5 h-4 w-4" /> : <X className="mt-0.5 h-4 w-4" />}
                  <span>
                    {result.verified
                      ? `Verified via ${result.method === 'meta_tag' ? 'meta tag' : 'embed script'} on ${result.checkedUrl}`
                      : `${result.error ?? 'Not verified'} (checked ${result.checkedUrl})`}
                  </span>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      <section className="card h-fit p-5">
        <h2 className="mb-4 font-semibold">Details</h2>
        <dl className="space-y-3 text-sm">
          {[
            ['Website URL', <a key="u" href={website.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 break-all text-brand-700 hover:underline">{website.url} <ExternalLink className="h-3 w-3 shrink-0" /></a>],
            ['Status', <Badge key="s" tone={website.status === 'ACTIVE' ? 'green' : 'gray'} dot>{website.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>],
            ['Your role', website.role ? WEBSITE_ROLE_LABEL[website.role] : '—'],
            ['Team members', website._count?.members ?? 0],
            ['Projects', website._count?.projects ?? 0],
            ['Tasks', website._count?.tasks ?? 0],
            ['Created', formatDateTime(website.createdAt)],
          ].map(([k, v]) => (
            <div key={k as string} className="flex items-start justify-between gap-4">
              <dt className="shrink-0 text-slate-500">{k}</dt>
              <dd className="text-right font-medium text-slate-800">{v}</dd>
            </div>
          ))}
        </dl>
        {website.description && <p className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-600">{website.description}</p>}
      </section>
    </div>
  );
};

const ProjectsTab = ({ website }: { website: WebsiteDetail }) => {
  const { data, isLoading } = useQuery({
    queryKey: ['projects', 'list', { websiteId: website.id }],
    queryFn: () => projectsApi.list({ websiteId: website.id, pageSize: 100 }),
  });
  if (isLoading) return <Skeleton className="h-40" />;
  if (!data?.items.length)
    return (
      <div className="card">
        <EmptyState icon={FolderKanban} title="No projects in this website" action={<Link to={`/projects?new=1&websiteId=${website.id}`}><Button icon={<Plus className="h-4 w-4" />}>Create project</Button></Link>} />
      </div>
    );
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {data.items.map((p) => (
        <Link key={p.id} to={`/projects/${p.id}`} className="card p-5 transition hover:border-brand-200 hover:shadow-md">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium">{p.name}</h3>
            <Badge tone={PROJECT_STATUS[p.status].tone}>{PROJECT_STATUS[p.status].label}</Badge>
          </div>
          <div className="mt-4 flex justify-between text-xs text-slate-500">
            <span>{p.progress?.completed ?? 0}/{p.progress?.total ?? 0} tasks</span>
            <span>{p.progress?.percent ?? 0}%</span>
          </div>
          <ProgressBar percent={p.progress?.percent ?? 0} className="mt-1.5" />
        </Link>
      ))}
    </div>
  );
};

const SettingsTab = ({ website }: { website: WebsiteDetail }) => {
  const qc = useQueryClient();
  const manage = canManageWebsite(website);
  const s = website.settings;
  const [domains, setDomains] = useState<string[]>(s?.allowedDomains ?? []);
  const [newDomain, setNewDomain] = useState('');
  const [form, setForm] = useState({
    timezone: s?.timezone ?? 'UTC',
    defaultTaskPriority: (s?.defaultTaskPriority ?? 'MEDIUM') as TaskPriority,
    clientsCanCreateTasks: s?.clientsCanCreateTasks ?? true,
    emailNotifications: s?.emailNotifications ?? true,
    brandColor: s?.brandColor ?? '',
    widgetEnabled: s?.widgetEnabled ?? true,
    widgetProjectId: s?.widgetProjectId ?? '',
    widgetAutoJoin: s?.widgetAutoJoin ?? true,
  });
  const widgetProjects = useQuery({
    queryKey: ['projects', 'list', { websiteId: website.id, status: 'ACTIVE' }],
    queryFn: () => projectsApi.list({ websiteId: website.id, pageSize: 100 }),
  });

  useEffect(() => setDomains(s?.allowedDomains ?? []), [s?.allowedDomains]);

  const save = useMutation({
    // Each save sends the full domain list: run them one at a time, in order.
    scope: { id: `website-settings-${website.id}` },
    mutationFn: (body: Parameters<typeof websitesApi.updateSettings>[1]) => websitesApi.updateSettings(website.id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['websites', 'detail', website.id] });
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const addDomain = () => {
    const d = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!d) return;
    if (!/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$|^localhost$/.test(d)) return toast.error('Enter a valid domain like example.com or *.example.com');
    if (domains.includes(d)) return toast.error('Domain already added');
    const next = [...domains, d];
    setDomains(next);
    setNewDomain('');
    save.mutate({ allowedDomains: next });
  };

  const timezones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['UTC'];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <section className="card p-5">
        <h2 className="font-semibold">Allowed domains</h2>
        <p className="mb-4 mt-1 text-sm text-slate-600">
          The embed widget only loads on these domains (plus <strong>{new URL(website.url).host}</strong>). Use <code>*.example.com</code> for subdomains.
        </p>
        {manage && (
          <div className="mb-4 flex gap-2">
            <input
              className="input"
              aria-label="New allowed domain"
              placeholder="staging.example.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDomain())}
            />
            <Button onClick={addDomain} icon={<Plus className="h-4 w-4" />} loading={save.isPending}>Add</Button>
          </div>
        )}
        {domains.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">No extra domains configured</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="allowed-domains">
            {domains.map((d) => (
              <li key={d} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="font-mono">{d}</span>
                {manage && (
                  <button
                    type="button"
                    aria-label={`Remove ${d}`}
                    disabled={save.isPending}
                    className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    onClick={() => {
                      const next = domains.filter((x) => x !== d);
                      setDomains(next);
                      save.mutate({ allowedDomains: next });
                    }}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-4 font-semibold">Task settings</h2>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ ...form, brandColor: form.brandColor || null, widgetProjectId: form.widgetProjectId || null });
          }}
        >
          <Select label="Timezone" disabled={!manage} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} options={timezones.map((t) => ({ value: t, label: t }))} />
          <Select
            label="Default task priority"
            disabled={!manage}
            value={form.defaultTaskPriority}
            onChange={(e) => setForm({ ...form, defaultTaskPriority: e.target.value as TaskPriority })}
            options={options(TASK_PRIORITY)}
          />
          <Input label="Brand color" disabled={!manage} placeholder="#4F46E5" value={form.brandColor} onChange={(e) => setForm({ ...form, brandColor: e.target.value })} hint="Hex color used by the feedback widget" />
          <Toggle disabled={!manage} label="Website users can create tasks" description="Clients/reviewers may submit new feedback" checked={form.clientsCanCreateTasks} onChange={(v) => setForm({ ...form, clientsCanCreateTasks: v })} />
          <Toggle
            disabled={!manage}
            label="Auto-add widget sign-ins as Website Users"
            description="Anyone who signs in through this website's review widget joins it (and its feedback project) and can report. They only ever see their own tasks. Off: invite-only."
            checked={form.widgetAutoJoin}
            onChange={(v) => setForm({ ...form, widgetAutoJoin: v })}
          />
          <Toggle disabled={!manage} label="Email notifications" checked={form.emailNotifications} onChange={(v) => setForm({ ...form, emailNotifications: v })} />
          <div className="border-t border-slate-100 pt-4">
            <h3 className="mb-3 text-sm font-semibold">Review widget</h3>
            <div className="space-y-4">
              <Toggle
                disabled={!manage}
                label="Review widget enabled"
                description="Show the Review button on your website (uses the embed script)"
                checked={form.widgetEnabled}
                onChange={(v) => setForm({ ...form, widgetEnabled: v })}
              />
              <Select
                label="Project for widget feedback"
                disabled={!manage}
                value={form.widgetProjectId}
                onChange={(e) => setForm({ ...form, widgetProjectId: e.target.value })}
                placeholder="Automatic (first active project)"
                hint="New comments from the widget go here when the reviewer is a member of it"
                options={(widgetProjects.data?.items ?? []).filter((p) => p.status === 'ACTIVE').map((p) => ({ value: p.id, label: p.name }))}
              />
            </div>
          </div>
          {manage && <Button type="submit" loading={save.isPending}>Save settings</Button>}
        </form>
      </section>
    </div>
  );
};

const TABS = [
  { key: 'overview', label: 'Overview & embed' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'projects', label: 'Projects' },
  { key: 'settings', label: 'Settings' },
  { key: 'audit', label: 'Audit log' },
] as const;

export const WebsiteDetailPage = () => {
  const { websiteId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'overview') as (typeof TABS)[number]['key'];
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);

  const { data: website, isLoading, isError, error } = useQuery({
    queryKey: ['websites', 'detail', websiteId],
    queryFn: () => websitesApi.get(websiteId),
  });

  const toggle = useMutation({
    mutationFn: () => websitesApi.update(websiteId, { status: website!.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
    onSuccess: (w) => {
      qc.invalidateQueries({ queryKey: ['websites'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(w.status === 'ACTIVE' ? 'Website activated' : 'Website deactivated');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const remove = useMutation({
    mutationFn: () => websitesApi.remove(websiteId),
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success('Website deleted');
      navigate('/websites', { replace: true });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-16 w-1/2" /><Skeleton className="h-64" /></div>;
  if (isError || !website)
    return <div className="card"><EmptyState icon={AlertTriangle} title="Website not found" description={getErrorMessage(error)} action={<Link to="/websites"><Button>Back to websites</Button></Link>} /></div>;

  const manage = canManageWebsite(website);

  return (
    <div>
      <Link to="/websites" className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> Websites
      </Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <WebsiteLogo website={website} size="lg" />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{website.name}</h1>
              <Badge tone={website.status === 'ACTIVE' ? 'green' : 'gray'} dot>{website.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>
              {website.domainVerifiedAt && <Badge tone="indigo"><BadgeCheck className="h-3.5 w-3.5" /> Verified</Badge>}
            </div>
            <a href={website.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm text-slate-500 hover:text-brand-700">
              <Globe className="h-3.5 w-3.5" /> {website.url}
            </a>
          </div>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditOpen(true)}>Edit</Button>
            <Button
              variant="secondary"
              loading={toggle.isPending}
              icon={<Power className="h-4 w-4" />}
              onClick={async () =>
                (await confirm({
                  title: website.status === 'ACTIVE' ? 'Deactivate website?' : 'Activate website?',
                  message: website.status === 'ACTIVE' ? 'No new tasks can be created while the website is inactive.' : 'The website will accept new tasks again.',
                  confirmLabel: website.status === 'ACTIVE' ? 'Deactivate' : 'Activate',
                  danger: website.status === 'ACTIVE',
                })) && toggle.mutate()
              }
            >
              {website.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
            </Button>
            {website.role === 'OWNER' && (
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={async () =>
                  (await confirm({ title: 'Delete website?', message: `${website.name} and all its projects, tasks and comments will be permanently deleted.`, confirmLabel: 'Delete website', danger: true })) &&
                  remove.mutate()
                }
              >
                Delete
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {TABS.filter((t) => t.key !== 'audit' || canManageWebsite(website)).map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium',
              tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab website={website} />}
      {tab === 'tasks' && <TaskTable fixed={{ websiteId }} emptyTitle="No tasks for this website yet" />}
      {tab === 'projects' && <ProjectsTab website={website} />}
      {tab === 'settings' && <SettingsTab website={website} />}
      {tab === 'audit' && canManageWebsite(website) && <AuditLogView websiteId={website.id} />}

      <WebsiteFormModal open={editOpen} onClose={() => setEditOpen(false)} website={website} />
    </div>
  );
};
