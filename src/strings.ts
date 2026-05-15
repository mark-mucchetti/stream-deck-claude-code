// All user-facing strings rendered into Stream Deck tiles live here. We
// don't ship localization; this is centralization so the words are easy to
// find and edit in one place.
export const STRINGS = {
	/** Caption shown in the band at the bottom of each tile, per state. The
	 *  `working` caption is overridden by the tool name when one is present. */
	state: {
		idle: "idle",
		thinking: "thinking",
		working: "working",
		waiting: "waiting",
		done: "ready",
		error: "error",
	},
	/** Strings used on the empty-tile placeholder. */
	empty: {
		noSession: "none",
		setupNeeded: "setup needed",
		setupHintTop: "setup",
		setupHintBottom: "in inspector →",
	},
};
