import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const ENDPOINT = 'https://e7api.onstove.com/gameApi/getBattleList?nick_no=199070445&world_code=world_asia&lang=en';

function recordKey(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Invalid battle record');
  }
  for (const field of ['worldCode', 'nicknameno', 'season_code', 'battle_seq']) {
    const value = record[field];
    if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' ||
        (typeof value === 'number' && !Number.isSafeInteger(value))) {
      throw new Error(`Invalid battle identity field: ${field}`);
    }
  }
  if (record.worldCode !== 'world_asia' || String(record.nicknameno) !== '199070445') {
    throw new Error('Unexpected battle account or world');
  }
  if (!/^\d+$/.test(String(record.battle_seq))) throw new Error('Invalid numeric battle_seq');
  if (typeof record.battle_day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(record.battle_day)) {
    throw new Error('Invalid battle_day timestamp');
  }
  return JSON.stringify([record.worldCode, String(record.nicknameno), record.season_code, String(record.battle_seq)]);
}

function compareBattles(a, b) {
  // Compare the API's wall-clock fields directly, without guessing its timezone.
  // Normalize only the comparison key: .0 and .00 denote the same time.
  const timeKey = value => {
    const [seconds, fraction = ''] = value.split('.');
    return `${seconds}.${fraction.replace(/0+$/, '')}`;
  };
  const aTime = timeKey(a.battle_day);
  const bTime = timeKey(b.battle_day);
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  const aSequence = BigInt(a.battle_seq);
  const bSequence = BigInt(b.battle_seq);
  return aSequence < bSequence ? -1 : aSequence > bSequence ? 1 : 0;
}

export async function fetchResponse(url = ENDPOINT, {
  attempts = 3, timeoutMs = 30000, retryDelayMs = 2000,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`HTTP ${response.status} ${response.statusText}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error.retryable === false || attempt === attempts) throw error;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error('No fetch attempts configured');
}

function parseSnapshot(raw) {
  const response = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  if (response.code !== 0) throw new Error(`API error: ${response.code} ${response.message ?? ''}`);
  const body = response.value?.result_body;
  if (String(body?.nick_no) !== '199070445' || !Array.isArray(body?.battle_list)) {
    throw new Error('Unexpected response account or battle_list structure');
  }
  body.battle_list.forEach(recordKey);
  return body.battle_list;
}

export async function saveSnapshot(raw, { dataDir, now = new Date() }) {
  const timestamp = now.toISOString();
  const snapshotDir = join(dataDir, 'snapshots', timestamp.slice(0, 10));
  const snapshot = join(snapshotDir, `${timestamp.replaceAll(':', '-')}-${randomUUID()}.json`);
  await mkdir(snapshotDir, { recursive: true });
  // Never reformat or overwrite a raw response, including repeated responses.
  await writeFile(snapshot, raw, { flag: 'wx' });
  return { snapshot, bytes: raw.length };
}

async function listSnapshots(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix + entry.name;
    if (entry.isDirectory()) {
      files.push(...await listSnapshots(join(directory, entry.name), relativePath + '/'));
    } else if (entry.isFile() && /\.(json|txt)$/i.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files;
}

export async function rebuildArchive({ dataDir }) {
  const snapshotDir = join(dataDir, 'snapshots');
  // ISO date paths sort chronologically. Never depend on filesystem enumeration order.
  const files = (await listSnapshots(snapshotDir)).sort();
  if (files.length === 0) throw new Error('No snapshots found; refusing to replace aggregate');
  const records = new Map();
  let recordsRead = 0;
  for (const file of files) {
    try {
      const battles = parseSnapshot(await readFile(join(snapshotDir, file)));
      recordsRead += battles.length;
      for (const battle of battles) {
        const key = recordKey(battle);
        if (!records.has(key)) records.set(key, battle);
      }
    } catch (error) {
      throw new Error(`Invalid snapshot ${file}: ${error.message}`, { cause: error });
    }
  }
  // All snapshots must validate before replacing the derived output.
  // The old aggregate is never an input, so missing/corrupt outputs can be rebuilt.
  const totalPath = join(dataDir, 'battles.json');
  const temporary = `${totalPath}.${randomUUID()}.tmp`;
  try {
    const sorted = [...records.values()].sort(compareBattles);
    await writeFile(temporary, JSON.stringify(sorted, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, totalPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { snapshots: files.length, recordsRead, duplicates: recordsRead - records.size, total: records.size };
}
