// 102b-hud (row 4): how the Game Value node writes a number as words. A LEAF, imports nothing.
//
// The official games each carried their own clock formatter (five of them) and an `info` node whose
// only job was "Coins 3 / 10", "Best 1:04.2", "★★☆". These are those shapes as settings:
//   number    3 · 3.5 (decimals)
//   time      1:04 · 1:04.2 (decimals 1) · 1:02:03 past an hour
//   fraction  3 / 10 (needs a max)
//   percent   30 % of max (or of 1 when no max is given: 0.3 -> 30 %)
//   stars     ★★☆ (value filled, max total; 3 when no max)
//   text      the value as it came (a level name, a published line)
// `prefix` / `suffix` wrap the result; `empty` is shown INSTEAD (no prefix/suffix) while the value is
// 0, empty or missing — the "Best —" / "not cleared yet" case.

export const GAME_VALUE_FORMATS = ['number', 'time', 'fraction', 'percent', 'stars', 'text'];

/** @param {any} v @returns {number | null} a finite number, or null for text that is not one */
export function asNumber(v) {
	if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (v === null || v === undefined) return 0;
	if (Array.isArray(v)) return asNumber(v[0]);
	const t = String(v).trim();
	if (t === '') return 0;
	const n = Number(t);
	return Number.isFinite(n) ? n : null;
}

/** @param {any} decimals @param {number} hi */
function places(decimals, hi) {
	return Math.max(0, Math.min(hi, Math.round(Number(decimals) || 0)));
}

/**
 * Seconds as a clock: m:ss, m:ss.d with decimals, h:mm:ss past an hour. Negative reads as 0.
 * @param {number} seconds @param {number} [decimals]
 */
export function formatClock(seconds, decimals = 0) {
	const dp = places(decimals, 2);
	let s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
	// round ONCE at the shown precision, so 59.96 with 1 place reads 1:00.0, not 0:60.0
	const scale = 10 ** dp;
	s = dp ? Math.round(s * scale) / scale : Math.floor(s);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s - h * 3600) / 60);
	const r = s - h * 3600 - m * 60;
	const sec = (r < 10 ? '0' : '') + r.toFixed(dp);
	return h > 0 ? h + ':' + (m < 10 ? '0' : '') + m + ':' + sec : m + ':' + sec;
}

/** @param {any} value the value is "nothing" (0, '', null, NaN) */
export function isEmptyValue(value) {
	if (value === null || value === undefined) return true;
	if (typeof value === 'string') return value.trim() === '' || Number(value.trim()) === 0;
	if (typeof value === 'number') return !Number.isFinite(value) || value === 0;
	if (typeof value === 'boolean') return !value;
	return false;
}

/**
 * @param {any} value
 * @param {{ format?: string, decimals?: any, max?: any, prefix?: any, suffix?: any, empty?: any }} [opts]
 * @returns {string}
 */
export function formatGameValue(value, opts = {}) {
	const empty = String(opts.empty ?? '');
	if (empty && isEmptyValue(value)) return empty;
	const format = GAME_VALUE_FORMATS.includes(String(opts.format)) ? String(opts.format) : 'number';
	const n = asNumber(value);
	const max = asNumber(opts.max) ?? 0;
	let body;
	if (format === 'text' || (n === null && format !== 'stars')) body = value === null || value === undefined ? '' : String(value);
	else if (format === 'time') body = formatClock(n ?? 0, opts.decimals);
	else if (format === 'fraction') {
		const dp = places(opts.decimals, 4);
		body = (n ?? 0).toFixed(dp) + ' / ' + max.toFixed(dp);
	} else if (format === 'percent') {
		const whole = max > 0 ? max : 1;
		body = ((n ?? 0) / whole * 100).toFixed(places(opts.decimals, 2)) + ' %';
	} else if (format === 'stars') {
		const total = Math.max(1, Math.min(10, Math.round(max > 0 ? max : 3)));
		const filled = Math.max(0, Math.min(total, Math.round(n ?? 0)));
		body = '★'.repeat(filled) + '☆'.repeat(total - filled);
	} else body = (n ?? 0).toFixed(places(opts.decimals, 4));
	return String(opts.prefix ?? '') + body + String(opts.suffix ?? '');
}
