import type { Request, Response } from 'express';
import { authOf } from '../../middleware/authenticate';
import { bodyOf, paramsOf, queryOf } from '../../middleware/validate';
import { projectIdParams } from '../projects/projects.schemas';
import * as s from './tasks.schemas';
import * as tasks from './tasks.service';

// Mounted under /projects/:projectId/tasks
export const list = async (req: Request, res: Response) => {
  const { projectId } = paramsOf(req, projectIdParams);
  res.json({ data: await tasks.list(authOf(req).userId, projectId, queryOf(req, s.listTasksQuery)) });
};

export const create = async (req: Request, res: Response) => {
  const { projectId } = paramsOf(req, projectIdParams);
  res.status(201).json({ data: await tasks.create(authOf(req).userId, projectId, bodyOf(req, s.createTaskBody)) });
};

// Mounted under /tasks/:taskId
export const get = async (req: Request, res: Response) => {
  res.json({ data: await tasks.get(authOf(req).userId, paramsOf(req, s.taskIdParams).taskId) });
};

export const update = async (req: Request, res: Response) => {
  const { taskId } = paramsOf(req, s.taskIdParams);
  res.json({ data: await tasks.update(authOf(req).userId, taskId, bodyOf(req, s.updateTaskBody)) });
};

export const remove = async (req: Request, res: Response) => {
  await tasks.remove(authOf(req).userId, paramsOf(req, s.taskIdParams).taskId);
  res.status(204).end();
};

export const activity = async (req: Request, res: Response) => {
  const { taskId } = paramsOf(req, s.taskIdParams);
  res.json({ data: await tasks.listActivity(authOf(req).userId, taskId, queryOf(req, s.activityQuery)) });
};

export const restore = async (req: Request, res: Response) => {
  res.json({ data: await tasks.restore(authOf(req).userId, paramsOf(req, s.taskIdParams).taskId) });
};

export const assignees = async (req: Request, res: Response) => {
  res.json({ data: await tasks.assignees(authOf(req).userId, paramsOf(req, s.taskIdParams).taskId) });
};

export const markRead = async (req: Request, res: Response) => {
  await tasks.markRead(authOf(req).userId, paramsOf(req, s.taskIdParams).taskId);
  res.status(204).end();
};

export const upload = async (req: Request, res: Response) => {
  const { taskId } = paramsOf(req, s.taskIdParams);
  const { kind, commentId } = queryOf(req, s.uploadQuery);
  const data = await tasks.addAttachment(authOf(req).userId, taskId, {
    body: req.body,
    fileName: s.fileNameOf(req.get('x-file-name')),
    kind,
    commentId,
  });
  res.status(201).json({ data });
};

export const removeAttachment = async (req: Request, res: Response) => {
  const { taskId, attachmentId } = paramsOf(req, s.attachmentParams);
  await tasks.removeAttachment(authOf(req).userId, taskId, attachmentId);
  res.status(204).end();
};

// Mounted under /tasks (cross-project)
export const listAll = async (req: Request, res: Response) => {
  res.json({ data: await tasks.listAll(authOf(req).userId, queryOf(req, s.listAllTasksQuery)) });
};

export const createAnywhere = async (req: Request, res: Response) => {
  const { projectId, ...input } = bodyOf(req, s.createTaskWithProjectBody);
  res.status(201).json({ data: await tasks.create(authOf(req).userId, projectId, input) });
};
