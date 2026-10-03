// 34 PF (profiler-xr) — THE SINK HALF: watching another peer's frames live (a headset, from the
// desktop). Each watched peer becomes a T1 document growing as batches land — the same shape a
// local recording has, so the Profiler tab draws it with the same code and "Save" puts it in
// this device's recordings (`saveDocument`) like any other.
//
// Times: the source sends ring times plus its ring's wall-clock origin (`base`), so a frame's
// wall time is base + t. The document starts at the first frame it holds (meta.startedAt) and
// keeps T1's "ms since startedAt" — two peers' clocks never have to agree for that.
//
// What the UI reads is the `perfLive` store (~2 Hz, written per batch, never per frame); the
// documents themselves live in a Map beside it (`liveDoc(peerId)`), because a store holding a
// growing array of 10 000 frames would hand every subscriber the whole thing twice a second.
import { writable, get } from 'svelte/store';
import { peers, userdata } from '../../stores/appStore';
import { peerHands } from '../../stores/sceneStore';
import { sameRoomOrUnknown } from '../peerScenes';
import { TPPROF_VERSION } from './tpprof.js';
import { saveDocument, MAX_RECORD_FRAMES } from './recorder.js';
import { unpackFrames } from './liveWire.js';

/** the bandwidth figure is the bytes of the last BW_WINDOW_MS, JSON-measured */
const BW_WINDOW_MS = 10000;
/** the "latest" numbers average the last n frames */
const LATEST_FRAMES = 30;

/**
 * @typedef {{
 *   peerId: string, name: string, mode: 'light' | 'detailed', watching: boolean,
 *   xr: boolean, device: string, rec: null | {id: string, mode: string, startedAt: number, frames: number},
 *   frames: number, events: number, captures: number, dropped: number, lastAt: number,
 *   bytesPerSec: number, latest: null | {fps: number, ms: number, calls: number | null, tris: number | null, quality: number | null},
 *   lastCapture: null | {t: number, objects: number, top: {name: string, path: string, calls: number, tris: number}[]},
 *   cpu: null | Record<string, number>, ended: boolean, waiting: boolean
 * }} LiveSession
 */

/**
 * The live view's state: the sessions we watch and the peers that announced a recording.
 * @type {import('svelte/store').Writable<{sessions: Record<string, LiveSession>, recording: Record<string, any>}>}
 */
export const perfLive = writable({ sessions: {}, recording: {} });

/** the minimal desktop viewer (ProfilerLive.svelte) is open — until the Profiler tab hosts it */
export const profilerLiveOpen = writable(false);

/** @type {Map<string, import('./tpprof.js').Tpprof>} */
const docs = new Map();
/** a `hello`'s meta, held until the first frames make the document @type {Map<string, any>} */
const metas = new Map();
/** @type {Map<string, {at: number, bytes: number}[]>} */
const traffic = new Map();

/** a peer's display name (lockControl's rule, without its import family) @param {string} peerId */
function nameOf(peerId) {
	const row = (/** @type {any[]} */ (get(userdata)) ?? []).find((u) => u[0] === peerId);
	return (row && row[1]) || peerId;
}

/** @param {string} peerId @param {any} payload */
function sendTo(peerId, payload) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn?.open) return false;
	try {
		conn.send(payload);
		return true;
	} catch {
		return false;
	}
}

/** @param {string} peerId @param {(s: LiveSession) => void} edit */
function patch(peerId, edit) {
	perfLive.update((st) => {
		const s = st.sessions[peerId];
		if (!s) return st;
		const next = { ...s };
		edit(next);
		return { ...st, sessions: { ...st.sessions, [peerId]: next } };
	});
}

/**
 * Start watching a peer's frames (`light` by default; `detailed` asks it for a detailed
 * recording, CPU phases and captures — it costs THEM frame time).
 * @param {string} peerId @param {'light' | 'detailed'} [mode]
 */
