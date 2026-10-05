// 36 (flow-revamp 199): the catalog audit as a GUARD. scripts/graph-audit.cjs reads the source
// tables; here it must find no value type without an evaluator (a wire from such a node LOOKS
// right and reads undefined — DEVX #22's hudbutton, plus hudtimer and ongamestate, all found by
// the audit) and no palette type without a card.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { catalogReport } = require('../../scripts/graph-audit.cjs');

describe('node catalog audit', () => {
	const { types, flags } = catalogReport();
	test('reads the whole palette', () => {
		expect(types.length).toBeGreaterThan(100);
		expect(types.map((t) => t.type)).toContain('script');
	});
	test('every listed value source has an evaluator case', () => {
		expect(flags.valueNoEval).toEqual([]);
	});
	test('every palette type has a card', () => {
		expect(flags.noCard).toEqual([]);
	});
	test('every palette type has a doc line', () => {
		expect(flags.noDoc).toEqual([]);
	});
});
