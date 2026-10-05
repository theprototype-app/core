import { describe, it, expect } from 'vitest';
import { moveTab } from '../../src/lib/codeTabs.js';
import { outlineOf } from '../../src/lib/codeOutline.js';
import { findInSources, findPattern } from '../../src/lib/codeFind.js';
import { projectTree, filterTree, leavesOf, keyOfTab, modulesInUse, nodeKey } from '../../src/lib/codeProject.js';
import { dropIndex } from '../../src/lib/dragReorder.js';
import { codeOfNode, builtinCodeActive, mergePlayerResult, BUILTIN_CODE } from '../../src/lib/builtinCode.js';
import { nodeHasCode, openCodeRequestFor } from '../../src/lib/graphContract.js';
import { sidebarKey, clampSidebarWidth } from '../../src/lib/codeSidebars.js';
import { fuzzyScore, rankQuick } from '../../src/lib/codeQuick.js';
import { quickItems } from '../../src/lib/codeProject.js';
import { nextIndex } from '../../src/lib/arrowNav.js';
import { textProblems, checkKindOf } from '../../src/lib/codeProblems.js';
import { KIT_PIECES } from '../../src/lib/kit/index.js';

// 36-fb-code (F5-F8): the code workspace's sidebars and the Player node's code — the pure halves
// (tab order, outline, find, the project tree, the reorder slot, the built-in code contract).

/** @param {string} id @returns {any} */
const t = (id) => ({ id, kind: 'node', title: id, lang: 'js', code: '', saved: '' });

describe('moveTab (F6/F8: one order for the strip and Open editors)', () => {
	const list = ['a', 'b', 'c', 'd'].map(t);
	const ids = (/** @type {any[]} */ l) => l.map((x) => x.id).join('');
	it('moves to the slot in the list without it', () => {
		expect(ids(moveTab(list, 'a', 2))).toBe('bcad');
		expect(ids(moveTab(list, 'd', 0))).toBe('dabc');
		expect(ids(moveTab(list, 'b', 3))).toBe('acdb');
	});
	it('dropping on its own slot changes nothing (same array)', () => {
		expect(moveTab(list, 'b', 1)).toBe(list);
		expect(moveTab(list, 'zz', 0)).toBe(list);
	});
	it('clamps the index', () => {
		expect(ids(moveTab(list, 'a', 99))).toBe('bcda');
		expect(ids(moveTab(list, 'c', -4))).toBe('cabd');
	});
});

describe('dropIndex (the reorder slot from midpoints)', () => {
	it('counts the midpoints before the pointer', () => {
		expect(dropIndex([10, 30, 50], 0)).toBe(0);
		expect(dropIndex([10, 30, 50], 31)).toBe(2);
		expect(dropIndex([10, 30, 50], 99)).toBe(3);
	});
});

