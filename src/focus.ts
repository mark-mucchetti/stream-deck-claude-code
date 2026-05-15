import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Session } from "./state.js";

type Result = { ok: boolean; out: string };

function osascript(script: string): Promise<Result> {
	return new Promise((resolve) => {
		const p = spawn("osascript", ["-e", script]);
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => (out += d.toString()));
		p.stderr.on("data", (d) => (err += d.toString()));
		p.on("close", (code) => resolve({ ok: code === 0 && !err.trim(), out: out.trim() }));
		p.on("error", () => resolve({ ok: false, out: "" }));
	});
}

function openInFinder(path: string): Promise<void> {
	return new Promise((resolve) => {
		const p = spawn("open", [path], { stdio: "ignore" });
		p.on("close", () => resolve());
		p.on("error", () => resolve());
	});
}

function esc(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function appIsRunning(name: string): Promise<boolean> {
	const r = await osascript(
		`tell application "System Events" to (name of processes) contains "${esc(name)}"`,
	);
	return r.ok && r.out === "true";
}

/** ITERM_SESSION_ID format is `w0t0p0:UUID`. The UUID after the colon is the
 *  iTerm session's unique id, queryable in AppleScript via `unique id of s`. */
function parseITermUuid(id: string | undefined): string | null {
	if (!id) return null;
	const i = id.indexOf(":");
	if (i < 0) return null;
	const uuid = id.slice(i + 1).trim();
	return uuid || null;
}

async function focusITermByUniqueId(uuid: string): Promise<boolean> {
	if (!(await appIsRunning("iTerm2")) && !(await appIsRunning("iTerm"))) return false;
	const u = esc(uuid);
	const script = `
		tell application "iTerm"
			set hit to false
			repeat with w in windows
				repeat with t in tabs of w
					repeat with s in sessions of t
						try
							if (unique id of s as text) is "${u}" then
								tell t to select
								tell s to select
								tell w to set frontmost to true
								set hit to true
								exit repeat
							end if
						end try
					end repeat
					if hit then exit repeat
				end repeat
				if hit then exit repeat
			end repeat
			if hit then activate
			return hit
		end tell
	`;
	const r = await osascript(script);
	return r.ok && r.out === "true";
}

async function focusTerminalByTty(tty: string): Promise<boolean> {
	if (!(await appIsRunning("Terminal"))) return false;
	const t = esc(tty);
	const script = `
		tell application "Terminal"
			set hit to false
			repeat with w in windows
				repeat with tb in tabs of w
					try
						if (tty of tb as text) is "${t}" then
							set selected of tb to true
							set frontmost of w to true
							set hit to true
							exit repeat
						end if
					end try
				end repeat
				if hit then exit repeat
			end repeat
			if hit then activate
			return hit
		end tell
	`;
	const r = await osascript(script);
	return r.ok && r.out === "true";
}

/** Bring a VS Code / Cursor window matching the project folder to the front.
 *  We can't pinpoint a specific integrated-terminal pane from AppleScript, but
 *  VS Code window titles include the workspace folder name, so we raise the
 *  matching window via System Events. */
async function focusVSCodeByTitle(appName: string, cwd: string): Promise<boolean> {
	if (!(await appIsRunning(appName))) return false;
	const project = esc(basename(cwd));
	if (!project) {
		await osascript(`tell application "${esc(appName)}" to activate`);
		return true;
	}
	const script = `
		tell application "${esc(appName)}" to activate
		delay 0.05
		tell application "System Events"
			tell process "${esc(appName)}"
				set wins to windows
				repeat with w in wins
					try
						if (name of w) contains "${project}" then
							perform action "AXRaise" of w
							return true
						end if
					end try
				end repeat
			end tell
		end tell
		return true
	`;
	const r = await osascript(script);
	return r.ok;
}

export async function focusSession(s: Session): Promise<void> {
	if (process.platform !== "darwin") return; // macOS-only for MVP

	const term = (s.terminal.termProgram ?? "").toLowerCase();

	if (term.includes("iterm")) {
		const uuid = parseITermUuid(s.terminal.iTermSessionId);
		if (uuid && (await focusITermByUniqueId(uuid))) return;
	}

	if (term.includes("apple_terminal") && s.terminal.tty) {
		if (await focusTerminalByTty(s.terminal.tty)) return;
	}

	if (term.includes("vscode") || s.terminal.vscodePid) {
		if (await focusVSCodeByTitle("Code", s.cwd)) return;
		if (await focusVSCodeByTitle("Code - Insiders", s.cwd)) return;
		if (await focusVSCodeByTitle("Cursor", s.cwd)) return;
	}

	// Unknown terminal — best-effort sweep so a stray Warp/Ghostty/etc session
	// at least surfaces *something* useful.
	if (s.terminal.iTermSessionId) {
		const uuid = parseITermUuid(s.terminal.iTermSessionId);
		if (uuid && (await focusITermByUniqueId(uuid))) return;
	}
	if (s.terminal.tty && (await focusTerminalByTty(s.terminal.tty))) return;

	if (s.cwd) await openInFinder(s.cwd);
}
