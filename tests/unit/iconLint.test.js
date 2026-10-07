import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HUD_KIND_DEFS } from '../../src/lib/hudKinds.js';
import { ICON_SIZES, ICON_DISPLAY_SIZES } from '../../src/lib/ui/icons.js';

// 38 R10 (SPEC §7): every icon goes through ui/Icon.svelte. A component that imports
// '@lucide/svelte' (or the ToolIcon glyph set) directly bypasses the one map a glyph is
// swapped in and the 16/20 size + stroke standard — so it fails here, by file and line.

const ROOT = join(import.meta.dirname, '../..');
const COMPONENTS = join(ROOT, 'src/components');
const ICON = 'ui/Icon.svelte';
/** files allowed to keep a size as given (`snap={false}`): authored game HUD content and a
 *  tick drawn inside a 16px control */
const SNAP_EXEMPT = new Set(['hud/HudElement.svelte', 'ui/Checkbox.svelte']);
/** files whose `icon: '…'` data feeds ANOTHER icon system (VR canvas, touch buttons, the
 *  code tree's own lookup, the custom tool set) — not Icon.svelte's map */
const OTHER_SYSTEMS = new Set([
	'src/lib/touchActions.js',
	'src/lib/touchIcons.js',
	'src/lib/vr/settingsSchema.js',
	'src/lib/vrRadialMenu.js',
	'src/lib/codeProject.js',
	'src/components/menu/MeshEditPopup.svelte',
	'src/components/menu/SculptToolbar.svelte'
]);

/** @param {string} dir @param {string[]} [out] @returns {string[]} */
function walk(dir, out = []) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(svelte|js|ts)$/.test(f)) out.push(p);
	}
	return out;
}

/**
 * Direct icon imports in one file's text: `@lucide/svelte` (any subpath) and ToolIcon.
 * @param {string} text
 * @returns {{ line: number, what: string }[]}
 */
