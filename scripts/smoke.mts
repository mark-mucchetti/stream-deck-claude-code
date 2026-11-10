// Smoke test for the HTTP server + session store. Does NOT exercise the
// Stream Deck WebSocket. Run with `npx tsx scripts/smoke.mts`.
import { SessionStore } from "../src/state.js";
import { startServer } from "../src/server.js";

const store = new SessionStore();
const { port, close } = await startServer(store, {
	port: 13999,
	logger: { info: () => {}, warn: console.warn, error: console.error },
});

async function post(body: Record<string, unknown>) {
	const r = await fetch(`http://127.0.0.1:${port}/event`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new Error(`bad status ${r.status}`);
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

// Auto-mode denial: flag sticks through later events, clears on next prompt.
const cwd1 = "/Users/mark/src/stream-deck-claude-code";
await post({ session_id: "s1", cwd: cwd1, hook_event_name: "PermissionDenied", tool_name: "Bash" });
assert(store.get("s1")?.denied === true, "PermissionDenied should set denied");
await post({ session_id: "s1", cwd: cwd1, hook_event_name: "PreToolUse", tool_name: "Read" });
await post({ session_id: "s1", cwd: cwd1, hook_event_name: "Stop" });
assert(store.get("s1")?.denied === true, "denied should survive later events");
assert(store.get("s1")?.state === "done", "denied should not change state");
{
	const { renderSession } = await import("../src/render.js");
	const svg = Buffer.from(renderSession(store.get("s1")!).image.split(",")[1], "base64").toString("utf8");
	assert(svg.includes('fill="#2a0d2a"'), "denied tile should paint magenta upper area");
	assert(svg.includes('fill="#2fa056"'), "denied tile band should keep its state color");
}
await post({ session_id: "s1", cwd: cwd1, hook_event_name: "UserPromptSubmit" });
assert(store.get("s1")?.denied === false, "UserPromptSubmit should clear denied");

// permission_mode is captured from the payload.
await post({ session_id: "s1", cwd: cwd1, hook_event_name: "PreToolUse", tool_name: "Read", permission_mode: "auto" });
assert(store.get("s1")?.permissionMode === "auto", "permission_mode should be captured");

// Liveness: etime parsing, missing pid, reused pid, live pid, no pid.
{
	const { parseEtime, isDead } = await import("../src/liveness.js");
	assert(parseEtime("05:03") === 303_000, "etime mm:ss");
	assert(parseEtime("01:00:00") === 3_600_000, "etime hh:mm:ss");
	assert(parseEtime("2-00:00:00") === 172_800_000, "etime dd-hh:mm:ss");
	const t = 1_000_000_000_000;
	const base = { id: "x", cwd: "", label: "x", state: "done" as const, lastEvent: "Stop", startedAt: t, lastUpdate: t, pidSeenAt: t };
	const procs = new Map([["100", t - 5_000], ["200", t + 3_600_000]]);
	assert(!isDead({ ...base, terminal: { ppid: "100" } }, procs), "live pid started before last event is alive");
	assert(isDead({ ...base, terminal: { ppid: "200" } }, procs), "pid that started after last event is reused -> dead");
	assert(isDead({ ...base, terminal: { ppid: "300" } }, procs), "missing pid is dead");
	assert(!isDead({ ...base, terminal: {} }, procs), "session with no pid is never judged dead");
}

// Capacity priority: denied and error outrank working/thinking/done.
{
	const st = new SessionStore();
	for (const [id, state] of [["a", "working"], ["b", "done"], ["c", "error"], ["d", "thinking"]] as const) {
		st.upsert(id, `/x/${id}`);
		st.apply(id, { state, lastEvent: "PreToolUse" });
	}
	st.apply("b", { denied: true });
	st.reconcileCapacity(2);
	const vis = st.visible().map((s) => s.id).sort().join(",");
	assert(vis === "b,c", `denied + error should keep the 2 tiles, got ${vis}`);
}

await close();
console.log("OK");
