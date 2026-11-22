// uir-people (People & session, owner 2026-11-09) — the OPTIONAL presence field: Available / Busy / Away.
//
// WHERE IT TRAVELS: on the roster row we already send (`userdata`, slot 6 — the `{kind}` object 55 A7 added),
// as `{kind, presence, presenceAt}`. No new message type and no server state: the roster is already sent on
// every join, relayed to a late joiner by the host, and re-sent by its owner on every change. An older peer's
// applier keeps `{kind}` only, so it simply never shows a status (the "older peers ignore it" rule).
//
// WHO WRITES IT: the row's OWNER, nobody else. The value is latest-wins on the owner's own stamp
// (`presenceAt`), so a host relaying a stale roster cannot put an old status back, and our own row is never
// taken from a remote roster at all (we are the authority on ourselves).
//
// OFF BY DEFAULT (`presenceEnabled`, this device): off sends `presence: ''` with a fresh stamp, which CLEARS
// the status on every peer — turning it off must not leave "Busy" standing on other screens.
import { get, writable } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { peers, userdata } from '../stores/appStore.js';
import { peerQuality } from './networkQuality';

/** @typedef {'available' | 'busy' | 'away'} Presence */
/** @type {Presence[]} */
export const PRESENCE = ['available', 'busy', 'away'];
/** @type {Record<Presence, string>} */
export const PRESENCE_LABEL = { available: 'Available', busy: 'Busy', away: 'Away' };
/** a SHAPE per status as well as a colour (53 A2: never colour alone) — Lucide names */
/** @type {Record<Presence, string>} */
export const PRESENCE_ICON = { available: 'circle-check', busy: 'circle-minus', away: 'clock' };

const KEY_ON = 'people:presence';
const KEY_VALUE = 'people:presenceValue';

/** @param {any} v @returns {v is Presence} */
export const isPresence = (v) => PRESENCE.includes(v);

function readOn() {
	try {
		return safeStorage.getItem(KEY_ON) === '1';
	} catch {
		return false;
	}
}
function readValue() {
	try {
		const v = safeStorage.getItem(KEY_VALUE);
		return isPresence(v) ? v : 'available';
	} catch {
		return 'available';
	}
}

/** Settings ▸ Interface ▸ Show my status (this device, default off) */
export const presenceEnabled = writable(readOn());
/** what we say when it is on */
export const myPresence = writable(/** @type {Presence} */ (readValue()));

/**
 * The status a roster row carries, '' when none (off, an older peer, or garbage).
 * @param {any} row a `userdata` row
 * @returns {Presence | ''}
 */
export function presenceOf(row) {
	const meta = Array.isArray(row) ? row[6] : null;
	return meta && typeof meta === 'object' && isPresence(meta.presence) ? meta.presence : '';
}

/**
 * The roster applier's slot-6 merge. `kind` keeps 55 A7's rule (agent or person); the presence pair is
 * latest-wins on the owner's stamp. Pure: returns the new slot, never mutates.
 * @param {any} local the slot we hold (may be absent)
 * @param {any} incoming the slot that arrived
 * @param {{ self?: boolean }} [opts] self = this row is OURS: keep our own presence whatever arrives
 */
export function mergeRowMeta(local, incoming, opts = {}) {
	const base = local && typeof local === 'object' ? local : {};
	/** @type {any} */
	const out = { kind: (incoming ? incoming.kind : base.kind) === 'agent' ? 'agent' : 'person' };
	const lp = isPresence(base.presence) || base.presence === '' ? base.presence : undefined;
	const lAt = Number(base.presenceAt) || 0;
	let p = lp;
	let at = lAt;
	if (!opts.self && incoming && typeof incoming === 'object' && Number.isFinite(Number(incoming.presenceAt))) {
		const iAt = Number(incoming.presenceAt);
		const ip = isPresence(incoming.presence) ? incoming.presence : '';
		if (iAt > lAt) {
			p = ip;
			at = iAt;
		}
	}
	if (p !== undefined) {
		out.presence = p;
		out.presenceAt = at;
	}
	return out;
}

