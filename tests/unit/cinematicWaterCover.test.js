// 100 C2-3 — water in the Cinematic view: which meshes the view draws itself, that the TSL port reads every uniform the
// standard view's GLSL reads (so each water setting drives both views), and that the cover leaves every source as it
// found it. The TSL graphs are built here without a GPU (no compile).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import * as W from 'three/webgpu';
import * as T from 'three/tsl';
import { waterCoverKind, fxCoverKind, classifyMaterial } from '../../src/lib/cinematic/cinematicCore.js';
import { createWaterCover, WATER_LAYER } from '../../src/lib/cinematic/waterCover.js';
import { surfaceVertex, surfaceFragment, overlayFragment, MAX_SHADER_WAVES, MAX_SHADER_RIPPLES } from '../../src/lib/water/waterShader.js';

/** every `uniform <type> <name>[n];` the GLSL declares @param {string} src */
const declared = (src) => [...src.matchAll(/uniform\s+(\w+)\s+(\w+)(\[[^\]]+\])?\s*;/g)].map((m) => ({ type: m[1], name: m[2], array: !!m[3] }));

/** the GLSL's uniforms read by the view some other way, with where (not a TSL uniform of the twin) */
const REPLACED = {
	uSceneColor: 'the scene pass colour (pipeline setSceneTextures)',
	uSceneDepth: 'the scene pass depth (pipeline setSceneTextures)',
	uViewport: 'screenUV',
	uSSActive: 'the view always has its pre-pass (the scene pass)',
	uCamNear: 'getViewPosition + cameraProjectionMatrixInverse',
	uCamFar: 'getViewPosition + cameraProjectionMatrixInverse',
	uProjInv: 'cameraProjectionMatrixInverse',
	uCamWorld: 'cameraWorldMatrix',
	uSelMask: 'not drawn: the editor selection un-refract mask (the view outlines the selection itself)',
	uSelActive: 'not drawn: see uSelMask',
	uReflTex: 'not drawn: WATER_PLANAR (a second scene render)',
	uReflMatrix: 'not drawn: WATER_PLANAR',
	uEnvMap: 'scene.environment through pmremTexture (the view holds a CPU copy of the HDRI)',
	uEnvTexel: 'pmremTexture sizes the atlas itself',
	uEnvMaxMip: 'pmremTexture sizes the atlas itself',
	uUnderwater: "the twin's own uniform (the runtime's hook that writes it skips the WebGPU renderer)",
	uNormalMap: 'texture(uNormalMap.value)',
	uWaveA: 'uniformArray', uWaveB: 'uniformArray', uRipple: 'uniformArray', uRippleAge: 'uniformArray'
};

/** a uniform holder for a GLSL type @param {{ type: string, name: string, array: boolean }} u */
function holder(u) {
	if (u.array) {
		const n = u.name.startsWith('uWave') ? MAX_SHADER_WAVES : MAX_SHADER_RIPPLES;
		const make = () => (u.type === 'vec4' ? new THREE.Vector4() : u.type === 'vec2' ? new THREE.Vector2() : 0);
		return { value: Array.from({ length: n }, make) };
	}
	switch (u.type) {
		case 'vec2': return { value: new THREE.Vector2(1, 1) };
		case 'vec3': return { value: /Color|Shallow|Deep|Emissive|Sky|Sun/.test(u.name) && !/Dir/.test(u.name) ? new THREE.Color(0.5, 0.5, 0.5) : new THREE.Vector3(0, 1, 0) };
		case 'mat3': return { value: new THREE.Matrix3() };
		case 'mat4': return { value: new THREE.Matrix4() };
		case 'sampler2D': return { value: u.name === 'uNormalMap' ? new THREE.DataTexture(new Uint8Array(4), 1, 1) : null };
		default: return { value: 0.5 };
	}
}

/** the runtime's surface / body ShaderMaterial, its uniforms built from the GLSL itself @param {number} body @param {Record<string, any>} [shared] */
function waterMaterial(body, shared = {}) {
	/** @type {Record<string, any>} */
	const uniforms = {};
	for (const u of [...declared(surfaceVertex), ...declared(surfaceFragment)]) uniforms[u.name] ??= shared[u.name] ?? holder(u);
	uniforms.uBody = { value: body };
	return new THREE.ShaderMaterial({ name: body ? 'water-body' : 'water-surface', uniforms });
}

