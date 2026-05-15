// End-to-end: spawn the real bridge.sh with a fake hook event piped in, and
// confirm the server receives an enriched payload.
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sandbox = await mkdtemp(join(tmpdir(), "sd-cc-e2e-"));
process.env.HOME = sandbox;

const { SessionStore } = await import("../src/state.js");
const { startServer } = await import("../src/server.js");
const { installHooks, bridgeShPath } = await import("../src/install.js");

const store = new SessionStore();
const noop = { info: () => {}, warn: console.warn, error: console.error };
const { port, close } = await startServer(store, { port: 13987, logger: noop });
await installHooks(port, noop);

const fakeEvent = JSON.stringify({
  session_id: "e2e-1",
  cwd: "/Users/mark/src/stream-deck-claude-code",
  hook_event_name: "SessionStart",
  source: "startup",
});

await new Promise<void>((resolve, reject) => {
  const env = {
    ...process.env,
    TERM_PROGRAM: "iTerm.app",
    ITERM_SESSION_ID: "w0t0p0:DEADBEEF-FEED-FACE-CAFE-1234567890AB",
  };
  const p = spawn(bridgeShPath, [], { stdio: ["pipe", "inherit", "inherit"], env });
  p.stdin.end(fakeEvent);
  p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("bridge exit " + c))));
});

// Give the server a moment to process.
await new Promise((r) => setTimeout(r, 250));

const list = store.list();
if (list.length !== 1) throw new Error("expected 1 session, got " + list.length);
const s = list[0];
console.log(JSON.stringify({id: s.id, label: s.label, state: s.state, terminal: s.terminal}, null, 2));
if (s.terminal.termProgram !== "iTerm.app") throw new Error("termProgram not captured");
if (!s.terminal.iTermSessionId?.includes("DEADBEEF")) throw new Error("ITERM_SESSION_ID not captured");
// We piped stdio in this test, so there's no controlling tty — the python
// bridge correctly filters out the literal "not a tty" string. In real use,
// Claude Code invokes the hook with the user's terminal as the controlling
// tty, so $(tty) returns /dev/ttysN and we capture it.
if (s.terminal.tty !== undefined) throw new Error("tty should be unset under piped stdio, got " + s.terminal.tty);
console.log("bridge-e2e OK (tty correctly unset under piped stdio)");

await close();
await fs.rm(sandbox, { recursive: true, force: true });
