import { promises as fs } from "node:fs";

const TAIL_BYTES = 32 * 1024;

type TranscriptMeta = {
	aiTitle?: string;
	lastPrompt?: string;
	/** Timestamp (ms) of the most recent `User rejected tool use` entry.
	 *  Claude Code emits NO hook event for user denials, so this transcript
	 *  marker is the only signal that the user clicked Deny on a permission
	 *  or tool-call prompt. */
	lastRejectionAt?: number;
};

/** Read the tail of a Claude Code transcript JSONL and pluck out the latest
 *  title, last-prompt, and user-rejection entries. The file format is one
 *  JSON object per line, written append-only. We only read the last ~32KB to
 *  keep this cheap on every hook event.
 *
 *  Title precedence: a user-set `custom-title` (from `/rename foo`) wins over
 *  an AI-generated `ai-title`. Both flow through the same `aiTitle` field so
 *  the renderer doesn't need to know the source. */
export async function readTranscriptMeta(path: string): Promise<TranscriptMeta> {
	if (!path) return {};
	try {
		const stat = await fs.stat(path);
		const start = Math.max(0, stat.size - TAIL_BYTES);
		const fh = await fs.open(path, "r");
		try {
			const buf = Buffer.alloc(stat.size - start);
			await fh.read(buf, 0, buf.length, start);
			const text = buf.toString("utf8");
			const lines = text.split("\n");
			let customTitle: string | undefined;
			let aiTitle: string | undefined;
			let lastPrompt: string | undefined;
			let lastRejectionAt: number | undefined;
			for (let i = lines.length - 1; i >= 0; i--) {
				if (customTitle && aiTitle && lastPrompt && lastRejectionAt) break;
				const line = lines[i].trim();
				if (!line) continue;
				try {
					const o = JSON.parse(line) as Record<string, unknown>;
					if (!customTitle && o.type === "custom-title" && typeof o.customTitle === "string") {
						customTitle = o.customTitle;
					}
					if (!aiTitle && o.type === "ai-title" && typeof o.aiTitle === "string") {
						aiTitle = o.aiTitle;
					}
					if (!lastPrompt && o.type === "last-prompt" && typeof o.lastPrompt === "string") {
						lastPrompt = o.lastPrompt;
					}
					if (
						!lastRejectionAt &&
						o.type === "user" &&
						o.toolUseResult === "User rejected tool use" &&
						typeof o.timestamp === "string"
					) {
						const ts = Date.parse(o.timestamp);
						if (!Number.isNaN(ts)) lastRejectionAt = ts;
					}
				} catch {
					// partial line at the start of our tail buffer; ignore.
				}
			}
			return { aiTitle: customTitle ?? aiTitle, lastPrompt, lastRejectionAt };
		} finally {
			await fh.close();
		}
	} catch {
		return {};
	}
}
