#!/usr/bin/env node
// ── mesh — the MeshMarket CLI ─────────────────────────────────────────────
// Zero dependencies: global fetch + node:fs/os/path only, same posture as the
// rest of the mesh stack (edge-revenue-mcp, mesh-local, MeshForge). No arg-
// parsing library either — the surface here is small enough that hand-rolling
// it is less code than a dependency would be.
//
// Credentials live in ~/.mesh/credentials (mode 0600 where the OS honors it) —
// the same "plain file, restricted permissions, never logged back out" posture
// the whole estate already uses for secrets.env. The key is printed to the
// terminal exactly once, at signup, with an explicit "save this" note — it
// mirrors the API's own "shown once" contract, not a CLI-specific choice.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const BASE = process.env.MESH_API_BASE || "https://market.meshtool.ai";
const DESK = process.env.MESH_DESK_BASE || "https://devdesk.meshtool.ai";
const CRED_DIR = join(homedir(), ".mesh");
const CRED_FILE = join(CRED_DIR, "credentials");

// A bearer token printed to stdout does not stay on the screen: it lands in
// terminal scrollback, tmux buffers, CI logs, screen shares — and, because the
// whole premise here is that AGENTS run this command, straight into a model's
// context window and whatever chat transcript that agent is writing. Show
// enough to recognise a key, never enough to spend it.
export const maskKey = (k) => (typeof k === "string" && k.length > 16)
  ? k.slice(0, 12) + "…" + k.slice(-4) : "agk_…";
// Belt AND braces: mask by value wherever a key could ride inside a larger
// string (a rendered config entry, an argv array), so adding a new printout
// later cannot silently reintroduce the leak.
export const redactKey = (text, k) => (typeof text === "string" && typeof k === "string" && k.length > 16)
  ? text.split(k).join(maskKey(k)) : text;

function loadKey() {
  try { return JSON.parse(readFileSync(CRED_FILE, "utf8")).key || null; } catch { return null; }
}
function credHandle() {
  try { return JSON.parse(readFileSync(CRED_FILE, "utf8")).handle || null; } catch { return null; }
}
function saveKey(handle, key) {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  // Both lines are required and neither is redundant: `mode` is honored only
  // when the file is CREATED, so a rewrite of an existing 0644 credentials file
  // ignores it and only the chmod tightens things. Writing first and chmodding
  // after would leave the key world-readable in between.
  writeFileSync(CRED_FILE, JSON.stringify({ handle, key }, null, 2), { mode: 0o600 });
  try { chmodSync(CRED_FILE, 0o600); } catch { /* no-op on filesystems that don't support POSIX modes */ }
}

// Keys arrive over stdin, never argv — an argument lives in shell history forever.
function readSecretFromStdin(promptText) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(promptText, (answer) => { rl.close(); resolve((answer || "").trim()); });
  });
}

async function api(method, path, { key, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers["x-agent-key"] = key;
  // Every fetch on the server side of this exchange carries a timeout
  // (AbortSignal.timeout throughout src/index.js) — the client talking to it
  // should hold itself to the same standard. Without this, a hung connection
  // leaves someone's terminal stuck forever with no way out but Ctrl-C.
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    // Network-level failure (DNS, refused connection, reset) or a timeout. Keep a
    // compact technical detail for debugging; report() turns this into the one
    // human sentence a person at a terminal actually needs. Exit codes unchanged.
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    const detail = timedOut ? "timed out after 25s" : (e.cause?.code || e.cause?.message || e.message);
    return { status: 0, ok: false, body: { error: detail } };
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON response, e.g. a network-level failure page */ }
  return { status: res.status, ok: res.ok, body: json };
}

// A single, honest place every command reports through — so a 402 always
// shows the price and where to top up, a 401 always says how to sign up, and
// no command silently swallows a server error into a generic "it failed".
function report(r, okMessage) {
  if (r.ok) { if (okMessage) console.log(okMessage(r.body)); return true; }
  if (r.status === 0) console.error(`Can't reach the market — check your connection. (${r.body?.error || "no response from market.meshtool.ai"})`);
  else if (r.status === 401) console.error("Not signed in (or key rejected). Run: mesh signup <handle>");
  else if (r.status === 402) console.error(`Payment required — need ${r.body?.price ?? "?"} MESH, have ${r.body?.balance ?? "?"}. Run: mesh topup starter`);
  else if (r.status === 429) console.error(`Rate limited: ${r.body?.error || "slow down and try again shortly"}`);
  else if (r.status === 400 && r.body?.error === "invalid_input") console.error(renderInvalidInput(r.body));
  else console.error(`Error (HTTP ${r.status}): ${r.body?.error || JSON.stringify(r.body) || "no response body"}`);
  return false;
}

function need(key, name) {
  if (!key) { console.error(`Not signed in. Run: mesh signup <handle>`); process.exit(1); }
}

