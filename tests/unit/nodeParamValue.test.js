import { describe, it, expect } from 'vitest';
import { nodeCatalog, findNodeSpec } from '../../src/lib/nodeCatalog';
import { paramsOf, paramValue } from '../../src/lib/ai/nodeTypesCore.js';

// 2.0-n3b step 0a (N3a star-once 0/3): create_flow_nodes / update_flow_nodes took a key only when the spec had a
// DEFAULT for it, so `latch {perRound: true}` arrived as false and On Enter `who` was dropped. paramValue is the
// one rule both tools read now. Counterfactual: with paramValue answering `key in spec.defaults` (the old rule),
// 'every editor param of every core type is settable' is red on 12 keys.
describe('2.0-n3b paramValue: every editor param is settable', () => {
	it('latch / once perRound and onenter / onexit who reach the node', () => {
		expect(paramValue(findNodeSpec('latch'), 'perRound', true)).toEqual({ ok: true, value: true });
		expect(paramValue(findNodeSpec('once'), 'perRound', true)).toEqual({ ok: true, value: true });
		expect(paramValue(findNodeSpec('onenter'), 'who', 'player')).toEqual({ ok: true, value: 'player' });
		expect(paramValue(findNodeSpec('onexit'), 'who', 'objects')).toEqual({ ok: true, value: 'objects' });
		expect(paramValue(findNodeSpec('proximity'), 'to', 'player')).toEqual({ ok: true, value: 'player' });
	});

	it('every editor param of every core type is settable to its own default', () => {
		const refused = [];
		for (const group of nodeCatalog)
			for (const spec of group.items)
				for (const p of Array.isArray(spec.params) ? spec.params : []) {
					if (!p?.key || p.legacy === true) continue;
					const row = paramsOf(spec).find((r) => r.key === p.key);
					const sample = row?.default ?? (row?.type === 'boolean' ? true : row?.options?.[0] ?? 1);
					const v = paramValue(spec, p.key, sample);
					if (!v?.ok) refused.push(spec.type + '.' + p.key);
				}
		expect(refused).toEqual([]);
	});

	it('a legacy VALUE is the default describe_node_types reports (who was hidden)', () => {
		const who = paramsOf(findNodeSpec('onenter')).find((p) => p.key === 'who');
		expect(who).toMatchObject({ key: 'who', type: 'choice', default: 'any', options: ['any', 'player', 'objects'] });
		const to = paramsOf(findNodeSpec('proximity')).find((p) => p.key === 'to');
		expect(to?.default).toBe('object');
	});

	it('refuses a choice outside its options and a non-boolean toggle, with the valid values', () => {
		const bad = paramValue(findNodeSpec('onenter'), 'who', 'me');
		expect(bad?.ok).toBe(false);
		expect(/** @type {any} */ (bad).error).toContain('"player"');
		expect(paramValue(findNodeSpec('latch'), 'perRound', 'yes')?.ok).toBe(false);
		expect(paramValue(findNodeSpec('latch'), 'perRound', 'true')).toEqual({ ok: true, value: true });
	});

	it('an unknown key is not a param (the tool drops it, as before)', () => {
		expect(paramValue(findNodeSpec('latch'), 'perround', true)).toBeNull();
		expect(paramValue(null, 'x', 1)).toBeNull();
	});
});
