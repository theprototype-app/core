// 34 PF (profiler-xr) — THE SOURCE HALF: this device's frames, streamed to the peers that asked.
//
// Any peer can be watched; the case it exists for is a HEADSET watched from a DESKTOP in the
// same room (the Quest has no devtools and no room for a profiler panel in front of your eyes).
//
//   - a peer sends `watch {mode}`: it gets `hello` (who we are: T1 meta, the recording state),
//     the last LIVE_BACKFILL_MS of the light ring (its graph starts full), then a `frames`
//     batch every LIVE_BATCH_MS for as long as it watches;
//   - `detailed` mode: if nothing is recording here, a DETAILED recording starts (it costs frame
//     time, which is why it is on request; it stops itself after 10 s and is saved HERE too),
//     its CPU phases ride the batches (`c`) and every capture it takes is sent as `capture`;
//   - `detail` = one capture now (into the running detailed recording, else a one-shot probe
//     capture that records nothing — a light recording keeps running untouched).
//
// The hot path is the recorder's live tap: one call per frame writing numbers into typed columns
// here; batches are built 2x a second. Sends are DIRECT down each watcher's own connection; a
// watcher that left the room is skipped (not dropped — it may come back), one whose connection
// closed is dropped. Starting or stopping a recording tells the whole mesh once (`state`) so a
// desktop can offer "Watch" without polling.
import { get } from 'svelte/store';
import { peers } from '../../stores/appStore';
import { sameRoomOrUnknown } from '../peerScenes';
import { registerPerfContext } from './perfMarks.js';
import { setLiveTap, onPerfEvent, onPerfCapture, currentMeta, ringClock, ringNow, lightWindow, recordingInfo, perfState, startRecording, captureOnce } from './recorder.js';
import { LIVE_BATCH_MS, LIVE_BACKFILL_MS, MAX_BATCH_FRAMES, MAX_BATCH_EVENTS, CPU_COLS, packFrames, trimCapture } from './liveWire.js';

/** frames held between two batches (a hidden tab's backlog past this is dropped and counted) */
const CAP = 2048;

/** @type {Map<string, {mode: 'light' | 'detailed', since: number}>} peerId -> what it asked for */
const watchers = new Map();

// ---- the tap's columns (preallocated; the tap allocates nothing)
const colT = new Float64Array(CAP);
const colMs = new Float32Array(CAP);
const colCalls = new Float64Array(CAP);
const colTris = new Float64Array(CAP);
const colQ = new Float32Array(CAP);
const colCpu = new Float32Array(CAP * CPU_COLS);
const colHasCpu = new Uint8Array(CAP);
let held = 0;
let dropped = 0;
/** @type {import('./tpprof.js').TpEvent[]} */
let pendingEvents = [];
let seq = 0;
/** @type {any} */
let timer = null;
/** @type {(() => void)[]} */
let offs = [];

const stats = { batches: 0, frames: 0, bytes: 0, captures: 0 };

/** @type {import('./recorder.js').LiveTap} */
function tap(t, ms, calls, tris, quality, cpu) {
	if (held >= CAP) {
		dropped++;
		return;
	}
	const i = held++;
	colT[i] = t;
	colMs[i] = ms;
	colCalls[i] = calls;
	colTris[i] = tris;
	colQ[i] = quality;
	if (cpu) {
		colHasCpu[i] = 1;
		for (let p = 0; p < CPU_COLS; p++) colCpu[i * CPU_COLS + p] = cpu[p] || 0;
	} else colHasCpu[i] = 0;
}

/** @param {string} peerId @param {any} payload @returns {boolean} false = that connection is gone */
function sendTo(peerId, payload) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn) return false;
	if (!conn.open) return true; // opening, or a blip: keep the watcher, skip this batch
	try {
		conn.send(payload);
		return true;
	} catch {
		return false;
	}
}

function recState() {
	const r = recordingInfo();
	return r ? { id: r.id, mode: r.mode, startedAt: r.startedAt, frames: r.frames } : null;
}

/** one batch to every watcher */
function flush() {
	const n = Math.min(held, MAX_BATCH_FRAMES);
	const skipped = held - n;
	/** @type {{t: number, ms: number, calls: number, tris: number, quality: number, cpu: number[] | null}[]} */
	const frames = new Array(n);
	let anyCpu = false;
	for (let k = 0; k < n; k++) {
		const i = skipped + k;
		/** @type {number[] | null} */
		let cpu = null;
		if (colHasCpu[i]) {
			anyCpu = true;
			cpu = Array.from(colCpu.subarray(i * CPU_COLS, i * CPU_COLS + CPU_COLS));
		}
		frames[k] = { t: colT[i], ms: colMs[i], calls: colCalls[i], tris: colTris[i], quality: colQ[i], cpu };
	}
	const lost = dropped + skipped;
	held = 0;
	dropped = 0;
	const events = pendingEvents.length > MAX_BATCH_EVENTS ? pendingEvents.slice(-MAX_BATCH_EVENTS) : pendingEvents;
	pendingEvents = [];
	if (!n && !events.length) return;
	const base = ringClock().epoch0;
	const rec = recState();
	seq++;
	const light = packFrames(frames, false);
	const full = anyCpu ? packFrames(frames, true) : light;
	for (const [peerId, w] of watchers) {
		if (!sameRoomOrUnknown(peerId)) continue;
		const b = w.mode === 'detailed' ? full : light;
		/** @type {any} */
		const msg = { type: 'perflive', op: 'frames', seq, base, ...b, rec };
		if (events.length) msg.ev = events;
		if (lost) msg.drop = lost;
		if (!sendTo(peerId, msg)) {
			watchers.delete(peerId);
			continue;
		}
		stats.batches++;
		stats.frames += n;
	}
	if (!watchers.size) stop();
}

