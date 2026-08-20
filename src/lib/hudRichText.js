// 21-E7.3 - RICH TEXT for a HUD element: a WHITELIST PARSER, never an HTML sanitizer.
//
// A HUD label is plain text today, so there is no way to emphasise a word, colour a
// number or put a glyph next to it - which is most of what a menu or a tooltip is made
// of. The obvious shortcut is `innerHTML` with a sanitizer dependency, and it is the one
// thing this must not be: an element's text is REPLICATED scene data written by whoever
// is in the session, so a sanitizer bug is a cross-peer script injection.
//
// So the model is inverted. This parses a small MARKUP to a flat list of RUNS, and the
// renderer draws each run with svelte text interpolation and nothing else. There is no
// HTML in the pipeline at ALL, which means a hostile string is not "sanitized" - it is
// simply never markup. `<img onerror=alert(1)>` matches no token, so it comes out as one
// literal text run and renders as the characters you typed.
//
// A FLAT LIST rather than a tree, deliberately: the renderer is an {#each} over runs, and
// nesting would need a recursive component whose only job is to re-implement inline flow
// that CSS already does. Style flags ride each run instead.
//
// Imports NOTHING: hudKinds' rule, and this is read by HudElement (the runtime layer AND
// the editor artboard), so it must stay outside every cycle.
//
// THE MARKUP, all of it:
//   **bold**            *italic*
//   {color:#ef562f}...{/color}     {color:accent}...{/color}   (a theme token or a literal)
//   {icon:heart}        a lucide icon name
//   a newline is a line break
// Anything else is text. An unclosed marker simply runs to the end of the string.

/**
 * @typedef {{kind: 'text', text: string, bold: boolean, italic: boolean, color: string}
 *   | {kind: 'icon', name: string, color: string}
 *   | {kind: 'br'}} HudRichRun
 */

/** The most runs one element may produce. A pathological string (10k asterisks) would
 * otherwise build 10k DOM nodes inside a layer that re-renders on every runtime tick. */
export const RICH_RUN_LIMIT = 400;
/** and the most source we will look at, for the same reason one level up */
export const RICH_SOURCE_LIMIT = 4000;

/** A colour is a #hex literal or a THEME TOKEN NAME - the same two things every other
 * HUD colour field accepts (HudElement.paint resolves them). Nothing else: an
 * `rgb(...)` form would need its own parse and `url(...)`/`var(...)` are exactly the
 * shapes worth never accepting from a string on the wire.
 * @param {string} value */
function validColor(value) {
	const text = String(value ?? '').trim();
	if (/^#[0-9a-f]{3,8}$/i.test(text)) return text;
	if (/^[a-z][a-z0-9-]{0,23}$/i.test(text)) return text.toLowerCase();
	return '';
}

/** A lucide icon NAME, which is the only thing Icon.svelte will look up. @param {string} value */
function validIcon(value) {
	const text = String(value ?? '')
		.trim()
		.toLowerCase();
	return /^[a-z][a-z0-9-]{0,39}$/.test(text) ? text : '';
}

/**
 * Parse the markup to runs. Total function: every input produces a valid list, and an
 * input with no markup produces exactly one text run.
 * @param {any} source @returns {HudRichRun[]}
 */
export function parseHudRichText(source) {
	const text = String(source ?? '').slice(0, RICH_SOURCE_LIMIT);
	/** @type {HudRichRun[]} */
	const out = [];
	let bold = false;
	let italic = false;
	/** a STACK, so {color:a}x{color:b}y{/color}z returns to a @type {string[]} */
	const colors = [];
	let buf = '';
	const flush = () => {
		if (!buf) return;
		if (out.length < RICH_RUN_LIMIT)
			out.push({ kind: 'text', text: buf, bold, italic, color: colors[colors.length - 1] ?? '' });
		buf = '';
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '\n') {
			flush();
			if (out.length < RICH_RUN_LIMIT) out.push({ kind: 'br' });
			i += 1;
			continue;
		}
		// ** before *, or bold would read as two italics
		if (ch === '*' && text[i + 1] === '*') {
			flush();
			bold = !bold;
			i += 2;
			continue;
		}
		if (ch === '*') {
			flush();
			italic = !italic;
			i += 1;
			continue;
		}
		if (ch === '{') {
			const close = text.indexOf('}', i + 1);
			// A brace with no partner, or a body naming something we do not know, is
			// LITERAL TEXT - it falls through to the buffer below. That is the whole
			// safety property: the DEFAULT for anything unrecognised is "characters".
			if (close > i) {
				const body = text.slice(i + 1, close);
				const at = body.indexOf(':');
				const name = (at < 0 ? body : body.slice(0, at)).trim().toLowerCase();
				const arg = at < 0 ? '' : body.slice(at + 1);
				if (name === '/color') {
					flush();
					colors.pop();
					i = close + 1;
					continue;
				}
				if (name === 'color') {
					const color = validColor(arg);
					if (color) {
						flush();
						colors.push(color);
						i = close + 1;
						continue;
					}
				}
				if (name === 'icon') {
					const icon = validIcon(arg);
					if (icon) {
						flush();
						if (out.length < RICH_RUN_LIMIT)
							out.push({ kind: 'icon', name: icon, color: colors[colors.length - 1] ?? '' });
						i = close + 1;
						continue;
					}
				}
			}
		}
		buf += ch;
		i += 1;
	}
	flush();
	return out;
}

/** The markup with every marker removed - what a screen reader and a one-line preview
 * both want. @param {any} source */
export function hudRichTextPlain(source) {
	return parseHudRichText(source)
		.map((run) => (run.kind === 'text' ? run.text : run.kind === 'br' ? '\n' : ''))
		.join('');
}