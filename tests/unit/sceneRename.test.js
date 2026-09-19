import { describe, it, expect } from 'vitest';
import {
	normalizeSceneRenames,
	resolveSceneName,
	recordSceneRename,
	foldRenamedScenes,
	foldSceneEntries,
	rewriteTravelNodes,
	RENAME_CHAIN_LIMIT
} from '../../src/lib/sceneRename.js';

// ROADMAP 22 R5. The rename record, the transitive resolve, the merge fold and the
// live-graph rewrite are pure over plain objects, so every rule that would otherwise need
// two browsers and a signaling box is pinned here.

/** @param {string[]} history */
const entry = (...history) => ({ history, pinned: [] });

describe('normalizeSceneRenames', () => {
	it('keeps a well-formed record and drops the rest', () => {
		expect(
			normalizeSceneRenames({
				Arena: { to: 'Forge', at: 5 },
				' Pad ': { to: ' Deck ', at: 1 },
				Self: { to: 'Self', at: 2 },
				NoTo: { to: '', at: 2 },
				NoAt: { to: 'X', at: 0 },
				Junk: 'string'
			})
		).toEqual({ Arena: { to: 'Forge', at: 5 }, Pad: { to: 'Deck', at: 1 } });
		expect(normalizeSceneRenames(null)).toEqual({});
		expect(normalizeSceneRenames([])).toEqual({});
	});
});

describe('resolveSceneName', () => {
	const renames = { Arena: { to: 'Forge', at: 1 }, Forge: { to: 'Vault', at: 2 } };
	it('answers the name itself when nothing renamed it', () => {
		expect(resolveSceneName('Vault', renames)).toBe('Vault');
		expect(resolveSceneName('Other', renames)).toBe('Other');
		expect(resolveSceneName('Arena', null)).toBe('Arena');
		expect(resolveSceneName('', renames)).toBe('');
	});
	it('follows a chain to its end', () => {
		expect(resolveSceneName('Arena', renames)).toBe('Vault');
		expect(resolveSceneName('Forge', renames)).toBe('Vault');
	});
	it('stops on a cycle instead of hanging', () => {
		const loop = { A: { to: 'B', at: 1 }, B: { to: 'A', at: 2 } };
		expect(['A', 'B']).toContain(resolveSceneName('A', loop));
		// and on an absurdly long chain
		/** @type {Record<string, {to: string, at: number}>} */
		const long = {};
		for (let i = 0; i < RENAME_CHAIN_LIMIT + 10; i++) long['n' + i] = { to: 'n' + (i + 1), at: i + 1 };
		expect(resolveSceneName('n0', long)).toBe('n' + RENAME_CHAIN_LIMIT);
	});
});

describe('recordSceneRename', () => {
	it('adds a record without touching the input', () => {
		const before = { Old: { to: 'New', at: 1 } };
		const after = recordSceneRename(before, 'Arena', 'Forge', 7);
		expect(after).toEqual({ Old: { to: 'New', at: 1 }, Arena: { to: 'Forge', at: 7 } });
		expect(before).toEqual({ Old: { to: 'New', at: 1 } });
	});
	it('renaming ONTO a renamed-away name lifts that record', () => {
		const r = recordSceneRename({ Arena: { to: 'Forge', at: 1 } }, 'Forge', 'Arena', 2);
		// Forge -> Arena is recorded; the stale Arena -> Forge would send the live Arena away
		expect(r).toEqual({ Forge: { to: 'Arena', at: 2 } });
		expect(resolveSceneName('Arena', r)).toBe('Arena');
	});
	it('refuses a no-op or an empty side', () => {
		expect(recordSceneRename({}, 'A', 'A', 1)).toEqual({});
		expect(recordSceneRename({}, '', 'A', 1)).toEqual({});
		expect(recordSceneRename({}, 'A', ' ', 1)).toEqual({});
	});
});