function start() {
	if (timer) return;
	held = 0;
	dropped = 0;
	pendingEvents = [];
	setLiveTap(tap);
	offs.push(onPerfEvent((ev) => pendingEvents.push(ev)));
	offs.push(
		onPerfCapture((cap) => {
			const msg = { type: 'perflive', op: 'capture', base: ringClock().epoch0, t: Math.round(ringNow() * 10) / 10, cap: trimCapture(cap) };
			for (const [peerId, w] of watchers) {
				if (w.mode !== 'detailed' || !sameRoomOrUnknown(peerId)) continue;
				if (sendTo(peerId, msg)) stats.captures++;
			}
		})
	);
	timer = setInterval(flush, LIVE_BATCH_MS);
}

function stop() {
	clearInterval(timer);
	timer = null;
	setLiveTap(null);
	for (const off of offs) off();
	offs = [];
	held = 0;
}

/** @param {string} peerId @param {'light' | 'detailed'} mode */
function watch(peerId, mode) {
	if (!sameRoomOrUnknown(peerId)) return; // the stream is for the room you are in
	const fresh = !watchers.has(peerId);
	watchers.set(peerId, { mode, since: Date.now() });
	start();
	if (fresh) {
		const { epoch0 } = ringClock();
		const meta = currentMeta('light', epoch0);
		sendTo(peerId, { type: 'perflive', op: 'hello', base: epoch0, meta, rec: recState() });
		// the backfill: the light ring's last seconds, in RING time (t + base = wall time)
		const win = lightWindow(LIVE_BACKFILL_MS);
		const shift = win.meta.startedAt - epoch0;
		const frames = win.frames.slice(-MAX_BATCH_FRAMES).map((f) => ({ ...f, t: f.t + shift }));
		if (frames.length) {
			const ev = win.events.slice(-MAX_BATCH_EVENTS).map((e) => ({ ...e, t: Math.round((e.t + shift) * 10) / 10 }));
			sendTo(peerId, { type: 'perflive', op: 'frames', seq: 0, base: epoch0, backfill: true, ...packFrames(frames), ev, rec: recState() });
		}
	}
	// detailed on request: a detailed recording here (unless one of any kind already runs)
	if (mode === 'detailed' && !recordingInfo()) startRecording({ mode: 'detailed', name: 'Detailed (requested by a peer)' });
}

/** @param {string} peerId */
function unwatch(peerId) {
	watchers.delete(peerId);
	if (!watchers.size) stop();
}

/** a peer asked for one capture now @param {string} peerId @param {number} frames */
async function detail(peerId, frames) {
	if (!watchers.has(peerId) || !sameRoomOrUnknown(peerId)) return;
	const w = /** @type {{mode: 'light' | 'detailed', since: number}} */ (watchers.get(peerId));
	const wasLight = w.mode === 'light';
	// a light watcher asking for a capture gets this one (the capture observer only feeds
	// detailed watchers, so send it directly)
	const cap = await captureOnce(Math.max(1, Math.min(10, frames || 3)));
	if (!cap) {
		sendTo(peerId, { type: 'perflive', op: 'nocapture' });
		return;
	}
	if (wasLight) sendTo(peerId, { type: 'perflive', op: 'capture', base: ringClock().epoch0, t: Math.round(ringNow() * 10) / 10, cap: trimCapture(cap) });
}

/** the source half of the router: requests addressed to us as a source @param {string} peerId @param {any} data */
export function sourceMessage(peerId, data) {
	if (data.op === 'watch') watch(peerId, data.mode === 'detailed' ? 'detailed' : 'light');
	else if (data.op === 'unwatch') unwatch(peerId);
	else if (data.op === 'detail') void detail(peerId, Number(data.frames) || 3);
}

/** @param {string} peerId */
export function sourcePeerGone(peerId) {
	unwatch(peerId);
}

let booted = false;
/** Boot: answer watch requests, tell the mesh when a recording starts/stops, feed the REC pill. */
export function startLiveSource() {
	if (booted) return;
	booted = true;
	registerPerfContext('perfLive', () => (watchers.size ? { watchers: watchers.size } : null));
	let lastRec = /** @type {string | null} */ (null);
	perfState.subscribe((s) => {
		const id = s.recording?.id ?? null;
		if (id === lastRec) return;
		lastRec = id;
		/** @type {any} */
		const peer = get(peers);
		try {
			peer?.broadcast?.({ type: 'perflive', op: 'state', rec: recState() });
		} catch {
			/* not connected yet */
		}
	});
}

/** suites: who is watching, and what went out */
export function liveSourceDebug() {
	return { watchers: [...watchers].map(([id, w]) => ({ id, mode: w.mode })), running: !!timer, ...stats };
}
