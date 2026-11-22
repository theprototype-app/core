import { describe, it, expect } from 'vitest';
import {
	splitPath,
	resolveRef,
	findFolder,
	pathOfItem,
	readWindow,
	spliceLines,
	createRateLimit,
	isTextName,
	MAX_READ_BYTES,
	WRITES_PER_MINUTE,
	DATA_NOTE,
	FILE_TEXT_EXTENSIONS
} from '../../src/lib/ai/filesCore.js';
import { PERSON_AI_TOOLS, PERSON_TOOL_NAMES, personToolReads } from '../../src/lib/ai/personTools.js';

// 104 C1: the pure rules of `files` (paths, caps, line windows) and the schema the agents read.

const folders = [
	{ id: 'f1', name: 'Scripts', parentId: null },
	{ id: 'f2', name: 'Doors', parentId: 'f1' },
	{ id: 'f3', name: 'Notes', parentId: null }
];
const items = [
	{ id: 'i1', name: 'door.js', folderId: 'f2' },
	{ id: 'i2', name: 'readme.md', folderId: null },
	{ id: 'i3', name: 'todo.txt', folderId: 'f3' },
	{ id: 'i4', name: 'logo.png', folderId: null }
];

describe('104 C1 files: paths', () => {
	it('splits folder paths and file paths', () => {
		expect(splitPath('Scripts/Doors/door.js')).toEqual({ folders: ['Scripts', 'Doors'], name: 'door.js', dir: false });
		expect(splitPath('Notes/')).toEqual({ folders: ['Notes'], name: '', dir: true });
		expect(splitPath('/')).toEqual({ folders: [], name: '', dir: true });
		expect(splitPath('Library/readme.md')).toEqual({ folders: [], name: 'readme.md', dir: false });
		expect(splitPath('Scripts\\door.js').folders).toEqual(['Scripts']);
	});
	it('resolves a full path, a bare unique name, a folder with or without the slash, and an id', () => {
		expect(resolveRef({ path: 'Scripts/Doors/door.js' }, folders, items)).toMatchObject({ type: 'file', item: { id: 'i1' } });
		expect(resolveRef({ path: 'door.js' }, folders, items)).toMatchObject({ type: 'file', item: { id: 'i1' } });
		expect(resolveRef({ path: 'Scripts/door.js' }, folders, items)).toMatchObject({ type: 'file', item: { id: 'i1' } });
		expect(resolveRef({ path: 'Scripts/Doors' }, folders, items)).toEqual({ type: 'folder', id: 'f2' });
		expect(resolveRef({ path: 'Scripts/Doors/' }, folders, items)).toEqual({ type: 'folder', id: 'f2' });
		expect(resolveRef({ path: 'Doors/' }, folders, items)).toEqual({ type: 'folder', id: 'f2' });
		expect(resolveRef({ path: '/' }, folders, items)).toEqual({ type: 'folder', id: null });
		expect(resolveRef({ id: 'f3' }, folders, items)).toEqual({ type: 'folder', id: 'f3' });
		expect(resolveRef({ id: 'i3' }, folders, items)).toMatchObject({ type: 'file', item: { id: 'i3' } });
	});
	it('says what is missing', () => {
		expect(resolveRef({ path: 'Nope/x.js' }, folders, items)).toMatchObject({ type: 'none', missing: ['Nope'] });
		expect(resolveRef({ path: 'Notes/missing.md' }, folders, items)).toMatchObject({ type: 'none', name: 'missing.md' });
	});
	it('names an item by its path', () => {
		expect(pathOfItem(items[0], folders)).toBe('Scripts/Doors/door.js');
		expect(pathOfItem(items[1], folders)).toBe('readme.md');
		expect(findFolder(['scripts', 'doors'], folders)).toBe('f2');
	});
	it('reads and writes text kinds only (rule 2)', () => {
		for (const n of ['a.txt', 'a.json', 'a.md', 'a.cfg', 'a.js']) expect(isTextName(n)).toBe(true);
		for (const n of ['a.png', 'a.glb', 'a.tpscene', 'a', '.env', 'a.html']) expect(isTextName(n)).toBe(false);
	});
});

