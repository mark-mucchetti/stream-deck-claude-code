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

/** True if any of the user's hook entries carry our marker. Used by the
 *  startup top-up so we only ADD missing events when the user has already
 *  opted in by clicking Install at some point. */
export async function isPartiallyInstalled(): Promise<boolean> {
	try {
		const raw = await fs.readFile(settingsPath, "utf8");
		const settings = JSON.parse(raw) as Settings;
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
		const raw = await fs.readFile(settingsPath, "utf8");
		const settings = JSON.parse(raw) as Settings;
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
	await fs.mkdir(hooksDir, { recursive: true });
	await fs.mkdir(dirname(settingsPath), { recursive: true });

	const py = bridgePython(port);
	await fs.writeFile(bridgePyPath, py);
	await fs.chmod(bridgePyPath, 0o755);

	const sh = bridgeShell(bridgePyPath);
	await fs.writeFile(bridgeShPath, sh);
	await fs.chmod(bridgeShPath, 0o755);

	let settings: Settings = {};
	let raw = "";
	try {
		raw = await fs.readFile(settingsPath, "utf8");
		settings = JSON.parse(raw) as Settings;
	} catch (err) {
		if (raw) {
			try {
				await fs.writeFile(settingsPath + ".bak", raw);
			} catch {
				/* ignore */
			}
			logger.warn("existing ~/.claude/settings.json was unparseable; backed up to .bak", err);
		}
		settings = {};
	}

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
	await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	logger.info(`installed Claude Code hooks → ${settingsPath}`);
}

export async function uninstallHooks(logger: Logger): Promise<void> {
	let settings: Settings = {};
	try {
		settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as Settings;
	} catch {
		return;
	}
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
	await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");
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

function bridgePython(port: number): string {
	return `#!/usr/bin/env python3
"""stream-deck-claude-code hook bridge.

Reads the Claude Code hook event JSON from stdin, attaches identifying env
(TERM_PROGRAM, ITERM_SESSION_ID, VSCODE_PID, controlling tty), and POSTs it to
the Stream Deck plugin on localhost. Stays silent on any error so it never
blocks Claude.
"""
from __future__ import annotations
import json, os, sys, urllib.request

PORT = ${port}
URL = f"http://127.0.0.1:{PORT}/event"
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
        body = json.loads(sys.stdin.read() or "{}")
    except Exception:
        body = {}

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
            headers={"Content-Type": "application/json"},
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
