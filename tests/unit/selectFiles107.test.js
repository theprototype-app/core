import { describe, it, expect } from 'vitest';
import { usersOfFile, holdsValue } from '../../src/lib/ai/filesCore.js';
import { nameProblem, renamedFileName, extensionOf } from '../../src/lib/codeFilesCore.js';

// 107-select-files: who points at a file (rename / move for every kind), and the name rules a non-text file keeps.

const H = 'a'.repeat(64);
const nodes = [
	{ id: 'n1', type: 'sound', data: { hash: H, name: 'boom.ogg' }, __graph: 'scene' },
	{ id: 'n2', type: 'image', data: { params: { file: 'Sounds/boom.ogg' } }, __graph: 'u-1' },
	{ id: 'n3', type: 'note', data: { text: 'boom.ogg is loud' }, __graph: 'scene' },
	{ id: 'n4', type: 'video', data: { deep: { deeper: { deepest: { x: H } } } }, __graph: 'scene' },
	{ id: 'n5', type: 'sound', data: { clips: [{ hash: H }] }, __graph: 'u-2' }
];

describe('107 usersOfFile', () => {
	it('a hash anywhere in the data (3 levels) is a use that follows; a name alone is a use by name', () => {
		const u = usersOfFile({ hash: H, name: 'boom.ogg' }, nodes);
		expect(u.byHash.map((r) => r.node)).toEqual(['n1', 'n5']);
		expect(u.byName).toEqual([{ graph: 'u-1', node: 'n2', type: 'image' }]);
	});
	it('a node carrying the hash AND the name is not a name-only use; prose mentioning the name is not a use', () => {
		const u = usersOfFile({ hash: H, name: 'boom.ogg' }, nodes);
		expect(u.byName.some((r) => r.node === 'n1' || r.node === 'n3')).toBe(false);
	});
	it('the name matches case-insensitively; no hash = name rules only; nothing given = nobody', () => {
		expect(usersOfFile({ name: 'BOOM.OGG' }, nodes).byName.map((r) => r.node)).toEqual(['n1', 'n2']);
		expect(usersOfFile({ hash: '', name: '' }, nodes)).toEqual({ byHash: [], byName: [] });
		expect(usersOfFile({ hash: H, name: 'x.png' }, /** @type {any} */ (null))).toEqual({ byHash: [], byName: [] });
	});
});

describe('107 non-text names', () => {
	it("'name' keeps the generic rules only (a .glb is a fine name), 'file' still wants a text extension", () => {
		expect(nameProblem('tower.glb', 'name')).toBeNull();
		expect(nameProblem('tower.glb', 'file')).toMatch(/Code tab keeps/);
		expect(nameProblem('a/b.glb', 'name')).toMatch(/cannot contain/);
		expect(nameProblem('', 'name')).toMatch(/empty/);
	});
	it('a bare new name keeps the old extension', () => {
		expect(renamedFileName('castle', 'tower.glb')).toBe('castle.glb');
		expect(extensionOf(renamedFileName('clip', 'intro.mp4'))).toBe('mp4');
		expect(renamedFileName('song.ogg', 'boom.ogg')).toBe('song.ogg');
	});
});

import { MORE_KIND, KIND_WORDS, SHOW_KINDS } from '../../src/lib/ai/showCore.js';

describe('107 show: the new actions ask no new question', () => {
	it('reveal, select and flow ride the panel kind; the kinds stay three', () => {
		expect(MORE_KIND).toEqual({ reveal: 'panel', select: 'panel', flow: 'panel' });
		expect(SHOW_KINDS).toEqual(['panel', 'camera', 'code']);
		expect(KIND_WORDS.panel).toMatch(/select/);
	});
});

describe('107 holdsValue (materials, objects, sequences point by content)', () => {
	it('finds a hash inside nested data, within the depth', () => {
		const seq = { name: 'Intro', tracks: [{ items: [{ kind: 'audio', sound: H, name: 'boom.ogg' }] }] };
		expect(holdsValue(seq, H, 5)).toBe(true);
		expect(holdsValue(seq, H, 2)).toBe(false);
		expect(holdsValue({ mapSource: H }, H)).toBe(true);
		expect(holdsValue({ a: 'x' }, H)).toBe(false);
		expect(holdsValue({ a: H }, '')).toBe(false);
	});
});
