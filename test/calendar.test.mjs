import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, source } from './helpers.mjs';
const body = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
async function seed(db) {
  await db.prepare('INSERT INTO calendars(code,name,url) VALUES(?,?,?)').bind('1', '1---Ž.ics', source + '1---%C5%BD.ics').run();
}
const path = '/data/cal/' + encodeURIComponent('1---Ž.ics');

test('cold ICS, cache hit, expired conditional 304, and changed content', async () => {
  let calls = 0;
  let changed = false;
  const { mf, db, request } = await runtime(async req => {
    calls++;
    if (req.headers.get('If-None-Match') === '"one"' && !changed) return new Response(null, { status: 304 });
    return new Response(changed ? body.replace('UID:1', 'UID:2') : body, { headers: { ETag: changed ? '"two"' : '"one"', 'Last-Modified': 'Thu, 08 Oct 2026 00:00:00 GMT' } });
  });
  try {
    await seed(db);
    let response = await request(path);
    assert.equal(response.status, 200); assert.equal(await response.text(), body); assert.equal(response.headers.get('X-Cache'), 'MISS');
    response = await request(path); assert.equal(response.headers.get('X-Cache'), 'HIT'); assert.equal(calls, 1);
    await db.prepare('UPDATE calendars SET checked_at = 1').run();
    response = await request(path); assert.equal(response.status, 200); assert.equal(response.headers.get('X-Cache'), 'MISS');
    let stored = await db.prepare('SELECT * FROM calendars').first();
    assert.equal(stored.etag, '"one"'); assert.ok(stored.last_modified); assert.ok(stored.checked_at > 1);
    const oldHash = stored.hash;
    changed = true; await db.prepare('UPDATE calendars SET checked_at = 1').run();
    assert.match(await (await request(path)).text(), /UID:2/);
    stored = await db.prepare('SELECT * FROM calendars').first(); assert.notEqual(stored.hash, oldHash);
    assert.equal((await request('/data/cal/missing')).status, 404);
    assert.equal((await request('/data/cal/%FF')).status, 400);
  } finally { await mf.dispose(); }
});

test('bad upstream status, HTML, oversized content, no-content 304, network failure preserve old cache', async () => {
  let mode = 'html';
  const { mf, db, request } = await runtime(async () => {
    if (mode === 'network') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('network unavailable')); } }));
    if (mode === '404') return new Response('missing', { status: 404 });
    if (mode === '304') return new Response(null, { status: 304 });
    return new Response(mode === 'large' ? body + 'x'.repeat(1_048_576) : '<html>bad gateway</html>');
  });
  try {
    await seed(db);
    assert.equal((await request(path)).status, 502);
    mode = '304'; assert.equal((await request(path)).status, 502);
    await db.prepare('UPDATE calendars SET content = ?, checked_at = 1').bind(body).run();
    for (const [value, status] of [['html', 502], ['large', 502], ['network', 502], ['404', 404]]) {
      mode = value; assert.equal((await request(path)).status, status);
      assert.equal((await db.prepare('SELECT content FROM calendars').first()).content, body);
      assert.equal((await db.prepare('SELECT checked_at FROM calendars').first()).checked_at, 1);
    }
  } finally { await mf.dispose(); }
});

test('failed database reads and writes return 503 with CORS', async () => {
  const { mf, db, request } = await runtime(async () => new Response(body));
  try {
    await seed(db);
    await db.exec("CREATE TRIGGER fail_update BEFORE UPDATE OF content ON calendars BEGIN SELECT RAISE(FAIL, 'write failed'); END;");
    assert.equal((await request(path)).status, 503);
    assert.equal((await db.prepare('SELECT content FROM calendars').first()).content, null);
    await db.exec('DROP TABLE calendars;');
    const response = await request(path, { headers: { Origin: 'https://umcalendar.com' } });
    assert.equal(response.status, 503); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://umcalendar.com');
    assert.equal((await request('/data/names')).status, 503);
  } finally { await mf.dispose(); }
});

test('rate limiter blocks one IP independently', async () => {
  const { mf, request } = await runtime(async () => new Response(''));
  try {
    let response;
    for (let i = 0; i < 51; i++) response = await request('/data/cal/missing', { headers: { 'CF-Connecting-IP': '192.0.2.1' } });
    assert.equal(response.status, 429);
    assert.equal((await request('/data/cal/missing', { headers: { 'CF-Connecting-IP': '192.0.2.2' } })).status, 404);
  } finally { await mf.dispose(); }
});

test('older concurrent fetch cannot overwrite newer content or a changed source URL', async () => {
  let release;
  let arrived;
  let calls = 0;
  let started = new Promise(resolve => { arrived = resolve; });
  const { mf, db, request } = await runtime(async () => {
    calls++;
    if (calls === 1 || calls === 3) {
      arrived();
      await new Promise(resolve => { release = resolve; });
      return new Response(body);
    }
    return new Response(body.replace('UID:1', 'UID:new'));
  });
  try {
    await seed(db);
    const older = request(path);
    await started;
    const newer = await request(path); assert.match(await newer.text(), /UID:new/);
    release(); assert.match(await (await older).text(), /UID:new/);
    assert.match((await db.prepare('SELECT content FROM calendars').first()).content, /UID:new/);
    await db.prepare('UPDATE calendars SET checked_at = 1').run();
    started = new Promise(resolve => { arrived = resolve; });
    const obsolete = request(path); await started;
    await db.prepare('UPDATE calendars SET url = ?, revision = revision + 1, content = NULL, checked_at = NULL').bind(source + 'changed.ics').run();
    release(); assert.equal((await obsolete).status, 503);
    assert.equal((await db.prepare('SELECT content FROM calendars').first()).content, null);
  } finally { release?.(); await mf.dispose(); }
});
