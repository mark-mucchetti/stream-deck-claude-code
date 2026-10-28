// Smoke test for the HTTP server + session store. Does NOT exercise the
// Stream Deck WebSocket. Run with `npx tsx scripts/smoke.mts`.
import { SessionStore } from "../src/state.js";
import { startServer } from "../src/server.js";

import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN = "smoke-test-token-0123456789abcdef0123456789abcdef";
const store = new SessionStore();
const { port, close } = await startServer(store, {
	port: 13999,
	logger: { info: () => {}, warn: () => {}, error: console.error },
	token: TOKEN,
});

async function post(body: Record<string, unknown>) {
	const r = await fetch(`http://127.0.0.1:${port}/event`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-StreamDeck-Token": TOKEN },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new Error(`bad status ${r.status}`);
}

/** Raw request so we can set Host/Origin, which fetch won't let us forge. */
function raw(method: string, path: string, headers: Record<string, string>, body = "", setHost = true): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path, headers, setHost }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end(body);
	});
}

await post({ session_id: "s1", cwd: "/Users/mark/src/stream-deck-claude-code", hook_event_name: "SessionStart" });
await post({ session_id: "s2", cwd: "/tmp/another-project", hook_event_name: "SessionStart" });
await post({ session_id: "s1", cwd: "/Users/mark/src/stream-deck-claude-code", hook_event_name: "UserPromptSubmit" });
await post({ session_id: "s1", cwd: "/Users/mark/src/stream-deck-claude-code", hook_event_name: "PreToolUse", tool_name: "Edit" });
await post({ session_id: "s2", cwd: "/tmp/another-project", hook_event_name: "Notification", notification_type: "permission_prompt" });
await post({ session_id: "s1", cwd: "/Users/mark/src/stream-deck-claude-code", hook_event_name: "Stop" });

const list = store.list();
console.log(JSON.stringify(list.map((s) => ({ id: s.id, label: s.label, state: s.state, lastTool: s.lastTool })), null, 2));

function assert(cond: unknown, msg: string) {
	if (!cond) {
		console.error("FAIL:", msg);
		process.exit(1);
	}
}
assert(list.length === 2, "expected 2 sessions");
assert(list[0].state === "done", `s1 should be done, was ${list[0].state}`);
assert(list[1].state === "waiting", `s2 should be waiting, was ${list[1].state}`);
assert(list[0].lastTool === "Edit", `s1 should have lastTool=Edit, was ${list[0].lastTool}`);
assert(list[1].label === "another-project", `unexpected label: ${list[1].label}`);

// Render check: ensure renderEmpty + renderSession produce valid data URIs.
const { renderEmpty, renderSession } = await import("../src/render.js");
const empty = renderEmpty();
assert(empty.startsWith("data:image/svg+xml;base64,"), "renderEmpty should return data URI");
for (const s of list) {
	const { image, title } = renderSession(s);
	assert(image.startsWith("data:image/svg+xml;base64,"), "renderSession should return data URI");
	assert(typeof title === "string", "title should be a string (empty: we paint the label into the SVG)");
}

// Persist/hydrate round-trip.
const snapshot = store.serialize();
const restored = new SessionStore();
restored.hydrate(snapshot);
const r = restored.list();
assert(r.length === 2, `hydrate should restore 2 sessions, got ${r.length}`);
assert(r[0].id === "s1" && r[1].id === "s2", "hydrate should preserve order");
assert(r[0].state === "done" && r[0].lastTool === "Edit", "hydrate should keep last known state");

// Hydrate should drop legacy "ended" state but keep everything else
// regardless of age — a session waiting on a human for hours is exactly
// what the tile is supposed to surface.
const ancientButValid = {
	sessions: [
		{ ...r[0], id: "legacy", state: "ended" as unknown as typeof r[0]["state"] },
		{ ...r[0], id: "old", lastUpdate: Date.now() - 6 * 60 * 60 * 1000 },
		{ ...r[0], id: "fresh" },
	],
	order: ["legacy", "old", "fresh"],
};
const filtered = new SessionStore();
filtered.hydrate(ancientButValid);
const f = filtered.list();
assert(f.length === 2 && f[0].id === "old" && f[1].id === "fresh",
	`hydrate should drop only legacy "ended", got [${f.map((x) => x.id).join(",")}]`);

// SessionEnd via the HTTP server should remove the session entirely (no
// "ended" intermediate state).
await post({ session_id: "s2", cwd: "/tmp/another-project", hook_event_name: "SessionEnd" });
const afterEnd = store.list();
assert(afterEnd.length === 1 && afterEnd[0].id === "s1", `SessionEnd should remove s2, got [${afterEnd.map((x) => x.id).join(",")}]`);

