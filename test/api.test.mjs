import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('health, CORS, methods, and unknown routes', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'dist/index.js', compatibilityDate: '2026-10-08' }));
  try {
    const health = await mf.dispatchFetch('https://api.example/health', {
      headers: { Origin: 'https://umcalendar.com' },
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { message: 'pong' });
    assert.equal(health.headers.get('Access-Control-Allow-Origin'), 'https://umcalendar.com');
    assert.equal((await mf.dispatchFetch('https://api.example/health', {
      headers: { Origin: 'https://untrusted.example' },
    })).status, 403);
    assert.equal((await mf.dispatchFetch('https://api.example/health', { method: 'POST' })).status, 405);
    assert.equal((await mf.dispatchFetch('https://api.example/missing')).status, 404);
    assert.equal((await mf.dispatchFetch('https://api.example/data/names', {
      method: 'OPTIONS', headers: { Origin: 'https://umcalendar.com' },
    })).status, 204);
  } finally {
    await mf.dispose();
  }
});
