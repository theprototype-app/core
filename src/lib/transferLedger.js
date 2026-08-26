// R22-R8 — THE TRANSFER LEDGER: what is moving, how far along, and what went wrong.
//
// WHY IT EXISTS. Auto-download (R8, on by default) makes files start arriving without
// anybody asking for them, and until now a transfer was completely unobservable: no
// per-transfer record, no byte counters, no error surface, and `requestAsset` was
// fire-and-forget behind a one-ask-per-session guard. Silence was tolerable while every
// download was a deliberate right-click. It is not tolerable once the app fetches on its
// own — a slow peer and a broken one look identical.
//
// A DELIBERATE LEAF: svelte stores and arithmetic, nothing else. The protocol lives in
// `assetShare.js`, which owns the channel; this owns the record and the numbers, so the
// aggregate maths is testable with no peer, no browser and no bytes (the throwVelocity /
// colliderSpec shape).
//
// LOCAL, always. A transfer is a fact about THIS machine's connection to another one:
// two peers pulling the same file have two different transfers, and neither is project
// data. Nothing here replicates, persists or undoes.
//
// THE ROW is keyed by `id` rather than by hash, because the same hash can legitimately be
// in flight twice in one session (a pull that failed and was retried, an outgoing push to
// one peer while an incoming pull from another is running). `hash` stays on the row for
// the Explorer to match a card against.

import { writable, derived, get } from 'svelte/store';

/**
 * @typedef {{
 *   id: string,
 *   hash: string,
 *   name: string,
 *   dir: 'in' | 'out',
 *   size: number,
 *   done: number,
 *   state: 'queued' | 'active' | 'done' | 'failed',
 *   peer: string,
 *   at: number,
 *   endedAt?: number,
 *   error?: string,
 *   batch: number
 * }} Transfer
 */

/** how many finished rows to keep. The log is a debugging surface, not an archive, and
 * an unbounded array behind a 10Hz view is a slow leak nobody would look for. */
export const HISTORY_CAP = 200;

/** @type {import('svelte/store').Writable<Transfer[]>} */
export const transfers = writable([]);

let seq = 0;

/**
 * R22 round 6 — THE BATCH, and why the aggregate needs one.
 *
 * A "4 of 12 · 61%" is a claim about THIS piece of work. Counting every row the ledger
 * holds means the fiftieth download of a session reads 50/51 = 98% before it has
 * transferred a byte, and the bar effectively stops moving — the classic mistake in a
 * progress aggregate, and the reason every download manager scopes its summary.
 *
 * A batch opens when work starts and NOTHING is already in flight, and it simply ends
 * when everything in it settles. That also answers "should it reset when I connect to a
 * new host?" — no reset is needed, because a new host's first download opens its own
 * batch. The LOG keeps everything; only the percentage is scoped.
 */
let batch = 0;

/**
 * Open a row. Returns its id — the caller keeps it and reports against it, which is what
 * makes two concurrent transfers of one hash distinguishable.
 * @param {{hash: string, name: string, dir: 'in'|'out', size?: number, peer?: string}} spec
 * @returns {string}
 */
export function beginTransfer(spec) {
	const id = 'tx' + ++seq;
	/** @type {Transfer} */
	const row = {
		id,
		hash: String(spec.hash ?? ''),
		name: String(spec.name ?? spec.hash ?? 'file'),
		dir: spec.dir === 'out' ? 'out' : 'in',
		// an unknown size is 0 and NOT a guess: the aggregate below falls back to counting
		// files when it cannot trust the bytes, which is honest about what it knows
		size: Math.max(0, Number(spec.size) || 0),
		done: 0,
		state: 'queued',
		peer: String(spec.peer ?? ''),
		at: Date.now(),
		batch: 0
	};
	transfers.update((list) => {
		// a new batch whenever work starts from rest
		if (!list.some((t) => t.state === 'queued' || t.state === 'active')) batch++;
		row.batch = batch;
		return trim([...list, row]);
	});
	return id;
}

/** @param {Transfer[]} list */
function trim(list) {
	const live = list.filter((t) => t.state === 'queued' || t.state === 'active');
	const past = list.filter((t) => t.state === 'done' || t.state === 'failed');
	return past.length > HISTORY_CAP ? [...live, ...past.slice(past.length - HISTORY_CAP)] : list;
}

/** @param {string} id @param {any} fields */
function patch(id, fields) {
	transfers.update((list) => {
		let touched = false;
		const next = list.map((t) => {
			if (t.id !== id) return t;
			touched = true;
			return { ...t, ...fields };
		});
		return touched ? trim(next) : list;
	});
}

/** The transfer has started moving bytes. @param {string} id @param {number} [size] */
export function activateTransfer(id, size) {
	/** @type {any} */
	const p = { state: 'active' };
	if (Number(size) > 0) p.size = Number(size);
	patch(id, p);
}

/** Report absolute progress — ABSOLUTE, not a delta, so a duplicate or out-of-order
 * report cannot inflate it. @param {string} id @param {number} done @param {number} [size] */