// ── Request hardening ────────────────────────────────────────────────────
const host = `127.0.0.1:${port}`;
const forged = JSON.stringify({ session_id: "forged", cwd: "/tmp/x", hook_event_name: "UserPromptSubmit" });
const okHeaders = { Host: host, "Content-Type": "application/json", "X-StreamDeck-Token": TOKEN };
assert(await raw("POST", "/event", { Host: host, "Content-Type": "application/json" }, forged) === 401, "no token → 401");
assert(await raw("POST", "/event", { ...okHeaders, "X-StreamDeck-Token": TOKEN.replace(/.$/, "x") }, forged) === 401, "wrong token → 401");
assert(await raw("POST", "/event", { ...okHeaders, "Content-Type": "text/plain" }, forged) === 415, "text/plain → 415");
assert(await raw("POST", "/event", { ...okHeaders, Origin: "https://evil.example" }, forged) === 403, "Origin header → 403");
assert(await raw("GET", "/sessions", { ...okHeaders, Host: `attacker.example:${port}` }) === 403, "foreign Host → 403");
assert(await raw("GET", "/sessions", { Host: host }) === 401, "GET /sessions without token → 401");
// Node itself answers 400 to an HTTP/1.1 request without Host; our check would 403.
assert([400, 403].includes(await raw("GET", "/sessions", { "X-StreamDeck-Token": TOKEN }, "", false)), "missing Host → refused");
assert(await raw("GET", "/sessions", { ...okHeaders, Origin: "https://evil.example" }) === 403, "Origin on GET → 403");
assert(await raw("GET", "/sessions", okHeaders) === 200, "GET /sessions with token → 200");
assert(!store.get("forged"), "rejected requests must not create sessions");

// Transcript paths outside ~/.claude/projects are dropped.
const projects = join(homedir(), ".claude", "projects");
await post({ session_id: "tp1", cwd: "/tmp/tp", hook_event_name: "UserPromptSubmit", transcript_path: "/etc/hosts" });
assert(store.get("tp1")?.transcriptPath === undefined, "/etc/hosts must not be accepted as transcript");
await post({ session_id: "tp1", cwd: "/tmp/tp", hook_event_name: "Stop", transcript_path: `${projects}/../../.ssh/x.jsonl` });
assert(store.get("tp1")?.transcriptPath === undefined, "traversal out of projects dir must be rejected");
await post({ session_id: "tp1", cwd: "/tmp/tp", hook_event_name: "Stop", transcript_path: `${projects}/p/abc.jsonl` });
assert(store.get("tp1")?.transcriptPath === `${projects}/p/abc.jsonl`, "real transcript path should be kept");

// Bad session ids and relative cwds are dropped.
await post({ session_id: "bad id\nwith newline", cwd: "/tmp/x", hook_event_name: "UserPromptSubmit" });
assert(!store.list().some((s) => s.id.includes("\n")), "session id with newline must be rejected");
await post({ session_id: "rel", cwd: "Applications/Calculator.app", hook_event_name: "UserPromptSubmit" });
assert(store.get("rel")?.cwd === "", "relative cwd must be dropped");

// Session cap: flooding evicts the stalest, never grows past MAX_SESSIONS.
const { MAX_SESSIONS } = await import("../src/state.js");
for (let i = 0; i < MAX_SESSIONS + 20; i++) {
	await post({ session_id: `flood-${i}`, cwd: "/tmp/f", hook_event_name: "UserPromptSubmit" });
}
assert(store.list().length === MAX_SESSIONS, `store should cap at ${MAX_SESSIONS}, has ${store.list().length}`);
assert(store.get(`flood-${MAX_SESSIONS + 19}`), "newest session must be kept");

// Finder fallback: only real, non-bundle folders, after resolving symlinks,
// `.`, `..` and `//`. Built in a temp dir so it doesn't depend on any app.
const { finderTarget } = await import("../src/focus.js");
const { mkdtemp, mkdir, symlink, writeFile, realpath, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const ft = await realpath(await mkdtemp(join(tmpdir(), "sd-cc-finder-")));
await mkdir(join(ft, "Fake.app", "Contents"), { recursive: true });
await mkdir(join(ft, "project"));
await writeFile(join(ft, "file.txt"), "x");
await symlink(join(ft, "Fake.app"), join(ft, "link-to-app"));
for (const p of [
	join(ft, "Fake.app"),
	join(ft, "Fake.app") + "//",
	join(ft, "Fake.app") + "/.",
	join(ft, "Fake.app", "Contents") + "/..",
	join(ft, "Fake.app", "Contents"),
	join(ft, "link-to-app"),
	join(ft, "file.txt"),
	"relative/project",
]) {
	assert((await finderTarget(p)) === undefined, `finderTarget must refuse ${p}`);
}
assert((await finderTarget(join(ft, "project"))) === join(ft, "project"), "finderTarget should allow a plain folder");
await rm(ft, { recursive: true, force: true });

await close();
console.log("OK");