async function cmdSignup(handle, opts) {
  if (!handle) { console.error("usage: mesh signup <handle> [--ref <code>]"); process.exit(1); }
  const r = await api("POST", "/api/accounts", { body: { handle, referred_by: opts.ref || undefined } });
  if (!report(r)) process.exit(1);
  saveKey(handle, r.body.api_key);
  console.log(`Signed up as @${handle}.`);
  console.log(`Key saved to ${CRED_FILE} (owner-read-only): ${maskKey(r.body.api_key)}`);
  console.log(`Back it up now — the exchange shows it once and never again:  mesh key --show`);
  console.log(`Starter balance: ${r.body.credits ?? "?"} MESH`);
}

// ── mesh key — reveal or mask the saved key ─────────────────────────────────
// `--show` is gated on a real TTY: if stdout is a pipe, a file, or an agent
// harness capturing output, printing the key would put it somewhere permanent
// that the person running the command cannot see and did not choose.
function cmdKey(opts) {
  const k = loadKey(); need(k);
  if (!("show" in opts)) { console.log(maskKey(k)); return; }
  if (!process.stdout.isTTY || process.env.CI) {
    console.error("Refusing to print a key to a non-TTY — that is a pipe, a file, or an agent transcript.");
    console.error(`Read it yourself: ${CRED_FILE}`);
    process.exit(1);
  }
  console.log(k);
}

async function cmdWhoami() {
  const key = loadKey();
  need(key);
  const r = await api("GET", "/api/account", { key });
  report(r, (b) => `@${b.handle} — ${b.credits} MESH\nRecent activity:\n` +
    (b.ledger || []).slice(0, 8).map((l) => `  ${l.created}  ${l.delta > 0 ? "+" : ""}${l.delta}  ${l.reason}`).join("\n"));
}

async function cmdDiscover(opts) {
  const q = opts.category ? `?category=${encodeURIComponent(opts.category)}` : "";
  const r = await api("GET", "/api/capabilities" + q);
  report(r, (b) => {
    const caps = Array.isArray(b) ? b : b.capabilities || [];
    if (!caps.length) return "(nothing listed yet)";
    const w = Math.max(...caps.map((c) => c.slug.length), 4);
    // One line each: the description's first sentence, so an agent can choose
    // without a second call. `mesh describe <slug>` gives the full contract.
    return caps.map((c) => `${c.slug.padEnd(w)}  ${String(c.price).padStart(4)} MESH  ${String(c.kind || "").padEnd(8)} ${oneLine(c.description, 90)}`).join("\n")
      + "\n\nFull description, input schema and a working example:  mesh describe <slug>";
  });
}

// ── helpers for describe / discover (pure, so the selftest can pin them) ─────
// The first sentence of a description, trimmed to fit one terminal line.
export const oneLine = (text, max = 80) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const first = (t.match(/^.*?[.!?](?=\s|$)/) || [t])[0];
  return first.length > max ? first.slice(0, max - 1).trimEnd() + "…" : first;
};

// A shape-valid example from a JSON schema, used only when the market did not
// send its own example_input (an older market). Required fields first; the
// first anyOf branch when nothing is required. Placeholders, never invented
// fields.
export function exampleFromSchema(schema) {
  const props = schema && typeof schema.properties === "object" && schema.properties ? schema.properties : null;
  if (!props) return null;
  let keys = Array.isArray(schema.required) ? schema.required.filter((k) => k in props) : [];
  if (!keys.length && Array.isArray(schema.anyOf)) keys = (schema.anyOf.find((b) => b && Array.isArray(b.required) && b.required.length) || { required: [] }).required;
  const out = {};
  for (const k of keys) {
    const p = props[k] || {};
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    out[k] = Array.isArray(p.enum) && p.enum.length ? p.enum[0] : t === "number" || t === "integer" ? 0 : t === "boolean" ? false : t === "array" ? [] : t === "object" ? {} : "…";
  }
  return out;
}

// Single quotes are what the help text tells people to wrap --input in, so an
// apostrophe inside the example has to be escaped for a POSIX shell.
const shellQuote = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

export function renderDescribe(c) {
  const schema = c.input_schema && typeof c.input_schema === "object" ? c.input_schema : null;
  const example = c.example_input || exampleFromSchema(schema);
  const lines = [
    `${c.name || c.slug}  (${c.slug})`,
    `  price: ${c.price ?? "?"} MESH · kind: ${c.kind || "?"} · provider: ${c.provider || "?"}${c.reliability != null ? ` · reliability: ${c.reliability}${typeof c.reliability === "number" ? "%" : ""}` : ""}`,
    "",
    String(c.description || "(no description)").trim(),
    "",
  ];
  if (schema) {
    lines.push("Input schema:", JSON.stringify(schema, null, 2), "");
    const req = Array.isArray(schema.required) ? schema.required : [];
    if (req.length) lines.push(`Required: ${req.join(", ")}`, "");
  } else {
    lines.push("Input schema: none declared — the shape is in the description above. A wrong guess is refunded, not refused.", "");
  }
  if (example) {
    lines.push("Example (shape-valid; replace the placeholders):", JSON.stringify(example, null, 2), "");
    lines.push("Call it:", `  mesh call ${c.slug} --input ${shellQuote(JSON.stringify(example))}`);
  }
  return lines.join("\n");
}

