// 37 R15 — CHAT v2's TEXT RULES: emoji shortcodes and @mentions.
//
// A ZERO-IMPORT LEAF (vitest: tests/unit/chatTokens.test.js), because both rules are string
// arithmetic that is easy to get subtly wrong and needs no browser to check.
//
// SHORTCODES ARE EXPANDED ON SEND, not on render: the text that travels is the emoji itself,
// so a peer on an older build sees 🎉 rather than ":tada:", and a saved session's history
// reads the same in any build. An unknown `:word:` is left alone (it may be a time, 12:30:45,
// or somebody's deliberate colons).
//
// MENTIONS ARE RESOLVED ON RENDER, against the roster as it is NOW: a message carries plain
// text ("@Ada can you…"), and each viewer finds the names it knows. Longest name first, so
// "@Ada Lovelace" beats "@Ada" when both are in the room, and a match must END at a word
// boundary ("@Adam" is not a mention of "Ada"). A peer id works as well as a name (a peer
// that has not set one is shown by id). The renderer gets TOKENS, never markup: a message is
// drawn through {#each} text nodes, so no string a peer sends can become HTML.

/** the shortcode table — a small, common set, keyed WITHOUT colons */
export const SHORTCODES = Object.freeze({
	smile: '😄',
	grin: '😁',
	joy: '😂',
	wink: '😉',
	blush: '😊',
	heart_eyes: '😍',
	thinking: '🤔',
	neutral: '😐',
	sweat_smile: '😅',
	cry: '😢',
	sob: '😭',
	angry: '😠',
	scream: '😱',
	sunglasses: '😎',
	eyes: '👀',
	wave: '👋',
	clap: '👏',
	pray: '🙏',
	ok_hand: '👌',
	thumbsup: '👍',
	'+1': '👍',
	thumbsdown: '👎',
	'-1': '👎',
	muscle: '💪',
	point_up: '☝️',
	raised_hands: '🙌',
	heart: '❤️',
	fire: '🔥',
	star: '⭐',
	sparkles: '✨',
	tada: '🎉',
	rocket: '🚀',
	100: '💯',
	check: '✅',
	x: '❌',
	warning: '⚠️',
	question: '❓',
	bulb: '💡',
	zap: '⚡',
	trophy: '🏆',
	gem: '💎',
	art: '🎨',
	game: '🎮',
	bug: '🐛',
	wrench: '🔧',
	hammer: '🔨',
	coffee: '☕',
	pizza: '🍕',
	cake: '🎂',
	sun: '☀️',
	moon: '🌙',
	tree: '🌳',
	cube: '🧊',
	robot: '🤖',
	ghost: '👻',
	skull: '💀',
	poop: '💩'
});

/** `:name:` with a name of letters, digits, _, + or - (the shortcode alphabet) */
const SHORTCODE_RE = /:([a-z0-9_+-]{1,32}):/gi;

/** Replace every KNOWN `:shortcode:` with its emoji. @param {string} text @returns {string} */
export function expandShortcodes(text) {
	return String(text ?? '').replace(SHORTCODE_RE, (whole, name) => {
		const emoji = SHORTCODES[/** @type {keyof typeof SHORTCODES} */ (name.toLowerCase())];
		return emoji ?? whole;
	});
}

/**
 * Shortcodes that start with what is being typed — the input's suggestions. `partial` is
 * the text after the last ':' (no closing colon yet).
 * @param {string} partial @param {number} [limit] @returns {{code: string, emoji: string}[]}
 */
export function shortcodeSuggestions(partial, limit = 6) {
	const p = String(partial ?? '').toLowerCase();
	if (!p) return [];
	return Object.entries(SHORTCODES)
		.filter(([code]) => code.startsWith(p))
		.slice(0, limit)
		.map(([code, emoji]) => ({ code, emoji }));
}

/** a mention must end here: end of text, whitespace or punctuation (never a letter/digit)
 * @param {string} text @param {number} at */
function endsWord(text, at) {
	if (at >= text.length) return true;
	return !/[\p{L}\p{N}_]/u.test(text[at]);
}

/**
 * Split a message into text / mention tokens.
 * @param {string} text
 * @param {{id: string, name?: string}[]} people the roster (us included)
 * @returns {({kind: 'text', text: string} | {kind: 'mention', text: string, id: string})[]}
 */
export function tokenizeChat(text, people) {
	const source = String(text ?? '');
	/** every (label, id) a mention may name, longest label first */
	const labels = [];
	for (const p of people ?? []) {
		if (!p?.id) continue;
		labels.push({ label: p.id, id: p.id });
		const name = String(p.name ?? '').trim();
		if (name && name !== p.id) labels.push({ label: name, id: p.id });
	}
	labels.sort((a, b) => b.label.length - a.label.length);
	/** @type {({kind: 'text', text: string} | {kind: 'mention', text: string, id: string})[]} */
	const out = [];
	let plain = '';
	let i = 0;
	while (i < source.length) {
		const ch = source[i];
		// an @ starts a mention only at the start or after whitespace/punctuation (not an email)
		if (ch === '@' && (i === 0 || !/[\p{L}\p{N}_]/u.test(source[i - 1]))) {
			const rest = source.slice(i + 1).toLowerCase();
			const hit = labels.find((l) => rest.startsWith(l.label.toLowerCase()) && endsWord(source, i + 1 + l.label.length));
			if (hit) {
				if (plain) out.push({ kind: 'text', text: plain });
				plain = '';
				const len = 1 + hit.label.length;
				out.push({ kind: 'mention', text: source.slice(i, i + len), id: hit.id });
				i += len;
				continue;
			}
		}
		plain += ch;
		i++;
	}
	if (plain) out.push({ kind: 'text', text: plain });
	return out;
}

/** the peer ids a message mentions @param {string} text @param {{id: string, name?: string}[]} people */
export function mentionsIn(text, people) {
	return [...new Set(tokenizeChat(text, people).flatMap((t) => (t.kind === 'mention' ? [t.id] : [])))];
}

/**
 * Suggestions for a name being typed after an at-sign: `partial` is the text after it.
 * @param {string} partial @param {{id: string, name?: string}[]} people @param {string} [me] left out
 * @returns {{id: string, label: string}[]}
 */
export function mentionSuggestions(partial, people, me) {
	const p = String(partial ?? '').toLowerCase();
	return (people ?? [])
		.filter((x) => x?.id && x.id !== me)
		.map((x) => ({ id: x.id, label: String(x.name ?? '').trim() || x.id }))
		.filter((x) => x.label.toLowerCase().startsWith(p) || x.id.toLowerCase().startsWith(p))
		.slice(0, 6);
}

/**
 * Merge chat histories by message id (37 R15: a joiner's reply, a loaded session). Entries
 * with no id (an older peer's) are kept as they are; the result is ordered by `at` (the
 * sender's time), ties by id, and capped to the newest `cap`.
 * @param {any[]} mine @param {any[]} incoming @param {number} [cap]
 */
export function mergeChat(mine, incoming, cap = 200) {
	const seen = new Set((mine ?? []).map((m) => m?.id).filter(Boolean));
	const added = (incoming ?? []).filter((m) => m && typeof m.text === 'string' && m.id && !seen.has(m.id) && (seen.add(m.id), true));
	if (!added.length) return mine ?? [];
	const all = [...(mine ?? []), ...added];
	all.sort((a, b) => (a.at ?? a.ts ?? 0) - (b.at ?? b.ts ?? 0) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
	return all.slice(-cap);
}
