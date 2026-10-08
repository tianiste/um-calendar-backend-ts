import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime } from './helpers.mjs';

test('catalog bootstrap validates links, deduplicates codes, sorts', async () => {
  let html = `<a href="2---B.ics">B</a><a href="1---%C5%BD.ics">Z</a>
    <a href="2---C.ics">duplicate</a><a href="---placeholder.ics">placeholder</a>
    <a href="https://evil.example/Program/calendars/3---E.ics">foreign</a>
    <a href="../4---E.ics">outside</a><a href="5---bad%FF.ics">bad encoding</a>`;
  let calls = 0;
  const { mf, db, request } = await runtime(async () => { calls++; return new Response(html, { headers: { 'Content-Type': 'text/html' } }); });
  try {
    assert.deepEqual(await (await request('/data/names')).json(), ['1---Ž.ics', '2---C.ics']);
    assert.deepEqual(await (await request('/data/names')).json(), ['1---Ž.ics', '2---C.ics']);
    assert.equal(calls, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM calendars').first()).n, 2);
  } finally { await mf.dispose(); }
});

test('empty upstream produce controlled errors with CORS', async () => {
  const { mf, request } = await runtime(async () => new Response('<html>empty</html>'));
  try {
    const response = await request('/data/names', { headers: { Origin: 'https://umcalendar.com' } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://umcalendar.com');
  } finally { await mf.dispose(); }
});
