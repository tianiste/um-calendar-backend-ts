import { CalendarError, serveCalendar } from './calendar';
import { calendarNames, type Env } from './catalog';

const allowedOrigins = new Set([
  'https://um-calendar-frontend.pages.dev',
  'https://umcalendar.com',
]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const headers = new Headers({ Vary: 'Origin' });
    if (origin) {
      if (!allowedOrigins.has(origin)) return new Response(null, { status: 403, headers });
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') {
      headers.set('Allow', 'GET, OPTIONS');
      return new Response(null, { status: 405, headers });
    }
    if (new URL(request.url).pathname === '/health') {
      headers.set('Content-Type', 'application/json');
      return new Response(JSON.stringify({ message: 'pong' }), { headers });
    }
    const path = new URL(request.url).pathname;
    if (path.startsWith('/data/')) {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
        if (!success) return new Response(JSON.stringify({ error: 'too many requests' }), { status: 429, headers });
      } catch {
        console.error(JSON.stringify({ event: 'rate_limit_failed' }));
        return new Response(null, { status: 503, headers });
      }
    }
    if (path.startsWith('/data/cal/')) {
      let name: string;
      try { name = decodeURIComponent(path.slice('/data/cal/'.length)).trim(); }
      catch { return new Response(null, { status: 400, headers }); }
      try { return await serveCalendar(env.DB, name, headers); }
      catch (error) {
        const status = error instanceof CalendarError ? error.status : 503;
        console.error(JSON.stringify({ event: 'calendar_failed', status }));
        return new Response(null, { status, headers });
      }
    }
    if (path === '/data/names') {
      try {
        headers.set('Content-Type', 'application/json');
        return new Response(JSON.stringify(await calendarNames(env.DB)), { headers });
      } catch {
        console.error(JSON.stringify({ event: 'names_failed' }));
        return new Response(null, { status: 503, headers });
      }
    }
    return new Response(null, { status: 404, headers });
  },
} satisfies ExportedHandler<Env>;
