// 100 C2-2 / C2-4 — what the Cinematic view draws itself (particles, bursts, bubbles, vertex deformers), and that the
// cover leaves every source exactly as it found it. The TSL graphs are built here without a GPU (no compile).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import * as W from 'three/webgpu';
import * as T from 'three/tsl';
import { fxCoverKind, classifyMaterial, DEFORM_COVERED } from '../../src/lib/cinematic/cinematicCore.js';
import { createFxCover } from '../../src/lib/cinematic/fxCover.js';
import { addDeformer, removeDeformer, deformSpecsOf } from '../../src/lib/vertexDeform.js';

/** a particle emitter as particleRuntime.buildEntry makes it (point or strip mode) @param {boolean} points */
function particleObject(points = true) {
	const g = new THREE.BufferGeometry();
	const n = 8;
	g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
	g.setAttribute('aRand', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
	g.setAttribute('aRand2', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
	g.setAttribute('aIndex', new THREE.BufferAttribute(new Float32Array(n), 1));
	g.setAttribute('aOrigin', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
	g.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
	if (!points) {
		g.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(n), 1));
		g.setAttribute('aSeg', new THREE.BufferAttribute(new Float32Array(n), 1));
	}
	g.setDrawRange(0, 5);
	/** @type {Record<string, any>} */
	const uniforms = {};
	for (const k of ['uTime', 'uMode', 'uBurstT', 'uCount', 'uLifetime', 'uLifeJitter', 'uPhaseNoise', 'uShape', 'uAngle', 'uRadius', 'uSpeed', 'uSpeedJitter', 'uGravity', 'uDrag', 'uTurbulence', 'uSizeStart', 'uSizeEnd', 'uSpin', 'uSizeScale', 'uFall', 'uGround', 'uWorldSpace', 'uAimWorld', 'uInherit', 'uRender', 'uSegs', 'uTrail', 'uColorMode', 'uOpacity', 'uFadeIn', 'uFadeOut'])
		uniforms[k] = { value: 0.5 };
	uniforms.uOffset = { value: new THREE.Vector3() };
	uniforms.uArea = { value: new THREE.Vector2(1, 1) };
	uniforms.uWind = { value: new THREE.Vector3() };
	uniforms.uQuat = { value: new THREE.Vector4(0, 0, 0, 1) };
	uniforms.uMap = { value: new THREE.Texture() };
	uniforms.uColorStart = { value: new THREE.Color('#ffffff') };
	uniforms.uColorEnd = { value: new THREE.Color('#8899aa') };
	const m = new THREE.ShaderMaterial({ uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
	const o = points ? new THREE.Points(g, m) : new THREE.Mesh(g, m);
	o.name = 'particles-node1';
	return o;
}

/** an effectsBurst system @returns {any} */
function burstObject() {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(96 * 3), 3));
	g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(96 * 3), 3));
	g.setDrawRange(0, 40);
	const o = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.1, map: new THREE.Texture(), vertexColors: true, transparent: true }));
	o.name = 'effects-burst-0';
	return o;
}

/** the water runtime's bubble mesh */
function bubbleObject() {
	const plane = new THREE.PlaneGeometry(2, 2);
	const g = new THREE.InstancedBufferGeometry();
	g.index = plane.index;
	g.setAttribute('position', plane.getAttribute('position'));
	g.setAttribute('uv', plane.getAttribute('uv'));
	g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(40), 4));
	g.instanceCount = 10;
	/** @type {Record<string, any>} */
	const uniforms = {};
	for (const k of ['uTime', 'uRiseH', 'uSpeed', 'uSizeMin', 'uSizeMax', 'uWobble', 'uCount', 'uRate', 'uBurstMode', 'uBurstAge', 'uPop', 'uOpacity']) uniforms[k] = { value: 1 };
	for (const k of ['uOrigin', 'uAxisX', 'uAxisZ']) uniforms[k] = { value: new THREE.Vector3() };
	uniforms.uColor = { value: new THREE.Color(1, 1, 1) };
	const o = new THREE.Mesh(g, new THREE.ShaderMaterial({ name: 'water-bubbles', uniforms, transparent: true }));
	o.name = 'water-bubbles';
	return o;
}

