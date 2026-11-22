import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_STRING = 200_000;     // longer strings are cut before logging/broadcasting
const MIN_INLINE_IMAGE = 512;   // base64 chars; smaller blobs stay inline

/**
 * Makes SDK messages safe and small for the event log and the WebSocket:
 * base64 images (Playwright screenshots, Read on images) become files under data/media,
 * giant strings are truncated. Returns a deep copy; the input is not modified.
 */
export class Media {
  constructor(dir) { this.dir = dir; }

  async sanitize(value) {
    const jobs = [];
    const out = this.#walk(value, jobs, 0);
    if (jobs.length) await Promise.all(jobs);
    return out;
  }

  #walk(v, jobs, depth) {
    if (depth > 48) return '[zu tief verschachtelt]';
    if (typeof v === 'string') {
      return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}\n… [gekürzt, ${Math.round(v.length / 1024)} KB gesamt]` : v;
    }
    if (Array.isArray(v)) return v.map((x) => this.#walk(x, jobs, depth + 1));
    if (!v || typeof v !== 'object') return v;

    // Anthropic image content block
    const src = v.source;
    if (v.type === 'image' && src?.type === 'base64' && typeof src.data === 'string' && src.data.length >= MIN_INLINE_IMAGE) {
      return { type: 'image', source: { type: 'url', url: this.#save(src.data, src.media_type, jobs) }, media_type: src.media_type };
    }
    // Structured tool outputs ({ base64, type: 'image/png' } and similar)
    const mime = [v.media_type, v.mimeType, v.mime_type, v.type].find((m) => typeof m === 'string' && EXT[m]);
    const key = typeof v.base64 === 'string' ? 'base64' : typeof v.data === 'string' ? 'data' : null;
    if (mime && key && v[key].length >= MIN_INLINE_IMAGE) {
      const copy = {};
      for (const [k, x] of Object.entries(v)) if (k !== key) copy[k] = this.#walk(x, jobs, depth + 1);
      copy.url = this.#save(v[key], mime, jobs);
      return copy;
    }
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = this.#walk(x, jobs, depth + 1);
    return o;
  }

  #save(b64, mime, jobs) {
    const ext = EXT[mime] ?? 'bin';
    const name = `${crypto.createHash('sha1').update(b64).digest('hex').slice(0, 24)}.${ext}`;
    jobs.push(
      fsp.writeFile(path.join(this.dir, name), Buffer.from(b64, 'base64'), { flag: 'wx' })
        .catch((e) => { if (e.code !== 'EEXIST') console.error(`[media] ${e.message}`); }),
    );
    return `/media/${name}`;
  }
}

export const MEDIA_NAME_RE = /^[0-9a-f]{24}\.(png|jpg|gif|webp|bin)$/;
