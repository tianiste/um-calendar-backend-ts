export const source = 'https://urnik.fov.um.si/Program/calendars/';

export interface Env { DB: D1Database }

export async function syncCatalog(db: D1Database): Promise<number> {
  const response = await fetch(source, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Catalog upstream failed');
  const calendars = new Map<string, { code: string; name: string; url: string }>();
  await new HTMLRewriter().on('a[href]', {
    element(element) {
      try {
        const url = new URL(element.getAttribute('href')!, source);
        if (url.origin !== new URL(source).origin || url.username || url.password ||
            !url.pathname.startsWith('/Program/calendars/') || !url.pathname.toLowerCase().endsWith('.ics')) return;
        const name = decodeURIComponent(url.pathname.slice('/Program/calendars/'.length)).trim();
        const parts = name.split('---');
        const code = parts.length > 1 ? parts[0].trim() : '';
        if (!code || name.includes('/') || name.includes('\\')) return;
        url.hash = '';
        calendars.set(code, { code, name, url: url.href });
      } catch { /* Ignore malformed source links. */ }
    },
  }).transform(response).text();
  if (!calendars.size) throw new Error('Empty catalog');
  await db.prepare(`
    INSERT INTO calendars (code, name, url)
    SELECT json_extract(value, '$.code'), json_extract(value, '$.name'), json_extract(value, '$.url')
    FROM json_each(?) WHERE 1
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, url = excluded.url,
      content = CASE WHEN calendars.url = excluded.url THEN content END,
      etag = CASE WHEN calendars.url = excluded.url THEN etag END,
      last_modified = CASE WHEN calendars.url = excluded.url THEN last_modified END,
      hash = CASE WHEN calendars.url = excluded.url THEN hash END,
      checked_at = CASE WHEN calendars.url = excluded.url THEN checked_at END,
      attempted_at = CASE WHEN calendars.url = excluded.url THEN attempted_at ELSE 0 END
    WHERE calendars.name != excluded.name OR calendars.url != excluded.url
  `).bind(JSON.stringify([...calendars.values()])).run();
  return calendars.size;
}

export async function calendarNames(db: D1Database): Promise<string[]> {
  let rows = await db.prepare('SELECT name FROM calendars ORDER BY name').all<{ name: string }>();
  if (!rows.results.length) {
    await syncCatalog(db);
    rows = await db.prepare('SELECT name FROM calendars ORDER BY name').all<{ name: string }>();
  }
  return rows.results.map(row => row.name);
}