describe('outlineOf (F7 Outline)', () => {
	const BEHAVIOUR = `export default behaviour({
  params: { power: { value: 7, min: 1 }, par: 3 },
  state: { shots: 0 },
  on: {
    start() { this.state.shots = 0; },
    hit(ball, speed) {}
  },
  reset() {}
});
`;
	it('a behaviour: params, state, handlers, methods, with lines', () => {
		const o = outlineOf(BEHAVIOUR, { kind: 'behaviour' });
		expect(o.partial).toBe(false);
		const by = (/** @type {string} */ k) => o.items.filter((i) => i.kind === k).map((i) => i.name);
		expect(by('param')).toEqual(['power', 'par']);
		expect(by('state')).toEqual(['shots']);
		expect(by('handler')).toEqual(['start', 'hit']);
		expect(by('method')).toEqual(['reset']);
		const hit = o.items.find((i) => i.name === 'hit');
		expect(hit?.line).toBe(6);
		expect(hit?.detail).toBe('(ball, speed)');
		expect(o.items.find((i) => i.name === 'power')?.detail).toBe('7');
	});
	it('a Script node body: inputs read, outputs returned, functions', () => {
		const code = 'function sq(x) { return x * x; }\nconst y = inputs.a + inputs.b;\nif (inputs.a) {}\nreturn { out: sq(y), twice: y * 2 };\n';
		const o = outlineOf(code, { kind: 'node' });
		expect(o.items.filter((i) => i.kind === 'input').map((i) => i.name)).toEqual(['a', 'b']);
		expect(o.items.filter((i) => i.kind === 'output').map((i) => i.name)).toEqual(['out', 'twice']);
		expect(o.items.find((i) => i.name === 'sq')).toMatchObject({ kind: 'function', line: 1 });
		// the return inside sq() is not an output
		expect(o.items.some((i) => i.kind === 'output' && i.line === 1)).toBe(false);
	});
	it('a module: functions, arrows, classes and methods, top-level consts', () => {
		const code = 'export const SPEED = 2;\nexport function go(a) {}\nconst f = (x) => x;\nclass Ball {\n  roll(d) {}\n}\nfunction inner() { const local = 1; }\n';
		const o = outlineOf(code, { kind: 'module' });
		const names = o.items.map((i) => i.kind + ':' + i.name);
		expect(names).toEqual(['const:SPEED', 'function:go', 'function:f', 'class:Ball', 'method:roll', 'function:inner']);
	});
	it('code that does not parse still outlines (partial)', () => {
		const o = outlineOf('function a(x) {\n  if (\n}\nconst b = () => 1;\n', { kind: 'module' });
		expect(o.partial).toBe(true);
		expect(o.items.map((i) => i.name)).toEqual(['a', 'b']);
	});
	it('a graph tab: its nodes by line', () => {
		const json = JSON.stringify({ nodes: [{ id: 'n1', type: 'spin', data: { label: 'Turn' } }, { id: 'n2', type: 'math', data: {} }], edges: [] }, null, 2);
		const o = outlineOf(json, { lang: 'json' });
		expect(o.items.map((i) => [i.name, i.detail])).toEqual([['Turn', 'spin'], ['n2', 'math']]);
		expect(o.items[1].line).toBeGreaterThan(o.items[0].line);
	});
});

describe('findInSources (F7 Find in files)', () => {
	const sources = [
		{ key: 'a', title: 'a.js', code: 'const Power = 1;\nlet power = 2;\n' },
		{ key: 'b', title: 'b.js', code: 'nothing here\n' },
		{ key: 'c', title: 'c.js', code: 'x.power()\n' }
	];
	it('case-insensitive by default, grouped by source, with line + col', () => {
		const r = findInSources(sources, 'power');
		expect(r.total).toBe(3);
		expect(r.results.map((x) => x.key)).toEqual(['a', 'c']);
		expect(r.results[0].matches.map((m) => [m.line, m.col])).toEqual([[1, 7], [2, 5]]);
	});
	it('case-sensitive, whole word and regex', () => {
		expect(findInSources(sources, 'Power', { caseSensitive: true }).total).toBe(1);
		expect(findInSources(sources, 'pow', { wholeWord: true }).total).toBe(0);
		expect(findInSources(sources, 'p\\w+r =', { regex: true }).total).toBe(2);
	});
	it('a bad pattern is an error, not a throw; an empty-matching one is refused', () => {
		expect(findInSources(sources, '(', { regex: true }).error).toBeTruthy();
		expect(findPattern('x*', { regex: true })).toHaveProperty('error');
		expect(findInSources(sources, '').total).toBe(0);
	});
	it('caps the total', () => {
		const many = [{ key: 'm', title: 'm', code: 'a '.repeat(50) }];
		const r = findInSources(many, 'a', { maxMatches: 10 });
		expect(r.total).toBe(10);
		expect(r.capped).toBe(true);
	});
	it('a long line previews around the match', () => {
		const long = [{ key: 'l', title: 'l', code: 'x'.repeat(400) + 'needle' + 'y'.repeat(400) }];
		const m = findInSources(long, 'needle').results[0].matches[0];
		expect(m.text.length).toBeLessThanOrEqual(121);
		expect(m.text).toContain('needle');
	});
});

