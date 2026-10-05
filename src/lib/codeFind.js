// 36-fb-code (F7): FIND IN FILES — a search over every source the Project tree lists. A LEAF
// (no imports): the workspace hands it the texts, it hands back matches with a line and a
// preview. Capped, because a game's module sources are tens of thousands of lines and the
// sidebar is a list, not a report.

/**
 * @typedef {{ key: string, title: string, code: string }} FindSource
 * @typedef {{ line: number, col: number, length: number, text: string }} FindMatch
 * @typedef {{ key: string, title: string, matches: FindMatch[] }} FindResult
 * @typedef {{ caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean, maxMatches?: number }} FindOptions
 */

/** the longest preview line (the match stays inside it) */
const PREVIEW = 120;

/**
 * Build the matcher for a query, or an error when the query is not a valid pattern.
 * @param {string} query @param {FindOptions} [opts] @returns {{re: RegExp} | {error: string} | null}
 */
export function findPattern(query, opts = {}) {
	const q = String(query ?? '');
	if (!q) return null;
	let body = opts.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	if (opts.wholeWord) body = '\\b(?:' + body + ')\\b';
	try {
		const re = new RegExp(body, opts.caseSensitive ? 'g' : 'gi');
		// a pattern that matches the empty string would never advance
		if (re.test('')) return { error: 'This pattern matches nothing at all — add a character' };
		re.lastIndex = 0;
		return { re };
	} catch (e) {
		return { error: String(/** @type {any} */ (e)?.message ?? e) };
	}
}

/** cut a long line down to a window around the match (0-based col) @param {string} text @param {number} col */
function preview(text, col) {
	if (text.length <= PREVIEW) return text;
	const start = Math.max(0, Math.min(col - 30, text.length - PREVIEW));
	return (start > 0 ? '…' : '') + text.slice(start, start + PREVIEW);
}

/**
 * Every match of `query` across `sources`, grouped by source, in the order the sources came.
 * @param {FindSource[]} sources @param {string} query @param {FindOptions} [opts]
 * @returns {{results: FindResult[], total: number, capped: boolean, error?: string}}
 */
export function findInSources(sources, query, opts = {}) {
	const pattern = findPattern(query, opts);
	if (!pattern) return { results: [], total: 0, capped: false };
	if ('error' in pattern) return { results: [], total: 0, capped: false, error: pattern.error };
	const max = opts.maxMatches ?? 500;
	const re = pattern.re;
	/** @type {FindResult[]} */
	const results = [];
	let total = 0;
	let capped = false;
	for (const src of sources) {
		/** @type {FindMatch[]} */
		const matches = [];
		const lines = String(src.code ?? '').split('\n');
		for (let i = 0; i < lines.length && !capped; i++) {
			const line = lines[i].replace(/\r$/, '');
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(line))) {
				if (total >= max) {
					capped = true;
					break;
				}
				matches.push({ line: i + 1, col: m.index + 1, length: m[0].length, text: preview(line, m.index) });
				total++;
				if (m[0].length === 0) re.lastIndex++;
			}
		}
		if (matches.length) results.push({ key: src.key, title: src.title, matches });
		if (capped) break;
	}
	return { results, total, capped };
}