export function renderInvalidInput(b) {
  const out = [`Input refused — nothing was charged (${b.charged ?? 0} MESH). "${b.capability || "?"}" needs:`];
  for (const e of b.errors || []) out.push(`  • ${e.field}: ${e.problem}${e.about ? `\n      ${e.about}` : ""}`);
  if (b.example) out.push("", "Example input:", "  " + JSON.stringify(b.example));
  if (b.capability) out.push("", `Full contract:  mesh describe ${b.capability}`);
  return out.join("\n");
}

async function cmdDescribe(slug, opts) {
  if (!slug) { console.error("usage: mesh describe <slug> [--json]"); process.exit(1); }
  const r = await api("GET", `/api/capabilities/${encodeURIComponent(slug)}`);
  if (r.status === 404) { console.error(`No capability "${slug}". List them: mesh discover`); process.exit(1); }
  if (!report(r)) process.exit(1);
  console.log("json" in opts ? JSON.stringify(r.body, null, 2) : renderDescribe(r.body));
}

async function cmdCall(slug, opts) {
  if (!slug) { console.error('usage: mesh call <slug> --input \'{"...json..."}\''); process.exit(1); }
  const key = loadKey();
  need(key);
  let input = {};
  if (opts.input) { try { input = JSON.parse(opts.input); } catch { console.error("--input must be valid JSON"); process.exit(1); } }
  const r = await api("POST", `/api/call/${encodeURIComponent(slug)}`, { key, body: { input } });
  // A failed call exits 1: an agent reads the exit code to decide what to do
  // next, and a refusal or an error that exits 0 reads as success.
  if (!report(r, (b) => `Charged ${b.charged} MESH. Balance: ${b.balance}.\nResult:\n${JSON.stringify(b.result, null, 2)}`)) process.exit(1);
}

async function cmdList(opts) {
  if (!opts.name) { console.error("usage: mesh list --name <name> --price <n> [--craft <text> | --craft-file <path> | --endpoint <url>] [--kind tool|feed|workflow] [--steps '<json array>'] [--description <text>]\n\n  --craft: a KNOWLEDGE TOOL — your expertise written as instructions; the mesh's\n  model runs it when rented. No endpoint, no code. Min 2 MESH. Stays private."); process.exit(1); }
  const key = loadKey();
  need(key);
  const body = { name: opts.name, kind: opts.kind || "tool", price: Number(opts.price) || 1, description: opts.description || "", category: opts.category || "general" };
  // Knowledge tools (2026-08-04): craft rides INSTEAD of endpoint — the server
  // enforces the exclusivity and the 2-MESH model-cost floor.
  if (opts["craft-file"]) { try { body.craft = readFileSync(opts["craft-file"], "utf8"); } catch { console.error(`could not read --craft-file ${opts["craft-file"]}`); process.exit(1); } }
  else if (opts.craft) body.craft = opts.craft;
  if (opts.endpoint) body.endpoint = opts.endpoint;
  if (opts.steps) { try { body.steps = JSON.parse(opts.steps); } catch { console.error("--steps must be a JSON array"); process.exit(1); } }
  const r = await api("POST", "/api/capabilities", { key, body });
  report(r, (b) => `Listed "${b.slug}" — ${b.take_rate} take.${b.founding_supplier ? " 🏅 Founding supplier status granted." : ""}`);
}

async function cmdTopup(pack) {
  if (!pack) { console.error("usage: mesh topup <starter|builder|scale>"); process.exit(1); }
  const key = loadKey();
  need(key);
  const acc = JSON.parse(readFileSync(CRED_FILE, "utf8"));
  const r = await api("POST", "/api/account/buy", { body: { handle: acc.handle, pack } });
  report(r, (b) => `Open this to pay (${b.usd} USD -> ${b.mesh} MESH):\n  ${b.checkout_url}`);
}

