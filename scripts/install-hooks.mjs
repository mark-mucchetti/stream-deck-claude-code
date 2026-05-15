#!/usr/bin/env node
// Manual installer/uninstaller for the stream-deck-claude-code hook bridge.
// The Setup button on the Stream Deck does the same thing; this is here for
// power users who want to install hooks without Stream Deck running.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PORT = Number(process.env.STREAM_DECK_CC_PORT || 13427);
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

const settingsPath = join(homedir(), ".claude", "settings.json");
const hooksDir = join(homedir(), ".claude", "hooks");
const shPath = join(hooksDir, "stream-deck-bridge.sh");
const pyPath = join(hooksDir, "stream-deck-bridge.py");

const shellQuote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

const bridgeShell = (py) => `#!/bin/sh
# Installed by stream-deck-claude-code.
export STREAMDECK_CC_TTY=\${STREAMDECK_CC_TTY:-$(tty 2>/dev/null || true)}
exec /usr/bin/python3 ${shellQuote(py)}
`;

const bridgePython = (port) => `#!/usr/bin/env python3
"""stream-deck-claude-code hook bridge."""
from __future__ import annotations
import json, os, sys, urllib.request

PORT = ${port}
URL = f"http://127.0.0.1:{PORT}/event"
KEYS = ("TERM_PROGRAM","TERM_SESSION_ID","ITERM_SESSION_ID","VSCODE_PID","VSCODE_INJECTION","SSH_TTY","WINDOWID")

def main() -> int:
    try:
        body = json.loads(sys.stdin.read() or "{}")
    except Exception:
        body = {}
    env = {k: os.environ[k] for k in KEYS if os.environ.get(k)}
    tty = os.environ.get("STREAMDECK_CC_TTY", "")
    if tty.startswith("/dev/"): env["TTY"] = tty
    env["PPID"] = str(os.getppid())
    body["_env"] = env
    try:
        urllib.request.urlopen(urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type":"application/json"}, method="POST"), timeout=2).read()
    except Exception:
        pass
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

async function readSettings() {
	try {
		return JSON.parse(await fs.readFile(settingsPath, "utf8"));
	} catch {
		return {};
	}
}

async function writeSettings(obj) {
	await fs.mkdir(dirname(settingsPath), { recursive: true });
	await fs.writeFile(settingsPath, JSON.stringify(obj, null, 2) + "\n");
}

async function install() {
	await fs.mkdir(hooksDir, { recursive: true });
	await fs.writeFile(pyPath, bridgePython(PORT));
	await fs.chmod(pyPath, 0o755);
	await fs.writeFile(shPath, bridgeShell(pyPath));
	await fs.chmod(shPath, 0o755);

	const settings = await readSettings();
	settings.hooks ??= {};
	for (const ev of EVENTS) {
		const list = (settings.hooks[ev] ??= []);
		const present = list.some(
			(e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?._source === MARKER),
		);
		if (!present) {
			list.push({ hooks: [{ type: "command", command: shPath, timeout: 5, _source: MARKER }] });
		}
	}
	await writeSettings(settings);
	console.log(`✔ wrote ${shPath}`);
	console.log(`✔ wrote ${pyPath}`);
	console.log(`✔ updated ${settingsPath}`);
	console.log(`hooks will POST to http://127.0.0.1:${PORT}/event`);
}

async function uninstall() {
	const settings = await readSettings();
	if (settings.hooks) {
		for (const ev of Object.keys(settings.hooks)) {
			settings.hooks[ev] = settings.hooks[ev]
				.map((e) => ({
					...e,
					hooks: (e.hooks || []).filter((h) => h?._source !== MARKER),
				}))
				.filter((e) => (e.hooks || []).length > 0);
			if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
		}
		if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
		await writeSettings(settings);
	}
	for (const p of [shPath, pyPath]) {
		try { await fs.unlink(p); } catch {}
	}
	console.log("✔ removed stream-deck-claude-code hooks");
}

const op = process.argv.includes("--uninstall") ? uninstall : install;
op().catch((err) => {
	console.error(err);
	process.exit(1);
});
