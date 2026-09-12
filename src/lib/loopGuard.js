// 27-D (audit C1) — THE LOOP GUARD.
//
// A Script node runs on EVERY peer, every frame, inside the shared flow tick. So a
// `while (true)` in one does not hang its author: it hangs the tab of everyone in the
// session, with no way out but closing it. That is audit finding C1 — the only CRITICAL
// one — and it is the whole reason this file exists.
//
// A LEAF on purpose: a string in, a string out, importing nothing. The part most likely
// to be subtly wrong is deciding what is CODE and what is a STRING, and as a leaf that
// decision is testable with no browser, no scene and no peer (the netBackoff /
// wireValidate shape).
//
// WHAT IT DOES: declare a counter per run and inject a check at the top of every loop
// BODY. The budget is per FRAME, not per session, because the function is called once a
// frame — a loop running a thousand times a frame is ordinary, one running a million has
// stopped being a loop and become a hang.
//
// WHAT IT DELIBERATELY DOES NOT DO: parse JavaScript. It is a SCANNER that knows just
// enough to tell code from a string, a template literal, a comment and a regex, because
// `// while (true)` must not be instrumented and `a / b` must not be read as the start
// of a regex. Anything it cannot bracket-match it REFUSES, and a refusal surfaces as the
// node's error badge rather than silently running unguarded — the one outcome worse than
// refusing is pretending to have guarded something.

/** Iterations per RUN before a loop is called a hang. */
export const LOOP_LIMIT = 1_000_000;

/** The counter's name. A user script declaring the same name is a duplicate-declaration
 * SyntaxError, which shows up as an ordinary script error badge. */
export const GUARD_VAR = '__lg';

const GUARD = `if(++${GUARD_VAR}>${LOOP_LIMIT})throw new Error("Script loop limit");`;
const DECL = `let ${GUARD_VAR}=0;\n`;

/** Words after which a `/` starts a REGEX, not a division. `return /x/` is the one that
 * bit: `return` ends in an identifier character, so testing the bare character reads it as
 * division and then swallows the rest of the line hunting for a divisor. */
const REGEX_PRECEDERS = new Set([
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
	'void', 'throw', 'case', 'do', 'else', 'yield', 'await'
]);

/** identifier characters, for word boundaries and the regex heuristic */
const isIdent = (/** @type {string} */ c) => !!c && /[A-Za-z0-9_$]/.test(c);

/** The identifier immediately before index `i`, ignoring whitespace.
 * @param {string} code @param {number} i */
function wordBefore(code, i) {
	let j = i - 1;
	while (j >= 0 && /\s/.test(code[j])) j--;
	const end = j + 1;
	while (j >= 0 && isIdent(code[j])) j--;
	return code.slice(j + 1, end);
}

/**
 * Walk `code` from `start`, calling `visit(i, ch)` for every character that is REAL CODE
 * — never inside a string, template, comment or regex literal. `visit` returns 'stop' to
 * end the walk. Returns the index it stopped at, or -1 if it ran to the end, or null when
 * the source is malformed (an unterminated string or comment).
 * @param {string} code @param {number} start
 * @param {(i: number, ch: string) => (string | void)} visit
 */
function walk(code, start, visit) {
	let i = start;
	// the last code character seen, which is how a regex is told from a division
	let prev = '';
	while (i < code.length) {
		const ch = code[i];
		const next = code[i + 1];
		// comments
		if (ch === '/' && next === '/') {
			i = code.indexOf('\n', i);
			if (i === -1) return -1; // a trailing line comment is fine
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = code.indexOf('*/', i + 2);
			if (end === -1) return null; // unterminated block comment
			i = end + 2;
			continue;
		}
		// strings and templates
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			let j = i + 1;
			let closed = false;
			while (j < code.length) {
				if (code[j] === '\\') {
					j += 2;
					continue;
				}
				if (code[j] === quote) {
					closed = true;
					break;
				}
				// `${ ... }` inside a template holds real code, but nothing we need to
				// instrument can legally live there without braces we would already be
				// tracking — skip it wholesale, brace-matched so a nested `}` is safe.
				if (quote === '`' && code[j] === '$' && code[j + 1] === '{') {
					let depth = 1;
					j += 2;
					while (j < code.length && depth > 0) {
						if (code[j] === '{') depth++;
						else if (code[j] === '}') depth--;
						j++;
					}
					continue;
				}
				j++;
			}
			if (!closed) return null; // unterminated string
			prev = quote;
			i = j + 1;
			continue;
		}
		// a regex literal, but only where a value may begin
		if (ch === '/' && (isIdent(prev) ? REGEX_PRECEDERS.has(wordBefore(code, i)) : prev !== ')' && prev !== ']')) {
			let j = i + 1;
			let closed = false;
			let inClass = false;
			while (j < code.length) {
				const c = code[j];
				if (c === '\\') {
					j += 2;
					continue;
				}
				if (c === '\n') break; // a regex cannot span lines: it was a division
				if (c === '[') inClass = true;
				else if (c === ']') inClass = false;
				else if (c === '/' && !inClass) {
					closed = true;
					break;
				}
				j++;
			}
			if (closed) {
				prev = '/';
				i = j + 1;
				continue;
			}
			// fall through: it was a division after all
		}
		if (visit(i, ch) === 'stop') return i;
		if (!/\s/.test(ch)) prev = ch;
		i++;
	}
	return -1;
}

