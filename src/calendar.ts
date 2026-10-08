export interface Calendar {
  code: string; name: string; url: string; content: string | null;
  etag: string | null; last_modified: string | null; hash: string | null;
  checked_at: number | null; attempted_at: number; revision: number;
}

export class CalendarError extends Error {
  constructor(public status: number) { super(`Calendar failure ${status}`); }
}

export async function refreshCalendar(db: D1Database, calendar: Calendar): Promise<Calendar> {
  const started = Date.now();
  await db.prepare('UPDATE calendars SET attempted_at = MAX(attempted_at, ?) WHERE code = ? AND url = ?')
    .bind(started, calendar.code, calendar.url).run();
  const headers = new Headers();
  if (calendar.content !== null) {
    if (calendar.etag) headers.set('If-None-Match', calendar.etag);
    if (calendar.last_modified) headers.set('If-Modified-Since', calendar.last_modified);
  }
  let content = calendar.content;
  let etag = calendar.etag;
  let lastModified = calendar.last_modified;
  let hash = calendar.hash;
  try {
    const response = await fetch(calendar.url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (response.status === 304) {
      if (content === null) throw new CalendarError(502);
      etag = response.headers.get('ETag') ?? etag;
      lastModified = response.headers.get('Last-Modified') ?? lastModified;
    } else {
      if (response.status !== 200) throw new CalendarError(404);
      if (!response.body) throw new CalendarError(502);
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
      let bytes = 0;
      content = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1_048_576) { await reader.cancel(); throw new CalendarError(502); }
          content += decoder.decode(value, { stream: true });
        }
        content += decoder.decode();
      } finally { reader.releaseLock(); }
      const trimmed = content.trim();
      if (!trimmed.startsWith('BEGIN:VCALENDAR\n') && !trimmed.startsWith('BEGIN:VCALENDAR\r\n')) throw new CalendarError(502);
      if (!trimmed.endsWith('END:VCALENDAR') || !/(?:^|\n)VERSION:2\.0\r?(?:\n|$)/.test(trimmed)) throw new CalendarError(502);
      hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), b => b.toString(16).padStart(2, '0')).join('');
      etag = response.headers.get('ETag');
      lastModified = response.headers.get('Last-Modified');
    }
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError(502);
  }
  const checked = Date.now();
  // A revision guard prevents concurrent older results and changed URLs from replacing newer data.
  const result = await db.prepare(`UPDATE calendars SET content = ?, etag = ?, last_modified = ?, hash = ?,
      checked_at = ?, revision = revision + 1 WHERE code = ? AND url = ? AND revision = ?`)
    .bind(content, etag, lastModified, hash, checked, calendar.code, calendar.url, calendar.revision).run();
  if (result.meta.changes) return { ...calendar, content, etag, last_modified: lastModified, hash, checked_at: checked, revision: calendar.revision + 1 };
  const current = await db.prepare('SELECT * FROM calendars WHERE code = ?').bind(calendar.code).first<Calendar>();
  if (!current || current.url !== calendar.url || current.content === null || current.checked_at === null || checked - current.checked_at >= 300_000) throw new CalendarError(503);
  return current;
}

export async function serveCalendar(db: D1Database, name: string, headers: Headers): Promise<Response> {
  let calendar = await db.prepare('SELECT * FROM calendars WHERE name = ? LIMIT 1').bind(name).first<Calendar>();
  if (!calendar) return new Response(null, { status: 404, headers });
  const fresh = calendar.content !== null && calendar.checked_at !== null && Date.now() - calendar.checked_at < 300_000;
  if (!fresh) calendar = await refreshCalendar(db, calendar);
  headers.set('Content-Type', 'text/calendar; charset=utf-8');
  headers.set('X-Cache', fresh ? 'HIT' : 'MISS');
  return new Response(calendar.content, { headers });
}
