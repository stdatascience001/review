import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { isApiError, type WidgetApi } from '../shared/api';
import type { Activity, Attachment, Comment, TaskDetail as Detail, TaskPriority, TaskStatus, Task, User } from '../shared/types';
import { useConfirm } from './confirm';
import { shrinkImage } from './image';
import { Avatar, Icon, PRIORITY_LABEL, STATUS_LABEL, Spinner, TYPE_LABEL, fileSize, fullDate, pageLabel, timeAgo } from './ui';

interface Props {
  api: WidgetApi;
  taskId: string;
  focus?: 'comments';
  me: User;
  onBack: () => void;
  /** The task changed (status, archive…) or was read: refresh list + badge. */
  onChanged: () => void;
  /** Bumped when a live event arrives for this task: reload it in place. */
  version?: number;
  toast: (message: string, error?: boolean) => void;
  /** Go to the task's page and highlight its element. */
  onShowOnPage?: (task: Task) => void;
}

const msg = (err: unknown, fallback: string) => (isApiError(err) ? err.message : fallback);

const STEPS: { status: TaskStatus; label: string }[] = [
  { status: 'OPEN', label: 'Open' },
  { status: 'IN_PROGRESS', label: 'In progress' },
  { status: 'IN_REVIEW', label: 'Under review' },
  { status: 'COMPLETED', label: 'Completed' },
];

const Progress = ({ status }: { status: TaskStatus }) => {
  const current = status === 'REOPENED' ? 0 : STEPS.findIndex((s) => s.status === status);
  return (
    <ol className="steps" aria-label="Task progress">
      {STEPS.map((s, i) => (
        <li
          key={s.status}
          className={status !== 'ARCHIVED' && i <= current ? (status === 'COMPLETED' ? 'done complete' : 'done') : undefined}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="bar" />
          <span className="lbl">{i === 0 && status === 'REOPENED' ? 'Reopened' : s.label}</span>
        </li>
      ))}
    </ol>
  );
};

const valueLabel = (field: string | null, v: string | null) => {
  if (!v) return '—';
  if (field === 'status') return STATUS_LABEL[v as TaskStatus] ?? v;
  if (field === 'priority') return PRIORITY_LABEL[v as TaskPriority] ?? v;
  return v;
};

const describe = (a: Activity): ReactNode => {
  const assignee = (a.changes as { assignee?: { from?: string; to?: string } } | null)?.assignee;
  const fromTo = (
    <>
      {' '}
      <b>{valueLabel(a.field, a.previousValue)}</b> → <b>{valueLabel(a.field, a.newValue)}</b>
    </>
  );
  switch (a.type) {
    case 'CREATED':
      return 'created the task';
    case 'ASSIGNED':
      return <>assigned it to <b>{assignee?.to ?? 'a developer'}</b></>;
    case 'UNASSIGNED':
      return <>unassigned <b>{assignee?.from ?? 'the developer'}</b></>;
    case 'STARTED':
      return 'started the task';
    case 'COMPLETED':
      return 'completed the task';
    case 'REOPENED':
      return 'reopened the task';
    case 'ARCHIVED':
      return 'archived the task';
    case 'RESTORED':
      return <>restored the task ({valueLabel('status', a.newValue)})</>;
    case 'STATUS_CHANGED':
      return <>changed status{fromTo}</>;
    case 'PRIORITY_CHANGED':
      return <>changed priority{fromTo}</>;
    case 'UPDATED':
      return a.field ? `edited the ${a.field}` : 'edited the task';
    case 'COMMENTED':
      return 'added a comment';
    case 'COMMENT_EDITED':
      return 'edited a comment';
    case 'COMMENT_DELETED':
      return 'deleted a comment';
    case 'ATTACHMENT_ADDED':
      return <>added {a.field === 'screenshot' ? 'a screenshot' : 'a file'} <b>{a.newValue}</b></>;
    case 'ATTACHMENT_REMOVED':
      return <>removed <b>{a.previousValue}</b></>;
    default:
      return a.type.replace(/_/g, ' ').toLowerCase();
  }
};

