import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, makeApp, prisma, resetDb, signUp, type TestUser } from './helpers';

/**
 * Admin analytics against known data: totals, website-wise and developer-wise statistics,
 * date-wise timelines (day/week/month), filters, the CSV report, and who may see what.
 */
const app = makeApp();
let owner: TestUser;
let dev1: TestUser;
let dev2: TestUser;
let otherOwner: TestUser;
let w1: string;
let w2: string;
let p1: string;
let p2: string;

const day = (d: string, h = 10) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00Z`);

beforeAll(async () => {
  await resetDb();
  [owner, dev1, dev2, otherOwner] = await Promise.all([
    signUp(app, { name: 'Analyst Owner' }),
    signUp(app, { name: 'Dev One' }),
    signUp(app, { name: 'Dev Two' }),
    signUp(app, { name: 'Other Owner' }),
  ]);
  w1 = (await owner.agent.post(`${API}/websites`).send({ name: 'Site One', url: 'https://one.example.com' })).body.data.id;
  w2 = (await owner.agent.post(`${API}/websites`).send({ name: 'Site Two', url: 'https://two.example.com' })).body.data.id;
  p1 = (await owner.agent.post(`${API}/websites/${w1}/projects`).send({ name: 'P1' })).body.data.id;
  p2 = (await owner.agent.post(`${API}/websites/${w2}/projects`).send({ name: 'P2' })).body.data.id;
  for (const [w, p] of [
    [w1, p1],
    [w2, p2],
  ]) {
    for (const d of [dev1, dev2]) {
      await owner.agent.post(`${API}/websites/${w}/members`).send({ email: d.email, role: 'DEVELOPER' }).expect(201);
      await owner.agent.put(`${API}/websites/${w}/members/${d.id}/projects`).send({ projects: [{ projectId: p }] }).expect(200);
    }
  }
  const ow = (await otherOwner.agent.post(`${API}/websites`).send({ name: 'Elsewhere', url: 'https://else.example.com' })).body.data.id;
  const op = (await otherOwner.agent.post(`${API}/websites/${ow}/projects`).send({ name: 'X' })).body.data.id;

  // Known data, with explicit dates (UTC):
  // Site One: 4 tasks — dev1 completes 2 (24h and 48h), dev2 has 1 in progress (overdue), 1 open unassigned
  // Site Two: 2 tasks — dev1 completed 1 (12h), 1 archived
  // Elsewhere: 1 task (other tenant, never counted)
  const mk = async (data: Record<string, unknown>) =>
    prisma.task.create({ data: { title: String(data.title), websiteId: String(data.websiteId), projectId: String(data.projectId), creatorId: owner.id, ...data } as never });
  await mk({ title: 'A', websiteId: w1, projectId: p1, type: 'BUG', priority: 'HIGH', assigneeId: dev1.id, status: 'COMPLETED', createdAt: day('2026-03-01'), completedAt: day('2026-03-02') });
  await mk({ title: 'B', websiteId: w1, projectId: p1, type: 'BUG', priority: 'LOW', assigneeId: dev1.id, status: 'COMPLETED', createdAt: day('2026-03-02'), completedAt: day('2026-03-04') });
  await mk({ title: '=HYPERLINK("evil")', websiteId: w1, projectId: p1, type: 'UI_ISSUE', priority: 'URGENT', assigneeId: dev2.id, status: 'IN_PROGRESS', createdAt: day('2026-03-02'), dueDate: day('2026-03-03') });
  await mk({ title: 'D', websiteId: w1, projectId: p1, type: 'FEATURE', priority: 'MEDIUM', status: 'OPEN', createdAt: day('2026-03-09') });
  await mk({ title: 'E', websiteId: w2, projectId: p2, type: 'IMPROVEMENT', priority: 'MEDIUM', assigneeId: dev1.id, status: 'COMPLETED', createdAt: day('2026-03-05', 0), completedAt: day('2026-03-05', 12) });
  await mk({ title: 'F', websiteId: w2, projectId: p2, type: 'OTHER', priority: 'LOW', status: 'ARCHIVED', createdAt: day('2026-03-06') });
  await mk({ title: 'Z', websiteId: ow, projectId: op, status: 'OPEN', createdAt: day('2026-03-03') });
});
afterAll(() => prisma.$disconnect());

const get = (u: TestUser, q: Record<string, string>) => u.agent.get(`${API}/analytics`).query(q);

describe('analytics', () => {
  it('totals and breakdowns are exact and tenant-scoped', async () => {
    const res = await get(owner, { from: '2026-03-01', to: '2026-03-31' });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.totals).toEqual({
      websites: 2,
      projects: 2,
      users: 3, // owner + 2 devs
      tasks: 6,
      openTasks: 1,
      inProgressTasks: 1,
      completedTasks: 3,
      archivedTasks: 1,
      overdueTasks: 1,
      createdInRange: 6,
      completedInRange: 3,
      reopenedInRange: 0,
      avgResolutionHours: 28, // (24 + 48 + 12) / 3
    });
    expect(d.byType).toEqual(expect.arrayContaining([{ type: 'BUG', count: 2 }, { type: 'UI_ISSUE', count: 1 }]));
    expect(d.byStatus.find((s: { status: string }) => s.status === 'COMPLETED').count).toBe(3);
  });

  it('website-wise task statistics', async () => {
    const d = (await get(owner, { from: '2026-03-01', to: '2026-03-31' })).body.data;
    expect(d.byWebsite).toEqual([
      expect.objectContaining({ website: { id: w1, name: 'Site One' }, total: 4, open: 1, inProgress: 1, completed: 2, overdue: 1, completionRate: 50, avgResolutionHours: 36 }),
      expect.objectContaining({ website: { id: w2, name: 'Site Two' }, total: 2, completed: 1, archived: 1, completionRate: 100, avgResolutionHours: 12 }),
    ]);
  });

  it('developer-wise performance', async () => {
    const d = (await get(owner, { from: '2026-03-01', to: '2026-03-31' })).body.data;
    const byName = Object.fromEntries(d.byDeveloper.map((r: { user: { name: string } }) => [r.user.name, r]));
    expect(byName['Dev One']).toMatchObject({ assigned: 3, completed: 3, completedInRange: 3, inProgress: 0, overdue: 0, completionRate: 100, avgResolutionHours: 28 });
    expect(byName['Dev Two']).toMatchObject({ assigned: 1, completed: 0, inProgress: 1, overdue: 1, completionRate: 0, avgResolutionHours: null });
    expect(d.byDeveloper[0].user.name).toBe('Dev One'); // ranked by completed work
  });

  it('date-wise reports: day, week and month buckets, and the range filter', async () => {
    const daily = (await get(owner, { from: '2026-03-01', to: '2026-03-07', interval: 'day' })).body.data.timeline;
    expect(daily).toHaveLength(7);
    expect(daily.slice(0, 5)).toEqual([
      { date: '2026-03-01', created: 1, completed: 0 },
      { date: '2026-03-02', created: 2, completed: 1 },
      { date: '2026-03-03', created: 0, completed: 0 },
      { date: '2026-03-04', created: 0, completed: 1 },
      { date: '2026-03-05', created: 1, completed: 1 },
    ]);
    const weekly = (await get(owner, { from: '2026-03-01', to: '2026-03-31', interval: 'week' })).body.data.timeline;
    expect(weekly.reduce((s: number, b: { created: number }) => s + b.created, 0)).toBe(6);
    expect(weekly[0].date).toBe('2026-02-23'); // ISO week containing Mar 1
    const monthly = (await get(owner, { from: '2026-01-01', to: '2026-03-31', interval: 'month' })).body.data.timeline;
    expect(monthly).toEqual([
      { date: '2026-01-01', created: 0, completed: 0 },
      { date: '2026-02-01', created: 0, completed: 0 },
      { date: '2026-03-01', created: 6, completed: 3 },
    ]);
    // Narrow range: only what happened in it
    const narrow = (await get(owner, { from: '2026-03-09', to: '2026-03-09' })).body.data.totals;
    expect(narrow).toMatchObject({ createdInRange: 1, completedInRange: 0, tasks: 6 /* snapshot */ });
  });

  it('filters by website and project', async () => {
    const one = (await get(owner, { from: '2026-03-01', to: '2026-03-31', websiteId: w1 })).body.data;
    expect(one.totals).toMatchObject({ websites: 1, tasks: 4, createdInRange: 4 });
    expect(one.byWebsite).toHaveLength(1);
    const proj = (await get(owner, { from: '2026-03-01', to: '2026-03-31', projectId: p2 })).body.data;
    expect(proj.totals).toMatchObject({ tasks: 2, completedTasks: 1 });
  });

  it('validates ranges and parameters', async () => {
    expect((await get(owner, { from: '2026-03-10', to: '2026-03-01' })).body.error.code).toBe('INVALID_RANGE');
    expect((await get(owner, { from: '2020-01-01', to: '2026-03-01', interval: 'day' })).body.error.code).toBe('INVALID_RANGE');
    expect((await get(owner, { from: 'yesterday' })).status).toBe(400);
    expect((await get(owner, { interval: 'hour' })).status).toBe(400);
  });

  it('exports a CSV report (spreadsheet-safe)', async () => {
    const res = await owner.agent.get(`${API}/analytics/tasks.csv`).query({ from: '2026-03-01', to: '2026-03-31', websiteId: w1 });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="tasks-2026-03-01-to-2026-03-31.csv"');
    const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Task ID,Created,Website,Project,Title,Type,Priority,Status,Reporter,Assignee,Due,Completed,Resolution hours');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/^TASK-\d+,2026-03-01T10:00:00.000Z,Site One,P1,A,BUG,HIGH,COMPLETED,.*,24$/);
    expect(res.text).toContain(`"'=HYPERLINK(""evil"")"`); // formula injection neutralised
  });

  it('access: owners/admins only, and only for their own websites', async () => {
    const dev = await get(dev1, {});
    expect([dev.status, dev.body.error.code]).toEqual([403, 'ANALYTICS_FORBIDDEN']);
    expect((await get(otherOwner, { websiteId: w1 })).status).toBe(404);
    const theirs = (await get(otherOwner, { from: '2026-03-01', to: '2026-03-31' })).body.data;
    expect(theirs.totals.tasks).toBe(1);
    const admin = await signUp(app, { name: 'Super' });
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'SUPER_ADMIN' } });
    expect((await get(admin, { from: '2026-03-01', to: '2026-03-31' })).body.data.totals.tasks).toBe(7);
  });
});
