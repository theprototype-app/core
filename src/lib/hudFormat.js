// The HUD's `{v}` formatter (hudtext / hudbar / hudtimer). A LEAF, imports nothing.
//
// fix-agenttest item 9: the value used to go through flowRuntime's num() FIRST, so a STRING
// (a behaviour's line, a variable holding a name) reached the text as 0 — "behaviour line ->
// HUD Text" showed "0" every time. A non-numeric string now passes through as text, the rule
// gameFeelActions.fillValue already keeps; numbers, numeric strings, booleans and an unwired
// socket format exactly as before.

/** the number num() would make of it, or null for a string that is not a number @param {any} value */
function numberOf(value) {
	if (typeof value === 'string') {
		const t = value.trim();
		if (t === '') return 0;
		const n = Number(t);
		return Number.isFinite(n) ? n : null;
	}
	if (Array.isArray(value)) return Number(value[0]) || 0;
	if (typeof value === 'boolean') return value ? 1 : 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * @param {any} format the pattern; `{v}` is replaced, a pattern without it is shown as-is
 * @param {any} value a number, or text to show verbatim
 * @param {any} decimals
 * @returns {string}
 */
export function hudFormat(format, value, decimals) {
	const n = numberOf(value);
	const text = n === null ? String(value) : n.toFixed(Math.max(0, Math.min(6, Math.round(Number(decimals) || 0))));
	const pattern = String(format ?? '{v}');
	return pattern.includes('{v}') ? pattern.split('{v}').join(text) : pattern || text;
}