describe('projectTree (F6 Project)', () => {
	const graphs = {
		scene: {
			nodes: [
				{ id: 's1', type: 'script', data: { label: 'Bounce', code: '' } },
				{ id: 'b1', type: 'behaviour', data: { name: 'Golf rules', code: '' } },
				{ id: 'p1', type: 'charcontroller', data: { label: 'Player: walk' } },
				{ id: 'k1', type: 'kit-score-set', data: {} },
				{ id: 'c1', type: 'coderef', data: { module: 'minigolf', file: 'rules.js' } },
				{ id: 'm1', type: 'script', data: { label: 'Copy me', src: { kind: 'module', module: 'minigolf', file: 'shot.js' } } },
				{ id: 'x', type: 'spin', data: {} }
			]
		},
		'obj-1': { nodes: [{ id: 's2', type: 'script', data: { label: 'Door', src: { kind: 'asset', hash: 'h1', name: 'door.js' } } }] }
	};
	const tree = projectTree({ graphs, scripts: [{ id: 'i1', name: 'door.js', hash: 'h1' }], boundCount: (h) => (h === 'h1' ? 1 : 0), graphTitle: (id) => (id === 'scene' ? 'Main graph' : 'Door object') });
	it('groups: Graphs (Main first), Script files, Module sources', () => {
		expect(tree.map((g) => g.label)).toEqual(['Graphs', 'Script files', 'Module sources']);
		expect(tree[0].children?.map((g) => g.label)).toEqual(['Main graph', 'Door object']);
	});
	it('Main lists its code nodes (incl. the Player) and the graph JSON', () => {
		const main = tree[0].children?.[0].children ?? [];
		expect(main.map((l) => l.label)).toEqual(['Bounce', 'Copy me', 'Golf rules', 'Player: walk', 'graph.json']);
		expect(main.find((l) => l.label === 'Player: walk')).toMatchObject({ icon: 'builtin', request: { source: 'script', ref: { nodeId: 'p1', graphId: 'scene' } } });
		expect(main.find((l) => l.label === 'Copy me')).toMatchObject({ readOnly: true, fork: 'node' });
	});
	it('a bound node says which file; a file says how many nodes run it', () => {
		expect(tree[0].children?.[1].children?.[0].detail).toBe('→ door.js');
		expect(tree[1].children?.[0]).toMatchObject({ label: 'door.js', detail: '1 node runs it', request: { source: 'script', ref: { itemId: 'i1' } } });
	});
	it('module sources the graphs use, read-only and forkable', () => {
		const mods = tree[2].children ?? [];
		expect(mods.map((m) => m.label)).toEqual(['kit', 'minigolf']);
		expect(mods[0].children?.map((l) => l.label)).toEqual(['score.js']);
		expect(mods[1].children?.map((l) => l.label)).toEqual(['rules.js', 'shot.js']);
		expect(mods[1].children?.[0]).toMatchObject({ readOnly: true, fork: 'module', key: 'm:minigolf/rules.js' });
		expect([...(modulesInUse(graphs, () => null).get('minigolf') ?? [])].sort()).toEqual(['rules.js', 'shot.js']);
	});
	it('filters by every word, keeping the path to a hit', () => {
		const f = filterTree(tree, 'player');
		expect(leavesOf(f).map((l) => l.label)).toEqual(['Player: walk']);
		expect(leavesOf(filterTree(tree, 'golf rul')).map((l) => l.label)).toEqual(['Golf rules', 'rules.js']);
		expect(leavesOf(filterTree(tree, 'minigolf shot')).map((l) => l.label)).toEqual(['shot.js']);
		expect(leavesOf(filterTree(tree, 'graphs')).length).toBe(0);
		expect(filterTree(tree, '')).toBe(tree);
	});
	it('keyOfTab names the leaf a tab shows', () => {
		expect(keyOfTab({ kind: 'node', nodeId: 'p1', graphId: 'scene' })).toBe(nodeKey('scene', 'p1'));
		expect(keyOfTab({ kind: 'file', itemId: 'i1' })).toBe('f:i1');
		expect(keyOfTab({ kind: 'module', moduleId: 'minigolf', name: 'rules.js' })).toBe('m:minigolf/rules.js');
		expect(keyOfTab({ kind: 'graph', graphId: 'scene' })).toBe('g:scene');
		const all = leavesOf(tree).map((l) => l.key);
		expect(all).toContain(keyOfTab({ kind: 'module', moduleId: 'minigolf', name: 'rules.js' }));
	});
});

