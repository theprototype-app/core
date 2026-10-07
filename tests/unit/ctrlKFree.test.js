// 38 R8 (NOTES-38 #14): Ctrl+K belongs to the command palette alone, in every scope
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
describe('Ctrl+K', () => {
	it('is bound by exactly one registry row (help.palette)', () => {
		const src = readFileSync(new URL('../../src/lib/shortcuts.js', import.meta.url), 'utf8');
		expect(src.match(/keys: 'Ctrl\+K'/g)?.length).toBe(1);
		expect(src).toMatch(/id: 'help\.palette',\s*\n\s*keys: 'Ctrl\+K'/);
	});
});
