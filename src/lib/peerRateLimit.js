// 71 TR7 — PER-PEER EDIT AND CHAT RATE LIMITS, the pure half (a token bucket per peer per kind). A peer that
// floods a session with new objects or chat is dropped on every receiver before anything is applied.
//
// WHAT COUNTS: discrete things a person does. NOT the streams (a pose, a drag, a live stroke: they replace
// themselves, so a flood harms nothing and limiting them only stutters), and NOT full state (`object`,
// `objectfile`, `nodes` and the other replies: a join legitimately pours thousands of them at once).
// `normal` sits far above what people and agents do: 600 at once covers a pasted scene or a big agent batch.

/** @typedef {{burst: number, perSec: number}} Bucket */
/** @type {Record<string, {edit: Bucket, chat: Bucket} | null>} */
export const RATE_PRESETS = {
	off: null,
	normal: { edit: { burst: 600, perSec: 120 }, chat: { burst: 12, perSec: 1 } },
	strict: { edit: { burst: 120, perSec: 20 }, chat: { burst: 4, perSec: 1 / 3 } }
};
export const DEFAULT_RATE_PRESET = 'normal';

const EDIT_TYPES = new Set([
	'create', 'light', 'group', 'duplicate', 'delete', 'clearscene', 'name', 'color', 'geometry', 'meshgeo',
	'nodecreate', 'nodedelete', 'edgecreate', 'edgedelete', 'graphcreate', 'graphdelete',
	'jointcreate', 'jointdelete', 'annotation', 'map', 'materials'
]);

/** @param {any} type @returns {'edit'|'chat'|null} */
export function rateKind(type) {
	if (type === 'sent') return 'chat';
	return EDIT_TYPES.has(type) ? 'edit' : null;
}

/** @param {() => number} [now] */
export function createRateLimiter(now = Date.now) {
	/** @type {Map<string, Record<string, {tokens: number, at: number}>>} */
	const peers = new Map();
	return {
		/**
		 * May this message through? Spends one token when it may.
		 * @param {string} peerId @param {any} type @param {string} preset
		 * @returns {'ok'|'edit'|'chat'} 'ok', or the kind that ran out
		 */
		take(peerId, type, preset) {
			const limits = RATE_PRESETS[preset];
			const kind = limits ? rateKind(type) : null;
			if (!limits || !kind) return 'ok';
			const { burst, perSec } = limits[kind];
			let row = peers.get(peerId);
			if (!row) {
				// a peer id is whatever a dialler says: forget the oldest rather than grow without bound
				if (peers.size >= 512) peers.delete(/** @type {string} */ (peers.keys().next().value));
				row = {};
				peers.set(peerId, row);
			}
			const t = now();
			const b = row[kind] ?? (row[kind] = { tokens: burst, at: t });
			b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec);
			b.at = t;
			if (b.tokens < 1) return kind;
			b.tokens -= 1;
			return 'ok';
		}
	};
}
