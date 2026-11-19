import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { projectsApi, tasksApi } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { useProjectOptions } from '@/hooks/useCommon';
import { getErrorMessage } from '@/lib/api';
import { TASK_PRIORITY, TASK_STATUS, TASK_TYPE, options } from '@/lib/labels';
import type { TaskPriority, TaskStatus, TaskType } from '@/types/api';

export const TaskFormModal = ({
  open,
  onClose,
  defaultProjectId,
  websiteId,
}: {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string;
  websiteId?: string;
}) => {
  const qc = useQueryClient();
  const projects = useProjectOptions(websiteId);
  const empty = {
    projectId: defaultProjectId ?? '',
    title: '',
    description: '',
    type: 'BUG' as TaskType,
    priority: '' as TaskPriority | '',
    status: 'OPEN' as TaskStatus,
    assigneeId: '',
    dueDate: '',
    pageUrl: '',
  };
  const [form, setForm] = useState(empty);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const screenshotPreview = useMemo(() => (screenshot ? URL.createObjectURL(screenshot) : null), [screenshot]);
  useEffect(() => () => void (screenshotPreview && URL.revokeObjectURL(screenshotPreview)), [screenshotPreview]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setForm({ ...empty, projectId: defaultProjectId ?? '' });
      setScreenshot(null);
      setFiles([]);
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultProjectId]);

  // Your role in the chosen project: reporters (Website Users / reviewers) set the content;
  // status, assignee and due date belong to the team, so those fields are only shown to it.
  const project = useQuery({
    queryKey: ['projects', form.projectId],
    queryFn: () => projectsApi.get(form.projectId),
    enabled: Boolean(form.projectId),
  });
  const canManage = !form.projectId || !project.data || project.data.role === 'MANAGER' || project.data.role === 'CONTRIBUTOR';

  const members = useQuery({
    queryKey: ['projects', form.projectId, 'members'],
    queryFn: () => projectsApi.members(form.projectId),
    enabled: Boolean(form.projectId) && canManage,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const task = await tasksApi.create({
        projectId: form.projectId,
        title: form.title,
        description: form.description || undefined,
        type: form.type,
        priority: form.priority || undefined,
        status: canManage ? form.status : undefined,
        assigneeId: (canManage && form.assigneeId) || undefined,
        dueDate: canManage && form.dueDate ? new Date(`${form.dueDate}T23:59:59`).toISOString() : undefined,
        pageUrl: form.pageUrl || undefined,
      });
      // Then the files (task first, so a failed upload never loses the task).
      const failed: string[] = [];
      for (const [file, kind] of [...(screenshot ? [[screenshot, 'screenshot'] as const] : []), ...files.map((f) => [f, 'file'] as const)]) {
        await tasksApi.upload(task.id, file, kind).catch(() => failed.push(file.name));
      }
      return { task, failed };
    },
    onSuccess: ({ task, failed }) => {
      ['tasks', 'dashboard', 'projects', 'websites'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(`Task created — ${task.key}`);
      if (failed.length) toast.error(`Could not upload: ${failed.join(', ')}`);
      // Clear now too: if the dialog is reopened in the same render as it closes, the
      // reset-on-open effect wouldn't run and the next task would inherit these values.
      setForm({ ...empty, projectId: defaultProjectId ?? '' });
      setScreenshot(null);
      setFiles([]);
      onClose();
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.projectId) return setError('Choose a project');
    setError('');
    mutation.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New task"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="task-form" loading={mutation.isPending}>Create task</Button>
        </>
      }
    >
      <form id="task-form" onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Select
          label="Project"
          required
          className="sm:col-span-2"
          value={form.projectId}
          onChange={(e) => setForm({ ...form, projectId: e.target.value, assigneeId: '' })}
          placeholder={projects.isLoading ? 'Loading…' : 'Select a project'}
          options={(projects.data ?? []).map((p) => ({ value: p.id, label: `${p.name} — ${p.website?.name ?? ''}` }))}
        />
        <div className="sm:col-span-2">
          <Input label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Header logo is blurry on retina screens" />
        </div>
        <div className="sm:col-span-2">
          <Textarea label="Description" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <Select label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as TaskType })} options={options(TASK_TYPE)} />
        <Select
          label="Priority"
          value={form.priority}
          onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}
          placeholder="Website default"
          options={options(TASK_PRIORITY)}
        />
        {canManage && (
          <>
            <Select label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })} options={options(TASK_STATUS)} />
            <Select
              label="Assignee"
              value={form.assigneeId}
              disabled={!form.projectId}
              onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
              placeholder="Unassigned"
              options={(members.data ?? []).map((m) => ({ value: m.user.id, label: m.user.name }))}
            />
            <Input label="Due date" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </>
        )}
        <Input label="Page URL" type="url" value={form.pageUrl} onChange={(e) => setForm({ ...form, pageUrl: e.target.value })} placeholder="https://…" />
        <div>
          <label className="label" htmlFor="task-screenshot">Screenshot</label>
          <input id="task-screenshot" type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="block w-full text-sm" onChange={(e) => setScreenshot(e.target.files?.[0] ?? null)} />
          {screenshotPreview && <img src={screenshotPreview} alt="Screenshot preview" className="mt-2 max-h-32 rounded-lg border border-slate-200" />}
        </div>
        <div>
          <label className="label" htmlFor="task-files">Additional files</label>
          <input id="task-files" type="file" multiple className="block w-full text-sm" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
          <p className="mt-1 text-xs text-slate-500">Images, PDF, ZIP, Office documents or text, up to 10 MB each.</p>
        </div>
        {error && <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2">{error}</p>}
      </form>
    </Modal>
  );
};