const Files = ({ items, canDelete, onDelete }: { items: Attachment[]; canDelete: (a: Attachment) => boolean; onDelete: (a: Attachment) => void }) => {
  const images = items.filter((a) => a.mimeType.startsWith('image/'));
  const others = items.filter((a) => !a.mimeType.startsWith('image/'));
  return (
    <>
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((a) => (
            <div className="thumb" key={a.id}>
              <a href={a.url} target="_blank" rel="noopener noreferrer" title={`Open ${a.fileName}`}>
                <img src={a.url} alt={a.fileName} loading="lazy" />
              </a>
              {canDelete(a) && (
                <button type="button" className="thumb-del" aria-label={`Remove ${a.fileName}`} onClick={() => onDelete(a)}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="file-list">
          {others.map((a) => (
            <li key={a.id}>
              <Icon name="file" size={14} />
              <a className="fname" href={a.url} download={a.fileName}>
                {a.fileName}
              </a>
              <span className="hint">{fileSize(a.sizeBytes)}</span>
              {canDelete(a) && (
                <button type="button" className="icon-btn" aria-label={`Remove ${a.fileName}`} onClick={() => onDelete(a)}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

/** Comment / reply box with optional attachments. */
const Composer = ({
  label,
  placeholder,
  autoFocus,
  onCancel,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (body: string, files: File[]) => Promise<boolean>;
}) => {
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    const ok = await onSubmit(body.trim(), files);
    setSending(false);
    if (ok) {
      setBody('');
      setFiles([]);
    }
  };
  return (
    <form className="composer-box" onSubmit={submit}>
      <textarea
        className="textarea"
        rows={2}
        aria-label={label}
        placeholder={placeholder}
        value={body}
        maxLength={10000}
        autoFocus={autoFocus}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <Icon name={f.type.startsWith('image/') ? 'image' : 'file'} size={14} />
              <span className="fname">{f.name}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-actions">
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label={label === 'Write a reply' ? 'Attach files to reply' : 'Attach files'}
          onChange={(e) => {
            setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 5));
            e.target.value = '';
          }}
        />
        <button type="button" className="action" onClick={() => input.current?.click()}>
          <Icon name="paperclip" size={14} /> Attach
        </button>
        <span className="spacer" />
        {onCancel && (
          <button type="button" className="action" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !body.trim()}>
          {sending ? <Spinner /> : <Icon name="send" size={14} />} {label === 'Write a reply' ? 'Reply' : 'Send'}
        </button>
      </div>
    </form>
  );
};

/** Task detail inside the widget: progress, details, files, comments & replies, history. */
export const TaskDetail = ({ api, taskId, focus, me, onBack, onChanged, toast, version = 0, onShowOnPage }: Props) => {
  const confirm = useConfirm();
  const [task, setTask] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [history, setHistory] = useState<Activity[] | null>(null);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const [assignees, setAssignees] = useState<{ user: User }[]>([]);
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [editingTask, setEditingTask] = useState<{ title: string; description: string } | null>(null);
  const commentsRef = useRef<HTMLDivElement>(null);
  const shotInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadTask = useCallback(async () => {
    try {
      setTask(await api.request<Detail>(`/tasks/${taskId}`));
    } catch (err) {
      setError(msg(err, 'Could not load this task'));
    }
  }, [api, taskId]);
  const loadComments = useCallback(async () => {
    try {
      setComments((await api.request<{ items: Comment[] }>(`/tasks/${taskId}/comments`)).items);
    } catch (err) {
      toast(msg(err, 'Could not load comments'), true);
    }
  }, [api, taskId, toast]);
  const loadHistory = useCallback(async () => {
    try {
      setHistory((await api.request<{ items: Activity[] }>(`/tasks/${taskId}/activity`)).items);
    } catch (err) {
      toast(msg(err, 'Could not load history'), true);
    }
  }, [api, taskId, toast]);

  // Load task + comments, then mark as read (the "New" labels stay for this visit).
  useEffect(() => {
    void (async () => {
      await Promise.all([loadTask(), loadComments()]);
      await api.request(`/tasks/${taskId}/read`, { method: 'POST' }).catch(() => undefined);
      onChanged();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  // Live update from someone else (status, reply, assignment…): refresh without a reload.
  const firstVersion = useRef(version);
  useEffect(() => {
    if (version === firstVersion.current) return;
    void Promise.all([loadTask(), loadComments(), tab === 'history' ? loadHistory() : undefined]).then(() =>
      api.request(`/tasks/${taskId}/read`, { method: 'POST' }).catch(() => undefined),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  useEffect(() => {
    if (task?.permissions.manage && assignees.length === 0) {
      api.request<{ user: User }[]>(`/tasks/${taskId}/assignees`).then(setAssignees).catch(() => undefined);
    }
  }, [api, taskId, task?.permissions.manage, assignees.length]);
  useEffect(() => {
    if (tab === 'history') void loadHistory();
  }, [tab, loadHistory]);
  useEffect(() => {
    if (focus === 'comments' && comments) commentsRef.current?.scrollIntoView({ block: 'start' });
  }, [focus, comments]);

  const patch = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    try {
      setTask(await api.request<Detail>(`/tasks/${taskId}`, { method: 'PATCH', body }));
      toast(success);
      onChanged();
      if (tab === 'history') void loadHistory();
      return true;
    } catch (err) {
      toast(msg(err, 'Could not update the task'), true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (status: TaskStatus) => {
    if (!task || status === task.status) return;
    if (status === 'ARCHIVED' && !(await confirm({ title: `Archive ${task.key}?`, message: 'It moves to the Archived tab. You can restore it later.', confirmLabel: 'Archive' }))) return;
    if (status === 'COMPLETED' && !(await confirm({ title: `Complete ${task.key}?`, message: 'The reporter will be notified that the task is done.', confirmLabel: 'Mark completed' }))) return;
    await patch({ status }, `${task.key} is now ${STATUS_LABEL[status].toLowerCase()}`);
  };

  const restore = async () => {
    setBusy(true);
    try {
      await api.request(`/tasks/${taskId}/archive`, { method: 'DELETE' });
      await loadTask();
      toast('Task restored');
      onChanged();
    } catch (err) {
      toast(msg(err, 'Could not restore the task'), true);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: File[], kind: 'screenshot' | 'file', commentId?: string) => {
    const failed: string[] = [];
    for (const f of files) {
      // Comment attachments: images count as screenshots. Task uploads use the chosen kind.
      const k = commentId ? (f.type.startsWith('image/') ? 'screenshot' : 'file') : kind;
      const q = `kind=${k}${commentId ? `&commentId=${commentId}` : ''}`;
      try {
        const blob = f.type.startsWith('image/') ? await shrinkImage(f) : f;
        await api.request(`/tasks/${taskId}/attachments?${q}`, { method: 'POST', blob, fileName: blob instanceof File ? blob.name : f.name });
      } catch (err) {
        failed.push(`${f.name}: ${msg(err, 'upload failed')}`);
      }
    }
    if (failed.length) toast(failed.join('\n'), true);
    return failed.length === 0;
  };

  const uploadToTask = async (files: File[], kind: 'screenshot' | 'file') => {
    if (!files.length) return;
    setBusy(true);
    const ok = await upload(files, kind);
    await loadTask();
    setBusy(false);
    if (ok) toast(files.length > 1 ? `${files.length} files added` : kind === 'screenshot' ? 'Screenshot added' : 'File added');
    onChanged();
  };

  const removeFile = async (a: Attachment) => {
    if (!(await confirm({ title: 'Remove file?', message: `${a.fileName} will be deleted.`, confirmLabel: 'Remove', danger: true }))) return;
    try {
      await api.request(`/tasks/${taskId}/attachments/${a.id}`, { method: 'DELETE' });
      toast('File removed');
      await Promise.all([loadTask(), loadComments()]);
    } catch (err) {
      toast(msg(err, 'Could not remove the file'), true);
    }
  };

  const addComment = async (body: string, files: File[], parentId?: string) => {
    try {
      const c = await api.request<Comment>(`/tasks/${taskId}/comments`, { method: 'POST', body: { body, parentId } });
      if (files.length) await upload(files, 'file', c.id);
      await loadComments();
      setReplyTo(null);
      onChanged();
      return true;
    } catch (err) {
      toast(msg(err, 'Could not send the comment'), true);
      return false;
    }
  };

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing?.body.trim()) return;
    try {
      await api.request(`/comments/${editing.id}`, { method: 'PATCH', body: { body: editing.body.trim() } });
      setEditing(null);
      toast('Comment updated');
      await loadComments();
    } catch (err) {
      toast(msg(err, 'Could not update the comment'), true);
    }
  };

  const deleteComment = async (c: Comment) => {
    const ok = await confirm({
      title: 'Delete comment?',
      message: c.parentId ? 'This reply will be removed.' : 'This comment and its replies will be removed.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.request(`/comments/${c.id}`, { method: 'DELETE' });
      toast('Comment deleted');
      await loadComments();
      onChanged();
    } catch (err) {
      toast(msg(err, 'Could not delete the comment'), true);
    }
  };

  const roots = useMemo(() => (comments ?? []).filter((c) => !c.parentId), [comments]);
  const repliesOf = (id: string) => (comments ?? []).filter((c) => c.parentId === id);

  if (error) {
    return (
      <>
        <div className="subheader">
          <button type="button" className="icon-btn" aria-label="Back to comments" onClick={onBack}>
            <Icon name="back" />
          </button>
          Task
        </div>
        <div className="body">
          <div className="empty">
            <div className="ico">
              <Icon name="alert" size={22} />
            </div>
            <p>{error}</p>
          </div>
        </div>
      </>
    );
  }

  const CommentView = ({ c }: { c: Comment }) => {
    const own = c.author?.id === me.id;
    return (
      <div className={c.isNew ? 'comment is-new' : 'comment'} data-comment-id={c.id}>
        <Avatar user={c.author} small />
        <div className="bubble">
          <div className="card-head">
            <span className="name">{c.author?.name ?? 'Deleted user'}</span>
            <time className="date" dateTime={c.createdAt} title={fullDate(c.createdAt)}>
              {timeAgo(c.createdAt)}
            </time>
            {c.editedAt && <span className="date">(edited)</span>}
            {c.isNew && <span className="new-tag">New</span>}
          </div>
          {editing?.id === c.id ? (
            <form className="composer-box" onSubmit={saveEdit}>
              <textarea className="textarea" rows={2} aria-label="Edit comment" value={editing.body} autoFocus onChange={(e) => setEditing({ id: c.id, body: e.target.value })} />
              <div className="composer-actions">
                <span className="spacer" />
                <button type="button" className="action" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary btn-sm">
                  Save
                </button>
              </div>
            </form>
          ) : (
            <p className="text">{c.body}</p>
          )}
          {c.attachments.length > 0 && <Files items={c.attachments} canDelete={(a) => a.uploader?.id === me.id} onDelete={removeFile} />}
          <div className="comment-actions">
            {!c.parentId && task?.permissions.comment && (
              <button type="button" className="mini" onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>
                Reply
              </button>
            )}
            {own && editing?.id !== c.id && (
              <button type="button" className="mini" onClick={() => setEditing({ id: c.id, body: c.body })}>
                Edit
              </button>
            )}
            {own && (
              <button type="button" className="mini danger" onClick={() => void deleteComment(c)}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="subheader">
        <button type="button" className="icon-btn" aria-label="Back to comments" onClick={onBack}>
          <Icon name="back" />
        </button>
        <span className="task-key" data-testid="detail-key">
          {task?.key ?? '…'}
        </span>
        <span className="spacer" />
        {task && <span className={`badge s-${task.status}`}>{STATUS_LABEL[task.status]}</span>}
      </div>
      <div className="body" style={{ background: '#fff' }} aria-busy={!task}>
        {!task ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : (
          <div className="detail">
            {editingTask ? (
              <form
                className="composer-box"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await patch({ title: editingTask.title.trim(), description: editingTask.description.trim() || null }, 'Task updated')) setEditingTask(null);
                }}
              >
                <input className="input" aria-label="Task title" value={editingTask.title} required onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })} />
                <textarea className="textarea" aria-label="Task description" value={editingTask.description} onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value })} />
                <div className="composer-actions">
                  <span className="spacer" />
                  <button type="button" className="action" onClick={() => setEditingTask(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                    Save
                  </button>
                </div>
              </form>
            ) : (
              <div className="detail-title">
                <h3>{task.title}</h3>
                {task.permissions.update && (
                  <button type="button" className="icon-btn" aria-label="Edit task" onClick={() => setEditingTask({ title: task.title, description: task.description ?? '' })}>
                    <Icon name="pencil" size={14} />
                  </button>
                )}
              </div>
            )}
            <Progress status={task.status} />

            {task.permissions.manage && (
              <div className="workflow" data-testid="workflow">
                {(task.status === 'OPEN' || task.status === 'REOPENED') && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void setStatus('IN_PROGRESS')}>
                    <Icon name="play" size={12} /> Start task
                  </button>
                )}
                {task.status === 'IN_PROGRESS' && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void setStatus('IN_REVIEW')}>
                    Send to review
                  </button>
                )}
                {(task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW') && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void setStatus('COMPLETED')}>
                    <Icon name="check" size={12} /> Mark completed
                  </button>
                )}
                {task.status === 'COMPLETED' && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void setStatus('REOPENED')}>
                    <Icon name="restore" size={12} /> Reopen
                  </button>
                )}
                {task.status === 'ARCHIVED' ? (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void restore()}>
                    <Icon name="restore" size={12} /> Restore
                  </button>
                ) : (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void setStatus('ARCHIVED')}>
                    <Icon name="archive" size={12} /> Archive
                  </button>
                )}
              </div>
            )}

            <dl className="facts">
              <dt>Status</dt>
              <dd>
                {task.permissions.manage ? (
                  <select className="select" aria-label="Status" value={task.status} disabled={busy} onChange={(e) => void setStatus(e.target.value as TaskStatus)}>
                    {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
                      <option key={s} value={s} disabled={s === 'REOPENED' && task.status !== 'COMPLETED' && task.status !== 'ARCHIVED'}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                ) : (
                  STATUS_LABEL[task.status]
                )}
              </dd>
              <dt>Priority</dt>
              <dd>
                {task.permissions.manage ? (
                  <select className="select" aria-label="Priority" value={task.priority} disabled={busy} onChange={(e) => void patch({ priority: e.target.value }, 'Priority updated')}>
                    {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={`prio p-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
                )}
              </dd>
              <dt>Assigned to</dt>
              <dd>
                {task.permissions.manage ? (
                  <select
                    className="select"
                    aria-label="Assign developer"
                    value={task.assignee?.id ?? ''}
                    disabled={busy}
                    onChange={(e) => void patch({ assigneeId: e.target.value || null }, e.target.value ? 'Developer assigned' : 'Unassigned')}
                  >
                    <option value="">Unassigned</option>
                    {assignees.map((a) => (
                      <option key={a.user.id} value={a.user.id}>
                        {a.user.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  (task.assignee?.name ?? 'Not assigned yet')
                )}
              </dd>
              <dt>Type</dt>
              <dd>{TYPE_LABEL[task.type]}</dd>
              <dt>Reported by</dt>
              <dd>{task.creator?.name ?? '—'}</dd>
              <dt>Created</dt>
              <dd title={fullDate(task.createdAt)}>{fullDate(task.createdAt)}</dd>
              {task.completedAt && (
                <>
                  <dt>Completed</dt>
                  <dd>{fullDate(task.completedAt)}</dd>
                </>
              )}
              {task.pageUrl && (
                <>
                  <dt>Page</dt>
                  <dd>
                    <a href={task.pageUrl} title={task.pageUrl}>
                      {task.pageTitle || pageLabel(task.pageUrl)}
                    </a>
                  </dd>
                </>
              )}
              {task.element && (
                <>
                  <dt>Element</dt>
                  <dd>
                    <button
                      type="button"
                      className="el-chip"
                      style={{ marginTop: 0 }}
                      title="Show me this on the page"
                      aria-label={`Show ${task.key} on the page`}
                      onClick={() => onShowOnPage?.(task)}
                    >
                      <span className="el-tag">{task.element.tag.toUpperCase()}</span>
                      <span className="el-text">{task.element.text || '(no text)'}</span>
                      <span className="go">Show on page</span>
                    </button>
                  </dd>
                </>
              )}
            </dl>

            {task.description && <p className="desc full">{task.description}</p>}

            <section className="section">
              <div className="section-head">
                <h4>Screenshots & files</h4>
                {task.permissions.upload && (
                  <>
                    <button type="button" className="action" onClick={() => shotInput.current?.click()} disabled={busy}>
                      <Icon name="camera" size={14} /> Add screenshot
                    </button>
                    <button type="button" className="action" onClick={() => fileInput.current?.click()} disabled={busy}>
                      <Icon name="paperclip" size={14} /> Add file
                    </button>
                    <input
                      ref={shotInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      multiple
                      hidden
                      aria-label="Upload additional screenshots"
                      onChange={(e) => {
                        const f = Array.from(e.target.files ?? []);
                        e.target.value = '';
                        void uploadToTask(f, 'screenshot');
                      }}
                    />
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      aria-label="Upload additional files"
                      onChange={(e) => {
                        const f = Array.from(e.target.files ?? []);
                        e.target.value = '';
                        void uploadToTask(f, 'file');
                      }}
                    />
                  </>
                )}
              </div>
              {task.attachments.length ? (
                <Files items={task.attachments} canDelete={(a) => a.uploader?.id === me.id} onDelete={removeFile} />
              ) : (
                <p className="hint">No screenshots or files yet.</p>
              )}
            </section>

            <div className="tabs inner" role="tablist" ref={commentsRef}>
              <button type="button" role="tab" className="tab" aria-selected={tab === 'comments'} onClick={() => setTab('comments')}>
                Comments <span className="n">{comments?.length ?? 0}</span>
              </button>
              <button type="button" role="tab" className="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
                History
              </button>
            </div>

            {tab === 'comments' ? (
              <div className="thread" data-testid="thread">
                {comments === null && <Spinner />}
                {comments?.length === 0 && <p className="hint">No comments yet. Start the conversation.</p>}
                {roots.map((c) => (
                  <div key={c.id} className="thread-group">
                    <CommentView c={c} />
                    {repliesOf(c.id).length > 0 && (
                      <div className="replies">
                        {repliesOf(c.id).map((r) => (
                          <CommentView key={r.id} c={r} />
                        ))}
                      </div>
                    )}
                    {replyTo === c.id && (
                      <div className="replies">
                        <Composer label="Write a reply" placeholder={`Reply to ${c.author?.name ?? 'comment'}…`} autoFocus onCancel={() => setReplyTo(null)} onSubmit={(b, f) => addComment(b, f, c.id)} />
                      </div>
                    )}
                  </div>
                ))}
                {task.permissions.comment && <Composer label="Write a comment" placeholder="Add a comment…" onSubmit={(b, f) => addComment(b, f)} />}
              </div>
            ) : (
              <ul className="history" data-testid="history">
                {history === null && <Spinner />}
                {history?.map((a) => (
                  <li key={a.id}>
                    <Avatar user={a.actor} small />
                    <div>
                      <span className="name">{a.actor?.name ?? 'Someone'}</span> {describe(a)}
                      <div className="date" title={fullDate(a.createdAt)}>
                        {timeAgo(a.createdAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </>
  );
};
