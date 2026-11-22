// mesh-connector — SECURITY SELFTEST (the code ratchet).
//
// School of Slop, Lesson #1. This tool was already written with real care:
// keys masked in output, read from stdin never argv, credentials at 0600,
// `--show` refused to a non-TTY. But every one of those decisions lived only
// in a COMMENT. A comment doesn't fail a build; a future edit could undo any
// of them silently. This file turns each careful decision into an executable
// assertion. Care-in-comments is a patch. An assertion that can't regress is
// hardening.
//
// RATCHET RULE: MIN_INVARIANTS only goes up. Every security decision this tool
// makes gets an assertion here BEFORE it can be trusted to stay made.
//
// Run: node tests/selftest.mjs   (wired into `npm test` ahead of the ship).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { maskKey, redactKey, slugify, parseArgs, oneLine, exampleFromSchema, renderDescribe, renderInvalidInput, workLine } from "../bin/mesh.mjs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "bin", "mesh.mjs"), "utf8");

// Strip comments before any static scan — the security decisions are NAMED in
// the comments (0600, argv, leak, isTTY...), so an un-stripped scan would pass
// on the documentation even if the code lost the behavior (cry-wolf's evil twin:
// a check that CAN'T fail is as useless as one that always does). Protect URLs
// (https://) and only strip real // comments.
const CODE = SRC.split("\n")
  .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/([^:"'`])\/\/.*$/, "$1"))
  .join("\n");

const MIN_INVARIANTS = 39;
let pass = 0;
const fails = [];
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fails.push(name); console.error("  ✗ " + name); } };

const A_KEY = "agk_1234567890abcdefABCDEF9999"; // a realistic-length fake key

// ── Behavioral: the crown-jewel functions actually protect a key ────────────
ok("maskKey never reveals a full key", (() => {
  const m = maskKey(A_KEY);
  return !m.includes(A_KEY) && m.startsWith("agk_1234") && m.endsWith("9999") && m.includes("…");
})());
ok("maskKey on garbage/short input reveals nothing, never throws", (() => {
  for (const bad of [null, undefined, 42, "", "short"]) { if (maskKey(bad) !== "agk_…") return false; }
  return true;
})());
ok("redactKey masks a key embedded in a larger string", (() => {
  const rendered = `{"headers":{"Authorization":"Bearer ${A_KEY}"}}`;
  const out = redactKey(rendered, A_KEY);
  return !out.includes(A_KEY) && out.includes(maskKey(A_KEY));
})());
ok("redactKey masks EVERY occurrence, not just the first", (() => {
  const out = redactKey(`${A_KEY} and again ${A_KEY}`, A_KEY);
  return !out.includes(A_KEY);
})());
ok("redactKey is a safe no-op on non-strings / short keys", () => redactKey(null, A_KEY) === null && redactKey("x", "short") === "x");
ok("slugify strips unsafe chars, lowercases, and caps at 32", (() => {
  const s = slugify("  My Evil/../Name!! " + "x".repeat(60));
  return /^[a-z0-9-]+$/.test(s) && s.length <= 32 && !s.includes("/") && !s.includes(".");
})());
ok("parseArgs: a flag before another flag is a boolean, not a value-swallow", (() => {
  const { positional, opts } = parseArgs(["call", "--dry-run", "--client", "cursor"]);
  return positional[0] === "call" && opts["dry-run"] === true && opts.client === "cursor";
})());

