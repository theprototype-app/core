// 36 B14 — the PURE half of checkpoints.js: which rows a full timeline evicts, the content
// fingerprint that keeps an untouched scene from cutting automatic rows, and the two labels the
// timeline draws. Imports nothing, so the rules are unit-tested with no idb and no scene.

/**
 * WHICH ROWS GO when a new one arrives. PURE (unit-tested): `rows` already holds the newcomer,
 * `keepId` is the newcomer and is never a candidate. Candidates are the unpinned rows, AUTO
 * before NAMED, oldest first within each; they leave one at a time until both limits hold.
 * `fits` is false when even that is not enough — the caller refuses the save.
 * @param {{id: string, bytes: number, createdAt: number, pinned: boolean, auto: boolean}[]} rows
 * @param {number} capBytes @param {number} maxCount @param {string | null} keepId
 * @returns {{evict: string[], fits: boolean}}
 */
export function planEviction(rows, capBytes, maxCount, keepId) {
	let total = rows.reduce((n, r) => n + (r.bytes || 0), 0);
	let count = rows.length;
	const candidates = rows
		.filter((r) => !r.pinned && r.id !== keepId)
		.sort((a, b) => Number(b.auto) - Number(a.auto) || a.createdAt - b.createdAt);
	/** @type {string[]} */
	const evict = [];
	for (const r of candidates) {
		if (total <= capBytes && count <= maxCount) break;
		evict.push(r.id);
		total -= r.bytes || 0;
		count--;
	}
	return { evict, fits: total <= capBytes && count <= maxCount };
}

/**
 * A short, stable fingerprint of a scene's CONTENT (levels.sceneSignature, which already knows
 * which fields are bookkeeping and which are content). FNV-1a 32 over the string, twice with two
 * seeds — the rows only ever compare it for equality with the newest row.
 * @param {string} text @returns {string}
 */
export function fingerprint(text) {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ text.length;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x5bd1e995);
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** "today" / "yesterday" / a date, for the timeline's day groups @param {number} ts @param {number} [now] */
export function dayLabel(ts, now = Date.now()) {
	const d = new Date(ts);
	const n = new Date(now);
	const start = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const days = Math.round((start(n) - start(d)) / 86_400_000);
	if (days === 0) return 'Today';
	if (days === 1) return 'Yesterday';
	return d.toLocaleDateString(undefined, { weekday: days < 7 ? 'long' : undefined, day: 'numeric', month: 'short', year: d.getFullYear() === n.getFullYear() ? undefined : 'numeric' });
}

/** @param {number} bytes */
export function formatBytes(bytes) {
	if (!(bytes > 0)) return '0 KB';
	if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
	return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}
