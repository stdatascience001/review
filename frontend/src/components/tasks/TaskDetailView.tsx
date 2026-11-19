import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Download,
  ExternalLink,
  Eye,
  FileText,
  ImagePlus,
  MessageSquare,
  Paperclip,
  Pencil,
  Play,
  Reply,
  RotateCcw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { commentsApi, tasksApi, type TaskInput } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Avatar, Badge, Skeleton } from '@/components/ui/Display';
import { Select, Textarea } from '@/components/ui/Form';
import { Modal, useConfirm } from '@/components/ui/Modal';
import { useAuth } from '@/hooks/useAuth';
import { getErrorMessage } from '@/lib/api';
import { TASK_PRIORITY, TASK_STATUS, TASK_TYPE, options } from '@/lib/labels';
import { cn, formatDateTime, isOverdue, timeAgo, toDateInput } from '@/lib/utils';
import type { Comment, TaskActivity, TaskAttachment, TaskDetail, TaskStatus } from '@/types/api';

const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const isImage = (a: TaskAttachment) => a.mimeType.startsWith('image/');

/** Workflow progress: Open → In progress → Under review → Completed. */
const STEPS: { status: TaskStatus; label: string }[] = [
  { status: 'OPEN', label: 'Open' },
  { status: 'IN_PROGRESS', label: 'In progress' },
  { status: 'IN_REVIEW', label: 'Under review' },
  { status: 'COMPLETED', label: 'Completed' },
];
const stepIndex = (s: TaskStatus) => (s === 'REOPENED' ? 0 : STEPS.findIndex((x) => x.status === s));