/** a mesh with each kind of deformer @param {string[]} kinds */
function deformedMesh(kinds) {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	/** @type {Record<string, Record<string, any>>} */
	const U = {
		jiggle: { jOffset: { value: new THREE.Vector3() }, jPivot: { value: new THREE.Vector3() }, jRadius: { value: 1 }, jFalloff: { value: 1.5 }, jWobble: { value: 0 } },
		bodywave: { bwToRoot: { value: new THREE.Matrix4() }, bwFromRoot: { value: new THREE.Matrix3() }, bwAxis: { value: new THREE.Vector3(0, 0, 1) }, bwSide: { value: new THREE.Vector3(1, 0, 0) }, bwRange: { value: new THREE.Vector2(0, 1) }, bwShape: { value: new THREE.Vector4(1, 0.3, 2, 1) }, bwDrive: { value: new THREE.Vector3() } },
		windsway: { wsToRoot: { value: new THREE.Matrix4() }, wsFromRoot: { value: new THREE.Matrix3() }, wsAxis: { value: new THREE.Vector3(0, 1, 0) }, wsRange: { value: new THREE.Vector2(0, 1) }, wsBend: { value: new THREE.Vector3(1, 0, 0) }, wsDrive: { value: new THREE.Vector4() }, wsMode: { value: 0 } },
		waterflow: { wfToRoot: { value: new THREE.Matrix4() }, wfFromRoot: { value: new THREE.Matrix3() }, wfDrive: { value: new THREE.Vector4() } },
		other: { xA: { value: 1 } }
	};
	kinds.forEach((k, i) => addDeformer(mesh, k + ':' + i, { kind: k, prefix: k.slice(0, 2), key: k + '1', decl: '', vertex: '#include <begin_vertex>', uniforms: U[k] }));
	return mesh;
}

/** a cover over a scene of `objects` */
function coverOf(/** @type {any[]} */ ...objects) {
	const scene = new THREE.Scene();
	for (const o of objects) scene.add(o);
	const glCanvas = /** @type {any} */ ({ width: 1600, height: 900 });
	return { scene, fx: createFxCover({ W, T, scene, glCanvas }) };
}

const deformKinds = (/** @type {any} */ o) => deformSpecsOf(o).map((s) => s.kind);

describe('fxCoverKind', () => {
	it('names each effect the view draws itself', () => {
		expect(fxCoverKind(particleObject(true), particleObject(true).material)).toBe('particles');
		const strip = particleObject(false);
		expect(fxCoverKind(strip, strip.material)).toBe('particleStrip');
		const b = burstObject();
		expect(fxCoverKind(b, b.material)).toBe('burst');
		const bb = bubbleObject();
		expect(fxCoverKind(bb, bb.material)).toBe('bubbles');
	});
	it('leaves look-alikes alone: an unnamed Points, a plain PointsMaterial cloud, a custom ShaderMaterial, a node material', () => {
		const p = particleObject(true);
		p.name = 'my-points';
		expect(fxCoverKind(p, p.material)).toBe(null);
		const cloud = burstObject();
		cloud.name = 'stars';
		expect(fxCoverKind(cloud, cloud.material)).toBe(null);
		const custom = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial({ name: 'water-bubbles' }));
		expect(fxCoverKind(custom, custom.material)).toBe(null); // not instanced: not the bubble mesh
		const n = particleObject(true);
		expect(fxCoverKind(n, new W.MeshBasicNodeMaterial())).toBe(null);
	});
	it('covers a deformed mesh only when every deformer on it has a TSL twin', () => {
		expect(DEFORM_COVERED).toEqual(['jiggle', 'bodywave', 'windsway', 'waterflow']);
		for (const k of DEFORM_COVERED) {
			const mesh = deformedMesh([k]);
			expect(fxCoverKind(mesh, mesh.material, deformKinds)).toBe('deform');
		}
		const both = deformedMesh(['jiggle', 'bodywave']);
		expect(fxCoverKind(both, both.material, deformKinds)).toBe('deform');
		const mixed = deformedMesh(['jiggle', 'other']);
		expect(fxCoverKind(mixed, mixed.material, deformKinds)).toBe(null);
		const plain = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		expect(fxCoverKind(plain, plain.material, deformKinds)).toBe(null);
	});
	it('a covered material is neither swapped nor listed by the stand-in pass', () => {
		const p = particleObject(true);
		expect(classifyMaterial(p, p.material)).toEqual({ swap: true, kind: 'particles' });
		expect(classifyMaterial(p, p.material, { covered: () => true })).toEqual({ swap: false, kind: null });
	});
});

