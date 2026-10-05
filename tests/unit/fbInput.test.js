// @ts-nocheck — hand-made fake DOM elements
// 36 fb-input (F1-F4, user feedback 2026-10-05): the panel input rules.
//   F1  a control in a node body neither drags the node NOR pans the graph (`nodrag nopan`)
//   F2  panels own the keyboard: `panel` hears only global rows, the Object list lends the
//       selection rows, a toolbar (`keep`) never moves the keys
//   F3/F4 the window-chrome rules in windowGrip.js (header drag vs a control in the header)
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hostScopeOf, scopeOfEvent, pickForScope, setLastScope, viewportHasKeys, movesScope, rowIn, SCOPE_LABELS } from '../../src/lib/keyScope.js';
import { isHeaderDrag, isWindowGrip, INTERACTIVE_CHROME } from '../../src/lib/windowGrip.js';

const ROOT = path.resolve(__dirname, '../..');

/** A minimal element whose `closest` understands simple selector lists: tags, .classes,
 * [attr] / [attr="v"] / [role="x"]. Enough for the rules under test. */
function el({ tag = 'DIV', cls = '', attrs = {}, parent = null } = {}) {
	const node = {
		tagName: tag,
		nodeType: 1,
		isContentEditable: false,
		parent,
		cls: cls.split(/\s+/).filter(Boolean),
		attrs,
		getAttribute: (name) => attrs[name] ?? null,
		matches(sel) {
			return sel.split(',').some((one) => matchOne(node, one.trim()));
		},
		closest(sel) {
			let at = node;
			while (at) {
				if (at.matches(sel)) return at;
				at = at.parent;
			}
			return null;
		}
	};
	return node;
}
function matchOne(node, sel) {
	const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(sel);
	if (!m) return false;
	if (m[1] && node.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
	for (const c of m[2].split('.').filter(Boolean)) if (!node.cls.includes(c)) return false;
	for (const a of m[3].match(/\[[^\]]+\]/g) ?? []) {
		const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a) ?? [];
		if (!name || !(name in node.attrs)) return false;
		if (value !== undefined && node.attrs[name] !== value) return false;
	}
	return true;
}

describe('36 F2 — panels own the keyboard', () => {
	beforeEach(() => setLastScope('viewport'));

	it('a press inside a panel names the panel scope; a marked editor inside it wins', () => {
		const win = el({ attrs: { 'data-key-scope': 'panel' } });
		expect(hostScopeOf(el({ parent: el({ parent: win }) }))).toBe('panel');
		const graph = el({ attrs: { 'data-key-scope': 'nodes' }, parent: win });
		expect(hostScopeOf(el({ parent: graph }))).toBe('nodes');
	});

	it('in a panel only GLOBAL rows answer, and the fly keys stand down', () => {
		const rows = [
			{ id: 'chat', scope: 'viewport' },
			{ id: 'undo', scope: 'global' }
		];
		expect(pickForScope([rows[0]], 'panel')).toBe(null);
		expect(pickForScope(rows, 'panel').id).toBe('undo');
		setLastScope('panel');
		expect(viewportHasKeys({ target: el() })).toBe(false);
		setLastScope('viewport');
		expect(viewportHasKeys({ target: el() })).toBe(true);
	});

	it('the Object list hears the selection rows the viewport lends it, and nothing else of the viewport', () => {
		const del = { id: 'objects.delete', scope: 'viewport', alsoScopes: ['objects'] };
		const chat = { id: 'panels.chat', scope: 'viewport' };
		expect(pickForScope([del], 'objects')).toBe(del);
		expect(pickForScope([chat], 'objects')).toBe(null);
		expect(pickForScope([del], 'panel')).toBe(null);
		expect(rowIn(del, 'viewport') && rowIn(del, 'objects') && !rowIn(del, 'panel')).toBe(true);
		setLastScope('objects');
		expect(viewportHasKeys({ target: el() })).toBe(false);
	});

	it('a toolbar (`keep`) never moves the keyboard; a panel does', () => {
		const bar = el({ attrs: { 'data-key-scope': 'keep' } });
		expect(movesScope(el({ tag: 'BUTTON', parent: bar }))).toBe(false);
		expect(movesScope(el({ parent: el({ attrs: { 'data-key-scope': 'panel' } }) }))).toBe(true);
		// a keep host is nobody's scope even when asked directly
		expect(hostScopeOf(el({ parent: bar }))).toBe('viewport');
		setLastScope('panel');
		expect(scopeOfEvent({ target: el({ parent: bar }) })).toBe('panel');
	});

	it('both new scopes have a human name (the ? sheet and Settings read it)', () => {
		expect(SCOPE_LABELS.panel).toBeTruthy();
		expect(SCOPE_LABELS.objects).toBeTruthy();
	});

	it('the registry lends exactly the selection rows to the Object list', () => {
		const src = fs.readFileSync(path.join(ROOT, 'src/lib/shortcuts.js'), 'utf8');
		const lent = [...src.matchAll(/id: '([\w.-]+)',[^}]*?alsoScopes: \['objects'\]/g)].map((m) => m[1]).sort();
		expect(lent).toEqual(['camera.focus', 'objects.delete', 'objects.delete-backspace', 'objects.duplicate', 'objects.select-all']);
	});

	it('every docked panel root is marked (a floating one is marked by dragWindow)', () => {
		const files = ['src/components/Flow.svelte', 'src/components/editors/FlowCode.svelte', 'src/components/editors/UvEditor.svelte', 'src/components/editors/AnimationWindow.svelte', 'src/components/editors/Profiler.svelte', 'src/components/editors/Explorer.svelte', 'src/components/editors/HudEditor.svelte', 'src/components/editors/CodeWorkspace.svelte'];
		for (const f of files) {
			const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
			const at = src.indexOf('style="z-index: var(--z-bottom); height: {$dockHeight}px');
			expect(at, f).toBeGreaterThan(0);
			expect(src.slice(at, at + 200), f).toContain('data-key-scope="panel"');
		}
		const drag = fs.readFileSync(path.join(ROOT, 'src/lib/dragWindow.js'), 'utf8');
		expect(drag).toMatch(/keyScope = 'panel'/);
		expect(drag).toMatch(/setAttribute\?\.\('data-key-scope', keyScope\)/);
	});
});

