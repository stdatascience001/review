import type { Request, Response } from 'express';
import { authOf } from '../../middleware/authenticate';
import { bodyOf, paramsOf, queryOf } from '../../middleware/validate';
import { websiteIdParams } from '../websites/websites.schemas';
import * as s from './projects.schemas';
import * as projects from './projects.service';

// /projects (cross-website)
export const listAll = async (req: Request, res: Response) => {
  res.json({ data: await projects.listAll(authOf(req).userId, queryOf(req, s.listAllProjectsQuery)) });
};

export const create = async (req: Request, res: Response) => {
  const { websiteId, ...input } = bodyOf(req, s.createProjectWithWebsiteBody);
  res.status(201).json({ data: await projects.create(authOf(req).userId, websiteId, input) });
};

// /websites/:websiteId/projects
export const listForWebsite = async (req: Request, res: Response) => {
  const { websiteId } = paramsOf(req, websiteIdParams);
  res.json({ data: await projects.listForWebsite(authOf(req).userId, websiteId, queryOf(req, s.listProjectsQuery)) });
};

export const createForWebsite = async (req: Request, res: Response) => {
  const { websiteId } = paramsOf(req, websiteIdParams);
  res.status(201).json({ data: await projects.create(authOf(req).userId, websiteId, bodyOf(req, s.createProjectBody)) });
};

// /projects/:projectId
export const get = async (req: Request, res: Response) => {
  res.json({ data: await projects.get(authOf(req).userId, paramsOf(req, s.projectIdParams).projectId) });
};

export const update = async (req: Request, res: Response) => {
  const { projectId } = paramsOf(req, s.projectIdParams);
  res.json({ data: await projects.update(authOf(req).userId, projectId, bodyOf(req, s.updateProjectBody)) });
};

export const remove = async (req: Request, res: Response) => {
  await projects.remove(authOf(req).userId, paramsOf(req, s.projectIdParams).projectId);
  res.status(204).end();
};

export const listMembers = async (req: Request, res: Response) => {
  res.json({ data: await projects.listMembers(authOf(req).userId, paramsOf(req, s.projectIdParams).projectId) });
};

export const addMember = async (req: Request, res: Response) => {
  const { projectId } = paramsOf(req, s.projectIdParams);
  res.status(201).json({ data: await projects.addMember(authOf(req).userId, projectId, bodyOf(req, s.addProjectMemberBody)) });
};

export const updateMember = async (req: Request, res: Response) => {
  const { projectId, userId } = paramsOf(req, s.projectMemberParams);
  const { role } = bodyOf(req, s.updateProjectMemberBody);
  res.json({ data: await projects.updateMember(authOf(req).userId, projectId, userId, role) });
};

export const removeMember = async (req: Request, res: Response) => {
  const { projectId, userId } = paramsOf(req, s.projectMemberParams);
  await projects.removeMember(authOf(req).userId, projectId, userId);
  res.status(204).end();
};
