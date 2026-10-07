import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import pending from '../../scripts/redesign-pending.json' with { type: 'json' };

// 38 R11 (NOTES-38 #1): "No native scrollbars anywhere — use the app's custom minimal scrollbar."
// app.css hides the platform bar everywhere; this lint makes sure every element that SCROLLS says
// how it is drawn instead, so no scroller is left with no bar at all by accident:
//   - `use:minimalScroll` ($lib/ui/minimalScroll.js): the thin auto-hiding overlay thumb, or
//   - class `tp-noscrollbar`: scrolls with no bar by design (a horizontal chip/tab strip, the
//     burger menu — NOTES-38 #1 "it just scrolls").
// A scroller is a tag whose class (or class: directive, or inline style) makes it overflow
// auto/scroll, or one that a scoped <style> rule with `overflow: auto|scroll` selects. And no
// stylesheet may style a native bar back in (scrollbar-width thin/auto, scrollbar-color,
// ::-webkit-scrollbar-thumb). tests/e2e/no-native-scrollbars.test.cjs checks the same thing on
// the running app (dynamic scrollers, third-party DOM).

const ROOT = join(import.meta.dirname, '../..');
const DIRS = ['src/components', 'src/routes'].map((d) => join(ROOT, d));
const STYLE_DIRS = ['src/components', 'src/routes', 'src/styles'].map((d) => join(ROOT, d));
/** files another branch is redesigning (scripts/redesign-pending.json) */
const PENDING = new Set(pending.files);
/** the action itself hides the bar on what it decorates */
const STYLE_EXEMPT = new Set(['src/lib/ui/minimalScroll.js']);

/** @param {string} dir @param {RegExp} ext @param {string[]} [out] @returns {string[]} */
function walk(dir, ext, out = []) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p, ext, out);
		else if (ext.test(f)) out.push(p);
	}
	return out;
}

/** @param {string} text */
const stripComments = (text) =>
	text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * Every opening tag of the MARKUP (outside <script>/<style>), brace- and quote-aware.
 * @param {string} text
 * @returns {{ tag: string, line: number }[]}
 */
export function openTags(text) {
	const markup = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g, (m) => m.replace(/[^\n]/g, ' '));
	/** @type {{ tag: string, line: number }[]} */
	const tags = [];
	const re = /<[a-zA-Z][\w:.-]*/g;
	let m;
	while ((m = re.exec(markup))) {
		let k = m.index + m[0].length;
		let depth = 0;
		/** @type {string | null} */
		let quote = null;
		for (; k < markup.length; k++) {
			const c = markup[k];
			if (quote) {
				if (c === quote) quote = null;
			} else if (depth === 0 && (c === '"' || c === "'")) quote = c;
			else if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '>' && depth === 0) break;
		}
		tags.push({ tag: markup.slice(m.index, k + 1), line: markup.slice(0, m.index).split('\n').length });
		re.lastIndex = k + 1;
	}
	return tags;
}

const SCROLL_CLASS = /(?<![\w-])overflow(?:-[xy])?-(?:auto|scroll)(?![\w-])/;
const SCROLL_STYLE = /overflow(?:-[xy])?\s*:\s*(?:auto|scroll)\b/;
/** @param {string} tag */
const handled = (tag) => /\buse:minimalScroll\b/.test(tag) || /(?<![\w-])tp-noscrollbar(?![\w-])/.test(tag);

/**
 * Scrollers in one .svelte file that say nothing about their bar.
 * @param {string} text
 * @returns {string[]} `line: what`
 */
export function unhandledScrollers(text) {
	const src = stripComments(text);
	const tags = openTags(src);
	/** @type {string[]} */
	const out = [];
	for (const { tag, line } of tags) {
		const scrolls = SCROLL_CLASS.test(tag) || (/\bstyle(?::[\w-]+)?=/.test(tag) && SCROLL_STYLE.test(tag));
		if (scrolls && !handled(tag)) out.push(`${line}: <${tag.slice(1, 60).replace(/\s+/g, ' ')}…>`);
	}
	// scoped CSS: a rule that scrolls must hide the bar itself or select a handled element
	const handledClasses = new Set(
		tags.filter((t) => handled(t.tag)).flatMap((t) => [...t.tag.matchAll(/(?<![\w-])([a-zA-Z_][\w-]*)/g)].map((m) => m[1]))
	);
	for (const style of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
		const base = src.slice(0, style.index).split('\n').length;
		for (const rule of style[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			if (!SCROLL_STYLE.test(rule[2]) || /scrollbar-width\s*:\s*none/.test(rule[2])) continue;
			const sels = rule[1].split(',').map((s) => s.trim());
			const ok = sels.every((sel) => {
				const cls = [...sel.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]).pop();
				return !!cls && handledClasses.has(cls);
			});
			if (!ok) out.push(`${base + style[1].slice(0, rule.index).split('\n').length - 1}: <style> ${rule[1].trim().slice(0, 60)} { overflow … }`);
		}
	}
	return out;
}

