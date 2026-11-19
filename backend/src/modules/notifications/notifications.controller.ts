import type { Request, Response } from 'express';
import { authOf } from '../../middleware/authenticate';
import { paramsOf, queryOf } from '../../middleware/validate';
import * as s from './notifications.schemas';
import * as service from './notifications.service';

export const list = async (req: Request, res: Response) => {
  res.json({ data: await service.list(authOf(req).userId, queryOf(req, s.listNotificationsQuery)) });
};

export const unreadCount = async (req: Request, res: Response) => {
  res.json({ data: { count: await service.unreadCount(authOf(req).userId) } });
};

export const markRead = async (req: Request, res: Response) => {
  await service.markRead(authOf(req).userId, paramsOf(req, s.notificationIdParams).notificationId);
  res.status(204).end();
};

export const markAllRead = async (req: Request, res: Response) => {
  res.json({ data: { updated: await service.markAllRead(authOf(req).userId) } });
};

export const remove = async (req: Request, res: Response) => {
  await service.remove(authOf(req).userId, paramsOf(req, s.notificationIdParams).notificationId);
  res.status(204).end();
};
