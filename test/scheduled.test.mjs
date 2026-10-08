import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtime, source } from './helpers.mjs';
const body = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n';
async function trigger(mf, cron) {
  return (await mf.getWorker()).scheduled({ cron, scheduledTime: Date.now() });
}

test('hourly catalog retains old rows, avoids unchanged writes, clears changed URL cache, rejects empty scrape', async () => {
  let html = '<a href="1---A.ics">A</a><a href="2---B.ics">B</a>';
  const { mf, db } = await runtime(async () => new Response(html));
  try {
    assert.equal((await trigger(mf, '17 * * * *')).outcome, 'ok');
    await db.prepare('UPDATE calendars SET content = ?, etag = ?, last_modified = ?, hash = ?, checked_at = 123, attempted_at = 456').bind(body, 'tag', 'date', 'hash').run();
    await trigger(mf, '17 * * * *');
    let row = await db.prepare('SELECT * FROM calendars WHERE code = ?').bind('1').first();
    assert.equal(row.checked_at, 123); assert.equal(row.attempted_at, 456); assert.equal(row.revision, 0);
    html = '<a href="1---Changed.ics">changed</a>';
    await trigger(mf, '17 * * * *');
    row = await db.prepare('SELECT * FROM calendars WHERE code = ?').bind('1').first();
    for (const key of ['content', 'etag', 'last_modified', 'hash', 'checked_at']) assert.equal(row[key], null);
    assert.equal(row.attempted_at, 0); assert.equal(row.revision, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM calendars').first()).n, 2);
    html = '<html>no links</html>';
    assert.notEqual((await trigger(mf, '17 * * * *')).outcome, 'ok');
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM calendars').first()).n, 2);
  } finally { await mf.dispose(); }
});

test('two-calendar batches rotate 64 rows, failed attempts yield, success and attempt timestamps differ, recovery works', async () => {
  const seen = [];
  let fail = true;
  const { mf, db } = await runtime(async request => {
    seen.push(request.url);
    if (fail && request.url === source + '0.ics') return new Response('unavailable', { status: 503 });
    return new Response(body);
  });
  try {
    await db.batch(Array.from({ length: 64 }, (_, i) => db.prepare('INSERT INTO calendars(code,name,url,content) VALUES(?,?,?,?)')
      .bind(String(i), `${i}.ics`, source + `${i}.ics`, body)));
    assert.notEqual((await trigger(mf, '* * * * *')).outcome, 'ok');
    assert.equal(seen.length, 2);
    const failed = await db.prepare('SELECT * FROM calendars WHERE code = ?').bind('0').first();
    assert.ok(failed.attempted_at > 0); assert.equal(failed.checked_at, null); assert.equal(failed.content, body);
    for (let i = 0; i < 31; i++) assert.equal((await trigger(mf, '* * * * *')).outcome, 'ok');
    assert.equal(new Set(seen).size, 64); assert.equal(seen.length, 64);
    await trigger(mf, '* * * * *'); assert.equal(seen.length, 64);
    fail = false; await db.prepare('UPDATE calendars SET attempted_at = 0 WHERE code = ?').bind('0').run();
    assert.equal((await trigger(mf, '* * * * *')).outcome, 'ok');
    assert.equal(seen.length, 65);
    assert.ok((await db.prepare('SELECT checked_at FROM calendars WHERE code = ?').bind('0').first()).checked_at > 0);
  } finally { await mf.dispose(); }
});