/** a water entry as waterRuntime.createEntry makes it, under a scene-root group @returns {any} */
function entry(withBody = true) {
	const object = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), new THREE.MeshStandardMaterial({ color: '#3399ff' }));
	object.userData.water = { shape: 'box' };
	const sg = new THREE.PlaneGeometry(2, 2, 4, 4);
	sg.setAttribute('aEdge', new THREE.Float32BufferAttribute(new Float32Array(sg.getAttribute('position').count).fill(1), 1));
	const shared = {};
	const surface = new THREE.Mesh(sg, waterMaterial(0, shared));
	surface.name = 'water-surface';
	Object.assign(shared, surface.material.uniforms);
	let body = null;
	if (withBody) {
		const bg = new THREE.BoxGeometry(2, 1, 2);
		bg.setAttribute('aTop', new THREE.Float32BufferAttribute(new Float32Array(bg.getAttribute('position').count), 1));
		body = new THREE.Mesh(bg, waterMaterial(1, surface.material.uniforms));
		body.name = 'water-body';
	}
	return { object, surface, body, ready: true, visible: true, uniforms: surface.material.uniforms };
}

function overlayMesh() {
	const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ name: 'water-underwater' }));
	m.name = 'water-underwater';
	return m;
}

describe('waterCoverKind', () => {
	it('names the runtime surface, the tank body and the underwater tint, and nothing else', () => {
		const e = entry();
		expect(waterCoverKind(e.surface, e.surface.material)).toBe('surface');
		expect(waterCoverKind(e.body, e.body.material)).toBe('body');
		const ov = overlayMesh();
		expect(waterCoverKind(ov, ov.material)).toBe('overlay');
		// the author's placeholder (a plain material) and a look-alike shader without the water uniforms are not water
		expect(waterCoverKind(e.object, e.object.material)).toBe(null);
		const fake = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ name: 'water-surface' }));
		expect(waterCoverKind(fake, fake.material)).toBe(null);
		expect(waterCoverKind(null, null)).toBe(null);
	});
	it('a covered surface takes no stand-in and leaves the chip; uncovered it is still "water"', () => {
		const e = entry();
		expect(classifyMaterial(e.surface, e.surface.material)).toEqual({ swap: true, kind: 'water' });
		expect(classifyMaterial(e.surface, e.surface.material, { covered: () => true })).toEqual({ swap: false, kind: null });
	});
	it('pour and spill drops are an fx piece (they read "Particles" in the chip before)', () => {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
		g.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(4), 1));
		const m = new THREE.ShaderMaterial({ uniforms: { uSize: { value: 0.045 }, uScale: { value: 800 }, uColor: { value: new THREE.Color() } } });
		const p = new THREE.Points(g, m);
		p.name = 'pour-drops';
		expect(fxCoverKind(p, m)).toBe('drops');
		p.name = 'spill-drops';
		expect(fxCoverKind(p, m)).toBe('drops');
		p.name = 'other';
		expect(fxCoverKind(p, m)).toBe(null);
	});
});

describe('the TSL port reads what the GLSL reads', () => {
	const src = fs.readFileSync(new URL('../../src/lib/cinematic/waterCover.js', import.meta.url), 'utf8');
	const all = [...declared(surfaceVertex), ...declared(surfaceFragment)];
	it('every surface / body uniform is read through U.<name> or S.<name>, or is listed with its replacement', () => {
		/** @type {string[]} */
		const missing = [];
		for (const u of all) {
			if (u.name === 'uBody' || u.name === 'uTime' && /U\.uTime/.test(src)) continue;
			if (REPLACED[/** @type {keyof typeof REPLACED} */ (u.name)]) continue;
			if (!new RegExp(`[US]\\.${u.name}\\b`).test(src)) missing.push(u.name);
		}
		expect(missing).toEqual([]);
	});
	it('the replacement list names no uniform the GLSL lacks (it would hide a rename)', () => {
		const names = new Set([...all, ...declared(overlayFragment)].map((u) => u.name));
		expect(Object.keys(REPLACED).filter((k) => !names.has(k))).toEqual([]);
	});
});

