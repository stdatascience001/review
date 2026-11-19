/**
 * Shrinks large images before upload (smaller storage, faster loading):
 * anything wider than 2560px or bigger than 1.5 MB is re-encoded as WebP (JPEG fallback),
 * and only kept if it actually got smaller. GIFs (maybe animated) and small images are left alone.
 */
const MAX_WIDTH = 2560;
const MAX_BYTES = 1.5 * 1024 * 1024;

const encode = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b && b.type === type ? b : null), type, quality));

export const shrinkImage = async <T extends Blob>(file: T): Promise<T | File> => {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width <= MAX_WIDTH && file.size <= MAX_BYTES) {
      bitmap.close();
      return file;
    }
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const out = (await encode(canvas, 'image/webp', 0.85)) ?? (await encode(canvas, 'image/jpeg', 0.85));
    if (!out || out.size >= file.size) return file;
    const base = (file as Blob & { name?: string }).name?.replace(/\.[^.]+$/, '') ?? 'image';
    return new File([out], `${base}.${out.type === 'image/webp' ? 'webp' : 'jpg'}`, { type: out.type });
  } catch {
    return file;
  }
};
