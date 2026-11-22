// @ts-nocheck — scene fixtures built ad hoc (the checkJs rule for test fixtures)
// fix-bake (the 1.61.0 production red, QUESTIONS-64-text-int Q1): Bake → Undo → Redo within about a
// second left the WRITER's object a text while its peers baked. applyRemoteBake waited (an import, its
// own build) and then bailed when the record's IDENTITY had changed — so any write of the same record in
// that window, or the object being replaced under its uuid, cancelled the bake. What cancels a waiting
// bake now is a newer TURN of the record (an undo, a remote edit, a local edit), taken synchronously by
// the writer of that state.
// Mocked: text3dBuild (the build's timing is the test's), textPathRuntime (its font URL), and the
// modules textTools64 mocks for the same reasons (runes, IndexedDB).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const owned = new WeakSet();
/** the next buildExtruded resolves when the test says so */
let release = null;
const build = { calls: 0 };
vi.mock('../../src/lib/text3dBuild.js', () => ({
	ownsGeometry: (g) => !!g && owned.has(g),
	bakeCopy: (g) => {
		const c = g.clone();
		c.userData = { baked: true };
		return c;
	},
	buildExtruded: () => {
		build.calls++;
		return new Promise((resolve) => {
			release = () => {
				const g = new THREE.BoxGeometry(1, 1, 1);
				owned.add(g);
				resolve({ geometry: g, info: { triangles: 12 } });
			};
		});
	},
	extrudedMaterials: () => [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()],
	releaseExtruded: () => {}
}));
vi.mock('../../src/lib/textPathRuntime.js', () => ({ solidFontUrl: async () => '/fonts/sans.ttf' }));
vi.mock('../../src/lib/textFonts.js', () => ({ shareFontAsset: () => {} }));
vi.mock('../../src/lib/addObjects.js', () => ({ spawnAtPoint: () => null }));
vi.mock('$lib/objectActions', () => ({ moveObjectToGroup: () => {} }));
vi.mock('$lib/physics', () => ({ setPhysicsFor: () => {}, physicsShapeChanged: () => {} }));

const { objectsGroup } = await import('../../src/stores/sceneStore');
const { stampTextPath, applyTextPathTo, bumpTextTurn, textTurn } = await import('../../src/lib/textPathObject.js');
const { applyRemoteBake } = await import('../../src/lib/textPathEdit.js');

const flush = () => new Promise((r) => setTimeout(r, 0));

let group;
/** a SOLID text; `built` = its carrier holds the runtime's own extruded build */
function solidText(built = true) {
	const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
	stampTextPath(m, 'solid');
	if (built) {
		const g = new THREE.BoxGeometry(1, 1, 1);
		owned.add(g);
		m.geometry = g;
		m.material = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
	}
	group.add(m);
	return m;
}

beforeEach(() => {
	group = new THREE.Group();
	objectsGroup.set(group);
	release = null;
	build.calls = 0;
});

describe('fix-bake: a waiting bake gives way to a newer turn, not to a reassigned record', () => {
	it('a built solid bakes: the record goes, the mesh is a copy, the name follows', async () => {
		const o = solidText(true);
		const solid = o.geometry;
		await applyRemoteBake(o, bumpTextTurn(o.uuid));
		expect(o.userData.textPath).toBeUndefined();
		expect(o.geometry).not.toBe(solid);
		expect(o.geometry.userData.baked).toBe(true);
		expect(o.name).toBe('Text mesh');
		expect(build.calls).toBe(0);
	});

	it('THE 1.61 RED: the same record written again while the bake builds — it still bakes', async () => {
		const o = solidText(false); // its solid not built here (or parked by an autosave export)
		const turn = bumpTextTurn(o.uuid);
		const pending = applyRemoteBake(o, turn);
		await flush();
		expect(build.calls).toBe(1);
		// a write of the SAME record (new identity, no new turn) — the 1.61 identity guard bailed here
		applyTextPathTo(o, JSON.parse(JSON.stringify(o.userData.textPath)));
		release();
		await pending;
		expect(o.userData.textPath).toBeUndefined();
		expect(o.geometry.userData.baked).toBe(true);
		expect(Array.isArray(o.material) && o.material.length).toBe(2);
	});

	it('an undo that comes after the bake (a newer turn) leaves the text standing', async () => {
		const o = solidText(false);
		const pending = applyRemoteBake(o, bumpTextTurn(o.uuid));
		await flush();
		// the history applier / remote applier: a new turn, then the record
		bumpTextTurn(o.uuid);
		applyTextPathTo(o, o.userData.textPath);
		release();
		await pending;
		expect(o.userData.textPath).toBeTruthy();
		expect(o.name).toBe('Text');
	});

	it('the object replaced under its uuid while the bake builds: the LIVE object bakes', async () => {
		const o = solidText(false);
		const pending = applyRemoteBake(o, bumpTextTurn(o.uuid));
		await flush();
		const twin = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
		stampTextPath(twin, 'solid');
		twin.uuid = o.uuid;
		group.remove(o);
		group.add(twin);
		release();
		await pending;
		expect(twin.userData.textPath).toBeUndefined();
		expect(twin.geometry.userData.baked).toBe(true);
		expect(twin.name).toBe('Text mesh');
	});

	it('the live solid built meanwhile is the one baked (not the stand-in build)', async () => {
		const o = solidText(false);
		const pending = applyRemoteBake(o, bumpTextTurn(o.uuid));
		await flush();
		const runtime = new THREE.BoxGeometry(2, 2, 2); // the runtime's own build landed first
		owned.add(runtime);
		o.geometry = runtime;
		release();
		await pending;
		expect(o.userData.textPath).toBeUndefined();
		o.geometry.computeBoundingBox();
		expect(o.geometry.boundingBox.max.x).toBeCloseTo(1); // a copy of the 2 m runtime box
	});

	it('turns count per uuid and start at zero', () => {
		expect(textTurn('nobody')).toBe(0);
		const a = bumpTextTurn('u-a');
		expect(bumpTextTurn('u-a')).toBe(a + 1);
		expect(textTurn('u-b')).toBe(0);
	});
});