describe('createFxCover', () => {
	it('gives every point effect a twin, hides the source material, and takes it all back', () => {
		const p = particleObject(true);
		const strip = particleObject(false);
		const b = burstObject();
		const bb = bubbleObject();
		const { fx } = coverOf(p, strip, b, bb);
		fx.scan();
		const s = fx.stats();
		expect(s.errors).toEqual([]);
		expect([s.particles, s.bursts, s.bubbles]).toEqual([2, 1, 1]);
		for (const o of [p, strip, b, bb]) {
			expect(o.material.visible).toBe(false);
			const twin = /** @type {any} */ (o.children.find((/** @type {any} */ c) => c.name === 'cinematic-fx'));
			expect(twin?.material?.isNodeMaterial).toBe(true);
			expect(fx.covered(o, o.material)).toBe(true);
		}
		// a point twin draws one quad per live point (the runtime's draw range)
		const pt = /** @type {any} */ (p.children[0]);
		expect(pt.geometry.instanceCount).toBe(5);
		b.geometry.setDrawRange(0, 12);
		fx.scan();
		expect(/** @type {any} */ (b.children[0]).geometry.instanceCount).toBe(12);
		// the strip twin draws the source's own geometry
		expect(/** @type {any} */ (strip.children[0]).geometry).toBe(strip.geometry);
		// a runtime write to its buffers reaches the twin's instanced copy
		const before = b.children[0].material;
		b.geometry.getAttribute('position').needsUpdate = true;
		fx.scan();
		expect(b.children[0].material).toBe(before);
		fx.undo();
		for (const o of [p, strip, b, bb]) {
			expect(o.material.visible).toBe(true);
			expect(o.children.length).toBe(0);
		}
	});
	it('follows the runtime: blending changes, a replaced material is covered again, a removed source drops its twin', () => {
		const b = burstObject();
		const p = particleObject(true);
		const { scene, fx } = coverOf(b, p);
		fx.scan();
		const m = b.children[0].material;
		b.material.blending = THREE.NormalBlending;
		fx.scan();
		expect(m.blending).toBe(THREE.NormalBlending);
		const old = p.material;
		p.material = particleObject(true).material;
		fx.scan();
		expect(old.visible).toBe(true);
		expect(p.material.visible).toBe(false);
		expect(p.children.filter((c) => c.name === 'cinematic-fx').length).toBe(1);
		scene.remove(b);
		fx.scan();
		expect(b.material.visible).toBe(true);
		expect(b.children.length).toBe(0);
		expect(fx.stats().bursts).toBe(0);
		fx.undo();
	});
	it('a deformer becomes a positionNode on its own material clone, and leaves with the view or the deformer', () => {
		const mesh = deformedMesh(['jiggle', 'windsway']);
		const clone = mesh.material;
		const { fx } = coverOf(mesh);
		fx.scan();
		expect(clone.positionNode?.isNode).toBe(true);
		expect(fx.covered(mesh, clone)).toBe(true);
		expect(fx.stats().deform).toBe(1);
		fx.undo();
		expect('positionNode' in clone).toBe(false);
		// on again, then the deformer goes while the view is on
		fx.scan();
		expect(clone.positionNode?.isNode).toBe(true);
		removeDeformer(mesh, 'jiggle:0');
		removeDeformer(mesh, 'windsway:1');
		expect(mesh.material).not.toBe(clone);
		fx.scan();
		expect('positionNode' in clone).toBe(false);
		expect('positionNode' in mesh.material).toBe(false);
		expect(fx.stats().deform).toBe(0);
		fx.undo();
	});
	it('a second deformer added while the view is on rebuilds the node', () => {
		const mesh = deformedMesh(['bodywave']);
		const { fx } = coverOf(mesh);
		fx.scan();
		const first = mesh.material.positionNode;
		addDeformer(mesh, 'waterflow:9', { kind: 'waterflow', prefix: 'wf', key: 'waterflow1', decl: '', vertex: '#include <begin_vertex>', uniforms: { wfToRoot: { value: new THREE.Matrix4() }, wfFromRoot: { value: new THREE.Matrix3() }, wfDrive: { value: new THREE.Vector4() } } });
		fx.scan();
		expect(mesh.material.positionNode).not.toBe(first);
		fx.undo();
	});
});
