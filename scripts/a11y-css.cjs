// 53 — THE ACCESSIBILITY CSS TRANSFORM (build time, every stylesheet): A1 UI scale + A5 reduced motion.
//
// A1 — UI SCALE. Settings ▸ Accessibility ▸ UI scale (90-150 %) sets ONE
// custom property, `--ui-scale`, on <html> ($lib/uiScale.js). This transform is what makes every
// panel, sheet, dock, toolbar, menu, toast and the phone shell honour it: each CSS `px` length
// longer than a hairline becomes `calc(Npx * var(--ui-scale, 1))`, and tokens.css scales the root
// font size (so every rem — all of Tailwind's spacing and type — follows too).
//
// WHY NOT CSS `zoom`: measured on Chromium 153 with `html { zoom: 1.5 }` — `100vw` laid out 1920 px
// wide on a 1280 px window (viewport units are multiplied too), and an element placed at
// `left: <clientX>px` landed at 1.5 × clientX, so every drag, popover and menu that positions
// itself from a pointer (~150 call sites) would have had to divide by the zoom. Scaling LENGTHS
// keeps the coordinate space 1:1: pointer maths, measured rects and the 3D canvas (which is sized
// by its container, never by a px length) are untouched — "canvas resolution is NOT scaled".
//
// At the default (no `--ui-scale` set) every rewritten length is `calc(Npx * 1)`, which computes to
// exactly Npx: 100 % is byte-identical in layout.
//
// What is left alone, deliberately:
//   · lengths of 1px or less (hairline borders, 1px nudges — scaling them blurs them);
//   · at-rule PRELUDES (`@media (max-width: 639.98px)`): breakpoints describe the SCREEN;
//   · url(...) and quoted strings (an SVG data URI's own `width='12px'` is not a CSS length);
//   · a declaration that already names `--ui-scale` (it scales itself);
//   · a stylesheet carrying the pragma comment `ui-scale: off` — authored GAME content whose px are
//     the creator's (the HUD elements a game draws), not the editor's chrome.
// JS that reads a px token back off a custom property (`--hud-cell` …) gets `calc(38px * 1.5)`
// from getComputedStyle — read it through `$lib/uiScale.js cssPx()`, never parseFloat.
//
// A5 — REDUCED MOTION. Settings ▸ Accessibility ▸ Motion (Follow system / Reduce / Full) resolves to
// ONE attribute, `data-motion="reduce" | "full"` on <html> ($lib/motion.js). A media query cannot be
// overridden from JS, so every `@media (prefers-reduced-motion: reduce)` block is RE-KEYED onto it:
// its rules are prefixed `:root[data-motion='reduce']` and the condition is dropped (any other
// condition in the same query stays: `… and (max-width: 640px)`). `no-preference` becomes
// `:root:not([data-motion='reduce'])`. Tailwind's motion-reduce: / motion-safe: variants compile to
// the same media and are covered too. app.html sets the attribute before first paint.
//
// Used by vite.config.ts (a `transform` on every CSS module, after Tailwind generates) and by the
// unit suite tests/unit/a11yCss.test.js.
const postcss = require('postcss');

