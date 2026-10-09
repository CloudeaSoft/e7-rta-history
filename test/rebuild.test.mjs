import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as archive from '../scripts/archive.mjs';

const battle = (seq, extra = {}) => ({ worldCode: 'world_asia', nicknameno: 199070445,
  season_code: 'pvp_rta_ss21', battle_seq: seq, ...extra });
const payload = records => Buffer.from(JSON.stringify({ code: 0, message: 'SUCCESS',
  value: { result_body: { nick_no: 199070445, battle_list: records } } }));
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'e7-rebuild-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function snapshot(dir, name, raw) {
  await mkdir(join(dir, 'snapshots'), { recursive: true });
  await writeFile(join(dir, 'snapshots', name), raw);
}

test('fetch stage saves exact bytes before validation without changing aggregate', async t => {
  const dataDir = await setup(t);
  await writeFile(join(dataDir, 'battles.json'), 'old aggregate');
  const raw = Buffer.from(' \r\n<html>upstream failure</html>\r\n');
  const first = await archive.saveSnapshot(raw, { dataDir, now: new Date('2026-10-09T14:00:00Z') });
  const second = await archive.saveSnapshot(raw, { dataDir, now: new Date('2026-10-09T14:00:00Z') });
  assert.notEqual(first.snapshot, second.snapshot);
  assert.deepEqual(await readFile(first.snapshot), raw);
  assert.equal(await readFile(join(dataDir, 'battles.json'), 'utf8'), 'old aggregate');
});

test('rebuild discovers historical txt snapshots, deduplicates and prefers earliest path', async t => {
  const dataDir = await setup(t);
  await snapshot(dataDir, '2026-10-09.json', payload([battle(2, { iswin: 2 }), battle('3')]));
  await snapshot(dataDir, '2026-09-28.txt', payload([battle('1'), battle('2'), battle('1')]));
  const result = await archive.rebuildArchive({ dataDir });
  assert.deepEqual(result, { snapshots: 2, recordsRead: 5, duplicates: 2, total: 3 });
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'battles.json'))), [battle('1'), battle('2'), battle('3')]);
  const first = await readFile(join(dataDir, 'battles.json'));
  await archive.rebuildArchive({ dataDir });
  assert.deepEqual(await readFile(join(dataDir, 'battles.json')), first);
});

test('aggregate can be deleted or corrupt and rebuilt from nested snapshots alone', async t => {
  const dataDir = await setup(t);
  await archive.saveSnapshot(payload([battle('1')]), { dataDir });
  await archive.rebuildArchive({ dataDir });
  const first = await readFile(join(dataDir, 'battles.json'));
  await rm(join(dataDir, 'battles.json'));
  await archive.rebuildArchive({ dataDir });
  assert.deepEqual(await readFile(join(dataDir, 'battles.json')), first);
  await writeFile(join(dataDir, 'battles.json'), '{broken');
  await archive.rebuildArchive({ dataDir });
  assert.deepEqual(await readFile(join(dataDir, 'battles.json')), first);
});

test('same battle sequence across seasons stays distinct and empty snapshots are valid', async t => {
  const dataDir = await setup(t);
  await snapshot(dataDir, '1.json', payload([]));
  assert.equal((await archive.rebuildArchive({ dataDir })).total, 0);
  await snapshot(dataDir, '2.json', payload([battle('1'), battle('1', { season_code: 'pvp_rta_ss22' })]));
  assert.equal((await archive.rebuildArchive({ dataDir })).total, 2);
});

test('invalid snapshot reports its path, preserves bytes and leaves aggregate intact', async t => {
  const dataDir = await setup(t);
  await snapshot(dataDir, 'good.json', payload([battle('1')]));
  await archive.rebuildArchive({ dataDir });
  const before = await readFile(join(dataDir, 'battles.json'));
  for (const raw of [Buffer.from('<html>error</html>'), Buffer.from('{"code":1}'),
    Buffer.from('{"code":0,"value":{}}'), payload([battle('')]),
    payload([battle('2', { nicknameno: 1 })]), payload([battle('2', { season_code: null })])]) {
    await snapshot(dataDir, 'bad.json', raw);
    await assert.rejects(archive.rebuildArchive({ dataDir }), /bad.json/);
    assert.deepEqual(await readFile(join(dataDir, 'battles.json')), before);
    assert.deepEqual(await readFile(join(dataDir, 'snapshots', 'bad.json')), raw);
  }
});

test('missing or empty snapshot directory cannot silently erase an existing aggregate', async t => {
  const dataDir = await setup(t);
  await writeFile(join(dataDir, 'battles.json'), '[{"existing":true}]');
  await assert.rejects(archive.rebuildArchive({ dataDir }));
  await mkdir(join(dataDir, 'snapshots'));
  await assert.rejects(archive.rebuildArchive({ dataDir }), /No snapshots/);
  assert.equal(await readFile(join(dataDir, 'battles.json'), 'utf8'), '[{"existing":true}]');
});
