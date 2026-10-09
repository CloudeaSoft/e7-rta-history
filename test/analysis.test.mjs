import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAnalysis, generateAnalysis } from '../scripts/analysis.mjs';

const characters = { en: [{ code: 'c1168', name: 'Rinak', grade: '5', job_cd: 'assassin', attribute_cd: 'wind' }] };
const seasons = [{ season_code: 'pvp_rta_ss21', name: 'Fall 2026', startDate: '2026-08-08 00:00:00.0', endDate: '2099-12-31 00:00:00.0', is_now_season: 1 }];
const stats = code => ({ hero_code: code, pick_order: 1, attack_damage: 1234, receive_damage: 234.5,
  recovery: 0, kill_count: 1, mvp_point: 7000, artifact: 'efa27', equip: ['set_speed'],
  respawn: 0, mvp: 1, position: 2, grade: 6, awaken_grade: 6, level: 60, job_cd: 'assassin', attribute_cd: 'wind' });
function battle(extra = {}) {
  return {
    worldCode: 'world_asia', nicknameno: 199070445, battle_seq: '9007199254740993',
    season_code: 'pvp_rta_ss21', season_name: 'Fall 2026', battle_day: '2026-09-01 12:00:00.0',
    battle_time: 57, turn: 5, iswin: 1, grade_code: 'champion',
    enemy_world_code: 'world_global', matchPlayerNicknameno: 123, enemy_nick_no: 'Opponent', enemy_grade_code: 'champion',
    myscore_info: { win_score: 1234, up_down_type: 1, up_down_score: 14 },
    my_deck: { hero_list: [{ hero_code: 'c1168', first_pick: 1, mvp: 1, ban: 0 }], preban_list: ['c1168'] },
    enemy_deck: { hero_list: [{ hero_code: 'c1168', first_pick: 0, mvp: 0, ban: 1 }], preban_list: ['c1168'] },
    teamBettleInfo: '"my_team":' + JSON.stringify([stats('c1168')]),
    teamBettleInfoenemy: '"my_team":' + JSON.stringify([{ ...stats('c1168'), attack_damage: 0 }]),
    ...extra,
  };
}

test('joins English metadata and creates relational battle, pick and preban tables', () => {
  const input = [battle()];
  const before = JSON.stringify(input);
  const result = buildAnalysis(input, characters, seasons);
  assert.equal(result.schema_version, 1);
  assert.equal(result.battles.length, 1);
  const row = result.battles[0];
  assert.equal(row.battle_seq, '9007199254740993');
  assert.equal(row.season_name, 'Fall 2026');
  assert.equal(row.season_end_date, '2099-12-31 00:00:00.0');
  assert.equal(row.result_code, 1);
  assert.equal(row.score_change_type_code, 1);
  assert.equal(row.score_change_points, 14);
  assert.equal(row.opponent_id, '123');
  assert.equal(result.picks.length, 2);
  assert.deepEqual(result.picks.map(p => [p.side, p.hero_name, p.base_grade, p.battle_grade, p.attack_damage, p.banned]),
    [['player', 'Rinak', 5, 6, 1234, false], ['opponent', 'Rinak', 5, 6, 0, true]]);
  assert.equal(result.picks[0].receive_damage, 234.5);
  assert.equal(result.picks[0].recovery, 0);
  assert.deepEqual(result.picks[0].equipment_sets, ['set_speed']);
  assert.ok([...result.picks, ...result.prebans].every(p => p.battle_id === row.battle_id));
  assert.deepEqual(result.prebans.map(p => [p.side, p.hero_name]), [['player', 'Rinak'], ['opponent', 'Rinak']]);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(buildAnalysis(input, characters, seasons), result);
});

test('unknown metadata preserves codes and missing statistics stay null, not zero', () => {
  const result = buildAnalysis([battle({ season_code: 'future', season_name: 'Future Season',
    my_deck: { hero_list: [{ hero_code: 'm0256', first_pick: 0, mvp: 0, ban: 0 }], preban_list: ['m0256'] },
    teamBettleInfo: null,
  })], characters, seasons);
  assert.deepEqual(result.missing_hero_codes, ['m0256']);
  assert.deepEqual(result.missing_season_codes, ['future']);
  assert.equal(result.battles[0].season_name, 'Future Season');
  assert.equal(result.battles[0].season_end_date, null);
  assert.equal(result.picks[0].hero_code, 'm0256');
  assert.equal(result.picks[0].hero_name, null);
  assert.equal(result.picks[0].attack_damage, null);
  assert.equal(result.picks[0].stats_available, false);
});

test('joins hero statistics by code rather than array position', () => {
  const row = battle();
  row.my_deck.hero_list.push({ hero_code: 'c6005', first_pick: 0, mvp: 0, ban: 0 });
  row.teamBettleInfo = '"my_team":' + JSON.stringify([{ ...stats('c6005'), attack_damage: 99 }, stats('c1168')]);
  const result = buildAnalysis([row], characters, seasons);
  assert.deepEqual(result.picks.filter(p => p.side === 'player').map(p => [p.hero_code, p.attack_damage]), [['c1168', 1234], ['c6005', 99]]);
});

test('malformed embedded stats and ambiguous reference codes fail visibly', () => {
  assert.throws(() => buildAnalysis([battle({ teamBettleInfo: 'broken json' })], characters, seasons), /teamBettleInfo/);
  assert.throws(() => buildAnalysis([battle()], { en: [...characters.en, ...characters.en] }, seasons), /Duplicate/);
  assert.throws(() => buildAnalysis([battle()], characters, [...seasons, ...seasons]), /Duplicate/);
});

test('generates repeatable output from local files and preserves prior output on failure', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'e7-analysis-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(join(dataDir, 'reference'));
  await writeFile(join(dataDir, 'reference/char.json'), JSON.stringify(characters));
  await writeFile(join(dataDir, 'reference/season.json'), JSON.stringify(seasons));
  await writeFile(join(dataDir, 'battles.json'), JSON.stringify([battle()]));
  const summary = await generateAnalysis({ dataDir });
  assert.equal(summary.battles, 1);
  assert.equal(summary.picks, 2);
  const before = await readFile(join(dataDir, 'analysis.json'));
  await generateAnalysis({ dataDir });
  assert.deepEqual(await readFile(join(dataDir, 'analysis.json')), before);
  await writeFile(join(dataDir, 'battles.json'), JSON.stringify([battle({ teamBettleInfo: 'invalid' })]));
  await assert.rejects(generateAnalysis({ dataDir }));
  assert.deepEqual(await readFile(join(dataDir, 'analysis.json')), before);
});
