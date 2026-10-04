// 36 U11: a note's description is markdown, rendered on the note card. A zero-import leaf.
//
// It returns a TOKEN TREE that the card renders through {#each}, never an HTML string: a
// note's text arrives from peers, and a string handed to {@html} would let anybody in the
// session run markup on everybody's screen (the hudRichText rule). The dialect is the small
// one a sticky note needs: # headings, - / * / 1. lists, > quotes, blank-line paragraphs,
// **bold**, *italic*, `code`, ~~strike~~ and [links](https://…) — http(s) and mailto only.

/** @typedef {{t: 'text'|'b'|'i'|'code'|'s'|'a', v: string, href?: string, kids?: Span[]}} Span */
/** @typedef {{t: 'p'|'h'|'li'|'oli'|'quote'|'hr', level?: number, n?: number, spans: Span[]}} Block */

const MAX = 8000;

/** @param {string} text @returns {Block[]} */
export function parseNote(text) {
	const src = String(text ?? '').slice(0, MAX).replace(/\r\n?/g, '\n');
	/** @type {Block[]} */
	const blocks = [];
	/** @type {string[]} */
	let para = [];
	const flush = () => {
		if (para.length) blocks.push({ t: 'p', spans: parseInline(para.join(' ')) });
		para = [];
	};
	for (const raw of src.split('\n')) {
		const line = raw.trimEnd();
		if (!line.trim()) {
			flush();
			continue;
		}
		let m;
		if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
			flush();
			blocks.push({ t: 'h', level: m[1].length, spans: parseInline(m[2]) });
		} else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
			flush();
			blocks.push({ t: 'hr', spans: [] });
		} else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
			flush();
			blocks.push({ t: 'li', spans: parseInline(m[1]) });
		} else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) {
			flush();
			blocks.push({ t: 'oli', n: +m[1], spans: parseInline(m[2]) });
		} else if ((m = /^>\s?(.*)$/.exec(line))) {
			flush();
			blocks.push({ t: 'quote', spans: parseInline(m[1]) });
		} else para.push(line.trim());
	}
	flush();
	return blocks;
}

/** Is a link target safe to put in an href? @param {string} href */
export function safeHref(href) {
	const h = String(href || '').trim();
	return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

/** @param {string} text @returns {Span[]} */
export function parseInline(text) {
	/** @type {Span[]} */
	const out = [];
	let rest = String(text ?? '');
	/** @param {string} v */
	const pushText = (v) => {
		if (!v) return;
		const last = out[out.length - 1];
		if (last && last.t === 'text') last.v += v;
		else out.push({ t: 'text', v });
	};
	const RULES = [
		{ t: 'code', re: /^`([^`]+)`/ },
		{ t: 'b', re: /^\*\*([^*]+)\*\*/ },
		{ t: 'b', re: /^__([^_]+)__/ },
		{ t: 's', re: /^~~([^~]+)~~/ },
		{ t: 'i', re: /^\*([^*]+)\*/ },
		{ t: 'i', re: /^_([^_]+)_/ },
		{ t: 'a', re: /^\[([^\]]+)\]\(([^)\s]+)\)/ }
	];
	let guard = 0;
	while (rest && guard++ < 4000) {
		let matched = false;
		for (const rule of RULES) {
			const m = rule.re.exec(rest);
			if (!m) continue;
			matched = true;
			rest = rest.slice(m[0].length);
			if (rule.t === 'a') {
				const href = safeHref(m[2]);
				if (href) out.push({ t: 'a', v: m[1], href });
				else pushText(m[1]);
			} else if (rule.t === 'code') out.push({ t: 'code', v: m[1] });
			else out.push({ t: /** @type {any} */ (rule.t), v: m[1] });
			break;
		}
		if (matched) continue;
		// plain run up to the next character that could open a span
		const next = rest.slice(1).search(/[`*_~[]/);
		const take = next < 0 ? rest.length : next + 1;
		pushText(rest.slice(0, take));
		rest = rest.slice(take);
	}
	return out;
}

/** The first line of a note, plain (for a collapsed card / a tooltip). @param {string} text */
export function notePlainSummary(text, max = 120) {
	const first = parseNote(text)[0];
	const plain = first ? first.spans.map((s) => s.v).join('') : '';
	return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}
