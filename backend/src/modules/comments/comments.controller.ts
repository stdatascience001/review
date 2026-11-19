import type { Request, Response } from 'express';
import { authOf } from '../../middleware/authenticate';
import { bodyOf, paramsOf, queryOf } from '../../middleware/validate';
import { taskIdParams } from '../tasks/tasks.schemas';
import * as s from './comments.schemas';
import * as comments from './comments.service';

// Mounted under /tasks/:taskId/comments
export const list = async (req: Request, res: Response) => {
  const { taskId } = paramsOf(req, taskIdParams);
  res.json({ data: await comments.list(authOf(req).userId, taskId, queryOf(req, s.listCommentsQuery)) });
};

export const create = async (req: Request, res: Response) => {
  const { taskId } = paramsOf(req, taskIdParams);
  res.status(201).json({ data: await comments.create(authOf(req).userId, taskId, bodyOf(req, s.createCommentBody)) });
};

// Mounted under /comments/:commentId
export const update = async (req: Request, res: Response) => {
  const { commentId } = paramsOf(req, s.commentIdParams);
  res.json({ data: await comments.update(authOf(req).userId, commentId, bodyOf(req, s.updateCommentBody).body) });
};

export const remove = async (req: Request, res: Response) => {
  await comments.remove(authOf(req).userId, paramsOf(req, s.commentIdParams).commentId);
  res.status(204).end();
};

// Mounted under /comments
export const listAll = async (req: Request, res: Response) => {
  res.json({ data: await comments.listAll(authOf(req).userId, queryOf(req, s.listAllCommentsQuery)) });
};
