import { useState } from 'react';
import type { Task } from '../shared/types';
import { useConfirm } from './confirm';
import { Avatar, Icon, PRIORITY_LABEL, STATUS_LABEL, Spinner, TYPE_LABEL, fullDate, pageLabel, timeAgo } from './ui';

interface Props {
  task: Task;
  signedIn: boolean;
  /** Runs `action` once the visitor is signed in with access (opens the login popup otherwise). */
  requireAuth: (action: () => void) => void;
  onOpen: (task: Task, focus?: 'comments') => void;
  onArchive: (task: Task, archived: boolean) => Promise<void>;
  /** Go to the task's page and highlight the element it is about. */
  onShow?: (task: Task) => void;
}

export const TaskCard = ({ task, signedIn, requireAuth, onOpen, onArchive, onShow }: Props) => {
  const confirm = useConfirm();
  const [archiving, setArchiving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const archived = task.status === 'ARCHIVED';

  const archive = () =>
    requireAuth(async () => {
      if (!archived) {
        const ok = await confirm({
          title: `Archive ${task.key}?`,
          message: 'It moves to the Archived tab. You can restore it at any time.',
          confirmLabel: 'Archive',
        });
        if (!ok) return;
      }
      setArchiving(true);
      try {
        await onArchive(task, !archived);
      } finally {
        setArchiving(false);
      }
    });

  return (
    <article className={task.unreadCount ? 'card unread' : 'card'} data-task-id={task.id} aria-label={task.title}>
      <div className="card-head">
        <Avatar user={task.creator} />
        <div className="who">
          <div className="name">{task.creator?.name ?? 'Deleted user'}</div>
          <time className="date" dateTime={task.createdAt} title={fullDate(task.createdAt)}>
            {timeAgo(task.createdAt)}
          </time>
        </div>
        <span className={`badge s-${task.status}`}>{STATUS_LABEL[task.status]}</span>
      </div>

      <button type="button" className="title title-btn" onClick={() => requireAuth(() => onOpen(task))}>
        <span className="task-key">{task.key}</span> {task.title}
      </button>
      <div className="meta">
        <span className="type">{TYPE_LABEL[task.type]}</span>
        <span className={`prio p-${task.priority}`}>{PRIORITY_LABEL[task.priority]}</span>
        {task.assignee && <span className="date">→ {task.assignee.name}</span>}
        {task.unreadCount > 0 && (
          <span className="unread-pill" aria-label={`${task.unreadCount} unread comments`}>
            {task.unreadCount} new
          </span>
        )}
      </div>

      {task.element && task.pageUrl && (
        <button
          type="button"
          className="el-chip"
          title="Show me this on the page"
          aria-label={`Show ${task.key} on the page`}
          onClick={() => onShow?.(task)}
        >
          <span className="el-tag">{task.element.tag.toUpperCase()}</span>
          <span className="el-text">{task.element.text || '(no text)'}</span>
          <span className="spacer" />
          <span className="go">Show</span>
        </button>
      )}

      {task.pageUrl && (
        <a
          className="page-link"
          href={task.pageUrl}
          title={task.pageTitle ? `${task.pageTitle} — ${task.pageUrl}` : task.pageUrl}
          onClick={(e) => {
            // Comments on an element: open that page and point at the element.
            if (task.element && onShow) {
              e.preventDefault();
              onShow(task);
            }
          }}
        >
          <Icon name="link" size={12} />
          <span>{pageLabel(task.pageUrl)}</span>
        </a>
      )}

      {task.description && (
        <p className={expanded ? 'desc full' : 'desc'} onClick={() => setExpanded((v) => !v)}>
          {task.description}
        </p>
      )}

      {task.screenshotUrl && (
        <button type="button" className="shot" onClick={() => requireAuth(() => onOpen(task))} title="Open task">
          <img src={task.screenshotUrl} alt={`Screenshot for ${task.title}`} loading="lazy" />
        </button>
      )}

      <div className="actions">
        <button type="button" className="action" onClick={() => requireAuth(() => onOpen(task, 'comments'))}>
          <Icon name="message" size={14} /> Reply{task.commentCount ? ` (${task.commentCount})` : ''}
        </button>
        {(task.permissions.archive || !signedIn) && (
          <button type="button" className="action" onClick={archive} disabled={archiving}>
            {archiving ? <Spinner /> : <Icon name={archived ? 'restore' : 'archive'} size={14} />}
            {archived ? 'Restore' : 'Archive'}
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="action" onClick={() => requireAuth(() => onOpen(task))}>
          View details
        </button>
      </div>
    </article>
  );
};
