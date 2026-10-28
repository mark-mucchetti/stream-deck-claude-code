// Sandboxed install/uninstall test. Sets HOME to a temp dir so we don't
// touch the user's real ~/.claude/settings.json.
import { promises as fs } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// Token: created 0600, kept across uninstall so the running server stays in sync.
const { tokenPath, ensureToken } = await import("../src/install.js");
const tokenStat = await fs.stat(tokenPath);
assert((tokenStat.mode & 0o777) === 0o600, `token file should be 0600, is ${(tokenStat.mode & 0o777).toString(8)}`);
const token1 = await ensureToken();
assert(/^[0-9a-f]{64}$/.test(token1), "token should be 64 hex chars");
assert((await ensureToken()) === token1, "token must be stable across calls");

// Loose permissions are tightened again.
await fs.chmod(tokenPath, 0o644);
await ensureToken();
assert(((await fs.stat(tokenPath)).mode & 0o777) === 0o600, "ensureToken should reset mode to 0600");

// An empty or truncated token (crash mid-write) is replaced, not fatal.
await fs.writeFile(tokenPath, "");
const token2 = await ensureToken();
assert(/^[0-9a-f]{64}$/.test(token2) && token2 !== token1, "empty token file should be regenerated");
await fs.writeFile(tokenPath, "abc\n");
assert(/^[0-9a-f]{64}$/.test(await ensureToken()), "short token file should be regenerated");

// Concurrent first runs agree on one token.
await fs.rm(tokenPath);
const raced = await Promise.all([ensureToken(), ensureToken(), ensureToken()]);
assert(raced.every((t) => t === raced[0]), "concurrent ensureToken calls must return the same token");
assert(!(await fs.readdir(dirname(tokenPath))).some((f) => f.endsWith(".tmp")), "no temp files left behind");

// The port is embedded in generated Python, so junk must be refused.
let badPort = false;
try { await installHooks(Number("abc"), noop); } catch { badPort = true; }
assert(badPort, "installHooks must refuse a non-numeric port");

// No-op install must not rewrite settings.json.
await installHooks(13427, noop);
const mtime1 = (await fs.stat(settingsPath)).mtimeMs;
await new Promise((r) => setTimeout(r, 20));
await installHooks(13427, noop);
assert((await fs.stat(settingsPath)).mtimeMs === mtime1, "unchanged install must not rewrite settings.json");

// Unparseable settings.json must be left untouched, and install must fail loudly.
const broken = '{ "model": "claude-opus-4-7", oops';
await fs.writeFile(settingsPath, broken);
let threw = false;
try { await installHooks(13427, noop); } catch { threw = true; }
assert(threw, "install should refuse an unparseable settings.json");
assert(await readFile(settingsPath, "utf8") === broken, "unparseable settings.json must not be modified");

// Symlinked settings.json (dotfiles setups) stays a symlink after a write.
const real = join(sandbox, "dotfiles-settings.json");
await fs.writeFile(real, JSON.stringify(seed, null, 2));
await fs.rm(settingsPath);
await fs.symlink(real, settingsPath);
await installHooks(13427, noop);
assert((await fs.lstat(settingsPath)).isSymbolicLink(), "settings.json symlink must survive install");
assert(JSON.parse(await readFile(real, "utf8")).hooks.Stop, "hooks must land in the symlink target");

console.log("install-smoke OK");
await fs.rm(sandbox, { recursive: true, force: true });