/**
 * CSS that draws a native bar back in.
 * @param {string} text
 * @returns {string[]}
 */
export function nativeBarStyles(text) {
	/** @type {string[]} */
	const out = [];
	stripComments(text)
		.split('\n')
		.forEach((ln, i) => {
			if (/scrollbar-width\s*:\s*(?:thin|auto)\b/.test(ln)) out.push(`${i + 1}: ${ln.trim()}`);
			if (/scrollbar-color\s*:/.test(ln)) out.push(`${i + 1}: ${ln.trim()}`);
			if (/::-webkit-scrollbar-(?:thumb|track|button|corner)/.test(ln)) out.push(`${i + 1}: ${ln.trim()}`);
		});
	return out;
}

describe('no native scrollbars (NOTES-38 #1)', () => {
	it('the scanners catch what they are for (counterfactual)', () => {
		expect(unhandledScrollers('<div class="flex-1 overflow-y-auto">x</div>')).toHaveLength(1);
		expect(unhandledScrollers('<div class="overflow-y-auto" use:minimalScroll>x</div>')).toEqual([]);
		expect(unhandledScrollers('<div class="flex overflow-x-auto tp-noscrollbar">x</div>')).toEqual([]);
		expect(unhandledScrollers('<div class={open ? "overflow-auto" : ""}>x</div>')).toHaveLength(1);
		expect(unhandledScrollers('<div style="max-height: 40vh; overflow-y: auto">x</div>')).toHaveLength(1);
		expect(unhandledScrollers('<div class="overflow-hidden text-ellipsis">x</div>')).toEqual([]);
		expect(unhandledScrollers('<ul class="list">a</ul>\n<style>\n.list { overflow-y: auto; }\n</style>')).toHaveLength(1);
		expect(unhandledScrollers('<ul class="list" use:minimalScroll>a</ul>\n<style>\n.list { overflow-y: auto; }\n</style>')).toEqual([]);
		expect(unhandledScrollers('<ul class="strip">a</ul>\n<style>\n.strip { overflow-x: auto; scrollbar-width: none; }\n</style>')).toEqual([]);
		expect(unhandledScrollers('<!-- <div class="overflow-auto"> -->')).toEqual([]);
		expect(nativeBarStyles('* { scrollbar-width: thin; }\n.a::-webkit-scrollbar-thumb { background: red }')).toHaveLength(2);
		expect(nativeBarStyles('.a { scrollbar-width: none } .a::-webkit-scrollbar { display: none }')).toEqual([]);
	});

	it('every scroller in the app UI draws the minimal scrollbar or none', () => {
		const bad = DIRS.flatMap((d) => walk(d, /\.svelte$/))
			.filter((f) => !PENDING.has(relative(ROOT, f)))
			.flatMap((f) =>
			unhandledScrollers(readFileSync(f, 'utf8')).map((w) => `${relative(ROOT, f)}:${w}`)
		);
		expect(bad).toEqual([]);
	});

	it('no stylesheet styles a native scrollbar back in', () => {
		const bad = STYLE_DIRS.flatMap((d) => walk(d, /\.(svelte|css|js)$/))
			.filter((f) => !STYLE_EXEMPT.has(relative(ROOT, f)) && !PENDING.has(relative(ROOT, f)))
			.flatMap((f) => nativeBarStyles(readFileSync(f, 'utf8')).map((w) => `${relative(ROOT, f)}:${w}`));
		expect(bad).toEqual([]);
	});

	it('app.css hides the platform bar everywhere (the safety net under the lint)', () => {
		const css = stripComments(readFileSync(join(ROOT, 'src/app.css'), 'utf8'));
		expect(css).toMatch(/\*\s*\{[^}]*scrollbar-width:\s*none/);
		expect(css).toMatch(/\*::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
	});
});