describe('the Player node has code (F5)', () => {
	const player = { id: 'p', type: 'charcontroller', data: { label: 'Player: walk', mode: 'walk', speed: 0.06 } };
	it('answers Open code / double-click like a Script node', () => {
		expect(nodeHasCode(player)).toBe(true);
		expect(openCodeRequestFor(player, 'scene')).toEqual({ source: 'script', ref: 'p', graphId: 'scene' });
	});
	it('shows the template until code is saved; the template runs nothing', () => {
		expect(codeOfNode(player)).toBe(BUILTIN_CODE.charcontroller.template);
		expect(builtinCodeActive(player)).toBe(false);
		expect(builtinCodeActive({ ...player, data: { code: BUILTIN_CODE.charcontroller.template } })).toBe(false);
		expect(builtinCodeActive({ ...player, data: { code: 'return { speed: 1 };' } })).toBe(true);
		expect(codeOfNode({ ...player, data: { code: 'x' } })).toBe('x');
	});
	it('a plain node still has no code', () => {
		expect(nodeHasCode({ id: 'x', type: 'spin', data: {} })).toBe(false);
	});
	it('the result merges over the card, clamped; a wrong key or type is a problem', () => {
		const card = { mode: 'walk', speed: 0.06, jumpHeight: 1, eyeHeight: 1.6, gravity: true };
		expect(mergePlayerResult(card, { speed: 0.2 }).settings).toEqual({ ...card, speed: 0.2 });
		expect(mergePlayerResult(card, undefined)).toEqual({ settings: card, problems: [] });
		expect(mergePlayerResult(card, { speed: 99 }).settings.speed).toBe(5);
		const bad = mergePlayerResult(card, { sped: 1, gravity: 'yes', mode: 'swim' });
		expect(bad.settings).toEqual(card);
		expect(bad.problems).toHaveLength(3);
		expect(mergePlayerResult(card, 5).problems).toHaveLength(1);
	});
});

describe('sidebarKey (F7 keyboard)', () => {
	it('Ctrl+B left, Ctrl+Alt+B right, Ctrl+Shift+F find, Ctrl+P open, Ctrl+Shift+O symbol, nothing else', () => {
		expect(sidebarKey({ key: 'b', code: 'KeyB', ctrlKey: true })).toBe('left');
		expect(sidebarKey({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true })).toBe('right');
		expect(sidebarKey({ key: '∫', code: 'KeyB', metaKey: true, altKey: true })).toBe('right');
		expect(sidebarKey({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })).toBe('find');
		expect(sidebarKey({ key: 'f', code: 'KeyF', ctrlKey: true })).toBe(null);
		expect(sidebarKey({ key: 'b', code: 'KeyB' })).toBe(null);
		expect(sidebarKey({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true })).toBe(null);
		expect(sidebarKey({ key: 'p', code: 'KeyP', ctrlKey: true })).toBe('quickOpen');
		expect(sidebarKey({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })).toBe('symbols');
		expect(sidebarKey({ key: 'o', code: 'KeyO', ctrlKey: true })).toBe(null);
		expect(sidebarKey({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })).toBe(null);
	});
	it('widths clamp', () => {
		expect(clampSidebarWidth('left', 10)).toBe(140);
		expect(clampSidebarWidth('right', 9999)).toBe(520);
	});
});

