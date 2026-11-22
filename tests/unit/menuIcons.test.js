import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERB_ICONS, rowIcon } from '../../src/lib/ui/menuIcons.js';

// 78 PL2: the verb -> icon fallback ContextMenuItems uses for rows that name no icon.
const iconSrc = readFileSync(join(import.meta.dirname, '../../src/components/ui/Icon.svelte'), 'utf8');
const mapBody = iconSrc.slice(iconSrc.indexOf('const MAP = {'), iconSrc.indexOf('\n\t};', iconSrc.indexOf('const MAP = {')));
const MAP_KEYS = new Set([...mapBody.matchAll(/^\s*'?([a-z0-9-]+)'?:\s*[A-Z]/gm)].map((m) => m[1]));

describe('menuIcons', () => {
	it('every verb maps to a name in Icon.svelte MAP', () => {
		expect(MAP_KEYS.size).toBeGreaterThan(100);
		const missing = Object.entries(VERB_ICONS).filter(([, name]) => !MAP_KEYS.has(name));
		expect(missing).toEqual([]);
	});
	it('a row keeps its own icon; an empty string means none', () => {
		expect(rowIcon({ label: 'Delete', icon: 'x' })).toBe('x');
		expect(rowIcon({ label: 'Delete', icon: '' })).toBe(null);
	});
	it('a bare command row gets its verb icon, whatever follows the verb', () => {
		expect(rowIcon({ label: 'Delete folder' })).toBe('trash-2');
		expect(rowIcon({ label: 'Rename…' })).toBe('square-pen');
		expect(rowIcon({ label: '  Copy (3)' })).toBe('copy');
		expect(rowIcon({ label: 'Save as…', children: [] })).toBe('save');
	});
	it('choice rows, sections, headers and unknown verbs stay bare', () => {
		expect(rowIcon({ label: 'Show grid', checked: false })).toBe(null);
		expect(rowIcon({ label: 'High', checked: true })).toBe(null);
		expect(rowIcon({ section: 'Edit' })).toBe(null);
		expect(rowIcon({ header: { title: 'Cube' } })).toBe(null);
		expect(rowIcon({ label: 'Medium' })).toBe(null);
		expect(rowIcon(null)).toBe(null);
		expect(rowIcon({})).toBe(null);
	});
});
