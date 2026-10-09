import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { archiveResponse, fetchResponse } from '../scripts/archive.mjs';

const battle = (seq, extra = {}) => ({ worldCode: 'world_asia', nicknameno: 199070445,
  season_code: 'pvp_rta_ss21', battle_seq: seq, ...extra });
const payload = (records) => JSON.stringify({ code: 0, message: 'SUCCESS',
  value: { result_body: { nick_no: 199070445, total_count: records.length, battle_list: records } } });
const setup = () => mkdtemp(join(tmpdir(), 'e7-rta-test-'));
const load = async (dir) => JSON.parse(await readFile(join(dir, 'battles.json'), 'utf8'));

test('preserves exact response bytes and appends only unseen battles across runs', async () => {
  const dir = await setup();
  const raw = Buffer.from(' \n' + payload([battle('1'), battle('2'), battle('1')]) + '\n');
  const first = await archiveResponse(raw, { dataDir: dir });
  assert.deepEqual(await readFile(first.snapshot), raw);
  assert.equal(first.added, 2);
  const second = await archiveResponse(Buffer.from(payload([battle(2, { iswin: 2 }), battle('3')])), { dataDir: dir });
  assert.equal(second.added, 1);
  assert.deepEqual(await load(dir), [battle('1'), battle('2'), battle('3')]);
  assert.equal((await readdir(join(dir, 'snapshots'), { recursive: true })).filter(x => x.endsWith('.json')).length, 2);
});

test('same sequence in a different season is a distinct battle', async () => {
  const dir = await setup();
  await archiveResponse(Buffer.from(payload([battle('1'), battle('1', { season_code: 'pvp_rta_ss22' })])), { dataDir: dir });
  assert.equal((await load(dir)).length, 2);
});

test('empty successful response preserves existing records', async () => {
  const dir = await setup();
  await archiveResponse(Buffer.from(payload([battle('1')])), { dataDir: dir });
  const result = await archiveResponse(Buffer.from(payload([])), { dataDir: dir });
  assert.equal(result.added, 0);
  assert.deepEqual(await load(dir), [battle('1')]);
});

test('API errors, malformed records, and wrong account never change the archive', async () => {
  const dir = await setup();
  await archiveResponse(Buffer.from(payload([battle('1')])), { dataDir: dir });
  const before = await readFile(join(dir, 'battles.json'));
  for (const raw of ['<html>error</html>', '{"code":1}', '{"code":0,"value":{}}',
    payload([battle('')]), payload([battle('2', { nicknameno: 1 })]),
    payload([battle('2'), battle('3', { season_code: null })])]) {
    await assert.rejects(archiveResponse(Buffer.from(raw), { dataDir: dir }));
    assert.deepEqual(await readFile(join(dir, 'battles.json')), before);
  }
});

test('corrupt existing archive is rejected instead of reset', async () => {
  const dir = await setup();
  await writeFile(join(dir, 'battles.json'), '{broken');
  await assert.rejects(archiveResponse(Buffer.from(payload([battle('1')])), { dataDir: dir }));
  assert.equal(await readFile(join(dir, 'battles.json'), 'utf8'), '{broken');
});

test('HTTP fetch uses POST, keeps query parameters and retries transient HTTP failures', async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/battle?nick_no=199070445&world_code=world_asia&lang=en');
    calls++;
    res.writeHead(calls === 1 ? 503 : 200);
    res.end(calls === 1 ? 'unavailable' : payload([battle('1')]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const raw = await fetchResponse(`http://127.0.0.1:${server.address().port}/battle?nick_no=199070445&world_code=world_asia&lang=en`, { retryDelayMs: 1 });
  assert.equal(raw.toString(), payload([battle('1')]));
  assert.equal(calls, 2);
});

test('HTTP 400 fails without retry and timeout is bounded', async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (req.url === '/slow') return;
    res.writeHead(400); res.end('bad request');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(fetchResponse(url, { retryDelayMs: 1 }), /400/);
  assert.equal(calls, 1);
  await assert.rejects(fetchResponse(`${url}/slow`, { timeoutMs: 30, attempts: 1 }));
});