export function progressTransfer(id, done, size) {
	/** @type {any} */
	const p = { state: 'active', done: Math.max(0, Number(done) || 0) };
	if (Number(size) > 0) p.size = Number(size);
	patch(id, p);
}

/** @param {string} id */
export function finishTransfer(id) {
	const row = get(transfers).find((t) => t.id === id);
	patch(id, { state: 'done', done: row?.size || row?.done || 0, endedAt: Date.now() });
}

/** @param {string} id @param {string} error */
export function failTransfer(id, error) {
	patch(id, { state: 'failed', error: String(error ?? 'failed'), endedAt: Date.now() });
}

/** Find the live row for a hash and direction, if any.
 * @param {string} hash @param {'in'|'out'} dir @returns {Transfer|null} */
export function liveTransferFor(hash, dir) {
	return (
		get(transfers).find(
			(t) => t.hash === hash && t.dir === dir && (t.state === 'queued' || t.state === 'active')
		) ?? null
	);
}

/** Drop finished rows — the Logs pane's Clear. */
export function clearFinished() {
	transfers.update((list) => list.filter((t) => t.state === 'queued' || t.state === 'active'));
}

/**
 * THE AGGREGATE the popover shows. Two numbers and they are not the same claim:
 *
 *   `pct` is a BYTE percentage when every live transfer knows its size, and a FILE
 *   percentage when any of them does not. Mixing the two silently is how a progress bar
 *   ends up going backwards — a file whose size arrives late would jump the denominator
 *   — so `byBytes` says which one you are reading.
 *
 * Derived rather than computed on demand so the popover and the pane cannot disagree.
 * @type {import('svelte/store').Readable<{active: number, left: number,
 *   doneInBatch: number, inBatch: number, total: number, pct: number, byBytes: boolean,
 *   failed: number, retryable: number, dir: 'in'|'out'|'both'|null}>}
 */
export const transferSummary = derived(transfers, ($t) => {
	const live = $t.filter((x) => x.state === 'queued' || x.state === 'active');
	const failed = $t.filter((x) => x.state === 'failed');
	// SCOPED TO THE CURRENT BATCH — see the `batch` comment above. When nothing is live
	// the batch is whatever finished last, so a just-completed run still reads 100%
	// rather than snapping back to zero.
	const current = live.length ? Math.max(...live.map((x) => x.batch)) : batch;
	const mine = $t.filter((x) => x.batch === current && x.state !== 'failed');
	const byBytes = mine.length > 0 && mine.every((x) => x.size > 0);
	const total = byBytes ? mine.reduce((n, x) => n + x.size, 0) : mine.length;
	const done = byBytes
		? mine.reduce((n, x) => n + Math.min(x.done, x.size), 0)
		: mine.filter((x) => x.state === 'done').length;
	const ins = live.filter((x) => x.dir === 'in').length;
	const outs = live.length - ins;
	/** @type {'in'|'out'|'both'|null} */
	const dir = !live.length ? null : ins && outs ? 'both' : ins ? 'in' : 'out';
	return {
		active: live.filter((x) => x.state === 'active').length,
		left: live.length,
		doneInBatch: mine.filter((x) => x.state === 'done').length,
		inBatch: mine.length,
		total,
		pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0,
		byBytes,
		failed: failed.length,
		retryable: failed.filter((x) => x.dir === 'in').length,
		dir
	};
});

/**
 * R22 round 6 — THE INDICATOR'S STATE, in one place so the pill, its colour and its
 * label cannot disagree. The four are the sync-indicator convention (Dropbox, Drive,
 * every git client): OFFLINE, WORKING, PROBLEM, IDLE.
 *
 * `offline` is not an error and must not look like one — nothing is wrong with a solo
 * project, so it is the quietest of the four.
 * @param {any} summary @param {boolean} connected
 * @returns {'offline'|'active'|'failed'|'idle'}
 */
export function indicatorState(summary, connected) {
	if (summary.left > 0) return 'active';
	if (summary.failed > 0) return 'failed';
	if (!connected) return 'offline';
	return 'idle';
}

/** Drop one row from the log. @param {string} id */
export function removeTransfer(id) {
	transfers.update((list) => list.filter((t) => t.id !== id));
}

/** Every row in the batch the summary is currently reporting on. @param {Transfer[]} list */
export function currentBatchRows(list) {
	const live = list.filter((x) => x.state === 'queued' || x.state === 'active');
	const current = live.length ? Math.max(...live.map((x) => x.batch)) : batch;
	return list.filter((x) => x.batch === current);
}
/** A percentage for ONE row. @param {Transfer} t @returns {number} */
export function transferPct(t) {
	if (!t) return 0;
	if (t.state === 'done') return 100;
	// an unknown size cannot be a percentage — the caller shows a spinner instead
	if (!t.size) return 0;
	return Math.min(100, Math.round((t.done / t.size) * 100));
}

/** Human bytes, matching the Explorer's own formatting. @param {number} n */
export function fmtBytes(n) {
	const b = Number(n) || 0;
	if (b < 1024) return b + ' B';
	if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
	return (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}