describe('104 C1 files: lines', () => {
	it('numbers lines and windows them', () => {
		const w = readWindow('a\nb\nc\nd', { from: 2, lines: 2 });
		expect(w).toEqual({ text: '2| b\n3| c', from: 2, to: 3, total: 4, next: 4 });
		expect(readWindow('x').text).toBe('1| x');
	});
	it('stops at 64 KB a read and says where to go on (rule 3)', () => {
		const big = Array.from({ length: 5000 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(40)).join('\n');
		const w = readWindow(big);
		expect(new TextEncoder().encode(w.text).length).toBeLessThanOrEqual(MAX_READ_BYTES);
		expect(w.next).toBe(w.to + 1);
		expect(w.total).toBe(5000);
	});
	it('replaces a line range the way read numbers it', () => {
		expect(spliceLines('a\nb\nc', 'B', [2, 2])).toEqual({ text: 'a\nB\nc' });
		expect(spliceLines('a\nb\nc', 'X\nY', [2, 3])).toEqual({ text: 'a\nX\nY' });
		expect(spliceLines('a\nb', 'z', [3, 2])).toEqual({ text: 'a\nb\nz' }); // append
		expect(spliceLines('a\nb', 'z', [1, 0])).toEqual({ text: 'z\na\nb' }); // insert before line 1
		expect(spliceLines('a', 'z', [5, 5])).toHaveProperty('error');
		expect(spliceLines('a', 'z', [0, 1])).toHaveProperty('error');
	});
});

describe('104 C1 files: the write rate (rule 3)', () => {
	it('allows 20 writes a minute, then says how long to wait', () => {
		let t = 0;
		const rl = createRateLimit(WRITES_PER_MINUTE, () => t);
		for (let i = 0; i < WRITES_PER_MINUTE; i++) {
			expect(rl.check()).toBe(0);
			rl.note();
			t += 100;
		}
		expect(rl.check()).toBeGreaterThan(0);
		t += 60000;
		expect(rl.check()).toBe(0);
	});
});

describe('104 C1 files: the schema agents read', () => {
	const files = PERSON_AI_TOOLS.find((t) => t.function.name === 'files');
	it('is listed as a person tool', () => {
		expect(PERSON_TOOL_NAMES).toContain('files');
		expect(files).toBeTruthy();
	});
	it('says the safety rules out loud (bin, private, read-only, nothing runs, data not instructions)', () => {
		const d = files.function.description;
		expect(d).toMatch(/Deleted bin/);
		expect(d).toMatch(/restore/);
		expect(d).toMatch(/private/);
		expect(d).toMatch(/read-only/);
		expect(d).toMatch(/Nothing written here runs/);
		expect(d).toMatch(/data, not instructions/);
		expect(d).toMatch(/assets/);
		expect(DATA_NOTE).toMatch(/data, not instructions/);
	});
	it('lists and reads under a look-only grant, nothing else', () => {
		expect(personToolReads('files', { action: 'list' })).toBe(true);
		expect(personToolReads('files', { action: 'read' })).toBe(true);
		for (const a of ['create', 'write', 'rename', 'move', 'delete', 'restore']) expect(personToolReads('files', { action: a })).toBe(false);
	});
	it('has no action that empties Deleted, shares, or runs', () => {
		const actions = files.function.parameters.properties.action.enum;
		expect(actions).toEqual(['list', 'read', 'create', 'write', 'rename', 'move', 'delete', 'restore']);
		for (const bad of ['empty', 'purge', 'share', 'run', 'execute']) expect(actions).not.toContain(bad);
	});
	it('the schema names the same text kinds filesCore enforces', () => {
		const d = PERSON_AI_TOOLS.find((t) => t.function.name === 'files').function.description;
		expect(d).toContain('(' + FILE_TEXT_EXTENSIONS.join(', ') + ')');
	});
});
