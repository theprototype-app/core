import { describe, it, expect } from 'vitest';
import {
	normTag,
	parseTags,
	normFolder,
	folderPaths,
	allTags,
	prefabView,
	freeFolderName,
	rebase,
	within
} from '../../src/lib/prefabLibraryCore.js';

// 37 R4: folders + tags + filter for the Library's prefab tab, as data.

const lib = [
	{ id: 'a', name: 'Oak chair', folder: 'Furniture/Chairs', tags: ['wood', 'seat'] },
	{ id: 'b', name: 'Steel chair', folder: 'Furniture/Chairs', tags: ['metal', 'seat'] },
	{ id: 'c', name: 'Table', folder: 'Furniture', tags: ['wood'] },
	{ id: 'd', name: 'Lamp', tags: [] },
	{ id: 'e', name: 'Tree' } // an older record: no folder, no tags
];

describe('names', () => {
	it('normalises tags and splits them from text', () => {
		expect(normTag('  Wooden   Chair ')).toBe('wooden chair');
		expect(parseTags('Wood, seat,,wood ,  OUTDOOR')).toEqual(['wood', 'seat', 'outdoor']);
	});
	it('cleans folder paths and refuses separators inside a name', () => {
		expect(normFolder('/Furniture//  Chairs /')).toBe('Furniture/Chairs');
		expect(normFolder('')).toBe('');
		expect(within('Furniture/Chairs', 'Furniture')).toBe(true);
		expect(within('Furnitures', 'Furniture')).toBe(false);
	});
});

describe('the view', () => {
	it('the root shows its folders (with counts) and its loose prefabs', () => {
		const v = prefabView(lib, ['Props'], '', [], '');
		expect(v.folders).toEqual([
			{ path: 'Furniture', name: 'Furniture', count: 3 },
			{ path: 'Props', name: 'Props', count: 0 }
		]);
		expect(v.items.map((p) => p.id)).toEqual(['d', 'e']);
	});
	it('a folder shows its sub-folders and its own prefabs only', () => {
		const v = prefabView(lib, [], 'Furniture', [], '');
		expect(v.folders.map((f) => f.path)).toEqual(['Furniture/Chairs']);
		expect(v.items.map((p) => p.id)).toEqual(['c']);
	});
	it('a tag filter reaches every prefab below the folder, combined with AND', () => {
		expect(prefabView(lib, [], '', ['wood'], '').items.map((p) => p.id)).toEqual(['a', 'c']);
		expect(prefabView(lib, [], '', ['wood', 'seat'], '').items.map((p) => p.id)).toEqual(['a']);
		expect(prefabView(lib, [], 'Furniture/Chairs', ['seat'], '').items.map((p) => p.id)).toEqual(['a', 'b']);
		expect(prefabView(lib, [], '', ['wood'], '').folders).toEqual([]);
	});
	it('the search matches a name or a tag', () => {
		expect(prefabView(lib, [], '', [], 'chair').items.map((p) => p.id)).toEqual(['a', 'b']);
		expect(prefabView(lib, [], '', [], 'meta').items.map((p) => p.id)).toEqual(['b']);
	});
	it('counts tags, most used first', () => {
		expect(allTags(lib)).toEqual([
			{ tag: 'seat', count: 2 },
			{ tag: 'wood', count: 2 },
			{ tag: 'metal', count: 1 }
		]);
	});
});

describe('folders', () => {
	it('an ancestor exists because something lives below it', () => {
		expect([...folderPaths(lib, [])].sort()).toEqual(['Furniture', 'Furniture/Chairs']);
	});
	it('a new folder gets a free name', () => {
		const paths = folderPaths(lib, ['New folder']);
		expect(freeFolderName(paths, '')).toBe('New folder 2');
		expect(freeFolderName(paths, 'Furniture')).toBe('New folder');
	});
	it('a rename re-homes everything below it and nothing beside it', () => {
		expect(rebase('Furniture/Chairs', 'Furniture', 'Home')).toBe('Home/Chairs');
		expect(rebase('Furniture', 'Furniture', 'Home')).toBe('Home');
		expect(rebase('Furnitures', 'Furniture', 'Home')).toBe('Furnitures');
		expect(rebase('Furniture/Chairs', 'Furniture', '')).toBe('Chairs');
	});
});
