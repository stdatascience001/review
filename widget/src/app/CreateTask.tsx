import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { isApiError, type WidgetApi } from '../shared/api';
import type { Me, PageInfo, Task, TaskPriority, TaskType } from '../shared/types';
import { anchorLabel, describeElement } from './element';
import { shrinkImage } from './image';
import { captureViewport } from './screenshot';
import { Icon, PRIORITY_LABEL, Spinner, TYPE_LABEL, fileSize } from './ui';

interface Props {
  api: WidgetApi;
  me: Me;
  page: PageInfo;
  host: HTMLElement;
  onCancel: () => void;
  onCreated: (task: Task, warning?: string) => void;
  /** The page element picked in "Add a Comment" mode (null: a comment on the whole page). */
  element?: Element | null;
  onWider?: () => void;
  onNarrower?: () => void;
  canNarrow?: boolean;
  onRepick?: () => void;
  onRemoveElement?: () => void;
}

const TYPES: TaskType[] = ['BUG', 'UI_ISSUE', 'FEATURE', 'IMPROVEMENT', 'OTHER'];
const PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Viewport/device context stored with the task (helps developers reproduce the issue). */
const captureContext = () => ({
  viewport: { width: window.innerWidth, height: window.innerHeight },
  screen: { width: window.screen.width, height: window.screen.height },
  devicePixelRatio: window.devicePixelRatio,
  scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
  userAgent: navigator.userAgent.slice(0, 400),
  language: navigator.language,
});

const errorText = (err: unknown, fallback: string) =>
  isApiError(err) && err.code === 'VALIDATION_ERROR' && err.details?.length
    ? err.details.map((d) => d.message).join('\n')
    : err instanceof Error
      ? err.message
      : fallback;

/**
 * "Add a Comment / Create Task" form. The page URL and title, website, reporter and time are
 * captured automatically; the screenshot can be taken of the current page or uploaded.
 */
