# Claude Code install proof — MeshTool plugin (mesh @ 1.0.0)

**Status: FAILED PROOF.** This proof could not be completed. Per the builder
order, a failed proof still goes up, clearly labeled failed, with every
failure recorded verbatim. Nothing in this PR was worked around, and nothing
was changed to force a pass.

## Repo and starting point (verified 2026-10-29)

- Repo: Meshtool/meshmarket-mcp, branch `cline/install-proof-claude-code`,
  base `main` (commit `2e5105f`)
- Catalog: `.claude-plugin/marketplace.json` — marketplace `mesh`, v1.0.0,
  exactly one plugin: `mesh`, source `./plugins/mesh`
- Plugin: `plugins/mesh/.claude-plugin/plugin.json` — name `mesh`,
  displayName MeshTool, v1.0.0, author Right On Par LLC
- Plugin servers (verbatim from `plugin.json`):
  - meshmarket: `https://market.meshtool.ai/mcp`, token `${MESHMARKET_AGENT_KEY}`
  - meshtool: `https://api.meshtool.ai/mcp`, token `${MESHTOOL_KEY}`
- Distribution gate (`node tools/distribution-gate.mjs`): **32 passed, 0
  failed** — all install-path files exist, parse, and agree.
- Open PRs in Meshtool/meshmarket-mcp: 0.

## Environment limitation

This sandbox has no Claude Code session, so the three `/plugin` commands
below **could not be executed here** (they are Claude Code commands, not
shell commands). No manual MCP config, different repo, or copied key was
substituted — a workaround would be a failed proof, so none was attempted.

Even setting that aside, the live MeshMarket API is down, so every step that
depends on it cannot be completed. That is the real blocking failure, recorded
verbatim below.

## Step 1 — the three install commands (verbatim)

```
 /plugin marketplace add Meshtool/meshmarket-mcp
 /plugin install mesh@mesh
 /reload-plugins
```

**Result: not executed.** No Claude Code session is available in this
environment to run `/plugin` commands. The repo files these commands resolve
against were verified valid instead (distribution gate 32/32; `plugin.json`
and `marketplace.json` parse as valid JSON; `plugin.json` declares exactly the
`meshmarket` and `meshtool` servers the order describes).

## Step 2 — `/mesh` live catalog

**Result: cannot be completed.** The live API returns an error on every
endpoint, so `/mesh` (which calls `mesh_discover` against
`https://market.meshtool.ai/mcp`) cannot return a catalog. No capability
names or prices can be reported, and none were copied from a README, an old
note, or memory.

Verbatim live-API response (`GET https://market.meshtool.ai/mcp`,
`tools/list` equivalent):

```json
{
  "error": "migrate_failed",
  "detail": "Error: D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL): internal error; reference = khlrp2mrvnj84j5it591brmi"
}
```

## Step 3 — keyless browse

**Result: cannot be completed.** Browsing is documented as keyless (no key,
no account, no form), but it still requires a reachable API. The API is down,
so a keyless browse could not be performed. Nothing was browsed.

Verbatim live-API response (`GET https://market.meshtool.ai/api/capabilities`):

```json
{
  "error": "migrate_failed",
  "detail": "Error: D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL): internal error; reference = 6btud3o55ds302r346aal75l"
}
```
## Step 4 — one paid call (mint key via `mesh_signup`, call once)

**Result: cannot be completed.** No fresh agent key was minted and no paid
call was made.

- No key from Dw, Frank, or any existing agent was used (the order forbids
  this), and no key was copied from any file, chat, or repo.
- `mesh_signup` requires `POST https://market.meshtool.ai/api/accounts`,
  which is down, so a fresh key with starter MESH could not be created.
- Without a reachable API and a valid key, no capability could be selected
  from the live catalog and called once. There is no receipt: no capability,
  no price, no call id, no balance before/after.

Verbatim live-API response (`POST https://market.meshtool.ai/api/accounts`,
`mesh_signup` equivalent):

```json
{
  "error": "migrate_failed",
  "detail": "Error: D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL): internal error; reference = evuqbp0r4jdbrt721k6am4b4"
}
```

## Where it stopped

The proof stopped at the live API: every endpoint returns `migrate_failed`
(a D1 `CREATE TABLE IF NOT EXISTS schema_meta` execution error). Steps 2, 3,
and 4 all depend on a reachable API, so none can be completed. Step 1 could
not be executed because no Claude Code session exists in this environment.

## What a visitor does NOT get yet

- No seat kit
- No shared memory listing
- No money-out

## Secrets

No secret values are in this PR. No `agk_…` or `sk_…` value appears anywhere
in the proof doc, this commit, or the PR. Receipt ids, capability names,
prices, and balances would be fine to include, but none exist here because
no call succeeded.

## Files changed

- `docs/claude-code-install-proof.md` — new proof doc (this file)
- `README.md` — one link line added to the Claude Code install block
  (links to this proof doc). No other README wording changed.

## PR body checklist (for the merge reader)

- Branch: `cline/install-proof-claude-code`, base: `main`
- Files changed: `docs/claude-code-install-proof.md` (new), `README.md` (one link line)
- Three install commands: not executable in this environment (no Claude Code
  session); repo install-path files verified valid instead (gate 32/32)
- Live catalog from `/mesh`: not available — API returns `migrate_failed`
- One paid call: not made — API returns `migrate_failed`; no key minted, no
  receipt
- Failures: recorded verbatim above; proof labeled FAILED
- No secret values are in this PR.