describe('createWaterCover', () => {
	function setup(withBody = true) {
		const scene = new THREE.Scene();
		const root = new THREE.Group();
		scene.add(root);
		const e = entry(withBody);
		scene.add(e.object);
		root.add(e.surface);
		if (e.body) root.add(e.body);
		const overlay = overlayMesh();
		root.add(overlay);
		const camera = new THREE.PerspectiveCamera();
		let under = /** @type {any} */ (null);
		const viewState = (/** @type {any} */ _c, /** @type {any[]} */ out = []) => {
			out.length = 0;
			out.push(e);
			return { entries: out, overlay, under, sun: new THREE.Color(1, 1, 1) };
		};
		const cover = createWaterCover({ W, T, scene, viewState, camera: () => camera });
		return { scene, e, overlay, cover, setUnder: (/** @type {any} */ u) => (under = u) };
	}

	it('twins the surface and the body on the water layer, hides their runtime materials, covers them', () => {
		const { e, cover, overlay } = setup();
		const sm = e.surface.material;
		const bm = e.body.material;
		cover.scan();
		const st = cover.stats();
		expect(st.errors).toEqual([]);
		expect(st.surfaces).toBe(1);
		expect(st.bodies).toBe(1);
		expect(cover.count).toBe(2);
		const twin = /** @type {any} */ (e.surface.children.find((/** @type {any} */ c) => c.name === 'cinematic-water'));
		expect(twin).toBeTruthy();
		expect(twin.layers.mask).toBe(1 << WATER_LAYER);
		expect(twin.material.isNodeMaterial && !!twin.material.positionNode && !!twin.material.colorNode).toBe(true);
		expect(twin.geometry).toBe(e.surface.geometry);
		expect(sm.visible).toBe(false);
		expect(bm.visible).toBe(false);
		expect(overlay.material.visible).toBe(false);
		expect(cover.covered(e.surface, sm)).toBe(true);
		expect(cover.covered(e.body, bm)).toBe(true);
		expect(cover.covered(overlay, overlay.material)).toBe(true);
		expect(cover.covered(e.object, e.object.material)).toBe(false);
		// a second scan builds nothing new
		cover.scan();
		expect(e.surface.children.filter((/** @type {any} */ c) => c.name === 'cinematic-water').length).toBe(1);
	});

	it('the placeholder is hidden for one view frame only (beforeRender / afterRender), never left swapped', () => {
		const { e, cover } = setup();
		const own = e.object.material;
		cover.scan();
		cover.beforeRender();
		expect(e.object.material).not.toBe(own);
		expect(e.object.material.visible).toBe(false);
		cover.afterRender();
		expect(e.object.material).toBe(own);
		// an entry whose programs are not ready keeps its placeholder (as under WebGL)
		e.ready = false;
		cover.beforeRender();
		expect(e.object.material).toBe(own);
		cover.afterRender();
	});

	it('a new runtime material (a tier change) is twinned again; a gone entry loses its twin', () => {
		const { e, cover } = setup(false);
		cover.scan();
		const first = /** @type {any} */ (e.surface.children.find((/** @type {any} */ c) => c.name === 'cinematic-water'));
		const old = e.surface.material;
		e.surface.material = waterMaterial(0, old.uniforms);
		cover.scan();
		expect(old.visible).toBe(true);
		const second = /** @type {any} */ (e.surface.children.find((/** @type {any} */ c) => c.name === 'cinematic-water'));
		expect(second).toBeTruthy();
		expect(second).not.toBe(first);
		expect(e.surface.material.visible).toBe(false);
	});

	it('under water: the tank shows its inner faces and the post look switches on', () => {
		const { e, cover, setUnder } = setup();
		setUnder({ entry: e, look: { fogColor: '#204060', fogDistance: 6, caustics: 0.5, causticScale: 1.2, causticSpeed: 0.6 }, surfaceY: 1 });
		cover.scan();
		const body = /** @type {any} */ (e.body.children.find((/** @type {any} */ c) => c.name === 'cinematic-water'));
		expect(body.material.side).toBe(W.BackSide);
		expect(cover.under.on.value).toBe(1);
		expect(cover.under.fogFar.value).toBe(6);
		expect(cover.stats().underwater).toBe(true);
		setUnder(null);
		cover.scan();
		expect(body.material.side).toBe(W.FrontSide);
		expect(cover.under.on.value).toBe(0);
	});

	it('leaving the view puts every source back as it was', () => {
		const { scene, e, cover, overlay } = setup();
		const own = e.object.material;
		cover.scan();
		cover.beforeRender();
		cover.undo();
		let twins = 0;
		scene.traverse((o) => {
			if (o.name === 'cinematic-water') twins++;
		});
		expect(twins).toBe(0);
		expect(e.surface.material.visible).toBe(true);
		expect(e.body.material.visible).toBe(true);
		expect(overlay.material.visible).toBe(true);
		expect(e.object.material).toBe(own);
	});

	it('no detail map yet (the runtime sets it on its first tick): no twin, no error, the stand-in stays', () => {
		const { e, cover } = setup(false);
		e.surface.material.uniforms.uNormalMap.value = null;
		cover.scan();
		expect(cover.count).toBe(0);
		expect(e.surface.material.visible).not.toBe(false);
		expect(cover.stats().errors).toEqual([]);
	});
});