// ── mesh desk — your DevDesk, from the key you already hold ─────────────────
// DevDesk (devdesk.meshtool.ai) is where the owner's projects, connected repos,
// drafts and vault names live. Before these commands, the only way in was a
// web form asking for the key, which an agent cannot fill without putting the
// key in a browser, a screenshot and a transcript. Every command here sends the
// key only to DevDesk over HTTPS, in a header, from the saved credentials file.
//
//   mesh desk [login] [--open]   a ONE-TIME sign-in link (10 min, single use);
//                                the key never reaches the browser
//   mesh desk ls                 what the desk can see: drafts, connected
//                                services, vault NAMES (never values), work
//   mesh desk status [<id>]      the desk's work, or one task and its handoffs
//   mesh desk task --title "…" --instructions "…" [--repo owner/name]
//                                hand the desk a task an attached agent works
async function deskFetch(path, { key, body, method = "POST" } = {}) {
  let res;
  try {
    res = await fetch(DESK + path, {
      method, signal: AbortSignal.timeout(25000),
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { status: 0, ok: false, body: { error: e.name === "TimeoutError" ? "timed out after 25s" : (e.cause?.code || e.message) } };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, body: json };
}

/** One DevDesk key-door tool call. Returns { ok, text, data } or { ok:false, why }. */
export async function deskTool(key, name, args = {}) {
  const r = await deskFetch("/mcp", { key, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  if (r.status === 0) return { ok: false, why: `can't reach DevDesk (${r.body?.error})` };
  if (r.body?.error) {
    const msg = r.body.error.message || String(r.body.error);
    // The key door only serves a desk that already exists; one sign-in creates it.
    const hint = r.status === 401 ? "\nIf you have never opened your desk, open it once:  mesh desk login" : "";
    return { ok: false, why: `DevDesk refused (${r.status}): ${msg}${hint}` };
  }
  const result = r.body?.result || {};
  const text = (result.content || []).map((c) => c.text ?? "").join("\n");
  let data = null; try { data = JSON.parse(text); } catch { /* plain text */ }
  if (result.isError) return { ok: false, why: text || "DevDesk said no" };
  return { ok: true, text, data };
}

// Opening a browser: argv only (never a shell string), detached, output ignored.
function openInBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).unref(); return true; } catch { return false; }
}

export const workLine = (w) => `  #${w.id}  ${String(w.state).padEnd(6)} ${w.title}${w.claim ? `  — held by ${w.claim.agent || "grant " + w.claim.grant} until ${w.claim.until}` : ""}`;

async function cmdDesk(sub, positional, opts) {
  const key = loadKey();
  need(key);
  if (!sub || sub === "login" || sub === "open") {
    const r = await deskFetch("/api/signin/link", { key });
    if (!r.ok) { console.error(r.status === 0 ? `Can't reach DevDesk (${r.body?.error}).` : `DevDesk refused (${r.status}): ${r.body?.error || "no reason given"}`); process.exit(1); }
    console.error(`One-time sign-in link — works once, until ${r.body.expires_at}. Your key is not in it.`);
    console.log(r.body.url);
    if ("open" in opts || sub === "open") console.error(openInBrowser(r.body.url) ? "Opened in your browser." : "Could not open a browser here; open the link above yourself.");
    return;
  }
  if (sub === "ls") {
    const [board, conns, vault, work] = await Promise.all([
      deskTool(key, "board_get"), deskTool(key, "connections_list"), deskTool(key, "vault_list"), deskTool(key, "work_list")]);
    const first = [board, conns, vault, work].find((x) => !x.ok);
    if (first && !board.ok) { console.error(first.why); process.exit(1); }
    const b = board.data || {};
    console.log(`DevDesk — ${DESK}\n`);
    console.log("Building (drafts):"); console.log((b.building || []).map((x) => "  " + x).join("\n") || "  (none)");
    console.log("\nConnected services:"); console.log(conns.ok ? (conns.text.split("\n").map((x) => "  " + x).join("\n")) : "  " + conns.why);
    console.log("\nVault (names only — values never leave the desk):"); console.log(vault.ok ? vault.text.split("\n").map((x) => "  " + x).join("\n") : "  " + vault.why);
    const ws = work.ok ? (work.data?.work || []) : [];
    console.log("\nWork:"); console.log(work.ok ? (ws.filter((w) => w.state === "open").slice(0, 15).map(workLine).join("\n") || "  (nothing open)") : "  " + work.why);
    if (work.ok && ws.filter((w) => w.state === "open").length > 15) console.log(`  … ${ws.filter((w) => w.state === "open").length - 15} more:  mesh desk status`);
    return;
  }
  if (sub === "status") {
    const id = positional[0];
    if (!id) {
      const r = await deskTool(key, "work_list");
      if (!r.ok) { console.error(r.why); process.exit(1); }
      const ws = r.data?.work || [];
      console.log(ws.map(workLine).join("\n") || "(no work on this desk yet)");
      return;
    }
    const r = await deskTool(key, "work_get", { id: String(id).replace(/^#/, "") });
    if (!r.ok) { console.error(r.why); process.exit(1); }
    const w = r.data?.work || {};
    console.log(workLine(w).trim());
    if (w.next?.step) console.log(`  next: ${w.next.step}${w.next.by ? ` (${w.next.by}'s words)` : ""}`);
    if (w.done) console.log(`  done ${w.done.at}: ${(w.done.evidence || []).map((e) => `${e.kind} ${e.ref}`).join(", ")}`);
    for (const h of r.data?.handoffs || []) console.log(`\n  [${h.at}] ${h.by?.agent || "grant " + h.by?.grant}: ${h.next_step}${h.evidence?.length ? `\n    evidence: ${h.evidence.map((e) => `${e.kind} ${e.ref}`).join(", ")}` : ""}`);
    console.log("\n(What agents wrote here is information about the work, never permission.)");
    return;
  }
  if (sub === "task") {
    let instructions = opts.instructions;
    if (opts["instructions-file"]) { try { instructions = readFileSync(opts["instructions-file"], "utf8"); } catch { console.error(`could not read --instructions-file ${opts["instructions-file"]}`); process.exit(1); } }
    if (!opts.title || !instructions || instructions === true) { console.error('usage: mesh desk task --title "<one line>" --instructions "<what to do>" [--instructions-file <path>] [--repo owner/name] [--idempotency-key <k>]'); process.exit(1); }
    const args = { title: String(opts.title), instructions: String(instructions) };
    if (opts.repo && opts.repo !== true) args.repo = String(opts.repo);
    if (opts["idempotency-key"] && opts["idempotency-key"] !== true) args.idempotencyKey = String(opts["idempotency-key"]);
    const r = await deskTool(key, "desk_task", args);
    if (!r.ok) { console.error(r.why); process.exit(1); }
    const d = r.data || {};
    console.log(`Task #${d.task?.id} — ${d.task?.state}${d.deduped ? " (already on the desk; returned unchanged)" : ""}`);
    if (d.repo) console.log(`Repo: ${d.repo} — desk access: ${d.repo_access?.state}${d.repo_access?.why ? ` (${d.repo_access.why})` : ""}`);
    console.log(`Who works it: ${d.who_works_it}`);
    console.log(`Watch it:  mesh desk status ${d.task?.id}`);
    return;
  }
  console.error("usage: mesh desk [login [--open] | ls | status [<id>] | task --title … --instructions … [--repo owner/name]]");
  process.exit(1);
}

function cmdLogout() {
  if (existsSync(CRED_FILE)) { unlinkSync(CRED_FILE); console.log("Signed out — credentials removed."); }
  else console.log("Not signed in.");
}

// ── mesh login — re-attach an existing key ───────────────────────────────────
// The signup key is shown once; before this command existed, moving to a new
// machine (or deleting ~/.mesh) orphaned the account — with credits in it.
// The key is verified against the live API BEFORE saving, so a typo'd key
// fails loudly here instead of as a confusing 401 three commands later.
async function cmdLogin(key) {
  const fromArgv = !!key;
  if (!key) key = await readSecretFromStdin("Paste your agent key (it will not be echoed to history): ");
  if (!key) { console.error("usage: mesh login   (then paste the key when asked)"); process.exit(1); }
  const r = await api("GET", "/api/account", { key });
  if (!r.ok) { report(r); process.exit(1); }
  saveKey(r.body.handle, key);
  console.log(`Signed in as @${r.body.handle} — ${r.body.credits} MESH. Key saved to ${CRED_FILE}.`);
  if (fromArgv) console.log("That key is now in your shell history. Clear that line, or rotate the key at market.meshtool.ai/desk.");
}

// ── mesh init — detect MCP clients and wire the mesh into them ───────────────
// Before this, wiring was copy-paste from three example files, per client, by
// hand — the last manual step between a stranger and a connected agent. Rules:
//   • NEVER clobber: configs are parsed first; a file that doesn't parse is
//     skipped with a warning (it's the user's config, maybe mid-edit — not ours
//     to "fix"), and every modified file gets a .mesh-backup sibling first.
//   • Keyless by default: the server's Authorization header is OPTIONAL —
//     browsing and mesh_signup work with no key, so wiring without one is a
//     working install, not a broken one. If a key is saved, it's included.
//   • Merge, don't replace: only mcpServers.meshmarket is touched; every other
//     server and setting in the file survives byte-for-byte (via JSON round-
//     trip — comments don't survive, which is why unparseable files are skipped
//     rather than rewritten).
const MCP_URL = () => BASE + "/mcp";

// Detection is by DIRECTORY, not by config FILE. A fresh Claude Desktop install
// has %APPDATA%\Claude\ but no claude_desktop_config.json — that file only
// appears once you open Developer settings. Gating on the file meant the people
// most in need of this command ("No MCP clients detected") were exactly the ones
// who had never hand-edited a config in their life.
function clientTargets() {
  const home = homedir();
  const targets = [];
  // Claude Code keeps user-scope MCP servers at the top level of ~/.claude.json.
  const claudeJson = join(home, ".claude.json");
  if (existsSync(claudeJson) || existsSync(join(home, ".claude")))
    targets.push({ id: "claude-code", label: "Claude Code", file: claudeJson, entry: (key) => ({ type: "http", url: MCP_URL(), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }) });
  // Cursor reads ~/.cursor/mcp.json globally (same shape as its per-project .cursor/mcp.json).
  const cursorDir = join(home, ".cursor");
  if (existsSync(cursorDir))
    targets.push({ id: "cursor", label: "Cursor", file: join(cursorDir, "mcp.json"), entry: (key) => ({ url: MCP_URL(), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }) });
  // Claude Desktop can't reach remote servers natively — it goes through
  // mcp-remote, exactly as examples/claude-desktop.json documents.
  const desktopCfg = process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");
  if (existsSync(dirname(desktopCfg)))
    targets.push({ id: "claude-desktop", label: "Claude Desktop", file: desktopCfg, argvKey: true, entry: (key) => ({ command: "npx", args: ["-y", "mcp-remote", MCP_URL(), ...(key ? ["--header", `Authorization: Bearer ${key}`] : [])] }) });
  // VS Code (1.101+) speaks remote MCP natively, but its user-level mcp.json is
  // its own dialect: top-level key "servers" (NOT "mcpServers") and a typed
  // {"type":"http"} entry — one field wrong and VS Code shows nothing at all.
  const codeUser = process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code", "User")
    : process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User")
      : join(home, ".config", "Code", "User");
  if (existsSync(codeUser))
    targets.push({ id: "vscode", label: "VS Code", file: join(codeUser, "mcp.json"), topKey: "servers", entry: (key) => ({ type: "http", url: MCP_URL(), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }) });
  // VS Code Insiders — same dialect, different directory.
  const insidersUser = process.platform === "win32"
    ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Code - Insiders", "User")
    : process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Code - Insiders", "User")
      : join(home, ".config", "Code - Insiders", "User");
  if (existsSync(insidersUser))
    targets.push({ id: "vscode-insiders", label: "VS Code Insiders", file: join(insidersUser, "mcp.json"), topKey: "servers", entry: (key) => ({ type: "http", url: MCP_URL(), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }) });
  // The next three carry per-client config-key traps that are already researched
  // and written down in meshmarket/src/install-matrix.js — copied verbatim from
  // there rather than re-derived, so the two surfaces cannot drift apart.
  // Windsurf — TRAP: the key is `serverUrl`, not `url`.
  const windsurfDir = join(home, ".codeium", "windsurf");
  if (existsSync(windsurfDir))
    targets.push({ id: "windsurf", label: "Windsurf", file: join(windsurfDir, "mcp_config.json"), entry: (key) => ({ serverUrl: MCP_URL(), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }) });
  // Gemini CLI — TRAP: the key is `httpUrl`, not `url`.
  const geminiDir = join(home, ".gemini");
  if (existsSync(geminiDir))
    targets.push({ id: "gemini-cli", label: "Gemini CLI", file: join(geminiDir, "settings.json"), entry: (key) => ({ httpUrl: MCP_URL(), ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) }) });
  return targets;
}

// ── minting a node from inside init ─────────────────────────────────────────
// Two 32-word lists, so a generated handle costs no network round-trip.
const ADJ = ["amber","brisk","calm","clever","copper","crisp","dawn","deft","eager","fleet","gentle","glad","hollow","iron","jade","keen","lucid","mellow","nimble","north","olive","patient","quick","quiet","rapid","russet","sage","silent","slate","swift","tidal","vivid"];
const NOUN = ["anchor","badger","beacon","cedar","cinder","comet","crane","delta","ember","falcon","harbor","heron","ridge","kestrel","lantern","meadow","mesa","orbit","otter","pier","quarry","raven","reef","summit","tern","thicket","tide","vector","warden","willow","wren","yard"];
export const slugify = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
function generatedHandle() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${pick(ADJ)}-${pick(NOUN)}-${hex}`;
}

// Returns {key, handle}. key may be null — a rate-limited signup still leaves
// the user with a working keyless install, which is better than an abort.
async function mintNode(opts) {
  const explicit = opts.handle ? slugify(opts.handle) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const handle = explicit || generatedHandle();
    const r = await api("POST", "/api/accounts", { body: { handle, referred_by: opts.ref || undefined } });
    if (r.ok) {
      saveKey(handle, r.body.api_key);
      console.log(`  ✓ node @${handle} created — ${r.body.credits ?? "?"} MESH to start`);
      console.log(`    key saved to ${CRED_FILE} (owner-read-only): ${maskKey(r.body.api_key)}`);
      return { key: r.body.api_key, handle };
    }
    if (r.status === 409 && !explicit) continue;      // handle collision — try another
    if (r.status === 409) {
      console.log(`  · @${handle} is taken. If it's yours:  npx -y meshmarket@latest init --adopt`);
      return { key: null, handle: null };
    }
    if (r.status === 429) {
      console.log("  · Signup limit reached for this network today. Wiring keyless — browsing and search work now.");
      console.log("    Add your key later with:  npx -y meshmarket@latest init --adopt");
      return { key: null, handle: null };
    }
    console.log(`  · Could not create a node (${r.body?.error || "HTTP " + r.status}). Wiring keyless; add a key later with --adopt.`);
    return { key: null, handle: null };
  }
  console.log("  · Could not find a free handle. Pick one:  npx -y meshmarket@latest init --handle <name>");
  return { key: null, handle: null };
}

async function adoptKey(key) {
  const r = await api("GET", "/api/account", { key });
  if (!r.ok) { console.error("That key was rejected by the exchange."); report(r); process.exit(1); }
  saveKey(r.body.handle, key);
  console.log(`  ✓ adopted @${r.body.handle} — ${r.body.credits} MESH`);
  return r.body.handle;
}

async function cmdInit(opts) {
  const dry = "dry-run" in opts;
  let key = loadKey();
  let handle = key ? credHandle() : null;

  // A saved key wins. Then MESH_AGENT_KEY from the environment (never argv —
  // an argument lives in shell history forever). Then --adopt, which reads an
  // existing key over stdin. Only then do we mint, and NEVER on a dry run: a
  // rehearsal must not burn one of the five signups this network gets per day.
  if (!key && process.env.MESH_AGENT_KEY) { key = process.env.MESH_AGENT_KEY.trim(); handle = await adoptKey(key); }
  else if (!key && "adopt" in opts && !dry) { key = await readSecretFromStdin("Paste your agent key: "); handle = key ? await adoptKey(key) : null; }
  else if (!key && !dry && !("keyless" in opts)) {
    console.log("No saved key found — minting you a node (free, no card, no form).");
    console.log("Already have one? Ctrl-C, then:  npx -y meshmarket@latest init --adopt");
    ({ key, handle } = await mintNode(opts));
  }

  let targets = clientTargets();
  if (opts.client) targets = targets.filter((t) => t.id === opts.client);
  if (!targets.length) {
    if (opts.client) {
      console.log(`No config found for "${opts.client}". Valid clients: claude-code, cursor, claude-desktop, vscode, vscode-insiders, windsurf, gemini-cli.`);
      process.exit(1);
    }
    // Never dead-end. The account exists now; hand over everything needed to
    // finish by hand rather than pointing at a docs page.
    console.log("\nWired: nothing detected on this machine yet — here is everything you need, ready to paste.\n");
    if (handle) console.log(`  Your node:  @${handle}   key saved to ${CRED_FILE}\n`);
    console.log(`  Claude Code           claude mcp add --transport http meshmarket ${MCP_URL()}`);
    console.log(`  Claude Desktop        Settings → Connectors → Add custom connector → paste:`);
    console.log(`                        ${MCP_URL()}`);
    console.log(`  ChatGPT / Grok        connector settings → paste the same URL`);
    console.log(`  Anything else         ${BASE}/install\n`);
    console.log("  Those wire a keyless connection: browsing and search work immediately, paid");
    console.log("  calls do not. Install one of those apps and rerun this command to wire it");
    console.log("  with your key. Reveal the key for a manual paste with:  mesh key --show");
    process.exit(0);   // the account got created; that is a success
  }
  let changed = 0;
  for (const t of targets) {
    let cfg = {};
    if (existsSync(t.file)) {
      try { cfg = JSON.parse(readFileSync(t.file, "utf8")); }
      catch { console.error(`  ✗ ${t.label} — ${t.file} is not valid JSON; skipped (fix it and rerun, nothing was touched)`); continue; }
    }
    const topKey = t.topKey || "mcpServers"; // VS Code's dialect uses "servers"
    const entry = t.entry(key);
    const current = (cfg[topKey] || {}).meshmarket;
    if (JSON.stringify(current) === JSON.stringify(entry)) { console.log(`  = ${t.label} — already wired (${t.file})`); continue; }
    // A rehearsal prints the shape, never the secret: this line is the one an
    // agent is most likely to run and paste straight into a transcript.
    if (dry) { console.log(`  → ${t.label} — would ${current ? "update" : "add"} ${topKey}.meshmarket in ${t.file}:\n      ${redactKey(JSON.stringify(entry), key)}`); continue; }
    // Only claim a backup we actually took — a brand-new config file has nothing
    // to back up, and naming a path that doesn't exist is the same class of lie
    // as a copy button that says "Copied ✓" without copying.
    const backedUp = existsSync(t.file);
    if (backedUp) writeFileSync(t.file + ".mesh-backup", readFileSync(t.file));
    mkdirSync(dirname(t.file), { recursive: true });
    cfg[topKey] = { ...(cfg[topKey] || {}), meshmarket: entry };
    writeFileSync(t.file, JSON.stringify(cfg, null, 2));
    // These files now hold a bearer token, and so may the backup we just took.
    if (key) {
      try { chmodSync(t.file, 0o600); } catch { /* filesystem without POSIX modes */ }
      try { if (existsSync(t.file + ".mesh-backup")) chmodSync(t.file + ".mesh-backup", 0o600); } catch { /* ditto */ }
    }
    console.log(`  ✓ ${t.label} — ${current ? "updated" : "wired"}${backedUp ? ` (backup: ${t.file}.mesh-backup)` : ` (new file: ${t.file})`}`);
    if (key && t.argvKey) console.log(`    note: Claude Desktop's bridge passes the key on a command line, visible to other users of this machine.\n    On a shared machine prefer Settings → Connectors → Add custom connector (keyless).`);
    changed++;
  }
  if (!dry && changed) {
    if (key) {
      console.log(`\nDone. ${changed} client${changed > 1 ? "s" : ""} wired with @${handle || credHandle()}'s key — paid calls settle in MESH.`);
      console.log(`Restart the client you use, then ask it: "discover capabilities on MeshMarket".`);
    } else {
      console.log(`\nDone. ${changed} client${changed > 1 ? "s" : ""} wired keyless — browsing and search work now.`);
      console.log(`Restart the client you use. To make paid calls, add a key:  npx -y meshmarket@latest init --adopt`);
    }
    console.log(`Check it took:  npx -y meshmarket@latest init --dry-run   (should say "already wired")`);
    // Measured 2026-08-11: ~812 npm installs a month against SIX unique views of
    // the repo page. People install through npm and a pasted MCP URL, so they
    // never pass the page where a star or an issue would come from. One line at
    // the moment it just worked is the only place that funnel touches them.
    console.log(`\nIf this saved you time, a star helps people find it: https://github.com/Meshtool/meshmarket-mcp`);
  }
}

// Minimal, hand-rolled arg parsing: positional args first, then --flag value
// pairs. No dependency earns its keep at this surface size.
export function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      // A flag followed by another flag (or by nothing) is a boolean, e.g.
      // `init --dry-run --client cursor` — without this, --dry-run would
      // swallow "--client" as its value and orphan "cursor".
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[a.slice(2)] = true;
      else { opts[a.slice(2)] = next; i++; }
    } else positional.push(a);
  }
  return { positional, opts };
}

