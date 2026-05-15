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

await close();
console.log("OK");
