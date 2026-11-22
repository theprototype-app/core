// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// 64-text TX7: the agent's text tools on a real objectsGroup, the real history and a recording
// peer — create_text (create_shape {action: 'text'}), set_geometry params on a text (edit_shape
// {action: 'params'}), list_fonts (assets {action: 'fonts'}). What each call writes and sends (the
// record over `objectParameters`, never a mesh), the refusals, and ONE undo per call.
// Mocked: spawnAtPoint (it reaches geometries.svelte.js — runes need the svelte compiler) with the
// real stamp, and textFonts (IndexedDB + network): a Google font "added" by name.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const google = vi.fn(async (family) =>
	family === 'Nope Font'
		? { ok: false, error: 'Google Fonts has no family called "Nope Font".' }
		: { ok: true, font: { hash: 'g'.repeat(64), family, licence: 'SIL Open Font License', url: 'https://openfontlicense.org', noEmbed: false, format: 'ttf' } }
);
vi.mock('../../src/lib/textFonts.js', () => ({
	addGoogleFont: google,
	shareFontAsset: () => {},
	fontAssetInfo: async (hash) => (hash === 'a'.repeat(64) ? { family: 'Uploaded', licence: '', url: '', noEmbed: true } : null),
	bundledFonts: () => [{ id: 'sans', label: 'Noto Sans', kind: 'sans' }],
	libraryFonts: () => [{ hash: 'a'.repeat(64), name: 'Uploaded.ttf', family: 'Uploaded', licence: '', url: '', noEmbed: true }],
	sceneFonts: () => ({ assets: [], bundled: [{ id: 'sans', label: 'Noto Sans', texts: 1 }] })
}));
vi.mock('../../src/lib/addObjects.js', () => ({ spawnAtPoint: (cmd, at) => globalThis.__spawn(cmd, at) }));
// stubbed (it reaches runes): the props undo kind it registers is not here, so a text edit's
// undo is asserted as its ENTRY; applying it is covered on two peers by e2e text-object
vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {} }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {}, physicsShapeChanged: () => {} }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { peers } = await import('../../src/stores/appStore');
const history = await import('../../src/lib/history.js');
const { stampTextPath } = await import('../../src/lib/textPathObject.js');
const { textTool, bundledFontFor } = await import('../../src/lib/ai/textTools.js');
const { geometryTool } = await import('../../src/lib/ai/geometryTools.js');
const { TEXT_CAPS } = await import('../../src/lib/textPathCore.js');

let sent = [];
let group;
globalThis.__spawn = (cmd, at) => {
	const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
	stampTextPath(m, cmd.split(' ')[2] ?? '');
	if (at) m.position.fromArray(at);
	group.add(m);
	history.recordObjectPresence('create', m);
	return m;
};

beforeEach(() => {
	group = new THREE.Group();
	objectsGroup.set(group);
	sent = [];
	peers.set({ send: (m) => sent.push(m) });
	history.undoStack.set([]);
	globalThis.window = globalThis.window ?? {};
	window.__tpTextProfile = undefined;
	google.mockClear();
});

async function call(name, args) {
	history.beginHistoryBatch();
	try {
		return name === 'set_geometry' ? await geometryTool(name, args, () => null) : await textTool(name, args);
	} finally {
		history.endHistoryBatch('Agent: ' + name);
	}
}
const live = (uuid) => group.getObjectByProperty('uuid', uuid);

