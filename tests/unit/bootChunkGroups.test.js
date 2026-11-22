// @ts-nocheck -- fixture test: hand-built module graphs
// fix-export-files: the chunk-group rule (scripts/boot-chunk-groups.cjs) over small synthetic kit
// graphs — what groups, what does not, the dependency order rolldown is told, and the merge rules.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyBootModules, kitOwned } = require('../../scripts/boot-chunk-groups.cjs');

const N = (n) => `/r/.svelte-kit/generated/build/client-optimized/nodes/${n}.js`;
const START = '/r/node_modules/@sveltejs/kit/src/runtime/client/entry.js';
const APP = '/r/.svelte-kit/generated/build/client-optimized/app.js';

/** spec: { id: [imports, dynamicImports, size?] }; entries are START, APP and the nodes listed */
function graph(spec, nodes = [0, 1, 2]) {
	const modules = new Map();
	const add = (id, imports = [], dynamicImports = [], isEntry = false, size = 100) => modules.set(id, { imports, dynamicImports, isEntry, size });
	add(START, [], [], true);
	add(APP, [], nodes.map(N), true);
	for (const n of nodes) add(N(n), spec[N(n)]?.[0] || [], spec[N(n)]?.[1] || [], true);
	for (const [id, [imp = [], dyn = [], size = 100] = []] of Object.entries(spec)) if (!modules.has(id)) add(id, imp, dyn, false, size);
	return { modules };
}

