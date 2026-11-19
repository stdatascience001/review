import { ArrowLeft } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { TaskDetailView } from '@/components/tasks/TaskDetailView';
import type { TaskDetail } from '@/types/api';

/** Full-page task detail: /tasks/:taskId (deep-linkable, e.g. from notifications). */
export const TaskDetailPage = () => {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const onLoaded = useCallback((t: TaskDetail) => setTask(t), []);

  return (
    <div className="space-y-4">
      <Link to="/tasks" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="h-4 w-4" /> All tasks
      </Link>
      <div>
        <p className="font-mono text-xs text-slate-500">{task ? `${task.key} · ${task.website.name} · ${task.project.name}` : ' '}</p>
        <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight text-slate-900">{task?.title ?? 'Task'}</h1>
      </div>
      <div className="card p-5">
        {taskId && <TaskDetailView key={taskId} taskId={taskId} onLoaded={onLoaded} onDeleted={() => navigate('/tasks')} />}
      </div>
    </div>
  );
};
