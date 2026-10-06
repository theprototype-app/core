// 36-fb-code (S7): the QUICK PICKS — Ctrl+P (open any project script) and Ctrl+Shift+O (go to a
// symbol of the current file) — rank their lists with the editor convention: the typed letters
// in order, anywhere in the name (`gr` finds "Golf rules"), better when they are a prefix, start
// words, or run together. A LEAF, no imports.

/**
 * How well `query` matches `text`: null = not at all, higher = better. Letters must appear in
 * order; each one scores more at a word start or right after the previous match.
 * @param {string} query @param {string} text @returns {number | null}
 */
export function fuzzyScore(query, text) {
	const q = String(query ?? '').toLowerCase().replace(/\s+/g, '');
	const t = String(text ?? '');
	const lower = t.toLowerCase();
	if (!q) return 0;
	let score = 0;
	let at = -1;
	let run = 0;
	for (const ch of q) {
		const i = lower.indexOf(ch, at + 1);
		if (i < 0) return null;
		const wordStart = i === 0 || /[\s_\-./:()]/.test(t[i - 1]) || (t[i] !== lower[i] && t[i - 1] === lower[i - 1]);
		run = i === at + 1 ? run + 1 : 0;
		score += 1 + (wordStart ? 3 : 0) + run * 2 - Math.min(3, (i - at - 1) * 0.1);
		at = i;
	}
	if (lower.startsWith(q)) score += 6;
	return score - t.length * 0.01;
}

/**
 * The items that match, best first (ties keep their order). Each item is matched on
 * `textOf(item)` (default: its label); `max` caps the list.
 * @template T @param {T[]} items @param {string} query
 * @param {(item: T) => string} [textOf] @param {number} [max]
 * @returns {T[]}
 */
export function rankQuick(items, query, textOf = (/** @type {any} */ i) => String(i?.label ?? ''), max = 60) {
	if (!String(query ?? '').trim()) return items.slice(0, max);
	const scored = [];
	for (let i = 0; i < items.length; i++) {
		const s = fuzzyScore(query, textOf(items[i]));
		if (s !== null) scored.push({ item: items[i], s, i });
	}
	scored.sort((a, b) => b.s - a.s || a.i - b.i);
	return scored.slice(0, max).map((x) => x.item);
}