/**
 * Index of the bracket matching the one at `open`, or -1. Strings and comments inside are
 * skipped, which is the entire point of doing this with the scanner rather than a regex.
 * @param {string} code @param {number} open
 */
function matchBracket(code, open) {
	const pairs = { '(': ')', '[': ']', '{': '}' };
	const close = pairs[/** @type {'('|'['|'{'} */ (code[open])];
	if (!close) return -1;
	let depth = 0;
	let found = -1;
	const bad = walk(code, open, (i, ch) => {
		if (ch === code[open]) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) {
				found = i;
				return 'stop';
			}
		}
	});
	if (bad === null) return -1;
	return found;
}

/**
 * The end of the single statement starting at `from` — the first `;` outside any bracket.
 * Used only for an UNBRACED loop body, which has to be wrapped in braces to hold a guard.
 * @param {string} code @param {number} from
 */
function statementEnd(code, from) {
	let depth = 0;
	let found = -1;
	const bad = walk(code, from, (i, ch) => {
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
		else if (ch === ';' && depth <= 0) {
			found = i;
			return 'stop';
		}
	});
	if (bad === null) return -1;
	return found;
}

/** first code index at or after `i` that is not whitespace (comments are skipped by walk)
 * @param {string} code @param {number} i */
function firstCode(code, i) {
	let found = -1;
	walk(code, i, (j, ch) => {
		if (!/\s/.test(ch)) {
			found = j;
			return 'stop';
		}
	});
	return found;
}

/**
 * Instrument every loop in `code`. Returns the transformed body INCLUDING the counter
 * declaration, ready to hand to `new Function`, or an error explaining the refusal.
 * @param {string} code
 * @returns {{ code: string, loops: number } | { error: string }}
 */
export function instrument(code) {
	const src = String(code ?? '');
	/** @type {{ pos: number, text: string }[]} */
	const edits = [];
	/** positions of `while` keywords that TERMINATE a do-loop rather than start one */
	const skipWhile = new Set();
	let loops = 0;
	let failure = '';

	const bad = walk(src, 0, (i, ch) => {
		if (!isIdent(ch) || isIdent(src[i - 1])) return; // mid-word, or not a word start
		// read the whole word so `format(` is never mistaken for `for (`
		let end = i;
		while (end < src.length && isIdent(src[end])) end++;
		const word = src.slice(i, end);
		if (word !== 'for' && word !== 'while' && word !== 'do') return;
		if (src[i - 1] === '.') return; // a member called `while`, not the keyword
		// the `while (cond)` closing a do-loop has no body; its body was guarded already
		if (word === 'while' && skipWhile.has(i)) return;

		let bodyAt;
		if (word === 'do') {
			bodyAt = firstCode(src, end);
			if (bodyAt !== -1) {
				const bodyEnd =
					src[bodyAt] === '{' ? matchBracket(src, bodyAt) + 1 : statementEnd(src, bodyAt) + 1;
				if (bodyEnd > 0) {
					const w = firstCode(src, bodyEnd);
					if (w !== -1 && src.startsWith('while', w)) skipWhile.add(w);
				}
			}
		} else {
			const paren = firstCode(src, end);
			// `for await (` is still a for loop
			if (paren !== -1 && /[A-Za-z]/.test(src[paren])) {
				let w = paren;
				while (w < src.length && isIdent(src[w])) w++;
				bodyAt = firstCode(src, w);
			} else bodyAt = paren;
			if (bodyAt === -1 || src[bodyAt] !== '(') {
				failure = 'could not read the ' + word + ' header';
				return 'stop';
			}
			const closeParen = matchBracket(src, bodyAt);
			if (closeParen === -1) {
				failure = 'unbalanced ( in a ' + word + ' header';
				return 'stop';
			}
			bodyAt = firstCode(src, closeParen + 1);
		}
		if (bodyAt === -1) {
			failure = 'a ' + word + ' loop with no body';
			return 'stop';
		}
		loops++;
		if (src[bodyAt] === '{') {
			edits.push({ pos: bodyAt + 1, text: GUARD });
			return;
		}
		// an unbraced body cannot hold a guard, so give it braces
		const semi = statementEnd(src, bodyAt);
		if (semi === -1) {
			failure = 'could not find the end of an unbraced ' + word + ' body';
			return 'stop';
		}
		edits.push({ pos: bodyAt, text: '{' + GUARD });
		edits.push({ pos: semi + 1, text: '}' });
	});

	if (bad === null) return { error: 'unterminated string or comment' };
	if (failure) return { error: failure };

	// apply back to front so earlier offsets stay valid; ties keep insertion order, which
	// is what nests an inner loop's braces inside an outer one's
	// Furthest POSITION first. Push order is not enough: an inner loop's opening brace sits
	// at a LOWER offset than an outer loop's closing one, so applying in push order shifts
	// the string out from under a later edit — measured as `Unexpected token }` on nested
	// unbraced loops. Ties keep push order reversed, which nests inner braces innermost.
	let out = src;
	edits
		.map((e, k) => ({ pos: e.pos, text: e.text, k }))
		.sort((a, b) => b.pos - a.pos || b.k - a.k)
		.forEach((e) => {
			out = out.slice(0, e.pos) + e.text + out.slice(e.pos);
		});
	return { code: DECL + out, loops };
}
