import { EventEmitter } from "node:events";
import { basename } from "node:path";

export type SessionState =
	| "idle"
	| "thinking"
	| "working"
	| "waiting"
	| "done"
	| "error";

export type TerminalHint = {
	termProgram?: string;
	termSessionId?: string;
	/** Full iTerm session id, format `w0t0p0:UUID`. The UUID portion matches
	 *  the AppleScript `unique id` of the session. */
	iTermSessionId?: string;
	/** Renderer PID for VS Code / Cursor integrated terminals. */
	vscodePid?: string;
	/** Controlling TTY, e.g. /dev/ttys001. Used to match Terminal.app tabs. */
	tty?: string;
	ppid?: string;
	windowId?: string;
};

export type Session = {
	id: string;
	cwd: string;
	label: string;
	state: SessionState;
	lastTool?: string;
	lastEvent: string;
	startedAt: number;
	lastUpdate: number;
	terminal: TerminalHint;
	/** Claude's auto-generated summary of the session, pulled from the
	 *  `ai-title` entries in the transcript JSONL. */
	aiTitle?: string;
	/** Last known path to the session's transcript JSONL — used to poll for
	 *  signals (like user rejections) that don't arrive via hook events. */
	transcriptPath?: string;
	/** True if the session is currently demoted out of the visible tile set
	 *  because there are more sessions than tiles. Set/cleared by
	 *  reconcileCapacity, persisted across restarts. */
	overflow?: boolean;
};

/** Tool names whose PreToolUse blocks on a human response. Kept in sync
 *  with the same constant in `server.ts`. */
const WAITS_ON_USER_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function deriveLabel(cwd: string): string {
	// Hand the full basename to the renderer; it owns the wrap/fit logic.
	return basename(cwd || "") || "claude";
}

export class SessionStore extends EventEmitter {
	private sessions = new Map<string, Session>();
	private order: string[] = [];

	list(): Session[] {
		return this.order
			.map((id) => this.sessions.get(id))
			.filter((s): s is Session => !!s);
	}

	/** Sessions assigned to tiles (overflow flag false), in arrival order. */
	visible(): Session[] {
		return this.list().filter((s) => !s.overflow);
	}

	/** Sessions bumped out by the overflow rule, in arrival order. */
	overflowList(): Session[] {
		return this.list().filter((s) => !!s.overflow);
	}

	get(id: string): Session | undefined {
		return this.sessions.get(id);
	}

	/** Demote longest-idle visible sessions until `visible <= capacity`, then
	 *  promote earliest-arrival overflow sessions until `visible == capacity`.
	 *  Emits "rebalanced" (not "change") so callers can persist without
	 *  triggering another render. Returns true if anything actually moved. */
	reconcileCapacity(capacity: number): boolean {
		let changed = false;
		// Demote excess.
		while (this.visible().length > capacity) {
			const visible = this.visible();
			let oldest = visible[0];
			if (!oldest) break;
			for (const s of visible) {
				if (s.lastUpdate < oldest.lastUpdate) oldest = s;
			}
			oldest.overflow = true;
			changed = true;
		}
		// Promote up to capacity from overflow, in arrival order.
		while (this.visible().length < capacity) {
			const next = this.overflowList()[0];
			if (!next) break;
			next.overflow = false;
			changed = true;
		}
		if (changed) this.emit("rebalanced");
		return changed;
	}

	upsert(id: string, cwd: string, hint: TerminalHint = {}): Session {
		let s = this.sessions.get(id);
		if (!s) {
			s = {
				id,
				cwd,
				label: deriveLabel(cwd),
				state: "idle",
				lastEvent: "SessionStart",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				terminal: hint,
			};
			this.sessions.set(id, s);
			this.order.push(id);
		} else {
			// Don't update cwd. Claude Code reports the *current* cwd in
			// hook payloads, which drifts whenever the agent runs `cd`. The
			// first cwd we saw is what the session is "about" — keep it
			// sticky so the tile label doesn't flip mid-session.
			s.terminal = { ...s.terminal, ...hint };
		}
		s.lastUpdate = Date.now();
		this.emit("change");
		return s;
	}

	apply(id: string, patch: Partial<Session>): Session | undefined {
		const s = this.sessions.get(id);
		if (!s) return undefined;
		Object.assign(s, patch);
		s.lastUpdate = Date.now();
		this.emit("change");
		return s;
	}

	remove(id: string): void {
		if (!this.sessions.has(id)) return;
		this.sessions.delete(id);
		this.order = this.order.filter((x) => x !== id);
		this.emit("change");
	}

	/** Snapshot the store as plain data so we can persist it across restarts. */
	serialize(): { sessions: Session[]; order: string[] } {
		return {
			sessions: [...this.sessions.values()],
			order: [...this.order],
		};
	}

	/** Rebuild the store from a previously-serialized snapshot. We don't
	 *  drop sessions by age — a session waiting on a human for hours is the
	 *  exact case we want the tile to keep surfacing. */
	hydrate(data: { sessions?: Session[]; order?: string[] } | undefined): void {
		if (!data?.sessions?.length) return;
		const valid = new Map<string, Session>();
		for (const s of data.sessions) {
			if (!s?.id) continue;
			// Tolerate persisted state from older builds that used "ended".
			if ((s.state as string) === "ended") continue;
			const migrated = { ...s, terminal: s.terminal ?? {} };
			// Old persisted state from before tools-that-block-on-user were
			// classified as `waiting`. Retro-tag those sessions correctly.
			if (
				migrated.state === "working" &&
				migrated.lastTool &&
				WAITS_ON_USER_TOOLS.has(migrated.lastTool)
			) {
				migrated.state = "waiting";
			}
			valid.set(s.id, migrated);
		}
		const orderedIds = (data.order ?? data.sessions.map((s) => s.id))
			.filter((id) => valid.has(id));
		// Append any sessions in `sessions` but missing from `order`.
		for (const s of data.sessions) {
			if (valid.has(s.id) && !orderedIds.includes(s.id)) orderedIds.push(s.id);
		}
		this.sessions = valid;
		this.order = orderedIds;
		if (this.sessions.size > 0) this.emit("change");
	}
}