export function directIconImports(text) {
	/** @type {{ line: number, what: string }[]} */
	const hits = [];
	text.split('\n').forEach((ln, i) => {
		if (/from\s+['"]@lucide\/svelte[^'"]*['"]|import\s*\(\s*['"]@lucide\/svelte/.test(ln)) hits.push({ line: i + 1, what: '@lucide/svelte' });
		if (/import\s+ToolIcon\b/.test(ln)) hits.push({ line: i + 1, what: 'ToolIcon' });
	});
	return hits;
}

/**
 * Every `<Icon …>` tag in a svelte file, brace- and quote-aware (attributes can hold `>`).
 * @param {string} text
 * @returns {{ tag: string, line: number }[]}
 */
export function iconTags(text) {
	/** @type {{ tag: string, line: number }[]} */
	const tags = [];
	let i = 0;
	while ((i = text.indexOf('<Icon', i)) >= 0) {
		if (!/[\s/>]/.test(text[i + 5])) {
			i += 5;
			continue;
		}
		let k = i + 5;
		let depth = 0;
		/** @type {string | null} */
		let quote = null;
		for (; k < text.length; k++) {
			const c = text[k];
			if (quote) {
				if (c === quote) quote = null;
			} else if (depth === 0 && (c === '"' || c === "'")) quote = c;
			else if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '>' && depth === 0) break;
		}
		tags.push({ tag: text.slice(i, k + 1), line: text.slice(0, i).split('\n').length });
		i = k + 1;
	}
	return tags;
}

const iconSrc = readFileSync(join(COMPONENTS, ICON), 'utf8');
const mapBody = iconSrc.slice(iconSrc.indexOf('const MAP = {'), iconSrc.indexOf('\n\t};', iconSrc.indexOf('const MAP = {')));
const MAP_KEYS = new Set([...mapBody.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*[A-Z]/gm)].map((m) => m[1]));
const toolSrc = readFileSync(join(COMPONENTS, 'ui/ToolIcon.svelte'), 'utf8');
const TOOL_KEYS = new Set([...toolSrc.matchAll(/^\t\t'?([a-z0-9-]+)'?:\s*[{[]/gm)].map((m) => m[1]));

/** @param {string} name */
const known = (name) => (name.startsWith('tool:') ? TOOL_KEYS.has(name.slice(5)) : MAP_KEYS.has(name));

const files = walk(COMPONENTS);

describe('icons go through ui/Icon.svelte', () => {
	it('the scanner catches what it is for (counterfactual)', () => {
		expect(directIconImports("\timport { Play, X } from '@lucide/svelte';")).toEqual([{ line: 1, what: '@lucide/svelte' }]);
		expect(directIconImports("import Play from '@lucide/svelte/icons/play';")).toHaveLength(1);
		expect(directIconImports("const m = await import('@lucide/svelte');")).toHaveLength(1);
		expect(directIconImports("import ToolIcon from '../ui/ToolIcon.svelte';")).toEqual([{ line: 1, what: 'ToolIcon' }]);
		expect(directIconImports("import Icon from '../ui/Icon.svelte';")).toEqual([]);
		expect(directIconImports('// icons come from @lucide/svelte through the map')).toEqual([]);
		expect(iconTags('<Icon name="x" size={16} class={a > b ? "y" : ""} />')).toHaveLength(1);
		expect(iconTags('<IconButton />')).toEqual([]);
	});

	it('no component imports @lucide/svelte or ToolIcon directly', () => {
		const offenders = files
			.filter((f) => relative(COMPONENTS, f) !== ICON)
			.flatMap((f) => directIconImports(readFileSync(f, 'utf8')).map((h) => `${relative(ROOT, f)}:${h.line} ${h.what}`));
		expect(offenders).toEqual([]);
	});

	it('every literal icon name exists in the map', () => {
		const unknown = files.flatMap((f) =>
			iconTags(readFileSync(f, 'utf8'))
				.map((t) => ({ ...t, name: t.tag.match(/\bname=(?:"([^"{]+)"|\{'([^']+)'\})/) }))
				.filter((t) => t.name && !known(t.name[1] ?? t.name[2]))
				.map((t) => `${relative(ROOT, f)}:${t.line} ${t.name?.[1] ?? t.name?.[2]}`)
		);
		expect(unknown).toEqual([]);
	});

	it('literal sizes are on the standard scale; only the exempt files opt out of snapping', () => {
		const allowed = new Set([...ICON_SIZES, ...ICON_DISPLAY_SIZES]);
		const bad = files.flatMap((f) => {
			const rel = relative(COMPONENTS, f);
			return iconTags(readFileSync(f, 'utf8')).flatMap((t) => {
				const out = [];
				const free = /\bsnap=\{false\}/.test(t.tag);
				if (free && !SNAP_EXEMPT.has(rel)) out.push(`${rel}:${t.line} snap={false} outside the exempt list`);
				const lit = t.tag.match(/\bsize=\{(\d+)\}/);
				if (lit && !free && !allowed.has(Number(lit[1]))) out.push(`${rel}:${t.line} size ${lit[1]}`);
				if (/\bclass="[^"]*\b[hw]-\d/.test(t.tag)) out.push(`${rel}:${t.line} sized by a class`);
				return out;
			});
		});
		expect(bad).toEqual([]);
	});

	it('names handed to Icon as data exist in the map (menus, HUD palette)', () => {
		const missing = [];
		for (const def of HUD_KIND_DEFS) if (def.icon && !known(def.icon)) missing.push(`hudKinds ${def.key}: ${def.icon}`);
		for (const f of walk(join(ROOT, 'src'))) {
			const rel = relative(ROOT, f);
			if (OTHER_SYSTEMS.has(rel) || rel.startsWith('src/modules/')) continue;
			for (const m of readFileSync(f, 'utf8').matchAll(/\bicon\s*:\s*'([a-z][a-z0-9:-]*)'/g)) if (!known(m[1])) missing.push(`${rel}: ${m[1]}`);
		}
		expect(missing).toEqual([]);
	});
});
