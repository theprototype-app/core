// 38 R8 (NOTES-38 #14) — THE COMMAND PALETTE'S MATCHING RULE. A LEAF (imports nothing): the
// ranking is pure, so "what does Ctrl+K find for this query" is provable without a browser.
//
// Every query word must be found in the command's text (label, then its detail/group/keywords);
// a command scores higher the earlier and the more WHOLE its matches are: a label that STARTS
// with the query beats a word inside it, which beats a match only in the detail line. Ties keep
// the order the sources were listed in (Array.sort is stable), so tools stay above settings rows.

/** @typedef {{id: string, kind: string, label: string, detail?: string, keys?: string, words?: string, run: () => void}} Command */

/** lower-case, accents folded, punctuation as spaces @param {string} s */
export function normalize(s) {
	return String(s ?? '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9+/ ]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * How well one command matches; 0 = not at all.
 * @param {Command} cmd @param {string[]} words normalized query words (non-empty)
 */
export function scoreCommand(cmd, words) {
	const label = normalize(cmd.label);
	const rest = normalize([cmd.detail, cmd.words, cmd.keys].filter(Boolean).join(' '));
	let score = 0;
	for (const w of words) {
		const at = label.indexOf(w);
		if (at === 0) score += 100;
		else if (at > 0 && label[at - 1] === ' ') score += 60;
		else if (at > 0) score += 25;
		else if (rest.includes(w)) score += 10;
		else return 0;
	}
	// the whole query as one phrase at the start of the label is the best possible match
	const phrase = words.join(' ');
	if (words.length > 1 && label.startsWith(phrase)) score += 50;
	// shorter labels win a tie in quality (an exact "Scale" over "Scale to fit")
	return score - Math.min(label.length, 60) / 100;
}

/**
 * The commands that match `query`, best first, at most `limit`. An empty query lists the
 * first `limit` commands as given (the caller decides what a fresh palette shows).
 * @param {Command[]} commands @param {string} query @param {number} [limit]
 * @returns {Command[]}
 */
export function rankCommands(commands, query, limit = 50) {
	const words = normalize(query).split(' ').filter(Boolean);
	if (!words.length) return commands.slice(0, limit);
	return commands
		.map((cmd, i) => ({ cmd, i, s: scoreCommand(cmd, words) }))
		.filter((r) => r.s > 0)
		.sort((a, b) => b.s - a.s || a.i - b.i)
		.slice(0, limit)
		.map((r) => r.cmd);
}
