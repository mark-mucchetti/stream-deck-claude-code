import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "./server.js";

const MARKER = "stream-deck-claude-code";
const EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"Notification",
	"PermissionRequest",
	"PermissionDenied",
	"Elicitation",
	"ElicitationResult",
	"Stop",
	"StopFailure",
	"SessionEnd",
];

type HookHandler = {
	type: string;
	command?: string;
	url?: string;
	timeout?: number;
	[k: string]: unknown;
	_source?: string;
};

type HookEntry = {
	matcher?: string;
	hooks: HookHandler[];
};

type Settings = {
	hooks?: Record<string, HookEntry[]>;
	[k: string]: unknown;
};

export const settingsPath = join(homedir(), ".claude", "settings.json");
export const hooksDir = join(homedir(), ".claude", "hooks");
export const bridgeShPath = join(hooksDir, "stream-deck-bridge.sh");
export const bridgePyPath = join(hooksDir, "stream-deck-bridge.py");
/** Shared secret between the bridge and the plugin's HTTP server. 0600, never
 *  rotated (the running server holds it in memory), kept on uninstall. */
export const tokenPath = join(hooksDir, "stream-deck-bridge.token");

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** The token file's trimmed contents, or undefined if it doesn't exist. */
async function readToken(): Promise<string | undefined> {
	try {
		return (await fs.readFile(tokenPath, "utf8")).trim();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** Read the bridge token, creating it on first use and repairing it if it's
 *  malformed (e.g. left empty by a crash). The new token is written to a temp
 *  file first and then moved into place, so the token file is never seen
 *  half-written; when two processes race to create it, `link` lets exactly
 *  one win and both read the winner's token. Permissions are reset to 0600
 *  on every call. */
export async function ensureToken(): Promise<string> {
	await fs.mkdir(hooksDir, { recursive: true });
	let token = await readToken();
	if (token === undefined || !TOKEN_RE.test(token)) {
		const tmp = `${tokenPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		await fs.writeFile(tmp, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
		try {
			if (token !== undefined) {
				await fs.rename(tmp, tokenPath); // replace a malformed (e.g. empty) token
			} else {
				await fs.link(tmp, tokenPath).catch((err: NodeJS.ErrnoException) => {
					if (err.code !== "EEXIST") throw err;
				});
			}
		} finally {
			await fs.rm(tmp, { force: true });
		}
		token = await readToken();
		if (token === undefined || !TOKEN_RE.test(token)) {
			throw new Error(`could not create a valid bridge token at ${tokenPath}`);
		}
	}
	await fs.chmod(tokenPath, 0o600);
	return token;
}

/** Parse ~/.claude/settings.json. A missing file is an empty object; an
 *  unparseable one throws, so we never overwrite settings we can't read. */
async function readSettings(): Promise<Settings> {
	let raw: string;
	try {
		raw = await fs.readFile(settingsPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
	try {
		return JSON.parse(raw) as Settings;
	} catch {
		throw new Error(`${settingsPath} is not valid JSON; not modifying it`);
	}
}

/** Atomic write (temp file + rename) through any symlink, keeping the
 *  file's mode. Skipped when nothing changed, so a plugin restart doesn't
 *  race Claude Code's own writes to the same file. */
async function writeSettingsIfChanged(settings: Settings, before: string): Promise<boolean> {
	if (JSON.stringify(settings) === before) return false;
	await fs.mkdir(dirname(settingsPath), { recursive: true });
	const target = await fs.realpath(settingsPath).catch(() => settingsPath);
	const mode = await fs.stat(target).then((s) => s.mode & 0o777, () => 0o600);
	const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", { mode });
	await fs.rename(tmp, target);
	return true;
}

/** True if any of the user's hook entries carry our marker. Used by the
 *  startup top-up so we only ADD missing events when the user has already
 *  opted in by clicking Install at some point. */
export async function isPartiallyInstalled(): Promise<boolean> {
	try {
		const settings = await readSettings();
		if (!settings.hooks) return false;
		for (const list of Object.values(settings.hooks)) {
			if (list.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => h?._source === MARKER))) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

export async function isInstalled(): Promise<boolean> {
	try {
		const settings = await readSettings();
		if (!settings.hooks) return false;
		for (const ev of EVENTS) {
			const list = settings.hooks[ev] ?? [];
			const ok = list.some(
				(e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?._source === MARKER),
			);
			if (!ok) return false;
		}
		return true;
	} catch {
		return false;
	}
}

export async function installHooks(port: number, logger: Logger): Promise<void> {
	// The port is written into generated Python; only a real port number may go there.
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`invalid port: ${port}`);
	}
	// Read first: if settings.json is unparseable we bail before touching anything.
	const settings = await readSettings();
	const before = JSON.stringify(settings);

	await fs.mkdir(hooksDir, { recursive: true });
	await ensureToken();

	const py = bridgePython(port, tokenPath);
	await fs.writeFile(bridgePyPath, py);
	await fs.chmod(bridgePyPath, 0o755);

	const sh = bridgeShell(bridgePyPath);
	await fs.writeFile(bridgeShPath, sh);
	await fs.chmod(bridgeShPath, 0o755);

	settings.hooks ??= {};
	for (const ev of EVENTS) {
		const list = (settings.hooks[ev] ??= []);
		const already = list.some(
			(e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?._source === MARKER),
		);
		if (already) continue;
		list.push({
			hooks: [{ type: "command", command: bridgeShPath, timeout: 5, _source: MARKER }],
		});
	}
	if (await writeSettingsIfChanged(settings, before)) {
		logger.info(`installed Claude Code hooks → ${settingsPath}`);
	}
}

export async function uninstallHooks(logger: Logger): Promise<void> {
	const settings = await readSettings();
	const before = JSON.stringify(settings);
	if (settings.hooks) {
		for (const ev of Object.keys(settings.hooks)) {
			settings.hooks[ev] = settings.hooks[ev]
				.map((entry) => ({
					...entry,
					hooks: (entry.hooks ?? []).filter((h) => h?._source !== MARKER),
				}))
				.filter((entry) => (entry.hooks ?? []).length > 0);
			if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
		}
		if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
	}
	await writeSettingsIfChanged(settings, before);
	for (const p of [bridgeShPath, bridgePyPath]) {
		try {
			await fs.unlink(p);
		} catch {
			/* ignore */
		}
	}
	logger.info("removed Claude Code hooks");
}

function bridgeShell(pyPath: string): string {
	// Capture the controlling tty in shell (Python's os.ttyname only works on a
	// real fd) and hand the rest off to Python for JSON + HTTP.
	return `#!/bin/sh
# Installed by stream-deck-claude-code. Forwards Claude Code hook events to the
# Stream Deck plugin's local server. Fire-and-forget; never blocks Claude.
export STREAMDECK_CC_TTY=\${STREAMDECK_CC_TTY:-$(tty 2>/dev/null || true)}
exec /usr/bin/python3 ${shellQuote(pyPath)}
`;
}

function bridgePython(port: number, tokenFile: string): string {
	return `#!/usr/bin/env python3
"""stream-deck-claude-code hook bridge.

Reads the Claude Code hook event JSON from stdin, keeps ONLY the fields the
plugin needs (never prompts, tool inputs or tool output), attaches
identifying env (TERM_PROGRAM, ITERM_SESSION_ID, VSCODE_PID, controlling tty),
and POSTs it to the Stream Deck plugin on localhost with the shared token.
Stays silent on any error so it never blocks Claude.
"""
from __future__ import annotations
import json, os, sys, urllib.request

PORT = ${port}
URL = f"http://127.0.0.1:{PORT}/event"
TOKEN_FILE = ${JSON.stringify(tokenFile)}
FIELDS = (
    "session_id",
    "cwd",
    "transcript_path",
    "hook_event_name",
    "tool_name",
    "notification_type",
    "source",
    "reason",
    "stop_reason",
)
KEYS = (
    "TERM_PROGRAM",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "VSCODE_PID",
    "VSCODE_INJECTION",
    "SSH_TTY",
    "WINDOWID",
)

def main() -> int:
    try:
        raw = json.loads(sys.stdin.read() or "{}")
        if not isinstance(raw, dict):
            raw = {}
    except Exception:
        raw = {}
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            token = f.read().strip()
    except Exception:
        return 0

    body = {k: raw[k] for k in FIELDS if k in raw}

    env = {k: os.environ[k] for k in KEYS if os.environ.get(k)}
    tty = os.environ.get("STREAMDECK_CC_TTY", "")
    if tty.startswith("/dev/"):
        env["TTY"] = tty
    env["PPID"] = str(os.getppid())
    body["_env"] = env

    try:
        req = urllib.request.Request(
            URL,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-StreamDeck-Token": token},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;
}

function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}
