// uir-preview — Pin to dock + View | Edit. The pure walk (text joins it, Edit walks library images
// only) and the bridge between the image editor's store and the preview window that hosts it.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { get } from 'svelte/store';

/** @type {any} */ let fp;
/** @type {any} */ let fw;
/** @type {any} */ let ies;

beforeAll(async () => {
	// the bridge installs only in a browser (fileWindows guards on `window`)
	/** @type {any} */ (globalThis).window ??= globalThis;
	fp = await import('../../src/lib/filePreview.js');
	ies = await import('../../src/lib/image/imageEditorState.js');
	fw = await import('../../src/lib/fileWindows.js');
});

const item = (/** @type {string} */ id, /** @type {string} */ kind, extra = {}) => ({ kind: 'item', item: { id, kind, name: id, ...extra } });
const folder = (/** @type {string} */ id) => ({ kind: 'folder', folder: { id, name: id } });

describe('the walk', () => {
	const entries = [folder('f1'), item('a', 'image'), item('t', 'text'), item('s', 'scene'), item('b', 'image', { volumeItem: true, volumeId: 'v' }), item('c', 'image'), item('m', 'object')];

	it('a text file has a face and joins the View walk; a scene still does not', () => {
		expect(fp.previewFaceOf(item('t', 'text'))).toBe('text');
		expect(fp.previewFaceOf(item('s', 'scene'))).toBe(null);
		expect(fp.previewWalk(entries).map(fp.previewIdOf)).toEqual(['f1', 'a', 't', 'b', 'c', 'm']);
	});

	it('Edit walks LIBRARY images only, clamped at both ends', () => {
		expect(fp.imageWalk(entries).map(fp.previewIdOf)).toEqual(['a', 'c']);
		expect(fp.previewIdOf(fp.stepImage(entries, 'a', 1))).toBe('c');
		expect(fp.stepImage(entries, 'c', 1)).toBe(null);
		expect(fp.stepImage(entries, 'a', -1)).toBe(null);
		// lost (not in the list): start from the end the step points at
		expect(fp.previewIdOf(fp.stepImage(entries, 'zz', -1))).toBe('c');
	});
});

describe('View | Edit bridge', () => {
	beforeEach(() => {
		fw.previewWindows.set([]);
		ies.imageEditorTarget.set(null);
	});

	it('opening the editor opens a preview window in Edit; clearing it returns to View', () => {
		ies.imageEditorTarget.set({ itemId: 'a', raise: 1 });
		const list = get(fw.previewWindows);
		expect(list.length).toBe(1);
		expect(list[0]).toMatchObject({ kind: 'image', itemId: 'a', mode: 'edit' });
		expect(get(fw.previewEditWin)).toBe(list[0].id);
		ies.imageEditorTarget.set(null);
		expect(get(fw.previewWindows)[0].mode).toBe('view');
		expect(get(fw.previewEditWin)).toBe(null);
	});

	it('a window entering Edit points the editor at it; ONE window edits at a time', () => {
		fw.previewWindows.set([
			{ id: 901, kind: 'image', itemId: 'a', url: '' },
			{ id: 902, kind: 'image', itemId: 'c', url: '' }
		]);
		fw.setPreviewMode(901, 'edit');
		expect(get(ies.imageEditorTarget)?.itemId).toBe('a');
		fw.setPreviewMode(902, 'edit');
		expect(get(fw.previewWindows).map((/** @type {any} */ w) => w.mode)).toEqual(['view', 'edit']);
		expect(get(ies.imageEditorTarget)?.itemId).toBe('c');
		fw.setPreviewMode(902, 'view');
		expect(get(ies.imageEditorTarget)).toBe(null);
	});

	it('openPreviewEditor re-points the window already showing the image, keeping its bytes', () => {
		fw.previewWindows.set([{ id: 903, kind: 'image', itemId: 'a', url: 'data:x', title: 'a.png' }]);
		const id = fw.openPreviewEditor('a', 'a.png');
		expect(id).toBe(903);
		expect(get(fw.previewWindows)[0]).toMatchObject({ id: 903, mode: 'edit', url: 'data:x' });
	});

	it('the guarded close asks the editor first and keeps the window on "Keep editing"', async () => {
		let answer = false;
		const off = ies.registerEditorGuard(async () => answer);
		fw.previewWindows.set([{ id: 904, kind: 'image', itemId: 'a', url: '', mode: 'edit' }]);
		expect(await fw.closePreviewGuarded(904)).toBe(false);
		expect(get(fw.previewWindows).length).toBe(1);
		answer = true;
		expect(await fw.closePreviewGuarded(904)).toBe(true);
		expect(get(fw.previewWindows).length).toBe(0);
		off();
	});

	it('the Preview tab opens pinned and empty, then waits for a selection', () => {
		fp.previewPinned.set(false);
		fw.openPinnedPreview();
		expect(get(fp.previewPinned)).toBe(true);
		expect(get(fw.previewWindows)[0]).toMatchObject({ kind: 'empty' });
	});
});
