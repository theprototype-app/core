// @ts-nocheck — fixture rows; the module under test is typed
// Roadmap 56 C13 — the session volume's pure rules: what each share scope shows, the 50 MB pull
// confirm, and the Save project dialog's model (addendum 2026-10-28f).
import { describe, it, expect } from 'vitest';
import {
	SHARE_SCOPES,
	DEFAULT_SHARE_SCOPE,
	normalizeShareScope,
	volumeProjection,
	projectionHas,
	BIG_PULL_BYTES,
	needsPullConfirm,
	pullQuestion,
	formatBytes,
	totalBytes,
	sessionVolumeId,
	sessionVolumeName,
	normalizeSaveMany,
	saveDialogRows,
	resolveSaveMany
} from '../../src/lib/sessionVolumeCore.js';

const folders = [
	{ id: 'f-art', name: 'Art', parentId: null },
	{ id: 'f-tex', name: 'Textures', parentId: 'f-art' },
	{ id: 'f-scenes', name: 'Scenes', parentId: null },
	{ id: 'f-private', name: 'Taxes', parentId: null }
];
const items = [
	{ id: 'i-scene', name: 'Castle.tpscene', kind: 'scene', folderId: 'f-scenes', hash: 'h-scene', size: 4000 },
	{ id: 'i-brick', name: 'brick.png', kind: 'image', folderId: 'f-tex', hash: 'h-brick', size: 2000 },
	{ id: 'i-song', name: 'song.mp3', kind: 'audio', folderId: null, hash: 'h-song', size: 9000 },
	{ id: 'i-other', name: 'Dungeon.tpscene', kind: 'scene', folderId: 'f-scenes', hash: 'h-other', size: 3000 },
	{ id: 'i-tax', name: 'return.pdf', kind: 'text', folderId: 'f-private', hash: 'h-tax', size: 100 }
];
const sceneHashes = ['h-scene', 'h-brick', 'h-song'];
const projectHashes = ['h-other'];
const names = (p) => p.items.map((i) => i.name).sort();

describe('share scope', () => {
	it('defaults to the current scene — never the whole library (trust boundary, 69)', () => {
		expect(DEFAULT_SHARE_SCOPE).toBe('scene');
		expect(normalizeShareScope(undefined)).toBe('scene');
		expect(normalizeShareScope('everything')).toBe('scene');
		for (const s of SHARE_SCOPES) expect(normalizeShareScope(s)).toBe(s);
	});

	it('scene: only the scene file and what it references, with only their folder chains', () => {
		const p = volumeProjection({ scope: 'scene', folders, items, sceneHashes, projectHashes });
		expect(names(p)).toEqual(['Castle.tpscene', 'brick.png', 'song.mp3']);
		expect(p.folders.map((f) => f.name).sort()).toEqual(['Art', 'Scenes', 'Textures']);
		expect(p.folders.find((f) => f.id === 'f-tex').parentId).toBe('f-art');
		expect(p.items.find((i) => i.hash === 'h-brick').size).toBe(2000);
	});

	it('project: the scene plus the project scenes and shared files', () => {
		const p = volumeProjection({ scope: 'project', folders, items, sceneHashes, projectHashes });
		expect(names(p)).toEqual(['Castle.tpscene', 'Dungeon.tpscene', 'brick.png', 'song.mp3']);
		expect(p.folders.some((f) => f.name === 'Taxes')).toBe(false);
	});

	it('library: everything, every folder', () => {
		const p = volumeProjection({ scope: 'library', folders, items, sceneHashes });
		expect(p.items).toHaveLength(5);
		expect(p.folders).toHaveLength(4);
	});

	it('none: nothing at all', () => {
		expect(volumeProjection({ scope: 'none', folders, items, sceneHashes })).toEqual({ folders: [], items: [] });
	});

	it('a file whose folder chain is broken lands at the root; never names a folder nobody offered', () => {
		const p = volumeProjection({
			scope: 'scene',
			folders: [{ id: 'f-a', name: 'A', parentId: 'f-gone' }],
			items: [{ id: 'x', name: 'x.png', kind: 'image', folderId: 'f-missing', hash: 'hx', size: 1 }],
			sceneHashes: ['hx']
		});
		expect(p.items[0].folderId).toBe(null);
		expect(p.folders).toEqual([]);
	});

	it('the host answers a pull only for a hash in the projection it sent', () => {
		const p = volumeProjection({ scope: 'scene', folders, items, sceneHashes });
		expect(projectionHas(p, 'h-brick')).toBe(true);
		expect(projectionHas(p, 'h-tax')).toBe(false);
		expect(projectionHas(p, '')).toBe(false);
	});
});

