import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { SessionAction } from "./actions/session-action.js";
import { installHooks, isPartiallyInstalled } from "./install.js";
import { startServer } from "./server.js";
import { SessionStore, type Session } from "./state.js";
import { readTranscriptMeta } from "./transcript.js";

streamDeck.logger.setLevel(LogLevel.INFO);

type PersistedState = {
	sessions?: Session[];
	order?: string[];
};
type PluginGlobalSettings = { state?: PersistedState };

const store = new SessionStore();

const logger = {
	info: (...a: unknown[]) => streamDeck.logger.info(...(a as [unknown])),
	warn: (...a: unknown[]) => streamDeck.logger.warn(...(a as [unknown])),
	error: (...a: unknown[]) => streamDeck.logger.error(...(a as [unknown])),
};

// Action must be registered before connect(). It safely no-ops in willAppear
// until bind() runs.
const sessionAction = new SessionAction();
streamDeck.actions.registerAction(sessionAction);

await streamDeck.connect();

// Pull last known sessions from global settings so a plugin/app restart
// doesn't blank the deck. State refreshes the moment any hook fires.
try {
	const settings = await streamDeck.settings.getGlobalSettings<PluginGlobalSettings>();
	if (settings?.state) {
		store.hydrate(settings.state);
		streamDeck.logger.info(`hydrated ${store.list().length} session(s) from global settings`);
	}
} catch (err) {
	streamDeck.logger.warn("could not read global settings", err);
}

const { port } = await startServer(store, { logger });
sessionAction.bind(store, port);

// Top-up: if the user has already installed our hooks at some point, make
// sure every event we currently care about is registered. This adds missing
// event entries without resurrecting them after an explicit uninstall.
try {
	if (await isPartiallyInstalled()) {
		await installHooks(port, logger);
	}
} catch (err) {
	streamDeck.logger.warn("hook top-up failed", err);
}

// Debounced persistence so a burst of hook events doesn't thrash the SDK.
// Wire up *after* hydrate so we don't immediately rewrite what we just read.
let persistTimer: NodeJS.Timeout | null = null;
const schedulePersist = () => {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = null;
		streamDeck.settings
			.setGlobalSettings({ state: store.serialize() } satisfies PluginGlobalSettings)
			.catch((err) => streamDeck.logger.warn("persist failed", err));
	}, 500);
};
store.on("change", schedulePersist);
store.on("rebalanced", schedulePersist);

// Poll waiting sessions' transcripts for "User rejected tool use" entries.
// Claude Code emits NO hook event when the user clicks Deny on a permission
// or tool prompt — the transcript marker is our only signal. Period of 3s
// keeps the false-red window short without thrashing disk.
const REJECTION_POLL_MS = 3000;
let rejectionPollInflight = false;
setInterval(async () => {
	if (rejectionPollInflight) return;
	rejectionPollInflight = true;
	try {
		for (const s of store.list()) {
			if (s.state !== "waiting") continue;
			if (!s.transcriptPath) continue;
			const meta = await readTranscriptMeta(s.transcriptPath);
			if (meta.lastRejectionAt && meta.lastRejectionAt > s.lastUpdate) {
				streamDeck.logger.info(`detected user rejection in transcript for ${s.id.slice(0, 8)}`);
				store.apply(s.id, { state: "done", lastEvent: "user_rejected" });
			}
		}
	} catch (err) {
		streamDeck.logger.warn("rejection poll error", err);
	} finally {
		rejectionPollInflight = false;
	}
}, REJECTION_POLL_MS);

streamDeck.logger.info(`Claude Code session bridge ready on port ${port}`);
