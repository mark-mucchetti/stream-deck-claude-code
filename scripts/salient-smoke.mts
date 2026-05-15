import { salientWord } from "../src/render.js";

// Cases exercise every branch: verb stripping, stopword/modifier filtering,
// project-complement preference, and the fallback chain.
const cases: { title: string; project: string; want: string }[] = [
	// Verb stripping + adjective filter ("latest" is a weak modifier).
	{ title: "Get latest updates", project: "alpha", want: "updates" },
	// Verb stripping + adjective filter + multi-noun pick.
	{ title: "Refactor monitoring for intermittent build failures", project: "alpha", want: "monitoring" },
	// Project-name complement: "Stream" and "Deck" are in the project, pick something else.
	{ title: "Build Stream Deck plugin for Claude Code sessions", project: "stream-deck-claude-code", want: "plugin" },
	// Verb stripping with no adjectives in the way.
	{ title: "Fix navigation summary count display", project: "beta", want: "navigation" },
	// Fallback: every content word is also in the project label, so v4 falls
	// back to the first non-stopword.
	{ title: "Refactor API client", project: "api-client", want: "API" },
	// Empty input.
	{ title: "", project: "x", want: "" },
];

let bad = 0;
for (const c of cases) {
	const got = salientWord(c.title, c.project);
	const ok = got === c.want;
	console.log(`${ok ? "✓" : "✗"} project=${c.project.padEnd(28)} title="${c.title}" → ${got.padEnd(14)} (want ${c.want})`);
	if (!ok) bad++;
}
if (bad) {
	console.error(`\n${bad}/${cases.length} cases failed`);
	process.exit(1);
}
console.log(`\nall ${cases.length} cases pass`);
