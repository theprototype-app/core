import { describe, it, expect } from 'vitest';
import {
	FILE_TEMPLATES,
	templateText,
	templateOf,
	nameProblem,
	fileNameFor,
	renamedFileName,
	uniqueName,
	nameTakenBy,
	folderNameTaken,
	moveProblem,
	subtreeOf,
	filesTree,
	extensionOf,
	isTextFileName,
	stemOf
} from '../../src/lib/codeFilesCore.js';
import { projectTree, leavesOf, keyOfTab, filterTree } from '../../src/lib/codeProject.js';
import { parseCheck } from '../../src/lib/codeTabs.js';
import { analyze } from '../../src/lib/behaviours/analyze.js';
import { KIT_PIECES } from '../../src/lib/kit/index.js';

// 70 W1 — files and folders from the Code tab: the pure half (templates, name and move rules, the
// Files group of the Project tree).

const SPECS = KIT_PIECES.map((r) => r.piece.spec);

describe('templates', () => {
	it('three: a script, a Markdown note, a JSON document', () => {
		expect(FILE_TEMPLATES.map((t) => [t.key, t.ext])).toEqual([
			['script', 'js'],
			['note', 'md'],
			['json', 'json']
		]);
	});
	it('the script is a clean behaviour with the lifecycle handlers stubbed', () => {
		const code = templateText('script', 'door_switch.js');
		expect(parseCheck(code, 'behaviour')).toBeNull();
		const m = analyze(code, SPECS);
		expect(m.ok).toBe(true);
		expect(m.lint).toEqual([]);
		expect(m.name).toBe('Door switch');
		for (const h of ['start', 'load', 'roundStart', 'won', 'lost']) expect(code).toMatch(new RegExp('\\b' + h + '\\(\\) \\{\\}'));
	});
	it('a name with a quote cannot break the script out of its string', () => {
		const code = templateText('script', "it's.js");
		expect(parseCheck(code, 'behaviour')).toBeNull();
		expect(analyze(code, SPECS).name).toBe("It's");
	});
	it('the note is headed by its name; the JSON parses', () => {
		expect(templateText('note', 'level ideas.md')).toBe('# level ideas\n\n');
		expect(JSON.parse(templateText('json', 'data.json'))).toEqual({});
		expect(parseCheck(templateText('json', 'data.json'), 'json')).toBeNull();
	});
	it('an unknown template is the script one', () => {
		expect(templateOf('nope').key).toBe('script');
	});
});

describe('names', () => {
	it('extension, stem, text-file test', () => {
		expect(extensionOf('a.JS')).toBe('js');
		expect(extensionOf('.env')).toBe('');
		expect(extensionOf('noext')).toBe('');
		expect(stemOf('rules.js')).toBe('rules');
		expect(isTextFileName('notes.md')).toBe(true);
		expect(isTextFileName('tower.glb')).toBe(false);
		expect(isTextFileName('README')).toBe(false);
	});
	it('the typed name gets the template extension only when it has none', () => {
		expect(fileNameFor('player', 'script')).toBe('player.js');
		expect(fileNameFor('  ideas ', 'note')).toBe('ideas.md');
		// a rename typed without an extension keeps the file's own (case and all)
		expect(renamedFileName('boss', 'enemy.js')).toBe('boss.js');
		expect(renamedFileName(' boss ', 'Enemy.JSON')).toBe('boss.JSON');
		expect(renamedFileName('boss.md', 'enemy.js')).toBe('boss.md');
		expect(renamedFileName('boss', '.env')).toBe('boss');
		expect(renamedFileName('', 'enemy.js')).toBe('');
		expect(fileNameFor('notes.txt', 'note')).toBe('notes.txt');
		expect(fileNameFor('', 'json')).toBe('data.json');
	});
	it('problems: empty, separators, reserved, too long, not a text file', () => {
		expect(nameProblem('')).toMatch(/empty/);
		expect(nameProblem('  ')).toMatch(/empty/);
		expect(nameProblem('a/b.js')).toMatch(/cannot contain/);
		expect(nameProblem('a\\b')).toMatch(/cannot contain/);
		expect(nameProblem('a*')).toMatch(/cannot contain/);
		expect(nameProblem('..')).toMatch(/reserved/);
		expect(nameProblem('x'.repeat(121))).toMatch(/at most/);
		expect(nameProblem('.env')).toMatch(/keeps \.js \.md/);
		expect(nameProblem('picture.png')).toMatch(/end the name/);
		expect(nameProblem('.env', 'folder')).toBeNull();
		expect(nameProblem('Folder.png', 'folder')).toBeNull();
		expect(nameProblem('rules.js')).toBeNull();
	});
	it('a free name numbers before the extension, ignoring case', () => {
		expect(uniqueName('script.js', [])).toBe('script.js');
		expect(uniqueName('script.js', ['Script.js'])).toBe('script 2.js');
		expect(uniqueName('script.js', ['script.js', 'script 2.js'])).toBe('script 3.js');
		expect(uniqueName('script 2.js', ['script 2.js'])).toBe('script 3.js');
		expect(uniqueName('New folder', ['new folder'])).toBe('New folder 2');
	});
	it('a text file name is taken library-wide (one shared-typing document per name), never by itself', () => {
		const items = [
			{ id: 'a', name: 'rules.js' },
			{ id: 'b', name: 'tower.glb' }
		];
		expect(nameTakenBy('Rules.js', items)?.id).toBe('a');
		expect(nameTakenBy('rules.js', items, 'a')).toBeNull();
		expect(nameTakenBy('tower.glb', items)).toBeNull(); // not a text file: not the Code tab's rule
	});
	it('a folder name is taken only under the same parent', () => {
		const folders = [
			{ id: 'f1', name: 'Scripts', parentId: null },
			{ id: 'f2', name: 'Levels', parentId: 'f1' }
		];
		expect(folderNameTaken('scripts', null, folders)).toBe(true);
		expect(folderNameTaken('Scripts', 'f1', folders)).toBe(false);
		expect(folderNameTaken('Scripts', null, folders, 'f1')).toBe(false);
	});
});