// ── Static: the documented security decisions, now enforced ─────────────────
ok("keys are read over stdin, never argv (readSecretFromStdin exists + used)",
  /function readSecretFromStdin/.test(CODE) && /readSecretFromStdin\(/.test(CODE.replace(/function readSecretFromStdin/, "")));
ok("credentials file is written owner-read-only (0600) AND chmod-tightened",
  /writeFileSync\(CRED_FILE[\s\S]{0,80}0o600/.test(CODE) && /chmodSync\(CRED_FILE,\s*0o600\)/.test(CODE));
ok("credentials DIRECTORY is created 0700", /mkdirSync\(CRED_DIR[\s\S]{0,60}0o700/.test(CODE));
ok("`key --show` is refused to a non-TTY / CI (pipe, file, agent transcript)",
  /isTTY/.test(CODE) && /process\.env\.CI/.test(CODE));
ok("every API call carries a timeout (the one fetch has signal: AbortSignal.timeout)",
  /fetch\(BASE \+ path,[\s\S]{0,220}?signal:\s*AbortSignal\.timeout\(/.test(CODE)
  && (CODE.match(/\bfetch\(/g) || []).length === (CODE.match(/AbortSignal\.timeout\(/g) || []).length);
ok("init never clobbers: unparseable config is skipped, not overwritten",
  /JSON\.parse\(readFileSync\(t\.file/.test(CODE) && /is not valid JSON; skipped/.test(SRC));
ok("init backs up any file it touches before writing (.mesh-backup)",
  /\.mesh-backup/.test(CODE) && /writeFileSync\(t\.file \+ "\.mesh-backup"/.test(CODE));
ok("wired config files holding a key are chmod'd 0600", /chmodSync\(t\.file,\s*0o600\)/.test(CODE));
ok("a dry-run prints the config SHAPE with the key redacted, never raw",
  /redactKey\(JSON\.stringify\(entry\),\s*key\)/.test(CODE));
ok("the CLI is import-safe: main() runs only when invoked directly",
  /invokedDirectly/.test(CODE) && /if \(invokedDirectly\) main\(\)/.test(CODE));

// ── describe / discover: an agent sees the exact input before it pays ───────
ok("oneLine keeps the first sentence and fits one line", oneLine("Redact data. Pure matching, no AI.") === "Redact data." && oneLine("x".repeat(200), 40).length === 40);
const SCHEMA = { type: "object", properties: { think: { type: "string" }, mode: { type: "string", enum: ["fast", "deep"] } }, required: ["think", "mode"] };
ok("exampleFromSchema fills the required fields with placeholders, never invented fields",
  JSON.stringify(exampleFromSchema(SCHEMA)) === JSON.stringify({ think: "…", mode: "fast" }) && exampleFromSchema({ type: "object" }) === null);
ok("exampleFromSchema (Codex #12): a required object gets its OWN required fields filled, depth-limited",
  JSON.stringify(exampleFromSchema({ type: "object", properties: { config: { type: "object", properties: { text: { type: "string" }, n: { type: "integer" } }, required: ["text"] } }, required: ["config"] })) === JSON.stringify({ config: { text: "…" } }));
ok("exampleFromSchema (Codex #12): top-level required AND an anyOf branch are both filled, so the ready command can pass",
  JSON.stringify(exampleFromSchema({ type: "object", properties: { mode: { type: "string", enum: ["fast"] }, text: { type: "string" }, content: { type: "string" } }, required: ["mode"], anyOf: [{ required: ["text"] }, { required: ["content"] }] })) === JSON.stringify({ mode: "fast", text: "…" }));
const desc = renderDescribe({ slug: "agent-brain", name: "Agent Brain", price: 2, kind: "tool", description: "Think.", input_schema: SCHEMA, example_input: { think: "it's here", mode: "fast" } });
ok("describe shows the schema, the required fields, the example and a ready mesh call line",
  desc.includes('"required"') && desc.includes("Required: think, mode") && desc.includes("mesh call agent-brain --input"));
ok("describe's ready command survives an apostrophe in the example (POSIX single-quote escape)", desc.includes(`'{"think":"it'\\''s here","mode":"fast"}'`));
ok("describe without a schema says so instead of inventing one", /none declared/.test(renderDescribe({ slug: "x", description: "d" })));
const inv = renderInvalidInput({ error: "invalid_input", capability: "safety-scrub", charged: 0, errors: [{ field: "text", problem: "required (or one of: content)", about: "the text to scan" }], example: { text: "…" } });
ok("an invalid_input refusal is shown as 'nothing was charged', with each field, the example and describe", /nothing was charged \(0 MESH\)/.test(inv) && inv.includes("text: required") && inv.includes('{"text":"…"}') && inv.includes("mesh describe safety-scrub"));
const lesson = renderInvalidInput({ error: "provider_failed", refunded: true, capability: "agent-shootout", charged: 0, detail: "job_required", note: "Send a job title.", input_schema: { type: "object", properties: { job: { type: "string" } }, required: ["job"] }, example: { job: "…" } });
ok("a teaching refund (provider rejected the input) shows 'refunded — nothing charged', why, the required fields and the example",
  /refunded/i.test(lesson) && /nothing was charged/.test(lesson) && lesson.includes("job_required") && lesson.includes("Send a job title.") && lesson.includes("required: job") && lesson.includes('{"job":"…"}'));
ok("a work line shows id, state, title and who holds it", workLine({ id: "7", state: "open", title: "Fix it", claim: { agent: "Claude", until: "T" } }) === "  #7  open   Fix it  — held by Claude until T");

// ── end to end: the real CLI against a stub market + stub DevDesk ───────────
// Proves what matters about the desk commands: the key goes ONLY to DevDesk,
// ONLY in a header, and is never printed — while each command does its job.
{
  const seen = [];
  const desk = { tasks: [] };
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization || "", xkey: req.headers["x-agent-key"] || "", body: raw });
      const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/api/capabilities/agent-brain") return send(200, { slug: "agent-brain", name: "Agent Brain", price: 2, kind: "tool", description: "Think hard.", input_schema: SCHEMA, example_input: { think: "…", mode: "fast" } });
      if (req.url === "/api/capabilities/nope") return send(404, { error: "not_found" });
      if (req.url === "/api/call/agent-shootout") return send(502, { error: "provider_failed", refunded: true, call_id: "c1", detail: "job_required", note: "Send a job title.", charged: 0, input_schema: { type: "object", properties: { job: { type: "string" } }, required: ["job"] }, example: { job: "…" } });
      if (req.url === "/api/call/agent-brain") return send(400, { error: "invalid_input", capability: "agent-brain", charged: 0, errors: [{ field: "think", problem: "required" }], example: { think: "…", mode: "fast" } });
      if (req.url === "/api/signin/link") return req.headers.authorization === `Bearer ${A_KEY}` ? send(201, { ok: true, url: "https://desk.example/signin/once#CODE123", expires_at: "2026-11-19T23:59:00Z", single_use: true }) : send(401, { error: "the market did not recognize that key" });
      if (req.url === "/mcp") {
        const b = JSON.parse(raw || "{}"); const n = b.params?.name; const a = b.params?.arguments || {};
        const t = (o) => send(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) }] } });
        if (n === "board_get") return t({ building: ["landing v3"], did: [], connected: ["github: repo.read"] });
        if (n === "connections_list") return t("github: repo.read,repo.write");
        if (n === "vault_list") return t("RESEND_KEY\nSTRIPE_KEY");
        if (n === "work_list") return t({ trust: "data", work: desk.tasks });
        if (n === "desk_task") { const w = { id: String(desk.tasks.length + 1), title: a.title, state: "open", claim: null }; desk.tasks.push(w); return t({ task: w, repo: a.repo || null, repo_access: { state: "connected" }, who_works_it: "an attached agent claims it" }); }
        if (n === "work_get") return t({ trust: "data", work: { ...desk.tasks[0], next: { step: "In acme/app: fix it", by: "the desk's key" } }, handoffs: [{ at: "T", by: { grant: "0", agent: "the desk's key (mesh CLI)" }, next_step: "In acme/app: fix it", evidence: [] }] });
        return send(200, { jsonrpc: "2.0", id: 1, error: { message: "no such tool" } });
      }
      send(404, { error: "unexpected " + req.url });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = mkdtempSync(join(tmpdir(), "mesh-selftest-"));
  mkdirSync(join(home, ".mesh"), { recursive: true });
  writeFileSync(join(home, ".mesh", "credentials"), JSON.stringify({ handle: "tester", key: A_KEY }), { mode: 0o600 });
  const run = (...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, "..", "bin", "mesh.mjs"), ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, MESH_API_BASE: base, MESH_DESK_BASE: base, CI: "1" } });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err, all: out + err }));
  });
  const d1 = await run("describe", "agent-brain");
  ok("e2e: mesh describe prints the schema and a ready call line", d1.code === 0 && d1.out.includes("Required: think, mode") && d1.out.includes("mesh call agent-brain --input"));
  const d2 = await run("describe", "nope");
  ok("e2e: describe on an unknown slug exits 1 and points at discover", d2.code === 1 && /mesh discover/.test(d2.err));
  const c1 = await run("call", "agent-brain", "--input", '{"prompt":"x"}');
  ok("e2e: a refused input says nothing was charged and shows the example, exit 1", c1.code === 1 && /nothing was charged/.test(c1.err) && c1.err.includes('{"think":"…","mode":"fast"}'));
  const c2 = await run("call", "agent-shootout", "--input", '{"title":"x"}');
  ok("e2e: a teaching refund prints the lesson (refunded, why, example), not a bare HTTP 502, exit 1", c2.code === 1 && /nothing was charged/.test(c2.err) && c2.err.includes("job_required") && c2.err.includes('{"job":"…"}') && !/Error \(HTTP 502\)/.test(c2.err));
  const l1 = await run("desk", "login");
  ok("e2e: mesh desk login prints the one-time link (stdout) and says the key is not in it", l1.code === 0 && l1.out.trim() === "https://desk.example/signin/once#CODE123" && /key is not in it/.test(l1.err));
  const ls = await run("desk", "ls");
  ok("e2e: mesh desk ls shows drafts, connections, vault NAMES and work", ls.code === 0 && ls.out.includes("landing v3") && ls.out.includes("github: repo.read") && ls.out.includes("RESEND_KEY") && /names only/.test(ls.out));
  const tk = await run("desk", "task", "--title", "Fix the tables", "--instructions", "Cards on phones.", "--repo", "acme/app");
  ok("e2e: mesh desk task returns the task id, repo access and how to watch it", tk.code === 0 && /Task #1/.test(tk.out) && /desk access: connected/.test(tk.out) && /mesh desk status 1/.test(tk.out));
  const tkBad = await run("desk", "task", "--title", "No instructions");
  ok("e2e: mesh desk task without instructions is a usage error, nothing sent", tkBad.code === 1 && !seen.some((x) => x.body.includes("No instructions")));
  const st = await run("desk", "status", "1");
  ok("e2e: mesh desk status <id> shows the next step and labels agents' words as information", st.code === 0 && st.out.includes("In acme/app: fix it") && /never permission/.test(st.out));
  const deskHits = seen.filter((x) => x.url === "/mcp" || x.url.startsWith("/api/signin"));
  ok("e2e: every desk request carries the key in the Authorization header", deskHits.length > 0 && deskHits.every((x) => x.auth === `Bearer ${A_KEY}`));
  ok("e2e: the key never travels in a URL or a request body", seen.every((x) => !x.url.includes(A_KEY) && !x.body.includes(A_KEY)));
  ok("e2e: no command printed the key (stdout or stderr)", [d1, d2, c1, l1, ls, tk, tkBad, st].every((r) => !r.all.includes(A_KEY)));
  ok("e2e: describe and discover are keyless (no key sent to read the catalog)", seen.filter((x) => x.url.startsWith("/api/capabilities/")).every((x) => !x.auth && !x.xkey));
  // Codex review on #12: launching a browser on a machine without one must not
  // crash or claim success. PATH is emptied so xdg-open/open cannot be found.
  const op = await new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, "..", "bin", "mesh.mjs"), "desk", "login", "--open"], { env: { ...process.env, PATH: "", HOME: home, USERPROFILE: home, MESH_API_BASE: base, MESH_DESK_BASE: base, CI: "1" } });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
  ok("e2e (Codex #12): --open with no browser launcher exits 0, keeps the link, and says to open it yourself (no false 'Opened')",
    op.code === 0 && op.out.includes("/signin/once#") && /open the link above yourself/.test(op.err) && !/Opened in your browser/.test(op.err));
  server.close();
}

