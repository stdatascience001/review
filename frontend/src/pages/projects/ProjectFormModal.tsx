import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { projectsApi, teamApi } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Display';
import { Input, Select, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { useWebsiteOptions } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { PROJECT_STATUS, WEBSITE_ROLE_LABEL, options } from '@/lib/labels';
import { toDateInput } from '@/lib/utils';
import type { Project, ProjectStatus } from '@/types/api';

export const ProjectFormModal = ({
  open,
  onClose,
  project,
  defaultWebsiteId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project?: Project | null;
  defaultWebsiteId?: string;
  onSaved?: (p: Project) => void;
}) => {
  const qc = useQueryClient();
  const websites = useWebsiteOptions();
  // Only websites where the user may create projects
  const creatable = (websites.data ?? []).filter((w) => w.role && ['OWNER', 'ADMIN', 'PROJECT_MANAGER'].includes(w.role));
  const [form, setForm] = useState({
    websiteId: '',
    name: '',
    description: '',
    status: 'ACTIVE' as ProjectStatus,
    startDate: '',
    dueDate: '',
    memberIds: [] as string[],
  });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setForm({
      websiteId: project?.websiteId ?? defaultWebsiteId ?? '',
      name: project?.name ?? '',
      description: project?.description ?? '',
      status: project?.status ?? 'ACTIVE',
      startDate: toDateInput(project?.startDate),
      dueDate: toDateInput(project?.dueDate),
      memberIds: [],
    });
  }, [open, project, defaultWebsiteId]);

  const team = useQuery({
    queryKey: ['team', form.websiteId, 'members'],
    queryFn: () => teamApi.members(form.websiteId),
    enabled: Boolean(form.websiteId) && !project,
  });

  const mutation = useMutation({
    mutationFn: () => {
      const common = {
        name: form.name,
        description: form.description.trim() || (project ? null : undefined),
        status: form.status,
        startDate: form.startDate || (project ? null : undefined),
        dueDate: form.dueDate || (project ? null : undefined),
      };
      return project
        ? projectsApi.update(project.id, common)
        : projectsApi.create({ ...common, websiteId: form.websiteId, memberIds: form.memberIds });
    },
    onSuccess: (p) => {
      ['projects', 'dashboard', 'websites', 'team'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(project ? 'Project updated' : 'Project created');
      onSaved?.(p);
      onClose();
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!project && !form.websiteId) return setError('Choose a website');
    if (form.startDate && form.dueDate && form.dueDate < form.startDate) return setError('Deadline must be on or after the start date');
    mutation.mutate();
  };

  const toggleMember = (id: string) =>
    setForm((f) => ({ ...f, memberIds: f.memberIds.includes(id) ? f.memberIds.filter((m) => m !== id) : [...f.memberIds, id] }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={project ? 'Edit project' : 'Create project'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="project-form" loading={mutation.isPending}>{project ? 'Save changes' : 'Create project'}</Button>
        </>
      }
    >
      <form id="project-form" onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Website"
          required
          className="sm:col-span-2"
          disabled={Boolean(project)}
          hint={project ? 'A project cannot be moved to another website' : creatable.length === 0 && !websites.isLoading ? 'You need Admin or Project Manager access to a website to create projects' : undefined}
          value={form.websiteId}
          onChange={(e) => setForm({ ...form, websiteId: e.target.value, memberIds: [] })}
          placeholder="Select a website"
          options={(project ? websites.data ?? [] : creatable).map((w) => ({ value: w.id, label: w.name }))}
        />
        <div className="sm:col-span-2">
          <Input label="Project name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Homepage redesign QA" />
        </div>
        <div className="sm:col-span-2">
          <Textarea label="Description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <Input label="Start date" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        <Input label="Deadline" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
        <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as ProjectStatus })} options={options(PROJECT_STATUS)} />

        {!project && form.websiteId && (
          <fieldset className="sm:col-span-2">
            <legend className="label">Assign team members</legend>
            {team.isLoading ? (
              <p className="text-sm text-slate-400">Loading team…</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                {(team.data ?? []).map((m) => (
                  <label key={m.user.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-slate-50">
                    <input type="checkbox" className="rounded border-slate-300" checked={form.memberIds.includes(m.user.id)} onChange={() => toggleMember(m.user.id)} />
                    <Avatar user={m.user} size="xs" />
                    <span className="flex-1 text-sm">{m.user.name}</span>
                    <span className="text-xs text-slate-500">{WEBSITE_ROLE_LABEL[m.role]}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-slate-500">You are added as project manager automatically.</p>
          </fieldset>
        )}
        {error && <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
};
