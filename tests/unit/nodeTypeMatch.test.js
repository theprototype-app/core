import { describe, it, expect } from 'vitest';
import { matchNodeType } from '../../src/lib/ai/nodeTypeMatch.js';
import { nodeCatalog } from '../../src/lib/nodeCatalog.js';

// 55 owner finding 2 (D5): kit-* node types were all "unknown" to agents and the assistant
const TYPES = nodeCatalog.flatMap((g) => g.items.map((i) => i.type));
const ALIASES = { rotate: 'spin', wait: 'delay' };

describe('55 D5 node type matching', () => {
	it('takes every catalog type exactly as written, kit types included', () => {
		const kit = TYPES.filter((t) => t.startsWith('kit-'));
		expect(kit.length).toBeGreaterThan(10);
		for (const t of TYPES) expect(matchNodeType(t, TYPES, ALIASES)).toBe(t);
		expect(matchNodeType('  kit-rules-setJump ', TYPES, ALIASES)).toBe('kit-rules-setJump');
	});
	it('forgives case and separators, then aliases', () => {
		expect(matchNodeType('KIT-RULES-SETJUMP', TYPES, ALIASES)).toBe('kit-rules-setJump');
		expect(matchNodeType('kit_rules_setjump', TYPES, ALIASES)).toBe('kit-rules-setJump');
		expect(matchNodeType('Spin', TYPES, ALIASES)).toBe('spin');
		expect(matchNodeType('Rotate', TYPES, ALIASES)).toBe('spin');
		expect(matchNodeType('wait', TYPES, ALIASES)).toBe('delay');
	});
	it('returns null for junk', () => {
		expect(matchNodeType('', TYPES, ALIASES)).toBeNull();
		expect(matchNodeType(undefined, TYPES, ALIASES)).toBeNull();
		expect(matchNodeType('kit-rules-nope', TYPES, ALIASES)).toBeNull();
		expect(matchNodeType('constructor', TYPES, ALIASES)).toBeNull();
	});
});
