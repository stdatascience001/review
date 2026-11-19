import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, resetDb } from './helpers';

/** The database itself enforces integrity, independent of the API layer. */
beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

const user = (email: string) => prisma.user.create({ data: { email, name: 'DB' } });

describe('database constraints', () => {
  it('rejects non-lowercase emails and duplicate emails', async () => {
    await expect(user('Mixed@Example.com')).rejects.toThrow(/users_email_lowercase_chk/);
    await user('dup@example.com');
    await expect(user('dup@example.com')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces slug format, one OWNER per website, and unique membership', async () => {
    const owner = await user('owner@example.com');
    await expect(
      prisma.website.create({ data: { name: 'x', slug: 'Bad Slug!', url: 'https://x.y', ownerId: owner.id, siteId: 'site_' + Math.random().toString(16).slice(2, 18).padEnd(16, '0'), verificationToken: 'tok' } }),
    ).rejects.toThrow(/websites_slug_format_chk/);

    const w = await prisma.website.create({ data: { name: 'x', slug: 'x', url: 'https://x.y', ownerId: owner.id, siteId: 'site_' + Math.random().toString(16).slice(2, 18).padEnd(16, '0'), verificationToken: 'tok' } });
    const other = await user('other@example.com');
    await prisma.websiteMember.create({ data: { websiteId: w.id, userId: owner.id, role: 'OWNER' } });
    await expect(
      prisma.websiteMember.create({ data: { websiteId: w.id, userId: other.id, role: 'OWNER' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.websiteMember.create({ data: { websiteId: w.id, userId: owner.id, role: 'DEVELOPER' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('enforces project date order, non-blank titles and the owner FK (Restrict)', async () => {
    const owner = await user('fk@example.com');
    const w = await prisma.website.create({ data: { name: 'w', slug: 'w', url: 'https://w.y', ownerId: owner.id, siteId: 'site_' + Math.random().toString(16).slice(2, 18).padEnd(16, '0'), verificationToken: 'tok' } });
    await expect(
      prisma.project.create({
        data: { websiteId: w.id, name: 'p', startDate: new Date('2026-02-01'), dueDate: new Date('2026-01-01') },
      }),
    ).rejects.toThrow(/projects_dates_chk/);
    const p = await prisma.project.create({ data: { websiteId: w.id, name: 'p' } });
    await expect(
      prisma.task.create({ data: { websiteId: w.id, projectId: p.id, title: '   ' } }),
    ).rejects.toThrow(/tasks_title_not_blank_chk/);
    // A user who owns a website cannot be deleted out from under it.
    await expect(prisma.user.delete({ where: { id: owner.id } })).rejects.toThrow();
  });
});