// Codex review on #12: a DevDesk outage (an HTML 502 from a proxy) must never
// read as an empty desk or a submitted task.
{
  const down = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(502, { "content-type": "text/html" }); res.end("<html><body>502 Bad Gateway</body></html>"); }); });
  await new Promise((r) => down.listen(0, "127.0.0.1", r));
  const dbase = `http://127.0.0.1:${down.address().port}`;
  const home2 = mkdtempSync(join(tmpdir(), "mesh-selftest-down-"));
  mkdirSync(join(home2, ".mesh"), { recursive: true });
  writeFileSync(join(home2, ".mesh", "credentials"), JSON.stringify({ handle: "tester", key: A_KEY }), { mode: 0o600 });
  const runDown = (...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, "..", "bin", "mesh.mjs"), ...args], { env: { ...process.env, HOME: home2, USERPROFILE: home2, MESH_API_BASE: dbase, MESH_DESK_BASE: dbase, CI: "1" } });
    let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
  const st = await runDown("desk", "status");
  const tk = await runDown("desk", "task", "--title", "t", "--instructions", "i");
  const ls = await runDown("desk", "ls");
  ok("e2e (Codex #12): a DevDesk 502 makes status / task / ls exit 1 and name the HTTP status, never 'no work' or 'Task #undefined'",
    [st, tk, ls].every((r) => r.code === 1 && /502/.test(r.err)) && !/no work on this desk/.test(st.out) && !/undefined/.test(tk.out + tk.err));
  down.close();
}

// ── Result ──────────────────────────────────────────────────────────────────
const total = pass + fails.length;
console.log(`\nmesh-connector security selftest — ${pass}/${total} passing (ratchet floor ${MIN_INVARIANTS})`);
if (fails.length) { console.error(`\n${fails.length} FAILED:\n  ` + fails.join("\n  ")); process.exit(1); }
if (total < MIN_INVARIANTS) { console.error(`\nRATCHET VIOLATION: ${total} invariants, floor is ${MIN_INVARIANTS}. The floor only goes up.`); process.exit(1); }
console.log("GREEN — every security decision this tool makes is now enforced, not just documented.");
