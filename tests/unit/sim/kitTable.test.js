// 34 R2 (T3) — the kit TABLE's own invariants: every row's spec is well-formed, named like its
// row, and every generated node type is unique and documented.
import { describe, it, expect } from 'vitest';
import { KIT_PIECES } from '../../../src/lib/kit/index.js';
import { specProblems, kitNodeItems } from '../../../src/lib/kit/spec.js';
import { kitCatalogGroups, kitNodeDoc } from '../../../src/lib/kit/catalog.js';

describe('KIT_PIECES', () => {
	it('every piece spec passes the spec check, and its row is named after it', () => {
		for (const row of KIT_PIECES) {
			expect(specProblems(row.piece.spec), row.name).toEqual([]);
			expect(row.piece.spec.piece).toBe(row.name);
			for (const k of ['initial', 'make']) expect(typeof row.piece[k], row.name + '.' + k).toBe('function');
		}
	});
	it('every action call has a reducer of the same name (an action IS an authority op)', () => {
		for (const row of KIT_PIECES)
			for (const call of row.piece.spec.calls)
				if (call.kind === 'action') expect(typeof row.piece.ops?.[call.name], row.name + '.' + call.name).toBe('function');
	});
	it('node types are unique across the kit, and every node has a doc line', () => {
		const types = KIT_PIECES.flatMap((row) => kitNodeItems(row.piece.spec).map((i) => i.type));
		expect(new Set(types).size).toBe(types.length);
		for (const t of types) expect(kitNodeDoc(t).length, t).toBeGreaterThan(20);
	});
	it('one palette group per piece', () => {
		expect(kitCatalogGroups().map((g) => g.group)).toEqual(KIT_PIECES.map((r) => r.piece.spec.group));
	});
});
