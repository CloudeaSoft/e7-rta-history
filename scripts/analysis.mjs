import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

function indexBy(rows, key, label) {
  if (!Array.isArray(rows)) throw new Error(`Expected ${label} array`);
  const result = new Map();
  for (const row of rows) {
    if (typeof row?.[key] !== 'string' || !row[key]) throw new Error(`Invalid ${label} key`);
    if (result.has(row[key])) throw new Error(`Duplicate ${label} key: ${row[key]}`);
    result.set(row[key], row);
  }
  return result;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value))) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return Number(value);
}

function flag(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  if (number !== 0 && number !== 1) throw new Error(`Invalid boolean flag: ${value}`);
  return number === 1;
}

function teamStats(value, field) {
  if (value === null || value === undefined || value === '') return new Map();
  try {
    // The API stores an object fragment, e.g. '"my_team":[...]'. Never evaluate it.
    const text = value.trim();
    const parsed = JSON.parse(text.startsWith('{') ? text : `{${text}}`);
    return indexBy(parsed.my_team, 'hero_code', field);
  } catch (error) {
    throw new Error(`Invalid ${field}: ${error.message}`, { cause: error });
  }
}

export function buildAnalysis(battles, characters, seasons) {
  if (!Array.isArray(battles)) throw new Error('Expected battles array');
  const heroes = indexBy(characters.en, 'code', 'English characters');
  const seasonIndex = indexBy(seasons, 'season_code', 'seasons');
  const missingHeroes = new Set();
  const missingSeasons = new Set();
  const output = { schema_version: 1, locale: 'en', missing_hero_codes: [], missing_season_codes: [], battles: [], picks: [], prebans: [] };
  const seen = new Set();

  function heroInfo(code, stats) {
    if (typeof code !== 'string' || !code) throw new Error('Missing hero code');
    const hero = heroes.get(code);
    if (!hero) missingHeroes.add(code);
    return {
      hero_code: code,
      hero_name: hero?.name ?? null,
      hero_reference_found: Boolean(hero),
      class_code: hero?.job_cd ?? stats?.job_cd ?? null,
      element_code: hero?.attribute_cd ?? stats?.attribute_cd ?? null,
      base_grade: numberOrNull(hero?.grade),
    };
  }

  for (const battle of battles) {
    const battleId = [battle.worldCode, battle.nicknameno, battle.season_code, battle.battle_seq].map(String).join(':');
    if (seen.has(battleId)) throw new Error(`Duplicate battle: ${battleId}`);
    seen.add(battleId);
    const season = seasonIndex.get(battle.season_code);
    if (!season) missingSeasons.add(battle.season_code);
    output.battles.push({
      battle_id: battleId,
      battle_seq: String(battle.battle_seq),
      battle_day: battle.battle_day,
      season_code: battle.season_code,
      season_name: season?.name ?? battle.season_name ?? null,
      season_reference_found: Boolean(season),
      season_start_date: season?.startDate ?? null,
      season_end_date: season?.endDate ?? null,
      player_id: String(battle.nicknameno),
      player_world: battle.worldCode,
      player_grade: battle.grade_code ?? null,
      opponent_id: battle.matchPlayerNicknameno == null ? null : String(battle.matchPlayerNicknameno),
      opponent_name: battle.enemy_nick_no ?? null,
      opponent_world: battle.enemy_world_code ?? null,
      opponent_grade: battle.enemy_grade_code ?? null,
      result_code: numberOrNull(battle.iswin),
      battle_time: numberOrNull(battle.battle_time),
      turns: numberOrNull(battle.turn),
      score: numberOrNull(battle.myscore_info?.win_score),
      score_change_type_code: numberOrNull(battle.myscore_info?.up_down_type),
      score_change_points: numberOrNull(battle.myscore_info?.up_down_score),
      opening_rule_code: battle.opening_rule_title ?? null,
      opening_rule_description_code: battle.opening_rule_desc_tid ?? null,
    });

    for (const [side, deckKey, statsKey] of [
      ['player', 'my_deck', 'teamBettleInfo'],
      ['opponent', 'enemy_deck', 'teamBettleInfoenemy'],
    ]) {
      const deck = battle[deckKey];
      if (!Array.isArray(deck?.hero_list) || !Array.isArray(deck?.preban_list)) {
        throw new Error(`Invalid ${deckKey} in battle ${battleId}`);
      }
      let stats;
      try { stats = teamStats(battle[statsKey], statsKey); }
      catch (error) { throw new Error(`Battle ${battleId}: ${error.message}`, { cause: error }); }
      for (const hero of deck.hero_list) {
        const detail = stats.get(hero.hero_code);
        if (detail?.equip != null && !Array.isArray(detail.equip)) throw new Error(`Invalid equipment in battle ${battleId}`);
        output.picks.push({
          battle_id: battleId,
          side,
          ...heroInfo(hero.hero_code, detail),
          first_pick: flag(hero.first_pick),
          banned: flag(hero.ban),
          mvp: flag(hero.mvp),
          stats_available: Boolean(detail),
          team_pick_order: numberOrNull(detail?.pick_order),
          position: numberOrNull(detail?.position),
          battle_grade: numberOrNull(detail?.grade),
          awaken_grade: numberOrNull(detail?.awaken_grade),
          level: numberOrNull(detail?.level),
          attack_damage: numberOrNull(detail?.attack_damage),
          receive_damage: numberOrNull(detail?.receive_damage),
          recovery: numberOrNull(detail?.recovery),
          kill_count: numberOrNull(detail?.kill_count),
          respawn: numberOrNull(detail?.respawn),
          mvp_points: numberOrNull(detail?.mvp_point),
          artifact_code: detail?.artifact || null,
          equipment_sets: detail?.equip ? [...detail.equip] : null,
        });
      }
      for (const code of deck.preban_list) {
        output.prebans.push({ battle_id: battleId, side, ...heroInfo(code) });
      }
    }
  }
  output.missing_hero_codes = [...missingHeroes].sort();
  output.missing_season_codes = [...missingSeasons].sort();
  return output;
}

export async function generateAnalysis({ dataDir }) {
  const [battles, characters, seasons] = await Promise.all(
    ['battles.json', 'reference/char.json', 'reference/season.json']
      .map(async file => JSON.parse(await readFile(join(dataDir, file), 'utf8'))),
  );
  const result = buildAnalysis(battles, characters, seasons);
  const path = join(dataDir, 'analysis.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { battles: result.battles.length, picks: result.picks.length, prebans: result.prebans.length,
    missing_hero_codes: result.missing_hero_codes, missing_season_codes: result.missing_season_codes };
}
