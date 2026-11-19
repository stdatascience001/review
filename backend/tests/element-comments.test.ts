import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, PASSWORD, makeApp, prisma, request, resetDb, signUp, type TestUser } from './helpers';

/**
 * Element-based comments: a widget comment can point at one element of the page. The element
 * anchor (selector, tag, text, position) is validated, saved with the task, and returned in
 * the widget list/detail (so the widget can group by page and jump to the element) and in
 * the dashboard task (metadata.element).
 */
const app = makeApp();
const ORIGIN = 'https://shop.example.com';

let owner: TestUser;
let client: TestUser;
let siteId: string;

const widget = async (email: string) => {
  const res = await request(app).post(`${API}/widget/auth/login`).set('Origin', ORIGIN).send({ siteId, email, password: PASSWORD });
  const token = res.body.data.session.accessToken as string;
  return {
    get: (p: string) => request(app).get(`${API}/widget${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
    post: (p: string) => request(app).post(`${API}/widget${p}`).set('Origin', ORIGIN).set('Authorization', `Bearer ${token}`),
  };
};

const heading = {
  selector: 'main > section:nth-of-type(2) > h3',
  tag: 'h3',
  text: 'We’re All About Relationships and Results',
  rect: { x: 360, y: 1290, width: 1170, height: 30 },
  viewportWidth: 1440,
};

beforeAll(async () => {
  await resetDb();
  [owner, client] = await Promise.all([signUp(app, { name: 'Owner' }), signUp(app, { name: 'Client' })]);
  const w = (await owner.agent.post(`${API}/websites`).send({ name: 'Shop', url: ORIGIN })).body.data;
  siteId = w.siteId;
});
afterAll(() => prisma.$disconnect());

describe('element anchors on widget comments', () => {
  let elementTaskId: string;

  it('saves the picked element with the comment, linked to page, project and user', async () => {
    const w = await widget(client.email); // auto-joins as Website User
    const res = await w.post('/tasks').send({ title: 'Heading wording', pageUrl: `${ORIGIN}/about`, pageTitle: 'About', element: heading });
    expect(res.status).toBe(201);
    elementTaskId = res.body.data.id;
    expect(res.body.data.element).toEqual(heading);

    const row = await prisma.task.findUniqueOrThrow({ where: { id: elementTaskId } });
    expect(row.pageUrl).toBe(`${ORIGIN}/about`);
    expect(row.creatorId).toBe(client.id);
    expect((row.metadata as { element: unknown }).element).toEqual(heading);
  });

  it('whole-page comments (and older tasks) have no element', async () => {
    const w = await widget(client.email);
    const res = await w.post('/tasks').send({ title: 'Page is slow', pageUrl: `${ORIGIN}/` });
    expect(res.status).toBe(201);
    expect(res.body.data.element).toBeNull();
  });

  it('the list and the detail return the element; the dashboard sees it in metadata', async () => {
    const w = await widget(client.email);
    const list = (await w.get('/tasks')).body.data.items;
    const t = list.find((x: { id: string }) => x.id === elementTaskId);
    expect(t.element).toEqual(heading);
    expect((await w.get(`/tasks/${elementTaskId}`)).body.data.element).toEqual(heading);
    // page filter still works per page
    expect((await w.get(`/tasks?pageUrl=${encodeURIComponent(`${ORIGIN}/about`)}`)).body.data.items.map((x: { id: string }) => x.id)).toEqual([elementTaskId]);

    const dash = await owner.agent.get(`${API}/tasks/${elementTaskId}`);
    expect(dash.body.data.metadata.element).toMatchObject({ tag: 'h3', text: heading.text });
  });

  it('rejects malformed anchors', async () => {
    const w = await widget(client.email);
    for (const element of [
      { ...heading, tag: '<script>' },
      { ...heading, selector: '' },
      { ...heading, selector: 'x'.repeat(1001) },
      { ...heading, text: 'y'.repeat(201) },
      { ...heading, rect: { x: 0, y: 0, width: -5, height: 1 } },
    ]) {
      const res = await w.post('/tasks').send({ title: 'bad', pageUrl: ORIGIN, element });
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    }
  });

  it('a tampered element stored in metadata is not returned to the widget', async () => {
    const t = await prisma.task.findUniqueOrThrow({ where: { id: elementTaskId } });
    await prisma.task.update({ where: { id: t.id }, data: { metadata: { ...(t.metadata as object), element: { tag: 'h3' } } } });
    const w = await widget(client.email);
    expect((await w.get(`/tasks/${elementTaskId}`)).body.data.element).toBeNull();
  });
});
