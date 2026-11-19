import crypto from 'node:crypto';
import { deleteFiles } from '../../lib/storage';
import { Prisma, WebsiteRole, type WebsiteStatus } from '@prisma/client';
import { env } from '../../config/env';
import { badRequest, conflict } from '../../lib/errors';
import { generateToken } from '../../lib/crypto';
import { paginated, toSkipTake, type Pagination } from '../../lib/pagination';
import { prisma } from '../../lib/prisma';
import {
  accessibleWebsiteWhere,
  getWebsiteAccess,
  isSuperAdmin,
  requireWebsitePermission,
} from '../access/access.service';
import { fetchHomepage, findVerificationMarker } from './domain-verification';

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'website';

/** Public site identifier used by the embed script, e.g. site_3f9a0c1d2e4b5a6c7d8e. */
export const generateSiteId = () => `site_${crypto.randomBytes(10).toString('hex')}`;
const generateVerificationToken = () => crypto.randomBytes(16).toString('hex');

export const websiteSelect = {
  id: true,
  name: true,
  slug: true,
  url: true,
  description: true,
  logoUrl: true,
  status: true,
  siteId: true,
  domainVerifiedAt: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WebsiteSelect;

/**
 * The snippet customers paste on their site. The loader calls the API on its own origin;
 * when the script is served from elsewhere (CDN), data-api-url tells it where the API is.
 */
export const buildEmbedScript = (siteId: string) => {
  const apiOrigin = new URL(env.API_URL).origin;
  const apiAttr = new URL(env.embedScriptUrl).origin === apiOrigin ? '' : ` data-api-url="${apiOrigin}/api/v1"`;
  return `<script src="${env.embedScriptUrl}" data-site-id="${siteId}"${apiAttr} async></script>`;
};

const verificationMetaTag = (token: string) => `<meta name="wrtm-site-verification" content="${token}">`;

export const create = async (
  userId: string,
  input: { name: string; url: string; description?: string; logoUrl?: string; status?: WebsiteStatus },
) => {
  const base = slugify(input.name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${generateToken(4).toLowerCase().replace(/[^a-z0-9]/g, '') || attempt}`;
    try {
      const website = await prisma.$transaction(async (tx) => {
        const w = await tx.website.create({
          data: {
            ...input,
            slug,
            ownerId: userId,
            siteId: generateSiteId(),
            verificationToken: generateVerificationToken(),
          },
          select: websiteSelect,
        });
        await tx.websiteMember.create({ data: { websiteId: w.id, userId, role: WebsiteRole.OWNER } });
        await tx.websiteSettings.create({ data: { websiteId: w.id } });
        return w;
      });
      return { ...website, role: WebsiteRole.OWNER, embedScript: buildEmbedScript(website.siteId) };
    } catch (err) {
      const isSlugClash =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        JSON.stringify(err.meta?.target ?? '').includes('slug');
      if (!isSlugClash) throw err;
    }
  }
  throw conflict('Could not generate a unique slug, please choose a different name');
};

/** Websites the user can access (all of them for SUPER_ADMIN), with search/filter/pagination. */
export const listForUser = async (
  userId: string,
  query: Pagination & { q?: string; status?: WebsiteStatus },
) => {
  const where: Prisma.WebsiteWhereInput = {
    AND: [
      await accessibleWebsiteWhere(userId),
      query.status ? { status: query.status } : {},
      query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { url: { contains: query.q, mode: 'insensitive' } },
              { siteId: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  };
  const [rows, total] = await prisma.$transaction([
    prisma.website.findMany({
      where,
      select: {
        ...websiteSelect,
        members: { where: { userId }, select: { role: true } },
        _count: { select: { members: true, projects: true, tasks: true } },
      },
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
    }),
    prisma.website.count({ where }),
  ]);
  const superAdmin = await isSuperAdmin(userId);
  const items = rows.map(({ members, ...w }) => ({
    ...w,
    role: members[0]?.role ?? (superAdmin ? WebsiteRole.OWNER : null),
  }));
  return paginated(items, total, query);
};

export const get = async (userId: string, websiteId: string) => {
  const { role } = await getWebsiteAccess(userId, websiteId);
  const website = await prisma.website.findUniqueOrThrow({
    where: { id: websiteId },
    select: {
      ...websiteSelect,
      verificationToken: true,
      settings: true,
      _count: { select: { members: true, projects: true, tasks: true } },
    },
  });
  const { verificationToken, ...rest } = website;
  const canManage = role === WebsiteRole.OWNER || role === WebsiteRole.ADMIN;
  return {
    ...rest,
    role,
    embedScript: buildEmbedScript(website.siteId),
    // The verification token is only needed (and shown) to website managers.
    verification: canManage ? { metaTag: verificationMetaTag(verificationToken), token: verificationToken } : null,
  };
};

export const update = async (
  userId: string,
  websiteId: string,
  data: { name?: string; url?: string; description?: string | null; logoUrl?: string | null; status?: WebsiteStatus },
) => {
  const { role } = await requireWebsitePermission(userId, websiteId, 'website:update');
  const current = await prisma.website.findUniqueOrThrow({ where: { id: websiteId }, select: { url: true } });
  const urlHostChanged = data.url !== undefined && new URL(data.url).host !== new URL(current.url).host;
  const website = await prisma.website.update({
    where: { id: websiteId },
    // Changing the domain invalidates a previous ownership verification.
    data: { ...data, ...(urlHostChanged ? { domainVerifiedAt: null } : {}) },
    select: websiteSelect,
  });
  return { ...website, role, embedScript: buildEmbedScript(website.siteId) };
};

export const remove = async (userId: string, websiteId: string) => {
  await requireWebsitePermission(userId, websiteId, 'website:delete');
  // Rows cascade in the database; the uploaded files on disk must be removed too.
  const files = await prisma.taskAttachment.findMany({ where: { task: { websiteId } }, select: { storageKey: true } });
  await prisma.website.delete({ where: { id: websiteId } });
  await deleteFiles(files.map((f) => f.storageKey));
};

/** Issues a new Site ID; the old embed script stops working. */
export const regenerateSiteId = async (userId: string, websiteId: string) => {
  await requireWebsitePermission(userId, websiteId, 'website:update');
  const website = await prisma.website.update({
    where: { id: websiteId },
    data: { siteId: generateSiteId() },
    select: websiteSelect,
  });
  return { ...website, embedScript: buildEmbedScript(website.siteId) };
};

export const verifyDomain = async (userId: string, websiteId: string) => {
  await requireWebsitePermission(userId, websiteId, 'website:update');
  const website = await prisma.website.findUniqueOrThrow({
    where: { id: websiteId },
    select: { url: true, siteId: true, verificationToken: true, domainVerifiedAt: true },
  });

  let result: { verified: boolean; method: string | null; checkedUrl: string; error: string | null };
  try {
    const { finalUrl, html } = await fetchHomepage(website.url);
    const method = findVerificationMarker(html, website);
    result = {
      verified: Boolean(method),
      method,
      checkedUrl: finalUrl,
      error: method ? null : 'Verification meta tag or embed script was not found on the page',
    };
  } catch (err) {
    result = { verified: false, method: null, checkedUrl: website.url, error: (err as Error).message || 'Request failed' };
  }

  const updated = await prisma.website.update({
    where: { id: websiteId },
    data: { domainVerifiedAt: result.verified ? new Date() : website.domainVerifiedAt },
    select: { domainVerifiedAt: true },
  });
  return { ...result, domainVerifiedAt: updated.domainVerifiedAt };
};

// ───────────────────────────── Settings ─────────────────────────────

export const getSettings = async (userId: string, websiteId: string) => {
  await getWebsiteAccess(userId, websiteId);
  return prisma.websiteSettings.upsert({ where: { websiteId }, create: { websiteId }, update: {} });
};

export const updateSettings = async (
  userId: string,
  websiteId: string,
  data: Prisma.WebsiteSettingsUncheckedUpdateInput,
) => {
  await requireWebsitePermission(userId, websiteId, 'website:settings:update');
  if (Array.isArray(data.allowedDomains)) data.allowedDomains = [...new Set(data.allowedDomains as string[])];
  if (typeof data.widgetProjectId === 'string') {
    const project = await prisma.project.findFirst({ where: { id: data.widgetProjectId, websiteId }, select: { id: true } });
    if (!project) throw badRequest('Widget project must belong to this website', 'INVALID_PROJECT');
  }
  return prisma.websiteSettings.upsert({
    where: { websiteId },
    create: { ...(data as Prisma.WebsiteSettingsUncheckedCreateInput), websiteId },
    update: data,
  });
};
