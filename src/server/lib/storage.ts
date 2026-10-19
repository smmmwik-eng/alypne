import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { hmacSign, safeEqual } from './crypto.js';

/**
 * Local-disk object storage with HMAC-signed, expiring download URLs.
 * Keys are generated server-side (never from user input) so path traversal is impossible;
 * the resolver still rejects anything escaping the storage root as defence in depth.
 */
const root = () => path.join(env.dataDir, 'uploads');

function resolveKey(key: string): string {
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
  const full = path.resolve(root(), key);
  if (!full.startsWith(path.resolve(root()) + path.sep)) throw new Error('Invalid storage key');
  return full;
}

export async function putObject(key: string, data: Uint8Array) {
  const full = resolveKey(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

export async function getObject(key: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveKey(key));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}

export async function deleteObject(key: string) {
  await rm(resolveKey(key), { force: true });
}

export async function objectExists(key: string) {
  try {
    await stat(resolveKey(key));
    return true;
  } catch {
    return false;
  }
}

/** Signed URL for a resource id, valid for `ttlSeconds`. Access is checked before signing. */
export function signedPath(base: string, id: string, ttlSeconds = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = hmacSign('download', `${id}.${exp}`);
  return `${base}/${id}?exp=${exp}&sig=${sig}`;
}

export function verifySignature(id: string, exp: string | undefined, sig: string | undefined): boolean {
  if (!exp || !sig) return false;
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(hmacSign('download', `${id}.${e}`), sig);
}

/* ---------------------------------------------------------- validation */

const ALLOWED: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log', 'md', 'lua', 'luau'],
  'text/csv': ['csv'],
  'application/json': ['json'],
  'application/zip': ['zip'],
  'video/mp4': ['mp4'],
  'video/webm': ['webm'],
  'audio/mpeg': ['mp3'],
  'audio/ogg': ['ogg'],
  'application/octet-stream': ['rbxm', 'rbxl', 'rbxmx', 'rbxlx', 'fbx', 'obj'],
};

const EXT_TO_MIME = new Map<string, string>();
for (const [mime, exts] of Object.entries(ALLOWED)) for (const e of exts) EXT_TO_MIME.set(e, mime);

function sniffImage(buf: Uint8Array): string | null {
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * Decide the stored MIME type from the extension allow-list and file contents.
 * Image types are only trusted when the magic bytes agree, so a renamed HTML/SVG
 * file can never be served inline as an image.
 */
export function classifyUpload(fileName: string, data: Uint8Array): { mimeType: string; isImage: boolean } | { error: string } {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const mime = EXT_TO_MIME.get(ext);
  if (!mime) return { error: `.${ext || '?'} files are not allowed. Allowed: ${[...EXT_TO_MIME.keys()].join(', ')}` };
  if (mime.startsWith('image/')) {
    const sniffed = sniffImage(data);
    if (!sniffed) return { error: 'File contents do not match an image format' };
    return { mimeType: sniffed, isImage: true };
  }
  return { mimeType: mime, isImage: false };
}

export function safeFileName(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  return (base || 'file').slice(0, 180);
}
