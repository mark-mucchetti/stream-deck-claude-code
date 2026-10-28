import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { SessionState, SessionStore, TerminalHint } from "./state.js";
import { readTranscriptMeta } from "./transcript.js";

export const DEFAULT_PORT = 13427;

type HookPayload = {
	session_id?: string;
	cwd?: string;
	transcript_path?: string;
	hook_event_name?: string;
	tool_name?: string;
	notification_type?: string;
	source?: string;
	reason?: string;
	stop_reason?: string;
	_env?: Record<string, string | undefined>;
};

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		req.setEncoding("utf8");
		req.on("data", (c) => {
			buf += c;
			// The bridge sends a few hundred bytes of metadata; anything big is not ours.
			if (buf.length > 64 * 1024) {
				reject(new Error("payload too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(buf));
		req.on("error", reject);
	});
}

// ── Request + input validation ────────────────────────────────────────────
// The server only ever talks to our own bridge (python urllib on this Mac).
// Browsers are the threat: a web page can POST "simple" requests to
// localhost, and DNS rebinding lets it read responses. So: require the
// shared token header (a page can't send custom headers cross-origin without
// a CORS preflight we never answer), require an exact loopback Host, refuse
// anything carrying an Origin header, and require a JSON content type.

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function str(v: unknown, max: number): string | undefined {
	return typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
}

/** Only transcripts Claude Code itself writes: absolute, normalized, under
 *  ~/.claude/projects, `.jsonl`. Anything else could point the transcript
 *  reader at an arbitrary file. */
export function safeTranscriptPath(p: unknown): string | undefined {
	const s = str(p, 4096);
	if (!s || !isAbsolute(s) || normalize(s) !== s || !s.endsWith(".jsonl")) return undefined;
	return s.startsWith(PROJECTS_DIR + sep) ? s : undefined;
}

function tokenMatches(header: string | string[] | undefined, token: string): boolean {
	if (typeof header !== "string") return false;
	const a = Buffer.from(header);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Throttle transcript reads per-session: at most one read every 2s. */
const lastTranscriptRead = new Map<string, number>();
const TRANSCRIPT_THROTTLE_MS = 2000;

function pickHint(env: Record<string, unknown> | undefined): TerminalHint {
	if (!env || typeof env !== "object") return {};
	const out: TerminalHint = {};
	const v = (k: string) => str(env[k], 256);
	if (v("TERM_PROGRAM")) out.termProgram = v("TERM_PROGRAM");
	if (v("TERM_SESSION_ID")) out.termSessionId = v("TERM_SESSION_ID");
	if (v("ITERM_SESSION_ID")) out.iTermSessionId = v("ITERM_SESSION_ID");
	if (v("VSCODE_PID")) out.vscodePid = v("VSCODE_PID");
	if (v("TTY")?.startsWith("/dev/")) out.tty = v("TTY");
	if (v("PPID")) out.ppid = v("PPID");
	if (v("WINDOWID")) out.windowId = v("WINDOWID");
	return out;
}

/** Tools that pause Claude on a human response. Their PreToolUse should
 *  surface as `waiting` so the tile pulses red. */
const WAITS_ON_USER = new Set(["AskUserQuestion", "ExitPlanMode"]);

function stateFor(payload: HookPayload): { state?: SessionState; tool?: string } {
	switch (payload.hook_event_name) {
		case "SessionStart": return { state: "idle" };
		case "UserPromptSubmit": return { state: "thinking" };
		case "PreToolUse":
			// Tools that block on the human are "waiting", not "working".
			if (payload.tool_name && WAITS_ON_USER.has(payload.tool_name)) {
				return { state: "waiting", tool: payload.tool_name };
			}
			return { state: "working", tool: payload.tool_name };
		case "PostToolUse":
			// Post-tool for a blocking tool means the user just answered →
			// the session is back to working until something else fires.
			return { state: "working", tool: payload.tool_name };
		case "Notification":
			// `permission_prompt`: Claude is asking the user to authorize a tool → urgent.
			// `elicitation_dialog`: an MCP server is asking the user a form question → urgent.
			// `idle_prompt`: Claude finished and is at the prompt → same as Stop.
			// `elicitation_complete` / `elicitation_response`: user answered → resume working.
			// `auth_success`: observability only.
			if (payload.notification_type === "permission_prompt") return { state: "waiting" };
			if (payload.notification_type === "elicitation_dialog") return { state: "waiting" };
			if (payload.notification_type === "idle_prompt") return { state: "done" };
			if (payload.notification_type === "elicitation_complete") return { state: "working" };
			if (payload.notification_type === "elicitation_response") return { state: "working" };
			return {};
		case "PermissionRequest":
			// Permission dialog is on screen — Claude is fully blocked on the user.
			return { state: "waiting", tool: payload.tool_name };
		case "Elicitation":
			// MCP server is asking the user a question via the elicitation API.
			return { state: "waiting" };
		case "ElicitationResult":
			// User answered the MCP elicitation — flow resumes.
			return { state: "working" };
		case "PostToolUseFailure":
			// Tool call failed for any reason — including the user clicking
			// Deny on a permission prompt. Either way, Claude is no longer
			// blocked on the tool; back to working until something else fires.
			return { state: "working", tool: payload.tool_name };
		case "PostToolBatch":
			// A batch of parallel tool calls just resolved. The LLM is now
			// generating the next decision (could be more tool calls or the
			// final response) — that's thinking, not working. Individual
			// PostToolUse stays at `working` because other tools in the same
			// batch may still be running; PostToolBatch is the one event
			// guaranteed to fire exactly once when the batch fully resolves.
			return { state: "thinking" };
		case "PermissionDenied":
			// Auto-mode classifier (or possibly user) denied the tool. Claude
			// resumes processing without it.
			return { state: "working", tool: payload.tool_name };
		case "Stop": return { state: "done" };
		case "StopFailure": return { state: "error" };
		default: return {};
	}
}

export type Logger = {
	info: (...a: unknown[]) => void;
	warn: (...a: unknown[]) => void;
	error: (...a: unknown[]) => void;
};

export async function startServer(
	store: SessionStore,
	opts: { port?: number; logger?: Logger; token: string },
): Promise<{ port: number; close: () => Promise<void> }> {
	const logger = opts.logger ?? console;
	const desired = opts.port ?? DEFAULT_PORT;
	const token = opts.token;
	if (!token) throw new Error("startServer requires a token");
	let boundPort = 0;

	const server = http.createServer(async (req, res) => {
		const url = req.url ?? "";
		// DNS rebinding: a rebound page sends its own hostname as Host.
		const host = req.headers.host;
		if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
			return json(res, 403, { error: "forbidden" });
		}
		// Browsers always send Origin on cross-origin requests; our bridge never does.
		if (req.headers.origin !== undefined) {
			return json(res, 403, { error: "forbidden" });
		}
		if (req.method === "GET" && (url === "/" || url === "/health")) {
			return json(res, 200, { ok: true });
		}
		if (!tokenMatches(req.headers["x-streamdeck-token"], token)) {
			return json(res, 401, { error: "unauthorized" });
		}
		if (req.method === "GET" && url === "/sessions") {
			return json(res, 200, { sessions: store.list() });
		}
		if (req.method !== "POST" || !(url === "/event" || url === "/hook")) {
			return json(res, 404, { error: "not found" });
		}
		if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
			return json(res, 415, { error: "expected application/json" });
		}
		try {
			const raw = await readBody(req);
			const parsed: unknown = raw ? JSON.parse(raw) : {};
			const payload = sanitizePayload(parsed);
			// Full payload to logs so we can diagnose what Claude actually
			// fires (or doesn't) under interrupt/esc/timeout scenarios.
			const sid = payload.session_id ?? "?";
			const sidShort = sid.length > 8 ? sid.slice(0, 8) : sid;
			logger.info(
				`hook ${payload.hook_event_name ?? "?"} sid=${sidShort}` +
				(payload.tool_name ? ` tool=${payload.tool_name}` : "") +
				(payload.notification_type ? ` notif=${payload.notification_type}` : "") +
				(payload.stop_reason ? ` stop=${payload.stop_reason}` : ""),
			);
			handleEvent(store, payload, logger);
			return json(res, 200, { ok: true });
		} catch (err) {
			logger.warn("hook parse error", err);
			return json(res, 400, { error: "bad request" });
		}
	});

	const port = await listenWithFallback(server, desired);
	boundPort = port;
	logger.info(`hook server listening on 127.0.0.1:${port}`);
	return {
		port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** Keep only known fields, each a bounded string (no newlines, so log lines
 *  can't be forged). Invalid values are dropped, not coerced. */
function sanitizePayload(raw: unknown): HookPayload {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const r = raw as Record<string, unknown>;
	const field = (k: string, max = 128) => {
		const v = str(r[k], max);
		return v && !/[\r\n]/.test(v) ? v : undefined;
	};
	const sid = field("session_id");
	const cwd = field("cwd", 4096);
	return {
		session_id: sid && SESSION_ID_RE.test(sid) ? sid : undefined,
		cwd: cwd && isAbsolute(cwd) ? cwd : undefined,
		transcript_path: safeTranscriptPath(r.transcript_path),
		hook_event_name: field("hook_event_name"),
		tool_name: field("tool_name"),
		notification_type: field("notification_type"),
		source: field("source"),
		reason: field("reason"),
		stop_reason: field("stop_reason"),
		_env: r._env && typeof r._env === "object" ? (r._env as Record<string, string | undefined>) : undefined,
	};
}

function handleEvent(store: SessionStore, payload: HookPayload, logger: Logger): void {
	const id = payload.session_id;
	if (!id) {
		logger.warn("hook event missing or invalid session_id", payload.hook_event_name);
		return;
	}
	const cwd = payload.cwd ?? "";
	const hint = pickHint(payload._env);

	if (payload.hook_event_name === "SessionEnd") {
		// User ^C'd or otherwise quit — drop the tile back to the empty state.
		// If they `claude --resume`, the first real event will re-add it.
		store.remove(id);
		return;
	}

	if (payload.hook_event_name === "SessionStart") {
		// The VS Code Claude extension auto-spawns a second `claude` process
		// (stream-json IO) that fires SessionStart and then idles forever
		// because the user is interacting with the terminal claude instead.
		// Creating a session record here would leak that phantom into the
		// store + globalSettings forever. Defer record creation until a real
		// event (UserPromptSubmit / PreToolUse / Notification / …) proves the
		// session is actually in use. Every real event includes the same
		// session_id, cwd, and terminal hints, so no information is lost.
		return;
	}

	const s = store.upsert(id, cwd, hint);
	const { state, tool } = stateFor(payload);
	const patch: Partial<typeof s> = { lastEvent: payload.hook_event_name ?? s.lastEvent };
	if (state) patch.state = state;
	if (tool) patch.lastTool = tool;
	if (payload.transcript_path) patch.transcriptPath = payload.transcript_path;
	store.apply(id, patch);

	// Refresh the session's aiTitle from the transcript tail. Throttled and
	// fire-and-forget so we don't block the hook response.
	if (payload.transcript_path) {
		const now = Date.now();
		const last = lastTranscriptRead.get(id) ?? 0;
		if (now - last >= TRANSCRIPT_THROTTLE_MS) {
			lastTranscriptRead.set(id, now);
			const path = payload.transcript_path;
			readTranscriptMeta(path)
				.then((meta) => {
					if (meta.aiTitle && meta.aiTitle !== store.get(id)?.aiTitle) {
						store.apply(id, { aiTitle: meta.aiTitle });
					}
				})
				.catch(() => {
					/* ignore */
				});
		}
	}
}

function json(res: ServerResponse, code: number, body: unknown): void {
	res.statusCode = code;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify(body));
}

function listenWithFallback(server: http.Server, port: number, attempts = 5): Promise<number> {
	return new Promise((resolve, reject) => {
		const tryPort = (p: number, left: number) => {
			const onError = (err: NodeJS.ErrnoException) => {
				server.removeListener("listening", onListening);
				if (err.code === "EADDRINUSE" && left > 0) {
					tryPort(p + 1, left - 1);
				} else {
					reject(err);
				}
			};
			const onListening = () => {
				server.removeListener("error", onError);
				const addr = server.address() as AddressInfo;
				resolve(addr.port);
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(p, "127.0.0.1");
		};
		tryPort(port, attempts);
	});
}
