import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../../src/stores/sceneStore';
import {
	shaderKeyParts,
	slotShaderKey,
	graphKeyForSlot,
	shaderGraphs,
	shaderGraphsSnapshot,
	setShaderGraphFor,
	compileAndApply,
	clearShaderGraphs,
	isShaderDriven,
	detachFrom,
	shaderTargetSupported,
	shaderRefusalReason,
	copyShaderGraphsOf,
	shaderUniformsOf,
	slotIdFor,
	reconcileShaderGraphs,
	SCENE_GRAPH_KEY
} from '../../src/lib/shaderGraph.js';
import { slotDrawn } from '../../src/lib/slotDrawLayer.js';
import { classifyMaterial } from '../../src/lib/cinematic/cinematicCore.js';

// 105-slot-shaders: a shader document per material slot (`<uuid>/<slotId>`), the object key = every slot without
// its own, the scene default reaching material lists, and the save prune reading a slot key.

/** @returns {any} */
const GRAPH = (/** @type {string} */ hex) => ({
	nodes: [
		{ id: 'c1', type: 'color', position: { x: 60, y: 80 }, data: { value: hex } },
		{ id: 's1', type: 'surface', position: { x: 320, y: 80 }, data: {} }
	],
	edges: [{ id: 'e1', source: 'c1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
});

/** a two-slot box (ids A and B) inside a fresh objects group */
function scene() {
	const group = new THREE.Group();
	const a = new THREE.MeshStandardMaterial({ color: 0xff0000 });
	a.userData.slot = { id: 'A' };
	a.name = 'lid';
	const b = new THREE.MeshStandardMaterial({ color: 0x00ff00 });
	b.userData.slot = { id: 'B' };
	b.name = 'sides';
	const geometry = new THREE.BoxGeometry();
	geometry.clearGroups();
	geometry.addGroup(0, 6, 0);
	geometry.addGroup(6, 30, 1);
	const box = new THREE.Mesh(geometry, [a, b]);
	const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	group.add(box, plain);
	objectsGroup.set(/** @type {any} */ (group));
	return { group, box, plain, a, b };
}

beforeEach(() => clearShaderGraphs());

/** the store with test documents (any shape: the resolution reads only the keys) @param {Record<string, any>} map */
const setDocs = (map) => shaderGraphs.set(/** @type {any} */ (map));

describe('the key', () => {
	it('shaderKeyParts is the one reader', () => {
		expect(shaderKeyParts('u1')).toEqual({ uuid: 'u1', slot: null });
		expect(shaderKeyParts('u1/B')).toEqual({ uuid: 'u1', slot: 'B' });
		expect(shaderKeyParts('u1/B~2')).toEqual({ uuid: 'u1', slot: 'B~2' });
		expect(shaderKeyParts(SCENE_GRAPH_KEY)).toEqual({ uuid: null, slot: null });
		expect(shaderKeyParts('post:x')).toEqual({ uuid: null, slot: null });
		expect(shaderKeyParts('')).toEqual({ uuid: null, slot: null });
		expect(slotShaderKey('u1', 'B')).toBe('u1/B');
		expect(slotShaderKey('u1', null)).toBe('u1');
	});
	it('resolution: slot key -> object key -> scene default -> none', () => {
		expect(graphKeyForSlot('u1', 'B')).toBe(null);
		setDocs({ scene: {} });
		expect(graphKeyForSlot('u1', 'B')).toBe('scene');
		setDocs({ scene: {}, u1: {} });
		expect(graphKeyForSlot('u1', 'B')).toBe('u1');
		setDocs({ scene: {}, u1: {}, 'u1/B': {} });
		expect(graphKeyForSlot('u1', 'B')).toBe('u1/B');
		expect(graphKeyForSlot('u1', 'A')).toBe('u1');
		expect(graphKeyForSlot('u1')).toBe('u1');
	});
	it('a material list is no longer refused; only "no material" is', () => {
		const { box } = scene();
		expect(shaderTargetSupported(box)).toBe(true);
		expect(shaderRefusalReason(box)).toBe('');
		expect(shaderRefusalReason({ material: null })).toBe('That object has no material.');
	});
	it('slotIdFor reads an index, an id or a name', () => {
		const { box } = scene();
		expect(slotIdFor(box, 0)).toBe('A');
		expect(slotIdFor(box, '1')).toBe('B');
		expect(slotIdFor(box, 'B')).toBe('B');
		expect(slotIdFor(box, 'sides')).toBe('B');
		expect(slotIdFor(box, 'nope')).toBe(null);
		expect(slotIdFor(box, '')).toBe(null);
	});
});

describe('the save prune', () => {
	it('a slot key is an orphan when the object OR the slot is gone', () => {
		const { box } = scene();
		const u = box.uuid;
		setDocs({ [u + '/B']: GRAPH('#000000'), [u + '/Z']: GRAPH('#000000'), ['gone/A']: GRAPH('#000000'), [u]: GRAPH('#000000') });
		const asked = /** @type {string[]} */ ([]);
		const out = shaderGraphsSnapshot({
			pruneMissing: (id) => (asked.push(id), !get(objectsGroup)?.getObjectByProperty('uuid', id))
		});
		expect(Object.keys(out).sort()).toEqual([u, u + '/B'].sort());
		// the predicate is asked about the OBJECT, never the slot key
		expect(asked.every((id) => !id.includes('/'))).toBe(true);
	});
	it('a single-material object keeps a slot key naming its one slot (a list that lost the others)', () => {
		const { plain } = scene();
		const id = plain.material.uuid;
		setDocs({ [plain.uuid + '/' + id]: GRAPH('#000000'), [plain.uuid + '/other']: GRAPH('#000000') });
		expect(Object.keys(shaderGraphsSnapshot({ pruneMissing: () => false }))).toEqual([plain.uuid + '/' + id]);
	});
});

describe('compile per slot', () => {
	it('a slot key draws on that slot only; the object key fills the rest; delete falls back', async () => {
		const { box, a, b } = scene();
		const u = box.uuid;
		setShaderGraphFor(u + '/B', GRAPH('#0000ff'), { silent: true });
		const r = await compileAndApply(u + '/B');
		expect(r.ok).toBe(true);
		expect(slotDrawn(box, 0)?.kind).toBe('material');
		expect(slotDrawn(box, 1)?.kind).toBe('shader');
		expect(box.material[0]).toBe(a);
		expect(box.material[1]).not.toBe(b);
		expect(isShaderDriven(u, 'B')).toBe(true);
		expect(isShaderDriven(u, 'A')).toBe(false);
		expect(isShaderDriven(u)).toBe(true);
		// the seated product serializes as the slot's own material
		expect(box.material[1].toJSON().uuid).toBe(b.uuid);

		// the object key reaches every slot WITHOUT its own key
		setShaderGraphFor(u, GRAPH('#ff00ff'), { silent: true });
		await compileAndApply(u);
		expect(slotDrawn(box, 0)?.kind).toBe('shader');
		const productB = box.material[1];
		await compileAndApply(u); // the object key never touches B
		expect(box.material[1]).toBe(productB);

		// deleting the slot key hands B to the object key
		setShaderGraphFor(u + '/B', null, { silent: true });
		await compileAndApply(u + '/B');
		expect(box.material[1]).toBe(b);
		reconcileShaderGraphs();
		await compileAndApply(u);
		expect(slotDrawn(box, 1)?.kind).toBe('shader');

		detachFrom(box);
		expect(box.material[0]).toBe(a);
		expect(box.material[1]).toBe(b);
		expect(isShaderDriven(u)).toBe(false);
	});

	it('the scene default reaches a material list, and an own key wins over it', async () => {
		const { box, plain } = scene();
		setShaderGraphFor(SCENE_GRAPH_KEY, GRAPH('#123456'), { silent: true });
		setShaderGraphFor(box.uuid + '/A', GRAPH('#654321'), { silent: true });
		await compileAndApply(SCENE_GRAPH_KEY);
		expect(slotDrawn(box, 0)?.kind).toBe('material'); // A has its own key: the scene skips it
		expect(slotDrawn(box, 1)?.kind).toBe('shader');
		expect(isShaderDriven(plain.uuid)).toBe(true); // a single-material object: today's path
		expect(Array.isArray(plain.material)).toBe(false);
	});

	it('off wins over a shader: the slot draws the default and keeps its product', async () => {
		const { box, b } = scene();
		b.userData.slot.off = true;
		setShaderGraphFor(box.uuid + '/B', GRAPH('#0000ff'), { silent: true });
		await compileAndApply(box.uuid + '/B');
		expect(slotDrawn(box, 1)?.kind).toBe('off');
		delete b.userData.slot.off;
		const { syncSlotDraw } = await import('../../src/lib/slotDrawLayer.js');
		syncSlotDraw(box);
		expect(slotDrawn(box, 1)?.kind).toBe('shader');
	});

	it('uniforms: every driven slot that has the name', async () => {
		const { box } = scene();
		setShaderGraphFor(box.uuid + '/A', GRAPH('#0000ff'), { silent: true });
		setShaderGraphFor(box.uuid + '/B', GRAPH('#00ff00'), { silent: true });
		await compileAndApply(box.uuid + '/A');
		await compileAndApply(box.uuid + '/B');
		const name = Object.keys(box.material[0].userData.shaderUniforms ?? {}).find((n) => n.includes('c1'));
		expect(name).toBeTruthy();
		expect(shaderUniformsOf(box.uuid, /** @type {string} */ (name)).length).toBe(2);
	});
});

describe('Cinematic view (100: already walks a material list per entry)', () => {
	it('the driven slot is named a shader (its stand-in), the other slot draws its own material', async () => {
		const { box } = scene();
		setShaderGraphFor(box.uuid + '/B', GRAPH('#0000ff'), { silent: true });
		await compileAndApply(box.uuid + '/B');
		expect(classifyMaterial(box, box.material[1]).kind).toBe('shader');
		expect(classifyMaterial(box, box.material[0])).toEqual({ swap: false, kind: null });
	});
});

describe('copies', () => {
	it('copyShaderGraphsOf re-keys the object key and every slot key', () => {
		scene();
		const map = { u1: GRAPH('#000000'), 'u1/A': GRAPH('#111111'), 'u2/A': GRAPH('#222222'), scene: GRAPH('#333333') };
		expect(copyShaderGraphsOf(map, 'u1', 'n1')).toBe(2);
		const keys = Object.keys(get(shaderGraphs)).sort();
		expect(keys).toEqual(['n1', 'n1/A']);
	});
});
