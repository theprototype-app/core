// 37 R20 — "REPORT A PROBLEM". The person saw something wrong: one press takes a picture of
// what they see (and, when they want it, the last 30 s of frame data), they draw boxes round
// the wrong bits, say what happened, and — only with the consent box ticked — send it to the
// team, where it lands in the staff panel's Problems tab (the cloud plugin's reporter,
// cloudHooks.problemReporter). Without a plugin, or without consent, the report is kept on
// this device as a Profiler recording, the "Report this moment" way (34 R1) — nothing leaves.
//
// It BUILDS ON perf/moment.js: the same eye screenshot (desktop render or the left eye in a
// headset) and the same light ring window, taken at the PRESS so the picture is of the moment,
// not of the time spent typing. The boxes are fractions of the picture (0..1), so they mean
// the same thing at any size it is drawn.
//
// Two entry points: the burger menu's "Report a problem" opens the dialog
// (ProblemReport.svelte); in a headset the VR menu captures the eye, the VR keyboard asks for
// the note, and the send waits behind an explicit yes (no boxes — there is no pointer-drawn
// rectangle on a headset panel; the note says where).
import { writable, get } from 'svelte/store';
import { showToast } from '../stores/appStore';
import { globalRenderer } from '../stores/sceneStore';
import { problemReporter } from './cloudHooks';
import { eyeScreenshot, finishMoment } from './perf/moment.js';
import { lightWindow } from './perf/recorder.js';
import { MOMENT_MS } from './perf/tpprof.js';
import { SESSION } from './perf/beacon.js';
import { APP_VERSION, COMMIT_SHA } from './version.js';

/** at most this many boxes on one report */
export const MAX_MARKS = 12;

/**
 * The open report (desktop): captured at the press. null = closed.
 * @type {import('svelte/store').Writable<null | {shot: Blob | null, shotUrl: string | null, perf: any, at: number}>}
 */
export const problemDraft = writable(null);

/** the suites' view */
export const problemDebug = { opened: 0, sent: 0, saved: 0, lastReport: /** @type {any} */ (null) };