describe('quick picks (S7: Ctrl+P / Ctrl+Shift+O)', () => {
	it('fuzzyScore: letters in order, prefix and word starts score higher', () => {
		expect(fuzzyScore('gr', 'Golf rules')).not.toBeNull();
		expect(fuzzyScore('rg', 'Golf rules')).toBeNull();
		expect(fuzzyScore('gol', 'Golf rules')).toBeGreaterThan(fuzzyScore('gol', 'a big olive') ?? -Infinity);
		expect(fuzzyScore('pw', 'Player: walk')).toBeGreaterThan(fuzzyScore('pw', 'upwards') ?? -Infinity);
		expect(fuzzyScore('', 'x')).toBe(0);
	});
	it('rankQuick: best first, non-matches out, empty query = the list', () => {
		const items = [{ label: 'score.js' }, { label: 'Golf rules' }, { label: 'graph.json' }, { label: 'rules.js' }];
		expect(rankQuick(items, 'rul').map((i) => i.label)).toEqual(['rules.js', 'Golf rules']);
		expect(rankQuick(items, '')).toHaveLength(4);
		expect(rankQuick(items, 'zzz')).toEqual([]);
	});
	it('quickItems: every openable leaf with its folders as the detail', () => {
		const tree = projectTree({ graphs: { scene: { nodes: [{ id: 'p', type: 'charcontroller', data: { label: 'Player: walk' } }, { id: 'k', type: 'kit-score-set', data: {} }] } } });
		const q = quickItems(tree);
		expect(q.map((i) => [i.label, i.detail])).toEqual([
			['Player: walk', 'Main graph'],
			['graph.json', 'Main graph'],
			['score.js', 'kit']
		]);
	});
});

describe('nextIndex (S12 arrow navigation)', () => {
	it('moves within the ends, Home/End, and enters from nowhere', () => {
		expect(nextIndex(3, 0, 'next')).toBe(1);
		expect(nextIndex(3, 2, 'next')).toBe(2);
		expect(nextIndex(3, 0, 'prev')).toBe(0);
		expect(nextIndex(3, 1, 'last')).toBe(2);
		expect(nextIndex(3, -1, 'prev')).toBe(2);
		expect(nextIndex(0, -1, 'next')).toBe(-1);
	});
});

describe('textProblems (F7 Problems)', () => {
	const specs = KIT_PIECES.map((r) => r.piece.spec);
	it('a behaviour using a kit event is clean WITH the kit specs (the loader reading)', () => {
		const src = 'export default behaviour({\n  on: { levelSelected() {} }\n});\n';
		expect(textProblems(src, 'behaviour', specs).filter((p) => /no such event/.test(p.message))).toEqual([]);
		expect(textProblems(src, 'behaviour', []).some((p) => /no such event/.test(p.message))).toBe(true);
	});
	it('a Library copy of a plain ES module is parsed, not linted as a behaviour', () => {
		const tab = { kind: 'file', code: "import x from './y.js';\nexport default { a: 1 };\n" };
		expect(checkKindOf(tab)).toBe('module');
		expect(textProblems(tab.code, 'module')).toEqual([]);
		expect(textProblems('export const = ;', 'module')[0]?.from).toBe('parse');
		expect(checkKindOf({ kind: 'file', code: 'export default behaviour({});' })).toBe('behaviour');
		expect(checkKindOf({ kind: 'module', readOnly: true, code: 'x' })).toBe(null);
	});
	it('a script: parse error, else determinism lint', () => {
		expect(textProblems('const a = ;', 'script')[0]).toMatchObject({ severity: 'error', from: 'parse' });
		expect(textProblems('const x = Math.random();', 'script')[0]).toMatchObject({ severity: 'warning', from: 'lint' });
	});
});