describe('classifyBootModules', () => {
	it('changes nothing for a graph with no kit client nodes (the SSR pass)', () => {
		const { names, order } = classifyBootModules({ modules: new Map([['/r/src/a.js', { imports: [], dynamicImports: [], isEntry: true }]]) });
		expect(names.size).toBe(0);
		expect(order).toEqual([]);
	});

	it('groups boot code by the pages that boot it; lazy-only code keeps the default split', () => {
		const g = graph({
			[N(2)]: [['/r/src/editor.js', '/r/src/shared.js']],
			[N(3)]: [['/r/src/play.js', '/r/src/shared.js']],
			'/r/src/editor.js': [['/r/src/util.js'], ['/r/src/lazy.js']],
			'/r/src/play.js': [['/r/src/util.js']],
			'/r/src/shared.js': [],
			'/r/src/util.js': [],
			'/r/src/lazy.js': [['/r/src/lazydep.js']],
			'/r/src/lazydep.js': []
		}, [0, 1, 2, 3]);
		const { names } = classifyBootModules(g);
		expect(names.get('/r/src/editor.js')).toBe('tp-b2');
		expect(names.get('/r/src/play.js')).toBe('tp-b3');
		expect(names.get('/r/src/shared.js')).toBe('tp-b2-3');
		expect(names.get('/r/src/util.js')).toBe('tp-b2-3');
		expect(names.has('/r/src/lazy.js')).toBe(false);
		expect(names.has('/r/src/lazydep.js')).toBe(false);
		// entries and kit's own files are never grouped
		for (const id of [START, APP, N(0), N(2)]) expect(names.has(id)).toBe(false);
	});

	it('splits boot code by the lazy entries that fetch it on the OTHER pages (the exact signature)', () => {
		const g = graph({
			[N(2)]: [['/r/src/a.js', '/r/src/b.js']],
			[N(3)]: [[], ['/r/src/la.js', '/r/src/lb.js']],
			'/r/src/a.js': [],
			'/r/src/b.js': [],
			'/r/src/la.js': [['/r/src/a.js']],
			'/r/src/lb.js': [['/r/src/b.js']]
		}, [0, 1, 2, 3]);
		const { names, sigs } = classifyBootModules(g);
		// both boot on the editor; on the play page one comes with la, the other with lb
		expect(sigs.get('/r/src/a.js')).not.toBe(sigs.get('/r/src/b.js'));
		expect(names.get('/r/src/a.js')).not.toBe(names.get('/r/src/b.js'));
		expect(names.get('/r/src/a.js')).toMatch(/^tp-b2-/);
	});

	it('a module importing kit runtime code is not grouped, and neither is what imports it', () => {
		const kit = '/r/node_modules/@sveltejs/kit/src/runtime/app/navigation.js';
		expect(kitOwned(kit)).toBe(true);
		const g = graph({
			[N(2)]: [['/r/src/top.js']],
			'/r/src/top.js': [['/r/src/nav.js', '/r/src/leaf.js']],
			'/r/src/nav.js': [[kit]],
			'/r/src/leaf.js': [],
			[kit]: []
		});
		const { names } = classifyBootModules(g);
		expect(names.has(kit)).toBe(false);
		expect(names.has('/r/src/nav.js')).toBe(false);
		expect(names.has('/r/src/top.js')).toBe(false);
		expect(names.get('/r/src/leaf.js')).toBe('tp-b2');
	});

	it('orders groups dependencies first (rolldown captures in that order)', () => {
		const g = graph({
			[N(2)]: [['/r/src/editor.js', '/r/src/common.js']],
			[N(3)]: [['/r/src/common.js']],
			'/r/src/editor.js': [['/r/src/common.js']],
			'/r/src/common.js': []
		}, [0, 1, 2, 3]);
		const { order } = classifyBootModules(g);
		expect(order.indexOf('tp-b2-3')).toBeLessThan(order.indexOf('tp-b2'));
	});

	describe('merging small groups', () => {
		// editor boot code that the play page fetches through three different lazy entries
		const spec = (sizes) => ({
			[N(2)]: [['/r/src/a.js', '/r/src/b.js', '/r/src/c.js']],
			[N(3)]: [[], ['/r/src/la.js', '/r/src/lb.js', '/r/src/lab.js']],
			'/r/src/a.js': [[], [], sizes.a],
			'/r/src/b.js': [[], [], sizes.b],
			'/r/src/c.js': [[], [], sizes.c],
			'/r/src/la.js': [['/r/src/a.js']],
			'/r/src/lb.js': [['/r/src/b.js']],
			'/r/src/lab.js': [['/r/src/a.js', '/r/src/b.js', '/r/src/c.js']]
		});
		it('off (mergeBelow 0) keeps every exact signature apart', () => {
			const { names } = classifyBootModules(graph(spec({ a: 10, b: 10, c: 10 }), [0, 1, 2, 3]));
			expect(new Set([names.get('/r/src/a.js'), names.get('/r/src/b.js'), names.get('/r/src/c.js')]).size).toBe(3);
		});
		it('small groups with the same boot pages merge', () => {
			const { names } = classifyBootModules(graph(spec({ a: 10, b: 10, c: 10 }), [0, 1, 2, 3]), { mergeBelow: 1000 });
			expect(new Set([names.get('/r/src/a.js'), names.get('/r/src/b.js'), names.get('/r/src/c.js')]).size).toBe(1);
		});
		it('a small group joins a big one only when its every trigger already loads the big one', () => {
			// c is big and only lab fetches it on the play page; a and b are also fetched by la / lb, which
			// would then fetch all of c — refused (and c itself is not small, so it never moves)
			const { names } = classifyBootModules(graph(spec({ a: 10, b: 10, c: 5000 }), [0, 1, 2, 3]), { mergeBelow: 1000 });
			expect(names.get('/r/src/a.js')).not.toBe(names.get('/r/src/c.js'));
			expect(names.get('/r/src/b.js')).not.toBe(names.get('/r/src/c.js'));
		});
		it('groups with different boot pages never merge', () => {
			const g = graph({
				[N(2)]: [['/r/src/x.js', '/r/src/y.js']],
				[N(3)]: [['/r/src/y.js']],
				'/r/src/x.js': [[], [], 10],
				'/r/src/y.js': [[], [], 10]
			}, [0, 1, 2, 3]);
			const { names } = classifyBootModules(g, { mergeBelow: 1000 });
			expect(names.get('/r/src/x.js')).toBe('tp-b2');
			expect(names.get('/r/src/y.js')).toBe('tp-b2-3');
		});
		it('the closure rule: no merge that makes a lazy load pull in a group it did not load before', () => {
			// p (editor boot, play fetches it via lp) imports q (boot on BOTH pages: free on play). r (editor
			// boot, the kit page fetches it via lr) is small too — merging p+r would make the kit page's lr
			// load q, which is boot code of other pages and lazy nowhere on the kit page
			const g = graph({
				[N(2)]: [['/r/src/p.js', '/r/src/r.js']],
				[N(3)]: [['/r/src/q.js'], ['/r/src/lp.js']],
				[N(4)]: [[], ['/r/src/lr.js']],
				'/r/src/p.js': [['/r/src/q.js'], [], 10],
				'/r/src/q.js': [[], [], 5000],
				'/r/src/r.js': [[], [], 10],
				'/r/src/lp.js': [['/r/src/p.js']],
				'/r/src/lr.js': [['/r/src/r.js']]
			}, [0, 1, 2, 3, 4]);
			const { names } = classifyBootModules(g, { mergeBelow: 1000 });
			expect(names.get('/r/src/p.js')).not.toBe(names.get('/r/src/r.js'));
		});
	});
});
