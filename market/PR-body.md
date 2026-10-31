# Add dsh-rules

Adds `xulei666a/dsh-rules` to the plugin list.

- Repo: https://github.com/xulei666a/dsh-rules
- Release: https://github.com/xulei666a/dsh-rules/releases/tag/v1.0.0
- Category: `memory` — it manages the agent's persistent guidelines/rules.
- Entry file: `data/plugins/xulei666a__dsh-rules.yml` (only this file is added; no generated README changes)

What it does: unified rules/guidelines library for DSH. Default rules are synced into the `AGENTS.md`
managed section; local rules are routed by task domain; there is a management page and right-sidebar
panel, semantic routing (optional local embeddings), a classification tree, and an in-panel assistant
for collecting rules from existing sources, calibrating pending rules, custom classification and an
issue ledger grouped by owner.

Checklist:

- [x] `package.json` has `dsh.bundle.patch` and `dsh.client`; `cordis.patch.yml` at repo root
- [x] Real implementation with tests (`scripts/selftest.mjs`: 110 checks, `scripts/selftest-client.mjs`: 4 checks) — CI green
- [x] `repository` points back to the listed repo
- [x] No build step, pure Node >= 20 ESM, MIT
