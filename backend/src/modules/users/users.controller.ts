import type { Request, Response } from 'express';
import { authOf } from '../../middleware/authenticate';
import { bodyOf, paramsOf, queryOf } from '../../middleware/validate';
import { changePassword } from '../auth/auth.service';
import * as s from './users.schemas';
import * as users from './users.service';

export const getMe = async (req: Request, res: Response) => {
  res.json({ data: await users.getMe(authOf(req).userId) });
};

export const updateMe = async (req: Request, res: Response) => {
  res.json({ data: await users.updateMe(authOf(req).userId, bodyOf(req, s.updateMeBody)) });
};

export const changeMyPassword = async (req: Request, res: Response) => {
  const { userId, sessionId } = authOf(req);
  await changePassword(userId, sessionId, bodyOf(req, s.changePasswordBody));
  res.json({ data: { message: 'Password updated. Other sessions have been signed out.' } });
};

export const listUsers = async (req: Request, res: Response) => {
  res.json({ data: await users.listUsers(queryOf(req, s.listUsersQuery)) });
};

export const getUser = async (req: Request, res: Response) => {
  res.json({ data: await users.getUser(paramsOf(req, s.userIdParams).userId) });
};

export const updateUser = async (req: Request, res: Response) => {
  const { userId } = paramsOf(req, s.userIdParams);
  res.json({ data: await users.adminUpdateUser(authOf(req).userId, userId, bodyOf(req, s.adminUpdateUserBody)) });
};