/** clamp a box to the picture, drop the degenerate ones @param {any} m */
export function normalizeMark(m) {
	const c = (/** @type {any} */ v) => Math.max(0, Math.min(1, Number(v) || 0));
	let x = c(m?.x);
	let y = c(m?.y);
	let w = c(m?.w);
	let h = c(m?.h);
	if (x + w > 1) w = 1 - x;
	if (y + h > 1) h = 1 - y;
	if (w < 0.01 || h < 0.01) return null;
	const r = (/** @type {number} */ v) => Math.round(v * 10000) / 10000;
	return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

/** what the app says about itself on a report — no ids, no query string, no names */
async function reportMeta() {
	/** @type {Record<string, any>} */
	const meta = { version: APP_VERSION, build: COMMIT_SHA, at: new Date().toISOString() };
	try {
		const { currentLevel } = await import('./levels');
		const { sceneFileName } = await import('./gameSettings');
		meta.scene = (get(currentLevel)?.name || sceneFileName() || '').slice(0, 120);
	} catch {
		/* no scene name */
	}
	try {
		meta.device = navigator.userAgent.slice(0, 300);
		meta.url = location.origin + location.pathname;
		meta.viewport = innerWidth + 'x' + innerHeight;
	} catch {
		/* not a browser */
	}
	const r = /** @type {any} */ (get(globalRenderer));
	meta.xr = !!r?.xr?.isPresenting;
	try {
		const { peers } = await import('../stores/appStore');
		const p = /** @type {any} */ (get(peers));
		meta.peers = p?.openedPeers?.size ?? 0;
	} catch {
		/* alone */
	}
	return meta;
}

/** Step 1, at the press: the picture + the last 30 s of frame data. */
export async function captureProblem() {
	const shot = await eyeScreenshot();
	let perf = null;
	try {
		perf = lightWindow(MOMENT_MS, { kind: 'moment', session: SESSION });
	} catch {
		/* the recorder is not running — the report goes without it */
	}
	return { shot, shotUrl: shot ? URL.createObjectURL(shot) : null, perf, at: Date.now() };
}

/** Desktop: capture now, then the dialog. */
export async function openProblemReport() {
	const draft = await captureProblem();
	problemDebug.opened++;
	problemDraft.set(draft);
	return draft;
}

/** who a report would go out as, or null when it cannot be sent from here */
export function reporterAccount() {
	const r = get(problemReporter);
	if (!r) return null;
	try {
		return r.account?.() ?? { signedIn: true };
	} catch {
		return { signedIn: false };
	}
}

/**
 * Step 2: send it (consent + a reporter) or keep it on this device.
 * @param {{shot: Blob | null, shotUrl?: string | null, perf: any}} draft
 * @param {{note?: string, marks?: any[], perf?: boolean, send?: boolean}} answer
 * @returns {Promise<{sent: boolean, saved: boolean, error?: string, reason?: string}>}
 */
export async function finishProblem(draft, answer) {
	const note = String(answer.note ?? '').trim().slice(0, 2000);
	const marks = /** @type {{x: number, y: number, w: number, h: number}[]} */ ((answer.marks ?? []).map(normalizeMark).filter(Boolean).slice(0, MAX_MARKS));
	const perf = answer.perf !== false ? draft.perf : null;
	const reporter = get(problemReporter);
	if (answer.send && reporter) {
		const report = { note, marks, meta: await reportMeta(), perf, shot: draft.shot };
		problemDebug.lastReport = { note, marks, meta: report.meta, perf: !!perf, shot: !!draft.shot };
		let result;
		try {
			result = await reporter.submit(report);
		} catch (error) {
			result = { ok: false, error: /** @type {any} */ (error)?.message ?? String(error) };
		}
		if (result?.ok) {
			problemDebug.sent++;
			if (draft.shotUrl) URL.revokeObjectURL(draft.shotUrl);
			return { sent: true, saved: false, error: result.error };
		}
		return { sent: false, saved: false, error: result?.error ?? 'Could not send the report', reason: result?.reason };
	}
	// kept on this device: a Profiler recording carrying the picture and the note (+ the boxes)
	const boxes = marks.length ? '\n[marked: ' + marks.map((m) => `${Math.round(m.x * 100)},${Math.round(m.y * 100)} ${Math.round(m.w * 100)}x${Math.round(m.h * 100)}%`).join('; ') + ']' : '';
	if (draft.perf) {
		await finishMoment({ doc: draft.perf, shot: draft.shot, shotUrl: draft.shotUrl }, { note: 'Problem: ' + note + boxes, send: false });
	} else if (draft.shotUrl) URL.revokeObjectURL(draft.shotUrl);
	problemDebug.saved++;
	return { sent: false, saved: !!draft.perf };
}

/** The dialog's answer. null = cancel. @param {{note?: string, marks?: any[], perf?: boolean, send?: boolean} | null} answer */
export async function closeProblemReport(answer) {
	const draft = get(problemDraft);
	if (!draft) return null;
	if (!answer) {
		problemDraft.set(null);
		if (draft.shotUrl) URL.revokeObjectURL(draft.shotUrl);
		return null;
	}
	const result = await finishProblem(draft, answer);
	if (answer.send && !result.sent) {
		// the dialog stays open: the person can sign in and press Send again, or save instead
		showToast(result.error ?? 'Could not send the report');
		return result;
	}
	problemDraft.set(null);
	showToast(result.sent ? 'Thanks — your report reached the team' + (result.error ? ' (' + result.error + ')' : '') : result.saved ? 'Report saved on this device (Profiler ▸ recordings)' : 'Report discarded — nothing to keep');
	return result;
}

/**
 * VR: capture at the press, then the VR keyboard asks what is wrong. There is no yes/no panel
 * in a headset, so the CONSENT is the keyboard's own title: when the report can be sent, it
 * says "Enter sends it to the team (picture, note, frame data)", and Enter is the explicit
 * act; Cancel discards. When it cannot be sent (no plugin, not signed in) the title says it is
 * kept on this device. No boxes (no pointer-drawn rectangle on a headset panel): the note says
 * where. `keyboard` is vrKeyboard's `openVRKeyboard`, handed in so this module does not import
 * the VR family.
 * @param {(opts: {title?: string, initial?: string, onCommit: (text: string) => void, onCancel?: () => void}) => void} [keyboard]
 */
export async function vrReportProblem(keyboard) {
	const draft = await captureProblem();
	problemDebug.opened++;
	const send = !!reporterAccount()?.signedIn;
	const title = send
		? 'What is wrong, and where? Enter SENDS it to the team (picture, note, frame data)'
		: 'What is wrong, and where? (kept on this device — sign in to send)';
	const note = await new Promise((resolve) => {
		if (!keyboard) return resolve('');
		keyboard({ title, initial: '', onCommit: (t) => resolve(t), onCancel: () => resolve(null) });
	});
	if (note === null) {
		if (draft.shotUrl) URL.revokeObjectURL(draft.shotUrl);
		return null;
	}
	const result = await finishProblem(draft, { note: String(note), marks: [], send });
	showToast(result.sent ? 'Report sent — thank you' : result.error ? 'Not sent: ' + result.error : 'Report saved on this device');
	return result;
}