describe('bandwidth', () => {
	it('asks above ~50 MB, not at or below', () => {
		expect(BIG_PULL_BYTES).toBe(50 * 1024 * 1024);
		expect(needsPullConfirm(BIG_PULL_BYTES)).toBe(false);
		expect(needsPullConfirm(BIG_PULL_BYTES + 1)).toBe(true);
		expect(needsPullConfirm(3 * 1024 * 1024)).toBe(false);
	});
	it('a Copy selection is judged by its total', () => {
		const rows = [{ size: 20 * 1048576 }, { size: 20 * 1048576 }, { size: 20 * 1048576 }];
		expect(needsPullConfirm(totalBytes(rows))).toBe(true);
		expect(needsPullConfirm(totalBytes(rows.slice(0, 2)))).toBe(false);
	});
	it('says how much and from whom', () => {
		expect(pullQuestion(72 * 1048576, 'AB12')).toBe('Download 72 MB from AB12?');
		expect(formatBytes(1536)).toBe('2 KB');
		expect(formatBytes(1)).toBe('1 byte');
		expect(formatBytes(1.5 * 1048576)).toBe('1.5 MB');
	});
});

describe('volume namespace', () => {
	it('the id can never carry the vol: separator', () => {
		expect(sessionVolumeId('ab:cd/ef')).toBe('session-abcdef');
		expect(sessionVolumeId('AB12-x_y')).toBe('session-AB12-x_y');
		expect(sessionVolumeName('AB12')).toBe("AB12's session");
	});
});

describe('Save project with several libraries open', () => {
	const own = { id: 'library', kind: 'library', name: 'My Library', active: false, canSave: true };
	const sess = { id: 'session-h', kind: 'session', name: "H's session", active: true, canSave: true };
	const viewerSess = { ...sess, canSave: false, reason: "View-only in H's session" };
	const cleanMount = { id: 'm1', kind: 'mount', name: 'Old', active: false, canSave: false, reason: 'No unsaved changes' };

	it('the setting defaults to Ask', () => {
		expect(normalizeSaveMany(undefined)).toBe('ask');
		expect(normalizeSaveMany('nope')).toBe('ask');
		expect(normalizeSaveMany('active')).toBe('active');
		expect(normalizeSaveMany('all')).toBe('all');
	});

	it('one library: saved straight away, no dialog, whatever the setting', () => {
		for (const s of ['ask', 'active', 'all'])
			expect(resolveSaveMany(s, [{ ...own, active: true }])).toEqual({ dialog: false, save: ['library'] });
	});

	it('several + Ask: the dialog', () => {
		expect(resolveSaveMany('ask', [own, sess])).toEqual({ dialog: true, save: [] });
	});

	it('several + Save the active one: only the active one', () => {
		expect(resolveSaveMany('active', [own, sess, cleanMount])).toEqual({ dialog: false, save: ['session-h'] });
		expect(resolveSaveMany('active', [own, viewerSess])).toEqual({ dialog: false, save: [] });
	});

	it('several + Save all I can: every saveable one', () => {
		expect(resolveSaveMany('all', [own, viewerSess, cleanMount])).toEqual({ dialog: false, save: ['library'] });
	});

	it('dialog rows: the active one pre-checked, unsaveable ones disabled with the reason', () => {
		const rows = saveDialogRows([own, viewerSess, cleanMount, { ...sess, id: 'session-2', active: false }]);
		expect(rows.map((r) => [r.id, r.checked, r.disabled])).toEqual([
			['library', false, false],
			['session-h', false, true],
			['m1', false, true],
			['session-2', false, false]
		]);
		expect(rows[1].reason).toMatch(/View-only/);
		expect(rows.map((r) => r.where)).toEqual(['This device', 'Save on host', 'Mounted project', 'Save on host']);
		expect(saveDialogRows([own, sess]).find((r) => r.id === 'session-h').checked).toBe(true);
	});
});
