import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { badRequest } from './errors';

/**
 * Local-disk file storage for uploads (task screenshots).
 * Files are stored under env.uploadDir with random names and served only through
 * signed, expiring URLs (GET /api/v1/files/:id?exp=&sig=), so an <img> on any
 * origin can show them without cookies or bearer tokens, and URLs can't be guessed.
 */

export const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;
export type ImageMime = keyof typeof IMAGE_TYPES;

/** Checks the file signature, not just the Content-Type header. */
export const sniffImage = (buf: Buffer): ImageMime | null => {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

/**
 * Allowed upload types, decided from the file content (and, for container/text formats,
 * the extension). Anything executable in a browser (HTML, SVG, JS) is refused.
 */
const ZIP_TYPES: Record<string, string> = {
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const TEXT_TYPES: Record<string, string> = { txt: 'text/plain', log: 'text/plain', md: 'text/plain', csv: 'text/csv', json: 'application/json' };

export interface DetectedFile {
  mime: string;
  ext: string;
  isImage: boolean;
}

export const detectUpload = (buf: Buffer, fileName: string): DetectedFile | null => {
  const image = sniffImage(buf);
  if (image) return { mime: image, ext: IMAGE_TYPES[image], isImage: true };
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return { mime: 'image/gif', ext: 'gif', isImage: true };
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', isImage: false };
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304) {
    return ZIP_TYPES[ext] ? { mime: ZIP_TYPES[ext], ext, isImage: false } : { mime: ZIP_TYPES.zip!, ext: 'zip', isImage: false };
  }
  if (TEXT_TYPES[ext] && !buf.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { mime: TEXT_TYPES[ext], ext, isImage: false };
    } catch {
      return null;
    }
  }
  return null;
};

/** Keeps a readable original name, without paths or odd characters. */
export const safeFileName = (name: string, fallbackExt: string) => {
  const base = name.split(/[\\/]/).pop()!.replace(/[^\w.\- ()]/g, '_').trim().slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : `file.${fallbackExt}`;
};

const resolveKey = (key: string) => {
  const full = path.resolve(env.uploadDir, key);
  if (!full.startsWith(path.resolve(env.uploadDir) + path.sep)) throw badRequest('Invalid storage key');
  return full;
};

export const saveFile = async (buf: Buffer, ext: string): Promise<string> => {
  const now = new Date();
  const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.${ext}`;
  const full = resolveKey(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf, { flag: 'wx' });
  return key;
};

export const filePath = resolveKey;

export const deleteFile = async (key: string) => {
  await fs.rm(resolveKey(key), { force: true });
};

// ───────────────────────────── Signed URLs ─────────────────────────────

const SIGNED_URL_TTL_SECONDS = 2 * 60 * 60;
const signingKey = () => crypto.createHash('sha256').update(`files:${env.JWT_ACCESS_SECRET}`).digest();
const sign = (id: string, exp: number) =>
  crypto.createHmac('sha256', signingKey()).update(`${id}.${exp}`).digest('base64url');

/**
 * Absolute signed URL. Expiry is rounded up to the next hour so the URL stays the same for
 * a while and browsers can cache the image instead of re-downloading it on every list refresh.
 */
export const signedFileUrl = (attachmentId: string): string => {
  const hour = 3600;
  const exp = Math.ceil((Date.now() / 1000 + SIGNED_URL_TTL_SECONDS) / hour) * hour;
  const base = env.API_URL.replace(/\/$/, '');
  return `${base}/api/v1/files/${attachmentId}?exp=${exp}&sig=${sign(attachmentId, exp)}`;
};

export const verifyFileSignature = (id: string, exp: number, sig: string): boolean => {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = Buffer.from(sign(id, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

/** Deletes many stored files (best effort), e.g. after a project or website was deleted. */
export const deleteFiles = async (keys: string[]) => {
  await Promise.all(keys.map((k) => deleteFile(k).catch(() => undefined)));
};