export const TaskProgress = ({ status }: { status: TaskStatus }) => {
  const current = stepIndex(status);
  return (
    <ol className="flex items-center gap-1" aria-label="Task progress" data-testid="task-progress">
      {STEPS.map((s, i) => {
        const done = status !== 'ARCHIVED' && i <= current;
        const label = i === 0 && status === 'REOPENED' ? 'Reopened' : s.label;
        return (
          <li key={s.status} className="flex flex-1 items-center gap-1" aria-current={i === current ? 'step' : undefined}>
            <div className="flex-1">
              <div className={cn('h-1.5 rounded-full', done ? (status === 'COMPLETED' ? 'bg-emerald-500' : 'bg-brand-500') : 'bg-slate-200')} />
              <div className={cn('mt-1 text-[11px]', i === current ? 'font-semibold text-slate-900' : 'text-slate-400')}>{label}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

// ───────────────────────────── Activity history ─────────────────────────────

const valueLabel = (field: string | null | undefined, v: string | null | undefined) => {
  if (!v) return '—';
  if (field === 'status' && v in TASK_STATUS) return TASK_STATUS[v as TaskStatus].label;
  if (field === 'priority' && v in TASK_PRIORITY) return TASK_PRIORITY[v as keyof typeof TASK_PRIORITY].label;
  if (field === 'type' && v in TASK_TYPE) return TASK_TYPE[v as keyof typeof TASK_TYPE];
  return v;
};

export const describeActivity = (a: TaskActivity): ReactNode => {
  const ch = (a.changes ?? {}) as Record<string, { from?: string | null; to?: string | null } | string>;
  const assignee = ch.assignee as { from?: string | null; to?: string | null } | undefined;
  const fromTo = (
    <>
      {' '}from <strong>{valueLabel(a.field, a.previousValue)}</strong> to <strong>{valueLabel(a.field, a.newValue)}</strong>
    </>
  );
  switch (a.type) {
    case 'CREATED':
      return <>created the task {a.newValue && <span className="font-mono">{a.newValue}</span>}</>;
    case 'ASSIGNED':
      return <>assigned the task to <strong>{assignee?.to ?? 'someone'}</strong></>;
    case 'UNASSIGNED':
      return <>unassigned <strong>{assignee?.from ?? 'the developer'}</strong></>;
    case 'STARTED':
      return <>started the task</>;
    case 'COMPLETED':
      return <>completed the task</>;
    case 'REOPENED':
      return <>reopened the task</>;
    case 'ARCHIVED':
      return <>archived the task</>;
    case 'RESTORED':
      return <>restored the task to <strong>{valueLabel('status', a.newValue)}</strong></>;
    case 'STATUS_CHANGED':
      return <>changed the status{fromTo}</>;
    case 'PRIORITY_CHANGED':
      return <>changed the priority{fromTo}</>;
    case 'UPDATED':
      return a.field ? <>changed the {a.field}{a.field === 'description' ? '' : fromTo}</> : <>updated {Object.keys(ch).join(', ')}</>;
    case 'COMMENTED':
      return <>commented: <span className="text-slate-500">“{(a.newValue ?? '').slice(0, 120)}”</span></>;
    case 'COMMENT_EDITED':
      return <>edited a comment</>;
    case 'COMMENT_DELETED':
      return <>deleted a comment</>;
    case 'ATTACHMENT_ADDED':
      return <>added {a.field === 'screenshot' ? 'a screenshot' : 'a file'} <strong>{a.newValue}</strong></>;
    case 'ATTACHMENT_REMOVED':
      return <>removed <strong>{a.previousValue}</strong></>;
    default:
      return <>{a.type.replace(/_/g, ' ').toLowerCase()}</>;
  }
};

// ───────────────────────────── Attachments ─────────────────────────────

const Lightbox = ({ image, onClose }: { image: TaskAttachment | null; onClose: () => void }) => (
  <Modal open={Boolean(image)} onClose={onClose} title={image?.fileName ?? 'Screenshot'} size="xl">
    {image && (
      <div className="space-y-3">
        <img src={image.url} alt={image.fileName} className="max-h-[70vh] w-full rounded-lg border border-slate-200 object-contain" />
        <a href={image.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline">
          Open original <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    )}
  </Modal>
);

const AttachmentList = ({
  items,
  onPreview,
  onDelete,
  canDelete,
  testId,
}: {
  items: TaskAttachment[];
  onPreview: (a: TaskAttachment) => void;
  onDelete?: (a: TaskAttachment) => void;
  canDelete?: (a: TaskAttachment) => boolean;
  testId?: string;
}) => {
  if (!items.length) return null;
  const images = items.filter(isImage);
  const files = items.filter((a) => !isImage(a));
  return (
    <div className="space-y-2" data-testid={testId}>
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {images.map((a) => (
            <div key={a.id} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
              <button type="button" className="block w-full" onClick={() => onPreview(a)} aria-label={`Preview ${a.fileName}`}>
                <img src={a.url} alt={a.fileName} className="h-28 w-full object-cover object-top" loading="lazy" />
              </button>
              <div className="flex items-center justify-between gap-1 px-2 py-1 text-[11px] text-slate-500">
                <span className="truncate">{a.kind === 'SCREENSHOT' ? 'Screenshot' : a.fileName}</span>
                {onDelete && canDelete?.(a) && (
                  <button type="button" aria-label={`Remove ${a.fileName}`} className="text-slate-400 hover:text-red-600" onClick={() => onDelete(a)}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {files.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <FileText className="h-4 w-4 shrink-0 text-slate-400" />
          <a href={a.url} className="min-w-0 flex-1 truncate text-brand-700 hover:underline" download={a.fileName}>
            {a.fileName}
          </a>
          <span className="text-xs text-slate-400">{formatSize(a.sizeBytes)}</span>
          <a href={a.url} download={a.fileName} aria-label={`Download ${a.fileName}`} className="text-slate-400 hover:text-slate-700">
            <Download className="h-3.5 w-3.5" />
          </a>
          {onDelete && canDelete?.(a) && (
            <button type="button" aria-label={`Remove ${a.fileName}`} className="text-slate-400 hover:text-red-600" onClick={() => onDelete(a)}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
};

// ───────────────────────────── Comment composer ─────────────────────────────

const Composer = ({
  label,
  placeholder,
  submitLabel,
  busy,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string, files: File[]) => Promise<boolean>;
  onCancel?: () => void;
}) => {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((p) => p && URL.revokeObjectURL(p)), [previews]);

  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        if (await onSubmit(body.trim(), files)) {
          setBody('');
          setFiles([]);
        }
      }}
    >
      <Textarea aria-label={label} rows={2} className="min-h-0" value={body} autoFocus={autoFocus} onChange={(e) => setBody(e.target.value)} placeholder={placeholder} />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 py-1 pl-1 pr-2 text-xs">
              {previews[i] ? <img src={previews[i]!} alt="" className="h-8 w-8 rounded object-cover" /> : <FileText className="h-4 w-4 text-slate-400" />}
              <span className="max-w-[10rem] truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          aria-label={label === 'Write a reply' ? 'Attach files to reply' : 'Attach files'}
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <Button type="button" variant="ghost" size="sm" icon={<Paperclip className="h-3.5 w-3.5" />} onClick={() => fileInput.current?.click()}>
          Attach
        </Button>
        <div className="flex-1" />
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" loading={busy} disabled={!body.trim()} icon={<Send className="h-3.5 w-3.5" />} aria-label={submitLabel}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};

// ───────────────────────────── Main view ─────────────────────────────

/**
 * Complete task detail (Task ID, website, project, title, description, screenshots, files,
 * reporter, assignee, priority, status, comments with replies, activity history) with the
 * actions the current user is allowed to take. Used by the task modal and the /tasks/:id page.
 */
export const TaskDetailView = ({ taskId, onDeleted, onLoaded }: { taskId: string; onDeleted?: () => void; onLoaded?: (t: TaskDetail) => void }) => {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const [preview, setPreview] = useState<TaskAttachment | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [editingTask, setEditingTask] = useState<{ title: string; description: string } | null>(null);
  const shotInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const task = useQuery({ queryKey: ['tasks', 'detail', taskId], queryFn: () => tasksApi.get(taskId) });
  const t = task.data;
  useEffect(() => {
    if (t) onLoaded?.(t);
  }, [t, onLoaded]);
  const comments = useQuery({ queryKey: ['tasks', 'comments', taskId], queryFn: () => tasksApi.comments(taskId) });
  const activity = useQuery({ queryKey: ['tasks', 'activity', taskId], queryFn: () => tasksApi.activity(taskId), enabled: tab === 'activity' });
  const assignees = useQuery({ queryKey: ['tasks', 'assignees', taskId], queryFn: () => tasksApi.assignees(taskId), enabled: Boolean(t?.permissions.manage) });

  // Opening the task marks its comments as read (the "New" badges stay for this visit).
  const markedRead = useRef(false);
  useEffect(() => {
    if (!comments.data || markedRead.current) return;
    markedRead.current = true;
    tasksApi
      .markRead(taskId)
      .then(() => qc.invalidateQueries({ queryKey: ['tasks', 'list'] }))
      .catch(() => undefined);
  }, [comments.data, taskId, qc]);

  const refresh = () => {
    ['dashboard', 'projects', 'comments', 'notifications'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    qc.invalidateQueries({ queryKey: ['tasks'], predicate: (q) => q.queryKey[2] !== taskId || q.queryKey[1] !== 'comments' });
  };
  const refreshComments = () => qc.invalidateQueries({ queryKey: ['tasks', 'comments', taskId] });

  const update = useMutation({
    mutationFn: (body: Partial<TaskInput>) => tasksApi.update(taskId, body),
    onSuccess: () => {
      refresh();
      toast.success('Task updated');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const restore = useMutation({
    mutationFn: () => tasksApi.restore(taskId),
    onSuccess: () => {
      refresh();
      toast.success('Task restored');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const removeTask = useMutation({
    mutationFn: () => tasksApi.remove(taskId),
    onSuccess: () => {
      refresh();
      toast.success('Task deleted');
      onDeleted?.();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const upload = useMutation({
    mutationFn: async ({ files, kind, commentId }: { files: File[]; kind: 'screenshot' | 'file'; commentId?: string }) => {
      const failed: string[] = [];
      for (const f of files) {
        await tasksApi
          .upload(taskId, f, kind === 'screenshot' || !f.type.startsWith('image/') ? kind : 'screenshot', commentId)
          .catch((err) => failed.push(`${f.name}: ${getErrorMessage(err)}`));
      }
      return failed;
    },
    onSuccess: (failed, vars) => {
      refresh();
      if (vars.commentId) refreshComments();
      if (failed.length) toast.error(failed.join('\n'));
      else if (!vars.commentId) toast.success(vars.files.length > 1 ? `${vars.files.length} files uploaded` : 'File uploaded');
    },
  });

  const removeAttachment = useMutation({
    mutationFn: (a: TaskAttachment) => tasksApi.removeAttachment(taskId, a.id),
    onSuccess: () => {
      refresh();
      refreshComments();
      toast.success('File removed');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const addComment = useMutation({
    mutationFn: async ({ body, files, parentId }: { body: string; files: File[]; parentId?: string }) => {
      const c = await tasksApi.addComment(taskId, body, parentId);
      for (const f of files) await tasksApi.upload(taskId, f, f.type.startsWith('image/') ? 'screenshot' : 'file', c.id).catch(() => undefined);
      return c;
    },
    onSuccess: () => {
      setReplyTo(null);
      refresh();
      refreshComments();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const editComment = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => commentsApi.update(id, body),
    onSuccess: () => {
      setEditing(null);
      refreshComments();
      toast.success('Comment updated');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const removeComment = useMutation({
    mutationFn: (id: string) => commentsApi.remove(id),
    onSuccess: () => {
      refresh();
      refreshComments();
      toast.success('Comment deleted');
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  if (task.isLoading || !t) {
    return task.isError ? (
      <p className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{getErrorMessage(task.error)}</p>
    ) : (
      <div className="space-y-3">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const manage = t.permissions.manage;
  const setStatus = async (status: TaskStatus) => {
    if (status === t.status) return;
    if (status === 'ARCHIVED') {
      const ok = await confirm({
        title: `Archive ${t.key}?`,
        message: 'Archived tasks are hidden from task lists and the review widget. You can restore it later.',
        confirmLabel: 'Archive task',
      });
      if (!ok) return;
    }
    if (status === 'COMPLETED') {
      const ok = await confirm({ title: `Mark ${t.key} as completed?`, message: 'The reporter will be notified.', confirmLabel: 'Mark completed' });
      if (!ok) return;
    }
    update.mutate({ status });
  };
  const screenshots = t.attachments.filter((a) => !a.commentId);
  const roots = (comments.data?.items ?? []).filter((c) => !c.parentId);
  const repliesOf = (id: string) => (comments.data?.items ?? []).filter((c) => c.parentId === id);
  const canDeleteFile = (a: TaskAttachment) => a.uploader?.id === user?.id || (manage && t.permissions.delete);
  const deleteFile = async (a: TaskAttachment) =>
    (await confirm({ title: 'Remove file?', message: `${a.fileName} will be permanently deleted.`, danger: true, confirmLabel: 'Remove' })) &&
    removeAttachment.mutate(a);

  const CommentItem = ({ c, reply }: { c: Comment; reply?: boolean }) => {
    const own = c.author?.id === user?.id;
    const isEditing = editing?.id === c.id;
    return (
      <li className={cn('flex gap-3', reply && 'ml-10')} data-testid="comment" data-new={c.isNew || undefined}>
        <Avatar user={c.author} size="sm" />
        <div className={cn('min-w-0 flex-1 rounded-lg px-3 py-2', c.isNew ? 'bg-brand-50 ring-1 ring-brand-200' : 'bg-slate-50')}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="font-medium text-slate-800">{c.author?.name ?? 'Deleted user'}</span>
            <time dateTime={c.createdAt} title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</time>
            {c.editedAt && <span title={formatDateTime(c.editedAt)}>(edited)</span>}
            {c.isNew && <Badge tone="indigo">New</Badge>}
            <span className="flex-1" />
            {!reply && t.permissions.comment && (
              <button type="button" className="flex items-center gap-1 hover:text-slate-800" onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>
                <Reply className="h-3.5 w-3.5" /> Reply
              </button>
            )}
            {own && !isEditing && (
              <button type="button" aria-label="Edit comment" className="hover:text-slate-800" onClick={() => setEditing({ id: c.id, body: c.body })}>
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            {(own || (manage && t.permissions.delete)) && (
              <button
                type="button"
                aria-label="Delete comment"
                className="hover:text-red-600"
                onClick={async () =>
                  (await confirm({
                    title: 'Delete comment?',
                    message: reply ? 'This reply will be removed.' : 'This comment and its replies will be removed.',
                    danger: true,
                    confirmLabel: 'Delete',
                  })) && removeComment.mutate(c.id)
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {isEditing ? (
            <form
              className="mt-2 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (editing.body.trim()) editComment.mutate({ id: c.id, body: editing.body.trim() });
              }}
            >
              <Textarea aria-label="Edit comment text" rows={2} value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} autoFocus />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" size="sm" loading={editComment.isPending}>Save</Button>
              </div>
            </form>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-slate-700">{c.body}</p>
          )}
          {c.attachments && c.attachments.length > 0 && (
            <div className="mt-2">
              <AttachmentList items={c.attachments} onPreview={setPreview} onDelete={deleteFile} canDelete={canDeleteFile} />
            </div>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-5 lg:col-span-2">
        {/* Header */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700" data-testid="task-id">{t.key}</span>
            <Badge tone={TASK_STATUS[t.status].tone} dot>{TASK_STATUS[t.status].label}</Badge>
            <Badge tone={TASK_PRIORITY[t.priority].tone}>{TASK_PRIORITY[t.priority].label}</Badge>
            <Badge>{TASK_TYPE[t.type]}</Badge>
            {isOverdue(t.dueDate, t.status) && <Badge tone="red">Overdue</Badge>}
            {t.metadata?.source === 'widget' && <Badge tone="blue">Review widget</Badge>}
          </div>
          <TaskProgress status={t.status} />
          {manage && (
            <div className="flex flex-wrap gap-2" data-testid="workflow-actions">
              {(t.status === 'OPEN' || t.status === 'REOPENED') && (
                <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={update.isPending} onClick={() => setStatus('IN_PROGRESS')}>Start task</Button>
              )}
              {t.status === 'IN_PROGRESS' && (
                <Button size="sm" variant="secondary" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => setStatus('IN_REVIEW')}>Send to review</Button>
              )}
              {(t.status === 'IN_PROGRESS' || t.status === 'IN_REVIEW') && (
                <Button size="sm" icon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={() => setStatus('COMPLETED')}>Mark completed</Button>
              )}
              {t.status === 'COMPLETED' && (
                <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setStatus('REOPENED')}>Reopen</Button>
              )}
              {t.status === 'ARCHIVED' ? (
                <Button size="sm" variant="secondary" icon={<ArchiveRestore className="h-3.5 w-3.5" />} loading={restore.isPending} onClick={() => restore.mutate()}>Restore</Button>
              ) : (
                <Button size="sm" variant="ghost" icon={<Archive className="h-3.5 w-3.5" />} onClick={() => setStatus('ARCHIVED')}>Archive</Button>
              )}
            </div>
          )}
        </div>

        {/* Description */}
        {editingTask ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ title: editingTask.title, description: editingTask.description || null }, { onSuccess: () => setEditingTask(null) });
            }}
          >
            <input className="input" aria-label="Task title" value={editingTask.title} onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })} required />
            <Textarea aria-label="Task description" rows={5} value={editingTask.description} onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditingTask(null)}>Cancel</Button>
              <Button type="submit" size="sm" loading={update.isPending}>Save</Button>
            </div>
          </form>
        ) : (
          <div className="group relative whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
            {t.description || <span className="text-slate-400">No description</span>}
            {t.permissions.update && (
              <button
                type="button"
                aria-label="Edit task"
                className="absolute right-2 top-2 rounded p-1 text-slate-400 hover:bg-white hover:text-slate-700"
                onClick={() => setEditingTask({ title: t.title, description: t.description ?? '' })}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        {t.pageUrl && (
          <a href={t.pageUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-sm text-brand-700 hover:underline">
            <span className="truncate">
              {typeof t.metadata?.pageTitle === 'string' && t.metadata.pageTitle ? `${t.metadata.pageTitle} — ` : ''}
              {t.pageUrl}
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        )}
        {t.pageUrl && <ElementAnchorRow taskId={t.id} pageUrl={t.pageUrl} element={t.metadata?.element} />}

        {/* Screenshots & files */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Screenshots & files {screenshots.length > 0 && <span className="text-slate-400">({screenshots.length})</span>}</h3>
            {t.permissions.upload && (
              <div className="flex gap-1">
                <input ref={shotInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden" aria-label="Upload screenshots"
                  onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) upload.mutate({ files, kind: 'screenshot' }); }} />
                <input ref={fileInput} type="file" multiple className="hidden" aria-label="Upload files"
                  onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) upload.mutate({ files, kind: 'file' }); }} />
                <Button variant="ghost" size="sm" icon={<ImagePlus className="h-3.5 w-3.5" />} loading={upload.isPending} onClick={() => shotInput.current?.click()}>Screenshot</Button>
                <Button variant="ghost" size="sm" icon={<Paperclip className="h-3.5 w-3.5" />} onClick={() => fileInput.current?.click()}>File</Button>
              </div>
            )}
          </div>
          {screenshots.length === 0 ? (
            <p className="text-sm text-slate-400">No screenshots or files.</p>
          ) : (
            <AttachmentList items={screenshots} onPreview={setPreview} onDelete={deleteFile} canDelete={canDeleteFile} testId="task-attachments" />
          )}
        </section>
        {t.metadata?.source === 'widget' && <CaptureContext metadata={t.metadata} />}

        {/* Comments / activity */}
        <div>
          <div className="mb-3 flex gap-4 border-b border-slate-200 text-sm" role="tablist">
            {(['comments', 'activity'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn('-mb-px border-b-2 pb-2 font-medium capitalize', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500')}
              >
                {k} {k === 'comments' && comments.data ? `(${comments.data.pagination.total})` : ''}
              </button>
            ))}
          </div>

          {tab === 'comments' ? (
            <div className="space-y-4">
              {comments.isLoading && <Skeleton className="h-16" />}
              {comments.data?.items.length === 0 && (
                <p className="flex items-center gap-2 text-sm text-slate-400"><MessageSquare className="h-4 w-4" /> No comments yet</p>
              )}
              <ul className="space-y-3" data-testid="comment-list">
                {roots.map((c) => (
                  <li key={c.id} className="space-y-2">
                    <ul className="space-y-2">
                      <CommentItem c={c} />
                      {repliesOf(c.id).map((r) => (
                        <CommentItem key={r.id} c={r} reply />
                      ))}
                    </ul>
                    {replyTo === c.id && (
                      <div className="ml-10">
                        <Composer
                          label="Write a reply"
                          placeholder={`Reply to ${c.author?.name ?? 'comment'}…`}
                          submitLabel="Reply"
                          autoFocus
                          busy={addComment.isPending}
                          onCancel={() => setReplyTo(null)}
                          onSubmit={async (body, files) => {
                            try {
                              await addComment.mutateAsync({ body, files, parentId: c.id });
                              return true;
                            } catch {
                              return false;
                            }
                          }}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {t.permissions.comment && (
                <Composer
                  label="Write a comment"
                  placeholder="Write a comment…"
                  submitLabel="Post comment"
                  busy={addComment.isPending && !replyTo}
                  onSubmit={async (body, files) => {
                    try {
                      await addComment.mutateAsync({ body, files });
                      return true;
                    } catch {
                      return false;
                    }
                  }}
                />
              )}
            </div>
          ) : (
            <ul className="space-y-3 text-sm" data-testid="activity-list">
              {activity.isLoading && <Skeleton className="h-16" />}
              {activity.data?.items.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <Avatar user={a.actor} size="xs" />
                  <div className="min-w-0">
                    <span className="font-medium">{a.actor?.name ?? 'Someone'}</span> <span className="text-slate-600">{describeActivity(a)}</span>
                    <div className="text-xs text-slate-400">{formatDateTime(a.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <aside className="h-fit space-y-4 rounded-xl border border-slate-200 p-4 lg:sticky lg:top-4">
        <Select
          label="Status"
          disabled={!manage}
          value={t.status}
          onChange={(e) => setStatus(e.target.value as TaskStatus)}
          options={options(TASK_STATUS)}
          hint={!manage ? 'Developers and admins update the status' : undefined}
        />
        <Select
          label="Priority"
          disabled={!manage}
          value={t.priority}
          onChange={(e) => update.mutate({ priority: e.target.value as TaskInput['priority'] })}
          options={options(TASK_PRIORITY)}
        />
        <Select
          label="Assignee"
          disabled={!manage}
          value={t.assignee?.id ?? ''}
          onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}
          placeholder="Unassigned"
          options={
            manage
              ? (assignees.data ?? []).map((m) => ({ value: m.user.id, label: m.user.name }))
              : t.assignee
                ? [{ value: t.assignee.id, label: t.assignee.name }]
                : []
          }
        />
        <Select
          label="Type"
          disabled={!t.permissions.update}
          value={t.type}
          onChange={(e) => update.mutate({ type: e.target.value as TaskInput['type'] })}
          options={options(TASK_TYPE)}
        />
        <div>
          <label className="label" htmlFor={`task-due-${t.id}`}>Due date</label>
          <input
            id={`task-due-${t.id}`}
            type="date"
            className="input"
            disabled={!manage}
            defaultValue={toDateInput(t.dueDate)}
            onChange={(e) => update.mutate({ dueDate: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : null })}
          />
        </div>
        <dl className="space-y-2 border-t border-slate-100 pt-4 text-xs" data-testid="task-facts">
          {(
            [
              ['Task ID', <span key="k" className="font-mono">{t.key}</span>],
              ['Website', <Link key="w" to={`/websites/${t.website.id}`} className="text-brand-700 hover:underline">{t.website.name}</Link>],
              ['Project', <Link key="p" to={`/projects/${t.project.id}`} className="text-brand-700 hover:underline">{t.project.name}</Link>],
              ['Created by', t.creator?.name ?? '—'],
              ['Assigned to', t.assignee?.name ?? 'Unassigned'],
              ['Created', formatDateTime(t.createdAt)],
              ['Updated', formatDateTime(t.updatedAt)],
              ['Completed', formatDateTime(t.completedAt)],
            ] as [string, ReactNode][]
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-medium text-slate-700">{v}</dd>
            </div>
          ))}
        </dl>
        {t.permissions.delete && (
          <Button
            variant="ghost"
            className="w-full text-red-600 hover:bg-red-50 hover:text-red-700"
            icon={<Trash2 className="h-4 w-4" />}
            onClick={async () =>
              (await confirm({ title: 'Delete task?', message: 'The task, its comments, files and history will be permanently deleted.', danger: true, confirmLabel: 'Delete task' })) &&
              removeTask.mutate()
            }
          >
            Delete task
          </Button>
        )}
      </aside>
      <Lightbox image={preview} onClose={() => setPreview(null)} />
    </div>
  );
};

/** The page element a widget comment points at, with a link that opens it highlighted. */
const ElementAnchorRow = ({ taskId, pageUrl, element }: { taskId: string; pageUrl: string; element: unknown }) => {
  const el = element as { tag?: unknown; text?: unknown } | null | undefined;
  if (!el || typeof el.tag !== 'string') return null;
  let href = pageUrl;
  try {
    const u = new URL(pageUrl);
    u.searchParams.set('wrtm_task', taskId);
    href = u.href;
  } catch {
    /* keep the plain URL */
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" data-testid="task-element">
      <span className="shrink-0 rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{el.tag.toUpperCase()}</span>
      <span className="min-w-0 flex-1 truncate text-slate-700">{typeof el.text === 'string' && el.text ? el.text : '(no text)'}</span>
      <a href={href} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-700 hover:underline">
        Show on page <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
};

/** Browser/viewport details the review widget captured with the task. */
export const CaptureContext = ({ metadata }: { metadata: Record<string, unknown> }) => {
  const vp = metadata.viewport as { width?: number; height?: number } | undefined;
  const ua = typeof metadata.userAgent === 'string' ? metadata.userAgent : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Unknown';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const rows: [string, string][] = [];
  if (vp?.width && vp.height) rows.push(['Viewport', `${vp.width} × ${vp.height}`]);
  if (ua) rows.push(['Browser', [browser, os].filter(Boolean).join(' on ')]);
  if (typeof metadata.devicePixelRatio === 'number') rows.push(['Pixel ratio', String(metadata.devicePixelRatio)]);
  if (!rows.length) return null;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-slate-200 px-4 py-3 text-xs" data-testid="capture-context" title={ua}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-1.5">
          <dt className="text-slate-500">{k}</dt>
          <dd className="font-medium text-slate-700">{v}</dd>
        </div>
      ))}
    </dl>
  );
};