describe('foldRenamedScenes', () => {
	it('is the identity with no records', () => {
		const scenes = { Arena: entry('h1') };
		const { scenes: out, renames } = foldRenamedScenes(scenes, {});
		expect(out).toEqual(scenes);
		expect(renames).toEqual({});
	});
	it('folds a stale peer\'s old key into the renamed line (same lineage)', () => {
		// the host renamed Arena -> Forge; a peer that had not heard saved h3 under Arena
		const scenes = { Forge: entry('h1', 'h2'), Arena: entry('h1', 'h2', 'h3') };
		const { scenes: out, renames } = foldRenamedScenes(scenes, { Arena: { to: 'Forge', at: 1 } });
		expect(Object.keys(out)).toEqual(['Forge']);
		expect(out.Forge.history).toEqual(['h1', 'h3', 'h2']); // novel spliced before the pointer
		expect(renames).toEqual({ Arena: { to: 'Forge', at: 1 } }); // kept for the next late peer
	});
	it('moves a scene whole when the target does not exist yet', () => {
		const scenes = { Arena: entry('h1', 'h2') };
		const { scenes: out } = foldRenamedScenes(scenes, { Arena: { to: 'Forge', at: 1 } });
		expect(out).toEqual({ Forge: entry('h1', 'h2') });
	});
	it('keeps a NEW scene that reuses a renamed-away name, and spends the record', () => {
		const scenes = { Forge: entry('h1', 'h2'), Arena: entry('x9') };
		const { scenes: out, renames } = foldRenamedScenes(scenes, { Arena: { to: 'Forge', at: 1 } });
		expect(Object.keys(out).sort()).toEqual(['Arena', 'Forge']);
		expect(out.Arena.history).toEqual(['x9']);
		expect(renames).toEqual({});
	});
	it('follows a chain when folding', () => {
		const scenes = { Vault: entry('h1', 'h2'), Arena: entry('h1') };
		const { scenes: out } = foldRenamedScenes(scenes, {
			Arena: { to: 'Forge', at: 1 },
			Forge: { to: 'Vault', at: 2 }
		});
		expect(Object.keys(out)).toEqual(['Vault']);
		expect(out.Vault.history).toEqual(['h1', 'h2']);
	});
	it('takes the caller\'s merge when given one', () => {
		const scenes = { Forge: entry('h1'), Arena: entry('h1', 'h2') };
		const { scenes: out } = foldRenamedScenes(scenes, { Arena: { to: 'Forge', at: 1 } }, (t, f) => ({
			...t,
			history: [...f.history, 'merged']
		}));
		expect(out.Forge.history).toEqual(['h1', 'h2', 'merged']);
	});
	it('does not mutate its inputs', () => {
		const scenes = { Forge: entry('h1'), Arena: entry('h1', 'h2') };
		const renames = { Arena: { to: 'Forge', at: 1 } };
		foldRenamedScenes(scenes, renames);
		expect(Object.keys(scenes).sort()).toEqual(['Arena', 'Forge']);
		expect(renames).toEqual({ Arena: { to: 'Forge', at: 1 } });
	});
});

describe('foldSceneEntries', () => {
	it('unions pins and labels, target winning a label tie, pruned to the history', () => {
		const target = { history: ['h1', 'h2'], pinned: ['h1'], labels: { h1: 'gold' } };
		const folded = { history: ['h1', 'h3'], pinned: ['h3', 'zz'], labels: { h1: 'silver', h3: 'v3' } };
		expect(foldSceneEntries(target, folded)).toEqual({
			history: ['h1', 'h3', 'h2'],
			pinned: ['h1', 'h3'],
			labels: { h1: 'gold', h3: 'v3' }
		});
	});
	it('omits labels when there are none', () => {
		expect(foldSceneEntries(entry('h1'), entry('h1'))).toEqual({ history: ['h1'], pinned: [] });
	});
});

describe('rewriteTravelNodes', () => {
	const nodes = [
		{ id: 'n1', __graph: 'scene', data: { type: 'travel', sceneName: 'Arena', level: '', levelName: '' } },
		{ id: 'n2', __graph: 'obj-1', data: { type: 'travel', sceneName: '', level: 'h2', levelName: 'Arena' } },
		{ id: 'n3', __graph: 'scene', data: { type: 'travel', sceneName: 'Other', level: '', levelName: '' } },
		{ id: 'n4', __graph: 'scene', data: { type: 'counter' }, type: 'counter' },
		{ id: 'n5', __graph: 'scene', data: { type: 'travel', sceneName: '', level: 'zz', levelName: 'Arena' } },
		{ id: 'n6', __graph: 'scene', data: { type: 'travel', sceneName: 'Forge', level: '', levelName: '' } }
	];
	it('patches the by-name node and the by-hash node of the renamed line, nothing else', () => {
		expect(rewriteTravelNodes(nodes, 'Arena', 'Forge', ['h1', 'h2'])).toEqual([
			{ id: 'n1', graphId: 'scene', data: { sceneName: 'Forge' } },
			{ id: 'n2', graphId: 'obj-1', data: { levelName: 'Forge' } }
		]);
	});
	it('is idempotent: applying the patches leaves nothing to patch', () => {
		const patched = nodes.map((n) => {
			const p = rewriteTravelNodes([n], 'Arena', 'Forge', ['h1', 'h2'])[0];
			return p ? { ...n, data: { ...n.data, ...p.data } } : n;
		});
		expect(rewriteTravelNodes(patched, 'Arena', 'Forge', ['h1', 'h2'])).toEqual([]);
	});
	it('reads a node whose type sits on the node rather than its data', () => {
		expect(rewriteTravelNodes([{ id: 'x', type: 'travel', data: { sceneName: 'Arena' } }], 'Arena', 'Forge')).toEqual([
			{ id: 'x', graphId: 'scene', data: { sceneName: 'Forge' } }
		]);
	});
	it('answers nothing for a no-op rename', () => {
		expect(rewriteTravelNodes(nodes, 'Arena', 'Arena', ['h1'])).toEqual([]);
		expect(rewriteTravelNodes(nodes, '', 'Forge', ['h1'])).toEqual([]);
	});
});
