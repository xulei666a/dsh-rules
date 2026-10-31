# dsh-rules — unified rules/guidelines layer for DSH

Keeps every agent guideline in **one rule library**: manage, resolve, sync, audit, personalize.

- **Rule store**: `~/.dsh/rules/rules.jsonl` (one rule per line: `scope / category / key / value / priority / tags / source / status`)
- **Always-on output**: effective rules are synced into the managed section at the top of `~/.dsh/AGENTS.md` (`<!-- dsh-rules:begin ... end -->`); hand-written content is untouched
- **Coverage**: `default` (always-on) / `local` (routed by task domain) + per-conversation pins
- **23 model tools · 23 host routes · admin page + right-sidebar panel + in-panel assistant**

> Version **1.0.9** (first public release). See [CHANGELOG.md](CHANGELOG.md) and [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Features

- Unified rule library with query, resolve, set/remove, bulk edit, audit, sync, export, rollback and change history.
- Managed `AGENTS.md` section (digest mode, auto-backup, rollback).
- Default vs local coverage; local rules are routed by task domain instead of being injected everywhere.
- **Read rules**: scan `~/.dsh/AGENTS.md` (hand-written part), `EXPERIENCE.md`, project `AGENTS.md`, user skills, plugin-bundled skills and style-packs; split long bullets, weighted classification, near-duplicate dedupe; deleted collected rules are suppressed from coming back.
- **Issue ledger**: problems grouped by **owner** (pending review / conflicts / same-title groups / duplicates / missing sources / suppression list / field errors / coverage review) and reported by the assistant with suggestions.
- **Assistant session** in the panel: bulk edits, skill import, rule drafting, custom classification, calibration; role constraints are injected only on the first message.
- Semantic routing: zero-dependency tier A (tags, synonyms, bigrams, category weighting); optional local embeddings (tier B, `Xenova/multilingual-e5-small`).
- Classification tree: 5 built-in top categories (deliverables / memory & red lines / working style / tools & environment / review queue), arbitrary depth, multiple schemes, move-not-copy.
- Source gate & harvesting pipeline (`rules_sources`, `harvest.mjs`, merge/dedupe/coverage audit).
- Admin page: single-file HTML, no build; search, filters, zoom, drill-down, animations.

## Install

**A. Plugin market (recommended)**: DSH sidebar **Plugins → Market**, search `dsh-rules`, install and restart DSH.

**B. Local link**: add the dependency and bundle to the profile, then restart DSH:

```json
{ "dependencies": { "dsh-rules": "link:/path/to/dsh-rules" } }
```

The plugin directory also needs junctions for `@deepseek-ai/{dsh-tools,cordis,schemastery}` pointing at the host packages. Details in [docs/QUICKSTART.md](docs/QUICKSTART.md).

## Quick start

1. Restart DSH, open the **Unified rules** tab (or `http://127.0.0.1:<DSH port>/dsh-rules/ui`).
2. **First run is an empty library** (no seeded rules — every user differs). Click **Read rules** to collect from existing sources, or tell the assistant “remember this: …”.
   - Want a generic starter set? Put `{"seedDefaults": true}` in `~/.dsh/rules/config.json`, delete `rules.jsonl`, restart.
3. Click **Read rules** to collect existing guidelines from the system (skills / plugins / AGENTS / EXPERIENCE / style-packs).
4. Open the **assistant** and ask: “check the rule library”, “calibrate pending rules”, “classify by my own habits”.
5. Run `rules_sync` to push changes into `AGENTS.md`.

## Rule model

| Field | Meaning |
|---|---|
| `scope` | `global` / `user` / `project:<path>` (same key resolved by scopeRank + priority) |
| `category` | `paths / install / tools / style / safety / workflow / model / notify / skill / imported` |
| `key` | e.g. `paths.downloads`, `tools.ppt`, `safety.delete_confirm` |
| `value` | string (JSON string for structured values) |
| `priority` | higher wins; defaults global=100 / user=200 / project=300 |
| `tags` | optional; inferred from key/title/value when absent |
| `coverage` | `default` (always-on) / `local` (with `appliesTo` task domains) |
| `status` | `active` / `pending` / `deprecated` |
| `source` | e.g. `AGENTS.md`, `技能:<name>`, `style-packs:<domain>/<pack>` |

## Tools (23)

`rules_query`, `rules_resolve`, `rules_set`, `rules_remove`, `rules_bulk`, `rules_route`, `rules_groups`, `rules_coverage`, `rules_collect`, `rules_read`, `rules_mark_read`, `rules_issues`, `rules_audit`, `rules_report`, `rules_sync`, `rules_export`, `rules_sources`, `rules_session`, `rules_draft`, `rules_history`, `rules_topology`, `rules_restore`, `rules_rollback`.

## Host routes (23)

`/dsh-rules/{list, audit, coverage, route, tree, set, sync, remove, report, sources, history, session, topology, read-state, read, assistant, skill-import, rule-draft, backups, rollback, project, ui}` plus `debug-session-controller`.

## CLI

```powershell
node scripts/cli.mjs list
node scripts/cli.mjs audit
node scripts/cli.mjs issues
node scripts/cli.mjs collect --dry-run
node scripts/cli.mjs sync
node scripts/cli.mjs groups show default
```

## Data files

`~/.dsh/rules/{rules.jsonl, groups.json, session-overrides.json, read-state.json, collect-suppressed.json, history.jsonl, coverage-map.json, embeddings.json}`.

## Test

```powershell
node scripts/selftest.mjs          # 110 offline checks (temporary HOME)
node scripts/selftest-client.mjs   # client bundle contract
```

## Known limitations

- Re-reading after editing a source adds a new version; the old one stays until deleted.
- Editing a rule's value is not auto-corrected by re-reading (key unchanged, dedupe skips it).
- Titles are truncated at the first clause; same-source/same-title groups may appear in the issue ledger.
- If `AGENTS.md` exceeds the host budget (~64KB), the managed section stays at the top but the tail is truncated.

## License

MIT — see [LICENSE](LICENSE).