/** a monotonic stamp per tab, so two changes inside one millisecond still order */
let lastStamp = 0;
function stamp() {
	lastStamp = Math.max(Date.now(), lastStamp + 1);
	return lastStamp;
}

/**
 * Write OUR row's slot 6 from the two settings and send the roster. Called on every change and once per
 * fresh connection (peerHandler's handshake sends the roster too, carrying whatever this wrote).
 * @param {{ send?: boolean }} [opts]
 */
export function publishPresence(opts = {}) {
	const p = /** @type {any} */ (get(peers));
	const me = p?.peer?.id;
	if (!me) return;
	const rows = /** @type {any[]} */ (get(userdata)) ?? [];
	const row = rows.find((r) => Array.isArray(r) && r[0] === me);
	if (!row) return;
	while (row.length < 6) row.push(row.length >= 3 ? null : '');
	const prev = row[6] && typeof row[6] === 'object' ? row[6] : {};
	const value = get(presenceEnabled) ? get(myPresence) : '';
	if ((prev.presence ?? '') === value && prev.presenceAt) return; // nothing new to say
	row[6] = { ...prev, kind: prev.kind === 'agent' ? 'agent' : 'person', presence: value, presenceAt: stamp() };
	userdata.set(/** @type {any} */ (rows));
	if (opts.send !== false) p?.send?.({ type: 'userdata', userdata: rows });
}

/** @param {boolean} on */
export function setPresenceEnabled(on) {
	presenceEnabled.set(!!on);
	try {
		safeStorage.setItem(KEY_ON, on ? '1' : '0');
	} catch {}
	publishPresence();
}

/** @param {Presence} v */
export function setMyPresence(v) {
	if (!isPresence(v)) return;
	myPresence.set(v);
	try {
		safeStorage.setItem(KEY_VALUE, v);
	} catch {}
	publishPresence();
}

// --- the Person card's connection graph: the last minute of round-trip samples per peer -----------------
// peerQuality is a live value only; the card wants a SHAPE (steady, or spiking?). Recorded here, beside
// the store it reads, so the graph is already full when the card opens. Local, never sent.
const PING_SAMPLES = 60;
/** @type {Record<string, number[]>} */
const pingLog = {};
/** @type {Record<string, any>} */
let lastSeen = {};
peerQuality.subscribe((/** @type {Record<string, any>} */ map) => {
	for (const [id, q] of Object.entries(map ?? {})) {
		if (!q || q.rtt == null || lastSeen[id] === q) continue;
		const log = (pingLog[id] ??= []);
		log.push(Math.round(q.rtt));
		if (log.length > PING_SAMPLES) log.splice(0, log.length - PING_SAMPLES);
	}
	for (const id of Object.keys(pingLog)) if (!(id in (map ?? {}))) delete pingLog[id];
	lastSeen = { ...(map ?? {}) };
});

/** @param {string} peerId @returns {number[]} oldest first, up to the last minute */
export function pingHistory(peerId) {
	return [...(pingLog[peerId] ?? [])];
}

/**
 * An SVG polyline for a sparkline box (pure, so it is unit-tested). Flat when there is one sample.
 * @param {number[]} samples @param {number} w @param {number} h
 */
export function sparkPoints(samples, w, h) {
	if (!samples.length) return '';
	const max = Math.max(...samples, 1);
	const min = Math.min(...samples, 0);
	const span = Math.max(1, max - min);
	const step = samples.length > 1 ? w / (samples.length - 1) : 0;
	return samples
		.map((v, i) => `${Math.round(i * step * 10) / 10},${Math.round((h - 2 - ((v - min) / span) * (h - 4)) * 10) / 10}`)
		.join(' ');
}