export const CreateTask = ({
  api,
  me,
  page,
  host,
  onCancel,
  onCreated,
  element = null,
  onWider,
  onNarrower,
  canNarrow,
  onRepick,
  onRemoveElement,
}: Props) => {
  const anchor = useMemo(() => (element ? describeElement(element) : null), [element]);
  const projects = me.access?.projects ?? [];
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<TaskType>('BUG');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [projectId, setProjectId] = useState(me.access?.defaultProjectId ?? '');
  const [screenshot, setScreenshot] = useState<{ blob: Blob; name: string; captured: boolean } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<'' | 'capturing' | 'saving' | 'uploading'>('');
  const [error, setError] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const shotInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  useEffect(() => titleRef.current?.focus(), []);
  const preview = useMemo(() => (screenshot ? URL.createObjectURL(screenshot.blob) : null), [screenshot]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const capture = async () => {
    setError('');
    setBusy('capturing');
    host.setAttribute('data-capturing', ''); // hide the widget while the page is captured
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const blob = await captureViewport(host);
      if (blob.size > MAX_BYTES) setError('The screenshot is too large. Upload a smaller image instead.');
      else setScreenshot({ blob, name: 'screenshot.jpg', captured: true });
    } catch {
      setError("Couldn't capture this page. You can upload an image instead.");
    } finally {
      host.removeAttribute('data-capturing');
      setBusy('');
    }
  };

  const pickScreenshot = (f: File | undefined) => {
    setError('');
    if (!f) return;
    if (!IMAGE_TYPES.includes(f.type)) return setError('Screenshots must be PNG, JPEG, WebP or GIF images.');
    if (f.size > MAX_BYTES) return setError('Images must be 10 MB or smaller.');
    setScreenshot({ blob: f, name: f.name, captured: false });
  };

  const pickFiles = (list: FileList | null) => {
    setError('');
    const picked = Array.from(list ?? []);
    const tooBig = picked.find((f) => f.size > MAX_BYTES);
    if (tooBig) return setError(`${tooBig.name} is larger than 10 MB.`);
    setFiles((prev) => [...prev, ...picked].slice(0, 10));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!title.trim()) return setError('Add a short title.');

    setBusy('saving');
    let task: Task;
    try {
      task = await api.request<Task>('/tasks', {
        method: 'POST',
        body: {
          title: title.trim(),
          description: description.trim() || undefined,
          type,
          priority,
          projectId: projectId || undefined,
          pageUrl: page.url,
          pageTitle: page.title.slice(0, 300) || undefined,
          // Re-described at submit time: the page may have scrolled or reflowed meanwhile.
          element: element?.isConnected ? describeElement(element) : (anchor ?? undefined),
          context: captureContext(),
        },
      });
    } catch (err) {
      setBusy('');
      return setError(errorText(err, 'Could not save the task.'));
    }

    // Files after the task, so a failed upload never loses the task itself.
    setBusy('uploading');
    const failed: string[] = [];
    const uploads: { blob: Blob; name: string; kind: 'screenshot' | 'file' }[] = [
      ...(screenshot ? [{ blob: screenshot.blob, name: screenshot.name, kind: 'screenshot' as const }] : []),
      ...files.map((f) => ({ blob: f, name: f.name, kind: 'file' as const })),
    ];
    for (const u of uploads) {
      try {
        // Large images are downscaled/re-encoded first (less storage, faster previews).
        const blob = u.blob.type.startsWith('image/') ? await shrinkImage(u.blob) : u.blob;
        const name = blob instanceof File ? blob.name : u.name;
        await api.request(`/tasks/${task.id}/attachments?kind=${u.kind}`, { method: 'POST', blob, fileName: name });
      } catch (err) {
        failed.push(`${u.name}${isApiError(err) ? ` (${err.message})` : ''}`);
      }
    }
    setBusy('');
    onCreated(task, failed.length ? `${task.key} saved, but some files failed: ${failed.join(', ')}` : undefined);
  };

  const working = busy !== '';
  return (
    <>
      <div className="subheader">
        <button type="button" className="icon-btn" aria-label="Back to comments" onClick={onCancel} disabled={working}>
          <Icon name="back" />
        </button>
        New comment / task
      </div>
      <div className="body" style={{ background: '#fff' }}>
        <form className="form" onSubmit={submit} noValidate aria-label="Create task">
          <div className="page-box" data-testid="captured-page">
            <strong>{page.title || 'Untitled page'}</strong>
            {page.url}
          </div>
          {anchor ? (
            <div className="el-picked" data-testid="picked-element">
              <div className="el-picked-head">
                <span className="el-tag">{anchorLabel(anchor)}</span>
                <span className="spacer" />
                <button type="button" className="btn btn-secondary btn-xs" onClick={onNarrower} disabled={!canNarrow || working}>
                  Narrower
                </button>
                <button type="button" className="btn btn-secondary btn-xs" onClick={onWider} disabled={working}>
                  Wider
                </button>
              </div>
              <p className="el-picked-text">
                <span className="el-text">{anchor.text || <em>(no text)</em>}</span>
              </p>
              <div className="row" style={{ alignItems: 'center' }}>
                <button type="button" className="link-btn" style={{ flex: 'none' }} onClick={onRepick} disabled={working}>
                  Select another element
                </button>
                <button type="button" className="link-btn" style={{ flex: 'none', color: 'var(--muted)' }} onClick={onRemoveElement} disabled={working}>
                  Comment on the whole page
                </button>
              </div>
            </div>
          ) : (
            onRepick && (
              <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onRepick} disabled={working}>
                <Icon name="target" size={14} /> Point to an element
              </button>
            )
          )}
          <label className="field">
            <span className="label">Task title</span>
            <input
              ref={titleRef}
              className="input"
              name="title"
              maxLength={255}
              required
              placeholder="What needs attention?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="label">Description</span>
            <textarea
              className="textarea"
              name="description"
              maxLength={20000}
              placeholder="Describe the issue or suggestion…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="row">
            <label className="field">
              <span className="label">Task type</span>
              <select className="select" name="type" value={type} onChange={(e) => setType(e.target.value as TaskType)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="label">Priority</span>
              <select className="select" name="priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {projects.length > 1 && (
            <label className="field">
              <span className="label">Project</span>
              <select className="select" name="project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="field">
            <span className="label">Screenshot</span>
            {preview ? (
              <div className="shot-preview">
                <img src={preview} alt="Screenshot preview" />
                <div className="row" style={{ alignItems: 'center' }}>
                  <span className="hint">{screenshot!.captured ? 'Captured from this page' : screenshot!.name}</span>
                  <button type="button" className="link-btn" style={{ flex: 'none' }} onClick={() => void capture()} disabled={working}>
                    Retake
                  </button>
                  <button type="button" className="link-btn" style={{ flex: 'none', color: 'var(--danger)' }} onClick={() => setScreenshot(null)} disabled={working}>
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void capture()} disabled={working}>
                  {busy === 'capturing' ? <Spinner /> : <Icon name="camera" size={14} />} Capture this page
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => shotInput.current?.click()} disabled={working}>
                  <Icon name="image" size={14} /> Upload image
                </button>
              </div>
            )}
            <input
              ref={shotInput}
              type="file"
              accept={IMAGE_TYPES.join(',')}
              hidden
              aria-label="Upload screenshot"
              onChange={(e) => {
                pickScreenshot(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>

          <div className="field">
            <span className="label">Additional files</span>
            {files.length > 0 && (
              <ul className="file-list">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`}>
                    <Icon name="file" size={14} />
                    <span className="fname">{f.name}</span>
                    <span className="hint">{fileSize(f.size)}</span>
                    <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                      <Icon name="x" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => filesInput.current?.click()} disabled={working}>
              <Icon name="paperclip" size={14} /> Attach files
            </button>
            <input
              ref={filesInput}
              type="file"
              multiple
              hidden
              aria-label="Attach additional files"
              onChange={(e) => {
                pickFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <span className="hint">Images, PDF, ZIP, Office documents or text, up to 10 MB each.</span>
          </div>

          {error && (
            <div className="alert" role="alert" style={{ whiteSpace: 'pre-line' }}>
              {error}
            </div>
          )}
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={working}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={working}>
              {(busy === 'saving' || busy === 'uploading') && <Spinner />}
              {busy === 'saving' ? 'Saving…' : busy === 'uploading' ? 'Uploading…' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
};
