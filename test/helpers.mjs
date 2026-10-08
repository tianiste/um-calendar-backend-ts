import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
export async function runtime(upstream) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-08',
    d1Databases: { DB: 'test' }, outboundService: upstream,
    ratelimits: { RATE_LIMITER: { namespace_id: '1001', simple: { limit: 50, period: 10 } } },
  }));
  const db = await mf.getD1Database('DB');
  await db.exec((await readFile('migrations/0001_calendars.sql', 'utf8')).replaceAll('\n', ' '));
  return { mf, db, request: (path, options) => mf.dispatchFetch(`https://api.example${path}`, options) };
}
export const source = 'https://urnik.fov.um.si/Program/calendars/';
