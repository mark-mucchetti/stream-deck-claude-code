#!/usr/bin/env node
// Manual installer/uninstaller for the stream-deck-claude-code hook bridge.
// The Setup button on the Stream Deck does the same thing; this is here for
// power users who want to install hooks without Stream Deck running.
//
// Thin wrapper over src/install.ts (run via tsx) so the bridge script, token
// handling and safe settings writes have exactly one implementation.

import { DEFAULT_PORT } from "../src/server.ts";
import { installHooks, settingsPath, tokenPath, uninstallHooks } from "../src/install.ts";

const PORT = Number(process.env.STREAM_DECK_CC_PORT || DEFAULT_PORT);
const logger = { info: console.log, warn: console.warn, error: console.error };

try {
	if (process.argv.includes("--uninstall")) {
		await uninstallHooks(logger);
	} else {
		await installHooks(PORT, logger);
		console.log(`✔ hooks in ${settingsPath} POST to http://127.0.0.1:${PORT}/event`);
		console.log(`✔ bridge token at ${tokenPath}`);
	}
} catch (err) {
	console.error(String(err?.message ?? err));
	process.exit(1);
}
