// 76 FW3: the Templates modal's search field — pure, so the unit suite and the modal agree.
// A query is up to 60 characters of words; a card matches when EVERY word appears somewhere
// in its title, description, author or tags (case-insensitive substring), so "space race"
// finds a scene titled "Race" tagged #space. The cloud provider searches the same four
// fields server-side (title, summary, tags, the maker's @handle), so a card the server
// returned also passes this filter.

/** @param {unknown} raw @returns {string} trimmed, single-spaced, lower-case, ≤ 60 chars */
export function normQuery(raw) {
	return String(raw ?? '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
		.slice(0, 60)
		.trim();
}

/** @param {unknown} q @returns {string[]} the distinct words, at most 6 (a leading # or @ is dropped) */
export function queryWords(q) {
	const words = normQuery(q)
		.split(' ')
		.map((w) => w.replace(/^[#@]+/, ''))
		.filter(Boolean);
	return [...new Set(words)].slice(0, 6);
}

/** @param {any} entry a normalized card entry @param {unknown} q @returns {boolean} */
export function matchesQuery(entry, q) {
	const words = queryWords(q);
	if (!words.length) return true;
	const hay = [entry?.title, entry?.description, entry?.author, ...(Array.isArray(entry?.tags) ? entry.tags : [])]
		.filter((v) => typeof v === 'string' && v)
		.join('\n')
		.toLowerCase();
	return words.every((w) => hay.includes(w));
}
