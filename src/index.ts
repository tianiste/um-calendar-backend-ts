const allowedOrigins = new Set([
  'https://um-calendar-frontend.pages.dev',
  'https://umcalendar.com',
]);

export default {
  async fetch(request: Request): Promise<Response> {
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
    return new Response(null, { status: 404, headers });
  },
} satisfies ExportedHandler;