export function watchPeer(peerId, mode = 'light') {
	const hands = /** @type {any} */ (get(peerHands))?.[peerId];
	perfLive.update((st) => {
		const prev = st.sessions[peerId];
		/** @type {LiveSession} */
		const s = {
			peerId,
			name: nameOf(peerId),
			mode,
			watching: true,
			xr: prev?.xr ?? !!hands?.active,
			device: prev?.device ?? '',
			rec: prev?.rec ?? st.recording[peerId] ?? null,
			frames: prev?.frames ?? 0,
			events: prev?.events ?? 0,
			captures: prev?.captures ?? 0,
			dropped: prev?.dropped ?? 0,
			lastAt: prev?.lastAt ?? 0,
			bytesPerSec: prev?.bytesPerSec ?? 0,
			latest: prev?.latest ?? null,
			lastCapture: prev?.lastCapture ?? null,
			cpu: prev?.cpu ?? null,
			ended: false,
			waiting: !prev
		};
		return { ...st, sessions: { ...st.sessions, [peerId]: s } };
	});
	if (!docs.has(peerId)) traffic.set(peerId, []);
	return sendTo(peerId, { type: 'perflive', op: 'watch', mode });
}

/** Stop watching (the document stays until `forgetPeer`, so it can still be saved). @param {string} peerId */
export function unwatchPeer(peerId) {
	sendTo(peerId, { type: 'perflive', op: 'unwatch' });
	patch(peerId, (s) => {
		s.watching = false;
	});
}

/** Ask for one detailed capture now. @param {string} peerId @param {number} [frames] */
export function requestCapture(peerId, frames = 3) {
	return sendTo(peerId, { type: 'perflive', op: 'detail', frames });
}

/** Drop a session and its document. @param {string} peerId */
export function forgetPeer(peerId) {
	if (get(perfLive).sessions[peerId]?.watching) unwatchPeer(peerId);
	docs.delete(peerId);
	metas.delete(peerId);
	traffic.delete(peerId);
	perfLive.update((st) => {
		const sessions = { ...st.sessions };
		delete sessions[peerId];
		return { ...st, sessions };
	});
}

/** The document being built from a peer's stream (live — do not mutate). @param {string} peerId */
export function liveDoc(peerId) {
	return docs.get(peerId) ?? null;
}

/**
 * Save what was streamed so far into this device's recordings.
 * @param {string} peerId @param {string} [name] @returns {Promise<string | null>} the new id
 */
export async function saveLive(peerId, name) {
	const doc = docs.get(peerId);
	if (!doc || !doc.frames.length) return null;
	const s = get(perfLive).sessions[peerId];
	const last = doc.frames[doc.frames.length - 1];
	const copy = structuredClone(doc);
	copy.meta.durationMs = Math.round(last.t);
	copy.meta.name = name || `Live · ${s?.name ?? peerId} · ${new Date(doc.meta.startedAt).toLocaleTimeString()}`;
	copy.meta.kind = 'live';
	if (!copy.captures?.length) delete copy.captures;
	return saveDocument(copy);
}

// ---------------------------------------------------------------- receiving

/** @param {string} peerId @param {any} data */
function account(peerId, data) {
	let bytes = 0;
	try {
		bytes = JSON.stringify(data).length;
	} catch {
		bytes = 0;
	}
	const now = Date.now();
	const list = traffic.get(peerId) ?? [];
	list.push({ at: now, bytes });
	while (list.length && list[0].at < now - BW_WINDOW_MS) list.shift();
	traffic.set(peerId, list);
	const span = Math.max(1000, Math.min(BW_WINDOW_MS, now - list[0].at + 500));
	return Math.round((list.reduce((a, x) => a + x.bytes, 0) * 1000) / span);
}

/** @param {string} peerId @param {any} meta @param {number} startedAt */
function newDoc(peerId, meta, startedAt) {
	/** @type {import('./tpprof.js').Tpprof} */
	const doc = {
		tpprof: TPPROF_VERSION,
		meta: { ...(meta ?? {}), startedAt: Math.round(startedAt), mode: get(perfLive).sessions[peerId]?.mode ?? 'light', live: { peerId } },
		frames: [],
		events: []
	};
	docs.set(peerId, doc);
	return doc;
}

/** @param {string} peerId @param {any} data */
function onHello(peerId, data) {
	const meta = data.meta ?? {};
	const doc = docs.get(peerId);
	if (doc) doc.meta = { ...doc.meta, ...meta, startedAt: doc.meta.startedAt, mode: doc.meta.mode, live: /** @type {any} */ (doc.meta).live };
	else metas.set(peerId, meta);
	patch(peerId, (s) => {
		s.xr = !!meta.xr;
		s.device = String(meta.device ?? '');
		s.rec = data.rec ?? null;
		s.waiting = false;
	});
}

