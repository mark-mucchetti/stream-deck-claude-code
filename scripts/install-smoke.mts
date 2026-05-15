// Sandboxed install/uninstall test. Sets HOME to a temp dir so we don't
// touch the user's real ~/.claude/settings.json.
import { promises as fs } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "sd-cc-"));
process.env.HOME = sandbox;
console.log("sandbox:", sandbox);

// Seed an existing settings.json with an unrelated hook so we can verify
// non-destructive merge.
const claudeDir = join(sandbox, ".claude");
await fs.mkdir(claudeDir, { recursive: true });
const seed = {
	model: "claude-opus-4-7",
	hooks: {
		PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
	},
};
await fs.writeFile(join(claudeDir, "settings.json"), JSON.stringify(seed, null, 2));

// Re-import after HOME change so module-level constants pick up the new path.
const { installHooks, uninstallHooks, isInstalled, settingsPath, bridgeShPath, bridgePyPath } = await import("../src/install.js");
const noop = { info: () => {}, warn: console.warn, error: console.error };

function assert(cond: unknown, msg: string) {
	if (!cond) { console.error("FAIL:", msg); process.exit(1); }
}

assert(settingsPath.startsWith(sandbox), "settingsPath should be sandboxed");
assert(!(await isInstalled()), "should start uninstalled");

await installHooks(13427, noop);
assert(await isInstalled(), "should report installed");

const after = JSON.parse(await readFile(settingsPath, "utf8"));
assert(after.model === "claude-opus-4-7", "must preserve unrelated settings");
assert(after.hooks.PreToolUse.some((e: { hooks?: { command?: string }[] }) =>
	e.hooks?.some((h) => h.command === "echo pre")), "must preserve unrelated hook");
const allEvents = ["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","Notification","Stop","StopFailure","SessionEnd"];
for (const ev of allEvents) {
	assert(after.hooks[ev]?.some((e: { hooks?: { _source?: string }[] }) =>
		e.hooks?.some((h) => h._source === "stream-deck-claude-code")), `missing hook for ${ev}`);
}

const sh = await readFile(bridgeShPath, "utf8");
assert(sh.includes("STREAMDECK_CC_TTY"), "shell bridge should capture tty");
assert(sh.includes(bridgePyPath), "shell bridge should reference python file");
const py = await readFile(bridgePyPath, "utf8");
assert(py.includes("ITERM_SESSION_ID"), "python bridge should forward ITERM_SESSION_ID");
assert(py.includes("13427"), "python bridge should reference port");

// Running install twice should be idempotent.
await installHooks(13427, noop);
const twice = JSON.parse(await readFile(settingsPath, "utf8"));
for (const ev of allEvents) {
	const count = twice.hooks[ev].filter((e: { hooks?: { _source?: string }[] }) =>
		e.hooks?.some((h) => h._source === "stream-deck-claude-code")).length;
	assert(count === 1, `duplicate hook entry for ${ev}: ${count}`);
}

await uninstallHooks(noop);
assert(!(await isInstalled()), "should report uninstalled");
const final = JSON.parse(await readFile(settingsPath, "utf8"));
assert(final.model === "claude-opus-4-7", "unrelated settings preserved after uninstall");
assert(final.hooks?.PreToolUse?.some((e: { hooks?: { command?: string }[] }) =>
	e.hooks?.some((h) => h.command === "echo pre")), "unrelated hook preserved after uninstall");
assert(!Object.values(final.hooks ?? {}).flat().some((e) =>
	(e as { hooks?: { _source?: string }[] }).hooks?.some((h) => h._source === "stream-deck-claude-code")),
	"all our hooks removed");

// Bridge files should be cleaned up.
let pyExists = true;
try { await fs.access(bridgePyPath); } catch { pyExists = false; }
assert(!pyExists, "python bridge file should be deleted on uninstall");

console.log("install-smoke OK");
await fs.rm(sandbox, { recursive: true, force: true });
