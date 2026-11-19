import { z } from 'zod';
import { ProjectRole, TaskPriority, WebsiteRole, WebsiteStatus } from '@prisma/client';
import { emailSchema } from '../auth/auth.schemas';
import { paginationQuery } from '../../lib/pagination';

const httpUrl = z
  .string()
  .trim()
  .url('Must be a valid URL')
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), 'URL must start with http:// or https://');

const logoUrl = z
  .string()
  .trim()
  .url('Must be a valid URL')
  .max(2048)
  .refine((v) => /^https:\/\//i.test(v), 'Logo URL must use https://');

export const websiteIdParams = z.object({ websiteId: z.string().uuid() });
export const memberParams = websiteIdParams.extend({ userId: z.string().uuid() });
export const invitationParams = websiteIdParams.extend({ invitationId: z.string().uuid() });

export const listWebsitesQuery = paginationQuery.extend({
  q: z.string().trim().max(200).optional(),
  status: z.nativeEnum(WebsiteStatus).optional(),
});

export const createWebsiteBody = z.object({
  name: z.string().trim().min(1).max(120),
  url: httpUrl,
  description: z.string().trim().max(2000).optional(),
  logoUrl: logoUrl.optional(),
  status: z.nativeEnum(WebsiteStatus).optional(),
});

export const updateWebsiteBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    url: httpUrl.optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    logoUrl: logoUrl.nullable().optional(),
    status: z.nativeEnum(WebsiteStatus).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$|^localhost$/, 'Invalid domain');

export const updateSettingsBody = z
  .object({
    timezone: z
      .string()
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid IANA timezone')
      .optional(),
    defaultTaskPriority: z.nativeEnum(TaskPriority).optional(),
    clientsCanCreateTasks: z.boolean().optional(),
    widgetAutoJoin: z.boolean().optional(),
    emailNotifications: z.boolean().optional(),
    allowedDomains: z.array(domainSchema).max(50).optional(),
    widgetEnabled: z.boolean().optional(),
    widgetProjectId: z.string().uuid().nullable().optional(),
    brandColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color like #1A2B3C')
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

/** OWNER can only be held by the website creator, never assigned through the API. */
export const assignableRole = z.enum([
  WebsiteRole.ADMIN,
  WebsiteRole.PROJECT_MANAGER,
  WebsiteRole.DEVELOPER,
  WebsiteRole.WEBSITE_USER,
]);

export const addMemberBody = z.object({
  email: emailSchema,
  role: assignableRole.default(WebsiteRole.DEVELOPER),
});

export const updateMemberBody = z.object({ role: assignableRole });

export const inviteBody = z.object({
  email: emailSchema,
  role: assignableRole.default(WebsiteRole.DEVELOPER),
  projectIds: z.array(z.string().uuid()).max(100).default([]),
});

export const setMemberProjectsBody = z.object({
  projects: z
    .array(z.object({ projectId: z.string().uuid(), role: z.nativeEnum(ProjectRole).optional() }))
    .max(200),
});