/** @param {string} peerId @param {any} data */
function onFrames(peerId, data) {
	const frames = unpackFrames(data);
	const base = Number(data.base);
	let d = docs.get(peerId);
	if (!d) {
		if (!frames.length) return 0;
		d = newDoc(peerId, metas.get(peerId) ?? {}, base + frames[0].t);
		metas.delete(peerId);
	}
	const shift = base - d.meta.startedAt;
	const lastT = d.frames.length ? d.frames[d.frames.length - 1].t : -Infinity;
	let added = 0;
	for (const f of frames) {
		const t = Math.round((f.t + shift) * 10) / 10;
		if (t <= lastT) continue; // a backfill overlapping what already arrived
		if (d.frames.length >= MAX_RECORD_FRAMES) break;
		d.frames.push({ ...f, t });
		added++;
	}
	if (Array.isArray(data.ev)) {
		for (const e of data.ev) {
			if (!e || typeof e.kind !== 'string') continue;
			d.events.push({ t: Math.round((Number(e.t) + shift) * 10) / 10, kind: e.kind.slice(0, 40), detail: e.detail ?? null });
		}
	}
	const recent = d.frames.slice(-LATEST_FRAMES);
	const bps = account(peerId, data);
	patch(peerId, (s) => {
		s.frames = d.frames.length;
		s.events = d.events.length;
		s.dropped += Number(data.drop) || 0;
		s.lastAt = Date.now();
		s.rec = data.rec ?? null;
		s.bytesPerSec = bps;
		s.waiting = false;
		if (recent.length) {
			const ms = recent.reduce((a, f) => a + f.ms, 0) / recent.length;
			const last = recent[recent.length - 1];
			s.latest = { fps: Math.round(1000 / Math.max(0.1, ms)), ms: Math.round(ms * 10) / 10, calls: last.calls ?? null, tris: last.tris ?? null, quality: last.quality ?? null };
			const withCpu = recent.filter((f) => f.cpu);
			if (withCpu.length) {
				/** @type {Record<string, number>} */
				const sum = {};
				for (const f of withCpu) for (const [k, v] of Object.entries(/** @type {Record<string, number>} */ (f.cpu))) sum[k] = (sum[k] ?? 0) + v;
				for (const k of Object.keys(sum)) sum[k] = Math.round((sum[k] / withCpu.length) * 100) / 100;
				s.cpu = sum;
			}
		}
	});
	return added;
}

/** @param {string} peerId @param {any} data */
function onCapture(peerId, data) {
	const doc = docs.get(peerId);
	if (!doc) return;
	const cap = { ...data.cap, t: Math.round((Number(data.base) + Number(data.t) - doc.meta.startedAt) * 10) / 10 };
	(doc.captures ??= []).push(cap);
	account(peerId, data);
	patch(peerId, (s) => {
		s.captures = doc.captures?.length ?? 0;
		s.lastCapture = {
			t: cap.t,
			objects: cap.objects.length,
			top: cap.objects.slice(0, 8).map((/** @type {any} */ o) => ({ name: String(o.name ?? ''), path: String(o.path ?? ''), calls: Number(o.calls) || 0, tris: Number(o.tris) || 0 }))
		};
	});
}

/** the sink half of the router @param {string} peerId @param {any} data */
export function sinkMessage(peerId, data) {
	if (data.op === 'state') {
		// a peer's recording started or stopped: offer Watch (room rule as for the stream itself)
		if (!sameRoomOrUnknown(peerId)) return;
		perfLive.update((st) => {
			const recording = { ...st.recording };
			if (data.rec) recording[peerId] = data.rec;
			else delete recording[peerId];
			const s = st.sessions[peerId];
			const sessions = s ? { ...st.sessions, [peerId]: { ...s, rec: data.rec ?? null } } : st.sessions;
			return { sessions, recording };
		});
		return;
	}
	// everything else answers a watch we sent: ignore a peer we are not watching
	const s = get(perfLive).sessions[peerId];
	if (!s?.watching) return;
	if (data.op === 'hello') onHello(peerId, data);
	else if (data.op === 'frames') onFrames(peerId, data);
	else if (data.op === 'capture') onCapture(peerId, data);
}

/** @param {string} peerId */
export function sinkPeerGone(peerId) {
	perfLive.update((st) => {
		const recording = { ...st.recording };
		delete recording[peerId];
		const s = st.sessions[peerId];
		const sessions = s ? { ...st.sessions, [peerId]: { ...s, watching: false, ended: true } } : st.sessions;
		return { sessions, recording };
	});
}

/** suites */
export function liveSinkDebug() {
	return { docs: [...docs.keys()], frames: Object.fromEntries([...docs].map(([k, d]) => [k, d.frames.length])) };
}
