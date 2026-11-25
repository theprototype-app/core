// 105 T1: the Explorer picker's filtering, folders and recent list (pure)
import { describe, it, expect } from 'vitest';
import { acceptsItem, filterPickerItems, pickerFolders, recentItems, withRecent, subtreeIds, RECENT_MAX } from '../../src/lib/explorerPickerCore.js';

const folders = [
	{ id: 'f1', name: 'Wood', parentId: null },
	{ id: 'f2', name: 'Oak', parentId: 'f1' },
	{ id: 'f3', name: 'Sounds', parentId: null },
	{ id: 'f4', name: 'Empty', parentId: null }
];
const items = [
	{ id: 'a', name: 'oak_color.png', kind: 'image', folderId: 'f2', createdAt: 3 },
	{ id: 'b', name: 'pine color.jpg', kind: 'image', folderId: 'f1', createdAt: 5 },
	{ id: 'c', name: 'brick.webp', kind: 'image', folderId: null, createdAt: 1 },
	{ id: 'd', name: 'step.mp3', kind: 'audio', folderId: 'f3', createdAt: 9 },
	{ id: 'e', name: 'icon.svg', kind: null, folderId: null, createdAt: 2 },
	{ id: 'g', name: 'Apple.png', kind: 'image', folderId: null, createdAt: 1 }
];

describe('explorer picker filtering', () => {
	it('accepts by kind and by extension', () => {
		expect(acceptsItem(items[0], ['image'])).toBe(true);
		expect(acceptsItem(items[3], ['image'])).toBe(false);
		expect(acceptsItem(items[4], ['image'])).toBe(false);
		expect(acceptsItem(items[4], ['image', '.svg'])).toBe(true);
		expect(acceptsItem(items[3], [])).toBe(true);
	});

	it('lists images only, newest first, ties by name', () => {
		const ids = filterPickerItems(items, folders, { accept: ['image'] }).map((i) => i.id);
		expect(ids).toEqual(['b', 'a', 'g', 'c']);
	});

	it('search needs every word, any case', () => {
		expect(filterPickerItems(items, folders, { accept: ['image'], query: 'COLOR' }).map((i) => i.id)).toEqual(['b', 'a']);
		expect(filterPickerItems(items, folders, { accept: ['image'], query: 'oak color' }).map((i) => i.id)).toEqual(['a']);
		expect(filterPickerItems(items, folders, { accept: ['image'], query: 'nothing' })).toEqual([]);
	});

	it('a folder includes its subfolders; root means the top level only', () => {
		expect(filterPickerItems(items, folders, { accept: ['image'], folderId: 'f1' }).map((i) => i.id)).toEqual(['b', 'a']);
		expect(filterPickerItems(items, folders, { accept: ['image'], folderId: 'f2' }).map((i) => i.id)).toEqual(['a']);
		expect(filterPickerItems(items, folders, { accept: ['image'], folderId: 'root' }).map((i) => i.id)).toEqual(['g', 'c']);
		expect(filterPickerItems(items, folders, { accept: ['image'], folderId: 'all' })).toHaveLength(4);
		expect([...subtreeIds(folders, 'f1')].sort()).toEqual(['f1', 'f2']);
	});

	it('offers only folders that hold an accepted file somewhere under them', () => {
		expect(pickerFolders(items, folders, ['image'])).toEqual([
			{ id: 'f1', path: 'Wood' },
			{ id: 'f2', path: 'Wood / Oak' }
		]);
		expect(pickerFolders(items, folders, ['audio']).map((f) => f.id)).toEqual(['f3']);
	});

	it('recent: front, no duplicates, capped, and only items still listed', () => {
		let recent = withRecent([], 'a');
		recent = withRecent(recent, 'b');
		recent = withRecent(recent, 'a');
		expect(recent).toEqual(['a', 'b']);
		for (let i = 0; i < 20; i++) recent = withRecent(recent, 'x' + i);
		expect(recent).toHaveLength(RECENT_MAX);
		expect(recentItems(['zz', 'c', 'a'], items).map((i) => i.id)).toEqual(['c', 'a']);
	});

	it('survives a cyclic folder list', () => {
		const loop = [
			{ id: 'p', name: 'P', parentId: 'q' },
			{ id: 'q', name: 'Q', parentId: 'p' }
		];
		expect(pickerFolders([{ id: 'i', name: 'x.png', kind: 'image', folderId: 'p' }], loop, ['image']).length).toBe(2);
	});
});
