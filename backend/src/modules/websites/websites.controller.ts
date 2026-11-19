import type { Request, Response } from 'express';
import { authOf } from '../../middleware/authenticate';
import { bodyOf, paramsOf, queryOf } from '../../middleware/validate';
import * as s from './websites.schemas';
import * as websites from './websites.service';

export const list = async (req: Request, res: Response) => {
  res.json({ data: await websites.listForUser(authOf(req).userId, queryOf(req, s.listWebsitesQuery)) });
};

export const create = async (req: Request, res: Response) => {
  res.status(201).json({ data: await websites.create(authOf(req).userId, bodyOf(req, s.createWebsiteBody)) });
};

export const get = async (req: Request, res: Response) => {
  res.json({ data: await websites.get(authOf(req).userId, paramsOf(req, s.websiteIdParams).websiteId) });
};

export const update = async (req: Request, res: Response) => {
  const { websiteId } = paramsOf(req, s.websiteIdParams);
  res.json({ data: await websites.update(authOf(req).userId, websiteId, bodyOf(req, s.updateWebsiteBody)) });
};

export const remove = async (req: Request, res: Response) => {
  await websites.remove(authOf(req).userId, paramsOf(req, s.websiteIdParams).websiteId);
  res.status(204).end();
};

export const regenerateSiteId = async (req: Request, res: Response) => {
  res.json({ data: await websites.regenerateSiteId(authOf(req).userId, paramsOf(req, s.websiteIdParams).websiteId) });
};

export const verifyDomain = async (req: Request, res: Response) => {
  res.json({ data: await websites.verifyDomain(authOf(req).userId, paramsOf(req, s.websiteIdParams).websiteId) });
};

export const getSettings = async (req: Request, res: Response) => {
  res.json({ data: await websites.getSettings(authOf(req).userId, paramsOf(req, s.websiteIdParams).websiteId) });
};

export const updateSettings = async (req: Request, res: Response) => {
  const { websiteId } = paramsOf(req, s.websiteIdParams);
  res.json({ data: await websites.updateSettings(authOf(req).userId, websiteId, bodyOf(req, s.updateSettingsBody)) });
};
