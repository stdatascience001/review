import { useQuery } from '@tanstack/react-query';
import { Maximize2 } from 'lucide-react';
import { Link } from 'react-router';
import { tasksApi } from '@/api/resources';
import { Modal } from '@/components/ui/Modal';
import { TaskDetailView } from './TaskDetailView';

/** Task detail in a dialog (from task tables), with a link to the full page. */
export const TaskDetailModal = ({ taskId, onClose }: { taskId: string | null; onClose: () => void }) => {
  // Shares the cache entry with TaskDetailView, so this doesn't cost an extra request.
  const task = useQuery({ queryKey: ['tasks', 'detail', taskId], queryFn: () => tasksApi.get(taskId!), enabled: Boolean(taskId) });
  const t = task.data;
  return (
    <Modal
      open={Boolean(taskId)}
      onClose={onClose}
      title={t ? t.title : 'Task'}
      size="xl"
      description={
        t && (
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="font-mono">{t.key}</span>·<span>{t.website.name}</span>·<span>{t.project.name}</span>
            <Link to={`/tasks/${t.id}`} className="ml-auto inline-flex items-center gap-1 text-brand-700 hover:underline">
              <Maximize2 className="h-3 w-3" /> Open full page
            </Link>
          </span>
        )
      }
    >
      {taskId && <TaskDetailView taskId={taskId} onDeleted={onClose} />}
    </Modal>
  );
};