const PRAGMA = /ui-scale:\s*off/;
// one whole number, exponent included: a minifier writes Tailwind's `rounded-full` (`calc(infinity * 1px)`) as
// `3.40282e38px`, and a pattern without the exponent rewrote its `38px` alone into `3.40282ecalc(38px * …)`, an
// invalid value, so every `rounded-full` drew SQUARE on built pages (80a-fix4-ui O4). The lookbehind keeps a match
// from starting inside a number or a name.
const NUM_PX = /(?<![\w.])(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px\b/gi;
/** a sentinel length (`infinity`, a huge radius) is not a size: scaling it means nothing, so it stays as written */
const HUGE = 1e6;

/**
 * Rewrite the px lengths of ONE declaration value (outside url() and strings).
 * @param {string} value
 * @returns {string}
 */
function scaleValue(value) {
	if (!value.includes('px') || value.includes('--ui-scale')) return value;
	let out = '';
	let plain = '';
	let i = 0;
	const flush = () => {
		out += plain.replace(NUM_PX, (m, n) => (Math.abs(Number(n)) > 1 && Math.abs(Number(n)) < HUGE ? `calc(${n}px * var(--ui-scale, 1))` : m));
		plain = '';
	};
	while (i < value.length) {
		const ch = value[i];
		if (ch === '"' || ch === "'") {
			flush();
			const end = value.indexOf(ch, i + 1);
			const stop = end < 0 ? value.length : end + 1;
			out += value.slice(i, stop);
			i = stop;
			continue;
		}
		if (/^url\(/i.test(value.slice(i, i + 4))) {
			flush();
			const end = value.indexOf(')', i);
			const stop = end < 0 ? value.length : end + 1;
			out += value.slice(i, stop);
			i = stop;
			continue;
		}
		plain += ch;
		i++;
	}
	flush();
	return out;
}

const MOTION_Q = /\(\s*prefers-reduced-motion\s*:\s*(reduce|no-preference)\s*\)/i;
const ATTR = { reduce: "[data-motion='reduce']", 'no-preference': ":not([data-motion='reduce'])" };

/**
 * One selector under the motion attribute: `:root`/`html` selectors take it on the root itself,
 * anything else is prefixed `:root<attr> `.
 * @param {string} sel @param {string} attr
 */
function motionSelector(sel, attr) {
	const s = sel.trim();
	const root = /^(:root|html)(?![\w-])/i.exec(s);
	if (root) return root[1] + attr + s.slice(root[1].length);
	return `:root${attr} ${s}`;
}

/** @param {import('postcss').Root} root @returns {boolean} changed */
function rekeyMotion(root) {
	let changed = false;
	root.walkAtRules('media', (at) => {
		const m = MOTION_Q.exec(at.params);
		if (!m || at.params.includes(',')) return; // an OR-list is left alone (none in the app)
		const attr = ATTR[/** @type {'reduce' | 'no-preference'} */ (m[1].toLowerCase())];
		at.walkRules((rule) => {
			const parent = /** @type {any} */ (rule.parent);
			if (parent?.type === 'atrule' && /keyframes$/i.test(parent.name)) return;
			rule.selectors = rule.selectors.map((sel) => motionSelector(sel, attr));
		});
		const rest = at.params
			.replace(m[0], '')
			.replace(/^\s*and\s+/i, '')
			.replace(/\s+and\s*$/i, '')
			.replace(/\s+and\s+and\s+/i, ' and ')
			.trim();
		if (rest) at.params = rest;
		else at.replaceWith(at.nodes);
		changed = true;
	});
	return changed;
}

/**
 * The whole transform: px lengths follow --ui-scale, reduced-motion media follow data-motion.
 * Returns the input untouched when nothing changes (or on a parse error — a stylesheet this
 * cannot read is left for the real CSS pipeline to report).
 * @param {string} css
 * @returns {string}
 */
function transformA11yCss(css) {
	if (!css) return css;
	const lengths = css.includes('px') && !PRAGMA.test(css);
	const motion = /prefers-reduced-motion/i.test(css);
	if (!lengths && !motion) return css;
	let root;
	try {
		root = postcss.parse(css);
	} catch {
		return css;
	}
	let changed = false;
	if (motion) changed = rekeyMotion(root) || changed;
	if (lengths)
		root.walkDecls((decl) => {
			const next = scaleValue(decl.value);
			if (next !== decl.value) {
				decl.value = next;
				changed = true;
			}
		});
	return changed ? root.toString() : css;
}

/** the A1 half alone (kept for the unit suite's names) @param {string} css */
const scaleCssLengths = (css) => transformA11yCss(css);

module.exports = { transformA11yCss, scaleCssLengths, scaleValue, motionSelector };