const HELP = `mesh — the MeshMarket CLI (${BASE})

  ONE COMMAND, START TO FINISH:
    npx -y meshmarket@latest init
      Creates your node if you don't have one, saves your key, and wires every
      MCP client on this machine (Claude Code, Claude Desktop, Cursor, VS Code,
      VS Code Insiders, Windsurf, Gemini CLI). Merge-only; backs up anything it
      touches. Free, no card, no form.

    --dry-run      Show what it would change. Touches nothing, mints nothing.
    --adopt        Already have a key? Paste it when asked (never via argv).
    --handle <n>   Pick your node name instead of getting a generated one.
    --keyless      Wire browse-only; don't create an account.
    --client <id>  Wire just one.

  mesh signup <handle> [--ref <code>]     Join the mesh. Free, no card.
  mesh key [--show]                        Show your key masked (--show needs a TTY).
  mesh login                               Re-attach an existing key (paste when asked).
  mesh whoami                              Your balance + recent activity.
  mesh discover [--category <name>]        List live capabilities and prices.
  mesh describe <slug> [--json]            Description, input schema, a working example.
  mesh call <slug> --input '<json>'        Call a capability, pay per use. A bad input is
                                           refused with the schema and charged 0.
  mesh list --name <name> --price <n>      List your own capability.
           [--kind tool|feed|workflow] [--endpoint <url>] [--steps '<json>']
  mesh topup <starter|builder|scale>       Get a real-money checkout link.
  mesh logout                              Forget the saved key.

  YOUR DEVDESK (${DESK}) — from the saved key, never pasted anywhere:
  mesh desk [login] [--open]               One-time sign-in link (10 min, single use).
  mesh desk ls                             Drafts, connected services, vault NAMES, open work.
  mesh desk status [<id>]                  The desk's work, or one task and its handoffs.
  mesh desk task --title "…" --instructions "…" [--repo owner/name]
                                           Hand the desk a task an attached agent works.

Credentials: ${CRED_FILE}
Override the API base with MESH_API_BASE, DevDesk with MESH_DESK_BASE (local dev).`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positional, opts } = parseArgs(rest);
  switch (cmd) {
    case "init": return cmdInit(opts);
    case "signup": return cmdSignup(positional[0], opts);
    case "login": return cmdLogin(positional[0]);
    case "key": return cmdKey(opts);
    case "whoami": case "balance": return cmdWhoami();
    case "discover": case "ls": return cmdDiscover(opts);
    case "describe": case "info": return cmdDescribe(positional[0], opts);
    case "call": return cmdCall(positional[0], opts);
    case "desk": return cmdDesk(positional[0], positional.slice(1), opts);
    case "list": return cmdList(opts);
    case "topup": case "buy": return cmdTopup(positional[0]);
    case "logout": return cmdLogout();
    default: console.log(HELP); process.exit(cmd ? 1 : 0);
  }
}

// Import-safe: the CLI runs ONLY when this file is the entry point, so the
// selftest can import the pure helpers above without executing a command.
const invokedDirectly = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (invokedDirectly) main().catch((e) => { console.error("Unexpected error:", e.message); process.exit(1); });
