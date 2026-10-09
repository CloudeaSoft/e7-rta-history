import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchResponse } from '../scripts/archive.mjs';

const battle = (seq, extra = {}) => ({ worldCode: 'world_asia', nicknameno: 199070445,
  season_code: 'pvp_rta_ss21', battle_seq: seq, ...extra });
const payload = (records) => JSON.stringify({ code: 0, message: 'SUCCESS',
  value: { result_body: { nick_no: 199070445, total_count: records.length, battle_list: records } } });

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