describe('moves', () => {
	const folders = [
		{ id: 'a', parentId: null },
		{ id: 'b', parentId: 'a' },
		{ id: 'c', parentId: 'b' },
		{ id: 'd', parentId: null }
	];
	it('the subtree, root first; a parent cycle does not hang', () => {
		expect(subtreeOf('a', folders)).toEqual(['a', 'b', 'c']);
		expect(subtreeOf('x', [{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }])).toEqual(['x', 'y']);
	});
	it('a folder never moves into itself or below itself', () => {
		expect(moveProblem({ kind: 'folder', id: 'a', parentId: null }, 'a', folders)).toMatch(/into itself/);
		expect(moveProblem({ kind: 'folder', id: 'a', parentId: null }, 'c', folders)).toMatch(/into itself/);
		expect(moveProblem({ kind: 'folder', id: 'b', parentId: 'a' }, 'd', folders)).toBeNull();
		expect(moveProblem({ kind: 'folder', id: 'b', parentId: 'a' }, null, folders)).toBeNull();
	});
	it('a move to where it is, or into a folder that is gone, is refused', () => {
		expect(moveProblem({ kind: 'file', id: 'i', parentId: 'a' }, 'a', folders)).toMatch(/already there/);
		expect(moveProblem({ kind: 'file', id: 'i', parentId: null }, null, folders)).toMatch(/already there/);
		expect(moveProblem({ kind: 'file', id: 'i', parentId: null }, 'zz', folders)).toMatch(/gone/);
		expect(moveProblem({ kind: 'file', id: 'i', parentId: null }, 'c', folders)).toBeNull();
	});
});

describe('the Files group', () => {
	const folders = [
		{ id: 'f2', name: 'Zone', parentId: null },
		{ id: 'f1', name: 'Scripts', parentId: null },
		{ id: 'f3', name: 'Doors', parentId: 'f1' },
		{ id: 'f4', name: 'Orphan', parentId: 'gone' }
	];
	const files = [
		{ id: 'i1', name: 'door.js', hash: 'h1', folderId: 'f3' },
		{ id: 'i2', name: 'notes.md', hash: 'h2', folderId: null },
		{ id: 'i3', name: 'tower.glb', hash: 'h3', folderId: 'f1' },
		{ id: 'i4', name: 'cfg.json', hash: 'h4', folderId: 'stale' },
		{ id: 'i5', name: 'a.js', hash: 'h5', folderId: 'f1' }
	];
	const tree = filesTree({ folders, files, detailOf: (f) => (f.hash === 'h1' ? '1 node runs it' : undefined) });
	it('folders first (by name), then files; nested as the Explorer nests them', () => {
		expect(tree.map((n) => n.label)).toEqual(['Orphan', 'Scripts', 'Zone', 'cfg.json', 'notes.md']);
		const scripts = tree.find((n) => n.label === 'Scripts');
		expect(scripts.key).toBe('dir:f1');
		expect(scripts.children.map((/** @type {any} */ n) => n.label)).toEqual(['Doors', 'a.js']);
		expect(scripts.children[0].children[0]).toMatchObject({ key: 'f:i1', label: 'door.js', detail: '1 node runs it', parentId: 'f3', itemId: 'i1' });
	});
	it('only text files are listed; an empty folder is still a place', () => {
		expect(leavesOf(tree).map((l) => l.label)).not.toContain('tower.glb');
		expect(tree.find((n) => n.label === 'Zone').children).toEqual([]);
	});
	it('a stale folder id lands at the root, it does not vanish', () => {
		expect(tree.find((n) => n.label === 'cfg.json')).toMatchObject({ parentId: null });
		expect(tree.find((n) => n.label === 'Orphan')).toMatchObject({ parentId: null });
	});
	it('a script opens as script, a note as text — and the key is the one keyOfTab computes', () => {
		const door = /** @type {any} */ (leavesOf(tree).find((l) => l.label === 'door.js'));
		expect(door.request).toEqual({ source: 'script', ref: { itemId: 'i1' } });
		expect(/** @type {any} */ (leavesOf(tree).find((l) => l.label === 'notes.md')).request).toEqual({ source: 'text', ref: { itemId: 'i2' } });
		expect(keyOfTab({ kind: 'file', itemId: 'i1' })).toBe(door.key);
	});
	it('projectTree carries it as the Files group; search walks the folders', () => {
		const pt = projectTree({ graphs: {}, scripts: files, folders });
		const group = pt.find((g) => g.key === 'grp:files');
		expect(group?.label).toBe('Files');
		expect(leavesOf(filterTree(pt, 'doors')).map((l) => l.label)).toEqual(['door.js']);
	});
});
