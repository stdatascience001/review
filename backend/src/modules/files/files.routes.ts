import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import { filePath, verifyFileSignature } from '../../lib/storage';

const params = z.object({ id: z.string().uuid() });
const query = z.object({ exp: z.coerce.number().int(), sig: z.string().min(10).max(100) });

/** GET /files/:id?exp=&sig= — serves an uploaded file through a signed, expiring URL. */
export const filesRoutes = () => {
  const r = Router();
  r.get('/:id', async (req, res) => {
    const p = params.safeParse(req.params);
    const q = query.safeParse(req.query);
    // Same 404 for bad signatures and missing files: nothing to enumerate.
    if (!p.success || !q.success || !verifyFileSignature(p.data.id, q.data.exp, q.data.sig)) throw notFound('File not found');
    const file = await prisma.taskAttachment.findUnique({
      where: { id: p.data.id },
      select: { storageKey: true, mimeType: true, fileName: true },
    });
    if (!file) throw notFound('File not found');
    res.set({
      'Content-Type': file.mimeType,
      'Cache-Control': 'private, max-age=3600',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // Images display inline; every other type downloads.
      'Content-Disposition': `${file.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${file.fileName.replace(/[^\w.-]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    // The path comes from our own storage key (not the request), so dot-directories are fine.
    res.sendFile(filePath(file.storageKey), { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
    });
  });
  return r;
};
