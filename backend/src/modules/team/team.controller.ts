import type { Request, Response } from 'express';
import { z } from 'zod';
import { authOf } from '../../middleware/authenticate';
import { bodyOf, paramsOf } from '../../middleware/validate';
import * as ws from '../websites/websites.schemas';
import * as team from './team.service';

export const tokenBody = z.object({ token: z.string().min(20).max(200) });
export const tokenParams = z.object({ token: z.string().min(20).max(200) });

export const listMembers = async (req: Request, res: Response) => {
  res.json({ data: await team.listMembers(authOf(req).userId, paramsOf(req, ws.websiteIdParams).websiteId) });
};

export const addMember = async (req: Request, res: Response) => {
  const { websiteId } = paramsOf(req, ws.websiteIdParams);
  res.status(201).json({ data: await team.addMember(authOf(req).userId, websiteId, bodyOf(req, ws.addMemberBody)) });
};

export const updateMember = async (req: Request, res: Response) => {
  const { websiteId, userId } = paramsOf(req, ws.memberParams);
  const { role } = bodyOf(req, ws.updateMemberBody);
  res.json({ data: await team.updateMemberRole(authOf(req).userId, websiteId, userId, role) });
};

export const setMemberProjects = async (req: Request, res: Response) => {
  const { websiteId, userId } = paramsOf(req, ws.memberParams);
  const { projects } = bodyOf(req, ws.setMemberProjectsBody);
  res.json({ data: await team.setMemberProjects(authOf(req).userId, websiteId, userId, projects) });
};

export const removeMember = async (req: Request, res: Response) => {
  const { websiteId, userId } = paramsOf(req, ws.memberParams);
  await team.removeMember(authOf(req).userId, websiteId, userId);
  res.status(204).end();
};

export const invite = async (req: Request, res: Response) => {
  const { websiteId } = paramsOf(req, ws.websiteIdParams);
  res.status(201).json({ data: await team.invite(authOf(req).userId, websiteId, bodyOf(req, ws.inviteBody)) });
};

export const listInvitations = async (req: Request, res: Response) => {
  res.json({ data: await team.listInvitations(authOf(req).userId, paramsOf(req, ws.websiteIdParams).websiteId) });
};

export const revokeInvitation = async (req: Request, res: Response) => {
  const { websiteId, invitationId } = paramsOf(req, ws.invitationParams);
  await team.revokeInvitation(authOf(req).userId, websiteId, invitationId);
  res.status(204).end();
};

export const resendInvitation = async (req: Request, res: Response) => {
  const { websiteId, invitationId } = paramsOf(req, ws.invitationParams);
  res.json({ data: await team.resendInvitation(authOf(req).userId, websiteId, invitationId) });
};

export const performance = async (req: Request, res: Response) => {
  res.json({ data: await team.performance(authOf(req).userId, paramsOf(req, ws.websiteIdParams).websiteId) });
};

export const previewInvitation = async (req: Request, res: Response) => {
  res.json({ data: await team.previewInvitation(paramsOf(req, tokenParams).token) });
};

export const acceptInvitation = async (req: Request, res: Response) => {
  res.json({ data: await team.acceptInvitation(authOf(req).userId, bodyOf(req, tokenBody).token) });
};
