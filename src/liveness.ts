import { execFile } from "node:child_process";
import type { Session } from "./state.js";

/** Parse `ps -o etime` ("[[dd-]hh:]mm:ss") into milliseconds. */
export function parseEtime(etime: string): number | undefined {
	const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!m) return undefined;
	const [, d, h, min, s] = m;
	return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60_000 + Number(s) * 1000;
}

/** Snapshot of every running process: pid -> start time (epoch ms). One
 *  `ps` call regardless of how many sessions we're checking. */
export function processStartTimes(): Promise<Map<string, number>> {
	return new Promise((resolve, reject) => {
		execFile("/bin/ps", ["-axo", "pid=,etime="], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
			if (err) return reject(err);
			const now = Date.now();
			const out = new Map<string, number>();
			for (const line of stdout.split("\n")) {
				const [pid, etime] = line.trim().split(/\s+/);
				if (!pid || !etime) continue;
				const age = parseEtime(etime);
				if (age !== undefined) out.set(pid, now - age);
			}
			resolve(out);
		});
	});
}

/** etime has 1s resolution and the clock moves between the event and the
 *  ps call; allow generous slack before calling a PID reused. */
const START_SLACK_MS = 60_000;

/** A session is dead when the Claude process that last reported for it is
 *  gone, or its PID now belongs to a process that started after that report
 *  (PID reuse). Sessions with no recorded PID are never judged dead. */
export function isDead(s: Session, procs: Map<string, number>): boolean {
	const pid = s.terminal?.ppid;
	if (!pid) return false;
	const started = procs.get(pid);
	if (started === undefined) return true;
	const seenAt = s.pidSeenAt ?? s.lastUpdate;
	return started > seenAt + START_SLACK_MS;
}