describe('TX7 create_text', () => {
	it('the agent builds "HELLO" extruded with a bevel: a record, solid, one undo', async () => {
		const r = await call('create_text', { text: 'HELLO', font: 'serif', size: 0.5, depth: 0.15, bevel: 0.01, position: [1, 2, 3] });
		expect(r.error).toBeUndefined();
		const o = live(r.created.uuid);
		expect(o.userData.textPath).toMatchObject({ text: 'HELLO', mode: 'extruded', font: 'serif', size: 0.5, depth: 0.15, bevel: { size: 0.01, thickness: 0.01 } });
		expect(r.created).toMatchObject({ mode: 'solid', font: 'serif' });
		expect(o.position.toArray()).toEqual([1, 2, 3]);
		// the record travels, never a mesh
		const msg = sent.find((m) => m.type === 'objectParameters' && m.parameter === 'textPath');
		expect(msg.textPath.mode).toBe('extruded');
		expect(JSON.stringify(sent).length).toBeLessThan(4000);
		expect(history.undoStack && (await import('svelte/store')).get(history.undoStack).length).toBe(1);
		history.undo();
		expect(live(r.created.uuid)).toBeUndefined();
	});
	it('flat by default; a Google family by name is fetched once and named in the record', async () => {
		const r = await call('create_text', { text: 'Welcome', font: 'Lobster' });
		expect(google).toHaveBeenCalledTimes(1);
		const rec = live(r.created.uuid).userData.textPath;
		expect(rec).toMatchObject({ mode: 'flat', fontAsset: 'g'.repeat(64), fontName: 'Lobster' });
		expect(r.note).toMatch(/added to the Library once/);
	});
	it('refuses plainly: no text, an unknown Google family, past the phone cap', async () => {
		expect((await call('create_text', {})).error).toMatch(/text:/);
		expect((await call('create_text', { text: 'x', font: 'Nope Font' })).error).toMatch(/no family called/);
		window.__tpTextProfile = 'low';
		const r = await call('create_text', { text: 'x'.repeat(TEXT_CAPS.low.extruded + 5), solid: true });
		expect(r.error).toMatch(/too long.*on this device/);
		expect(group.children.length).toBe(0); // the half-made object went with the refusal
	});
	it('bundled fonts by id, name or style word', () => {
		expect(bundledFontFor('Noto Serif').id).toBe('serif');
		expect(bundledFontFor('monospace').id).toBe('plex-mono');
		expect(bundledFontFor('display').id).toBe('pixel');
		expect(bundledFontFor('Lobster')).toBe(null);
	});
});

describe('TX7 edit_shape params on a text', () => {
	it('set_geometry params change the words, the bevel and the font; one undo each', async () => {
		const made = await call('create_text', { text: 'Sign', solid: true });
		const uuid = made.created.uuid;
		const r = await call('set_geometry', { updates: [{ uuid, params: { text: 'Big sign', bevel: false, align: 'left', anchor: 'bottom-left', font: { asset: 'a'.repeat(64) } } }] });
		expect(r.updated[0].ok).toBe(true);
		expect(live(uuid).userData.textPath).toMatchObject({ text: 'Big sign', bevel: { size: 0 }, align: 'start', anchor: 'bottom-left', fontAsset: 'a'.repeat(64), fontMeta: { noEmbed: true } });
		const { get } = await import('svelte/store');
		const top = get(history.undoStack).at(-1);
		const props = top.kind === 'aibatch' ? top.entries : [top];
		expect(props).toHaveLength(1); // ONE undo step for the whole edit
		expect(props[0]).toMatchObject({ kind: 'props', uuid, before: { textPath: { text: 'Sign', fontAsset: null } }, after: { textPath: { text: 'Big sign' } } });
	});
	it('solid text on a path is refused with the reason', async () => {
		const made = await call('create_text', { text: 'Arc' });
		const uuid = made.created.uuid;
		await call('set_geometry', { updates: [{ uuid, params: { text: 'Arc' } }] });
		live(uuid).userData.textPath = { ...live(uuid).userData.textPath, path: { kind: 'arc' } };
		const r = await call('set_geometry', { updates: [{ uuid, params: { solid: true } }] });
		expect(r.error ?? r.updated[0].errors[0]).toMatch(/cannot follow a path/);
	});
});

describe('TX7 list_fonts', () => {
	it('bundled + library (with licence flags) + what the scene uses, and the caps', async () => {
		const r = await call('list_fonts', {});
		expect(r.bundled[0]).toEqual({ font: 'sans', name: 'Noto Sans', style: 'sans' });
		expect(r.library[0]).toMatchObject({ font: { asset: 'a'.repeat(64) }, name: 'Uploaded', noEmbedding: true });
		expect(r.inScene.bundled[0]).toEqual({ font: 'sans', texts: 1 });
		expect(r.caps.solid).toBe(TEXT_CAPS.desktop.extruded);
	});
});
