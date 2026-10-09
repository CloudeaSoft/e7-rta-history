import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  return JSON.stringify([record.worldCode, String(record.nicknameno), record.season_code, String(record.battle_seq)]);
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

export async function archiveResponse(raw, { dataDir, now = new Date() }) {
  const response = JSON.parse(raw.toString('utf8'));
  if (response.code !== 0) throw new Error(`API error: ${response.code} ${response.message ?? ''}`);
  const body = response.value?.result_body;
  if (String(body?.nick_no) !== '199070445' || !Array.isArray(body?.battle_list)) {
    throw new Error('Unexpected response account or battle_list structure');
  }
  // Validate every incoming record before writing any data.
  body.battle_list.forEach(recordKey);
  const totalPath = join(dataDir, 'battles.json');
  let existing;
  try {
    existing = JSON.parse(await readFile(totalPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existing = [];
  }
  if (!Array.isArray(existing)) throw new Error('battles.json must be an array');
  const seen = new Set(existing.map(recordKey));
  if (seen.size !== existing.length) throw new Error('Existing archive contains duplicate identities');
  const additions = [];
  for (const record of body.battle_list) {
    const key = recordKey(record);
    if (!seen.has(key)) { seen.add(key); additions.push(record); }
  }

  const timestamp = now.toISOString();
  const snapshotDir = join(dataDir, 'snapshots', timestamp.slice(0, 10));
  const snapshot = join(snapshotDir, `${timestamp.replaceAll(':', '-')}-${randomUUID()}.json`);
  await mkdir(snapshotDir, { recursive: true });
  // Never reformat or overwrite a raw response, including repeated responses.
  await writeFile(snapshot, raw, { flag: 'wx' });
  const temporary = `${totalPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify([...existing, ...additions], null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, totalPath);
  } catch (error) {
    await rm(temporary, { force: true });
    await rm(snapshot, { force: true });
    throw error;
  }
  return { snapshot, received: body.battle_list.length, added: additions.length, total: seen.size };
}