describe('36 F4 — a control in a window header is not a grip', () => {
	const header = () => el({ cls: 'ui-panel-header move-handle' });

	it('the header itself (and its title text) drags', () => {
		const h = header();
		expect(isHeaderDrag(h)).toBe(true);
		expect(isHeaderDrag(el({ tag: 'SPAN', parent: h }))).toBe(true);
	});

	it('a TAB in the header is clicked, not dragged (the code workspace undocked)', () => {
		const strip = el({ attrs: { role: 'tablist' }, parent: header() });
		const tab = el({ cls: 'code-tab', attrs: { role: 'tab' }, parent: strip });
		expect(isHeaderDrag(tab)).toBe(false);
		expect(isHeaderDrag(el({ tag: 'SPAN', cls: 'code-tab-name', parent: tab }))).toBe(false);
	});

	it('buttons, links, inputs, ARIA controls and opt-outs in a header stay controls', () => {
		for (const spec of [{ tag: 'BUTTON' }, { tag: 'A', attrs: { href: '#' } }, { tag: 'INPUT' }, { tag: 'SELECT' }, { attrs: { role: 'button' } }, { attrs: { role: 'checkbox' } }, { attrs: { 'data-no-window-drag': '' } }])
			expect(isHeaderDrag(el({ ...spec, parent: header() })), JSON.stringify(spec)).toBe(false);
	});

	it('outside a header nothing is a header drag', () => {
		expect(isHeaderDrag(el())).toBe(false);
		expect(isHeaderDrag(null)).toBe(false);
	});

	it('the grips a right press must not interrupt: header, tab strip, resize grips', () => {
		expect(isWindowGrip(header())).toBe(true);
		expect(isWindowGrip(el({ tag: 'BUTTON', cls: 'tab-note', parent: el({ cls: 'tab-strip' }) }))).toBe(true);
		for (const c of ['dw-resize', 'resize-cue', 'resize-handle']) expect(isWindowGrip(el({ cls: c })), c).toBe(true);
		expect(isWindowGrip(el({ tag: 'BUTTON', parent: header() }))).toBe(false);
	});

	it('every header-drag module asks the one rule', () => {
		for (const f of ['src/lib/dragWindow.js', 'src/lib/windowTabs.js', 'src/lib/bottomDockDrop.js', 'src/lib/docking.js', 'src/components/menu/Controls.svelte']) {
			const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
			expect(src, f).toContain('isHeaderDrag(');
			// no module keeps its own "closest('.move-handle')" verdict for starting a drag
			expect(/if \(!e\.target\.closest\('\.move-handle'\)/.test(src), f).toBe(false);
		}
		expect(INTERACTIVE_CHROME).toContain('[role="tab"]');
	});
});

describe('36 F1 — a control in a node body never pans the graph', () => {
	/** every .svelte file under src (node bodies live in several folders) */
	const svelteFiles = (dir) =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? svelteFiles(path.join(dir, d.name)) : d.name.endsWith('.svelte') ? [path.join(dir, d.name)] : []));

	it('every `nodrag` class ships with `nopan` (xyflow pans unless the control says nopan)', () => {
		const bad = [];
		for (const f of svelteFiles(path.join(ROOT, 'src'))) {
			const src = fs.readFileSync(f, 'utf8');
			for (const m of src.matchAll(/class="([^"]*)"/g)) {
				const tokens = m[1].split(/\s+/);
				if (tokens.includes('nodrag') && !tokens.includes('nopan')) bad.push(path.relative(ROOT, f) + ': ' + m[0]);
			}
		}
		expect(bad).toEqual([]);
	});

	it('DragRow, the number scrubber, carries nopan whenever it carries nodrag', () => {
		const src = fs.readFileSync(path.join(ROOT, 'src/components/ui/DragRow.svelte'), 'utf8');
		expect(src).toMatch(/class:nodrag class:nopan=\{nodrag\}/);
	});
});
