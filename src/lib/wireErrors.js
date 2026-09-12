import { writable, get } from 'svelte/store';
import { log, registerDiagnosticsSection } from './diagnostics';
import { showToast } from '../stores/appStore';

// 27-A (hardening audit H1) — WHEN A PEER'S MESSAGES FAIL, SOMEBODY SHOULD KNOW.
//
// Before this, a malformed or unknown message threw out of `conn.on('data')` into peerjs,
// where nothing caught it and nothing counted it. Two peers on different releases could
// spend a whole session failing to exchange one domain, and the only symptom was a
// feature that "did not work" for one of them.
//
// A SEPARATE LEAF from diagnostics.js on purpose: that module is deliberately
// zero-dependency (version.js and svelte/store only) so ANY module can log without
// thinking about cycles, and it must not grow an import of appStore for a toast. This
// file is the consumer — it uses diagnostics' own registration seam to contribute a
// section, which is exactly what that seam exists for.
//
// THE RATE LIMIT IS THE POINT. A peer sending a bad message per frame would otherwise
// produce a toast per frame; the counters stay exact while the user is told once.

/** How many failures from one (peer, type) pair before the user is told. */
const TOAST_AFTER = 5;
/** …and how long before that pair may raise another toast. */
const TOAST_COOLDOWN_MS = 60_000;

/** @typedef {{count: number, first: number, last: number, sample: string}} WireFailure */

/** @type {Map<string, WireFailure>} keyed `<peerId>|<type>` */
const failures = new Map();
/** @type {Map<string, number>} last toast per peer, so one bad peer cannot spam */
const lastToastAt = new Map();

/** Bumped on every recorded failure, so a panel can react without reading the map. */
export const wireErrorCount = writable(0);

/** @param {string} peerId */
const shortId = (peerId) => String(peerId || '?').slice(0, 6).toUpperCase();

/**
 * Record one failed message.
 * @param {string} peerId
 * @param {string} type the message type, or a pseudo-type: 'shape' (not an object),
 *   'invalid' (failed its validator), 'unknown:<t>' (no branch), 'threw' (applier threw)
 * @param {unknown} [error]
 */
export function noteWireError(peerId, type, error) {
	const key = peerId + '|' + type;
	const now = Date.now();
	const entry = failures.get(key) ?? { count: 0, first: now, last: now, sample: '' };
	entry.count++;
	entry.last = now;
	if (error !== undefined && !entry.sample) entry.sample = String(error).slice(0, 200);
	failures.set(key, entry);
	wireErrorCount.update((n) => n + 1);

	// The first three carry the detail; after that the counter is the record.
	if (entry.count <= 3)
		log('warn', 'wire', 'message from ' + shortId(peerId) + ' failed (' + type + ')', entry.sample || undefined);

	if (entry.count === TOAST_AFTER) {
		const since = lastToastAt.get(peerId) ?? 0;
		if (now - since > TOAST_COOLDOWN_MS) {
			lastToastAt.set(peerId, now);
			showToast(
				'Messages from ' + shortId(peerId) + ' are failing (' + type + ') - you may be on different versions.'
			);
		}
	}
}

/** Everything recorded, newest-first. Read by the diagnostics bundle and by tests. */
export function wireErrors() {
	return [...failures.entries()]
		.map(([key, v]) => {
			const [peerId, type] = key.split('|');
			return { peerId, type, ...v };
		})
		.sort((a, b) => b.last - a.last);
}

/** Total failures recorded (tests read this rather than the store). */
export function wireErrorTotal() {
	return get(wireErrorCount);
}

/** Drop a departed peer's rows — golden rule 3's cleanup obligation. @param {string} peerId */
export function dropWireErrors(peerId) {
	for (const key of [...failures.keys()]) if (key.startsWith(peerId + '|')) failures.delete(key);
	lastToastAt.delete(peerId);
}

/** Tests, and a fresh session. */
export function clearWireErrors() {
	failures.clear();
	lastToastAt.clear();
	wireErrorCount.set(0);
}

let registered = false;
/** Contribute the counters to the diagnostics bundle (idempotent). */
export function startWireErrors() {
	if (registered) return;
	registered = true;
	registerDiagnosticsSection('wire', () => ({ total: get(wireErrorCount), failures: wireErrors().slice(0, 20) }));
}
