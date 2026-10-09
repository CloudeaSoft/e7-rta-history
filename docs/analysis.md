# Analysis dataset

`data/analysis.json` is generated from `data/battles.json` and the supplied reference files in `data/reference/`. It contains three related tables in a single JSON document. All field names and character names use English; original player names and source codes are preserved.

| Table | One row per | Contents |
| --- | --- | --- |
| `battles` | Battle | Time, season, players, grades, result code, score, turns, and opening rule codes |
| `picks` | Drafted hero on each side | Character metadata, draft flags, equipment, and combat statistics |
| `prebans` | Prebanned hero on each side | Character metadata and side |

Join the tables on `battle_id`, composed of world, player ID, season code, and battle sequence. `side` is `player` or `opponent`, relative to the archived account. Battle order follows the chronological aggregate; pick and preban rows follow battle order and then the original deck order. `team_pick_order` comes from the API and is local to each team, not a global draft sequence.

## Generate

```sh
npm run analyze  # Regenerate only the analysis file from the current aggregate
npm run rebuild  # Rebuild the aggregate from snapshots, then regenerate analysis
npm run archive  # Fetch a new snapshot, rebuild the aggregate, and regenerate analysis
```

Daily GitHub Actions runs commit the snapshot, aggregate, and analysis together. Generation requires Node.js 24 and no third-party dependencies. Repeated generation from identical inputs produces identical output; a failed generation preserves the previous analysis file.

## Interpretation

- `schema_version` is `1`. IDs remain strings, including large battle sequences.
- Character names use the `en` section of `char.json`. Missing names remain `null`, original codes are retained, and `missing_hero_codes` lists unmatched codes from both picks and prebans. Class and element can fall back to combat statistics when the character reference is missing.
- `base_grade` comes from the character reference; `battle_grade`, awakening, and level come from the actual battle. Missing statistics are `null`, not zero. `stats_available` distinguishes absent combat statistics from a valid all-zero record.
- Pick flags come from `my_deck` / `enemy_deck`. Combat statistics are parsed from `teamBettleInfo` / `teamBettleInfoenemy` and joined by hero code on each side. Banned heroes remain in `picks`; exclude `banned: true` when analyzing heroes that participated. Do not treat zero values for banned heroes as performance observations.
- Equipment set arrays retain duplicates. Artifact codes remain codes because no artifact reference was supplied. Prebans are separate from draft bans and do not count as picks.
- `result_code` preserves `iswin`. `score`, `score_change_type_code`, and `score_change_points` preserve `myscore_info` values. No unverified result labels, signed score changes, or win rates are inferred.
- Time strings remain unchanged; no timezone conversion is performed. `battle_time` preserves the API value. Opening rule codes also remain unchanged.
- Seasons are joined by code, not inferred from date ranges. Reference dates are copied verbatim, including `2099-12-31` in the supplied current-season entry; do not treat this as a confirmed season end date. The reference's temporary `is_now_season` flag is not exported. Unknown season codes retain their original name where available and appear in `missing_season_codes`.
- Reference files are static copies supplied for this project. Update them when new heroes or seasons appear, then rebuild. Raw snapshots and their aggregate remain available for fields omitted from this analysis dataset.

This dataset is intended for personal analysis only.
