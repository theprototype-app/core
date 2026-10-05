// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, TControls, selectedObjects, lockedObjects } from '../../stores/sceneStore';
import { HELPER_LAYER } from '../helperLayer';
import { isEditOverlay } from '../editOverlays';
import { qualityOverrides } from '../qualityGovernor';
import { noteSimplified } from './simplifiedNotice.js';
import { sessionNow } from '../sessionClock';
import { waterVolumes, invertAffine, localBounds } from './volumes.js';
import { waveComponents } from './waves.js';
import { resolveLook, resolveBubbles, MAX_BUBBLES } from './presets.js';
import { waterDetailTexture } from './waterTextures.js';
import { waterQuality } from './waterPrefs.js';
import {
	surfaceVertex,
	surfaceFragment,
	bubbleVertex,
	bubbleFragment,
	overlayVertex,
	overlayFragment,
	MAX_SHADER_WAVES,
	MAX_SHADER_RIPPLES
} from './waterShader.js';

// 36-water — the RENDERER. Every object carrying userData.water (W1, volumes.js) gets
// LOCAL visuals under the scene-root 'water-root' group (golden rule 5: never inside
// objectsGroup, so nothing here enters a save, the wire or undo):
//   surface  a grid at the volume's level, Gerstner waves + W2 ripples in the vertex shader
//   body     walls + floor of a box/cylinder tank (an ocean `plane` has none)
//   bubbles  one InstancedMesh, analytic motion (no per-frame CPU work per bubble)
// and the object's OWN mesh is swapped to an invisible material for each render call
// (the lod.js bracket: scene.onBeforeRender/onAfterRender), so picking, the gizmo,
// physics and every serializer still see the plain box the user created.
//
// TIERS (LOCAL, `waterPrefs.waterQuality`, auto by default):
//   high/medium  desktop: a pre-pass renders the scene WITHOUT water into a colour + depth
//                target (full / half resolution) once per frame; the surface samples it for
//                refraction, absorption by real thickness, shoreline foam and caustics.
//                Opaque — no sorting. Planar reflection on the nearest 'planar' volume.
//   quest        headset, phone, or the governor past "post off": no screen-space passes,
//                a blurred-sky fake refraction, analytic thickness, alpha blending.
// Underwater (camera inside a volume): scene fog + background swapped to the water fog
// for the render call, plus a full-screen tint (with caustics on desktop).
//
// Determinism: waves/ripples/bubbles read the shared clock (sessionNow), the same one the
// CPU query (36-sim buoyancy) uses — set here through waterVolumes.setClock.

const DAY_MS = 86400000;
/** seconds of the shared day (double precision — never hand this to a shader raw) */
export function waterClock() {
	if (frozenClock !== null) return frozenClock;
	return (sessionNow() % DAY_MS) / 1000;
}
/** @type {number | null} */ let frozenClock = null;
/**
 * TEST/EVIDENCE (36-fb-water F13/S2): hold the water clock at `t` seconds (null = live) so two
 * frames differ ONLY by the parameter under test — waves, detail ripples and bubbles all read it.
 * Local to this page; nothing replicates. @param {number | null} t
 */
export function freezeWaterClock(t) {
	frozenClock = typeof t === 'number' && Number.isFinite(t) ? t : null;
}
waterVolumes.setClock(waterClock);

/** @type {any} */ let root = null;
/** @type {any} */ let sceneRef = null;
/** @type {any} */ let rendererRef = null;
/** @type {Map<string, any>} volume uuid -> entry */
const entries = new Map();
/** @type {Map<string, any>} standalone bubble emitter uuid -> entry */
const emitters = new Map();
/** @type {any[]} the volumes of the last scan (query fast path) */
let volumeList = [];
let dirty = true;
let lastScan = 0;
let frameNo = 0;
let qualityPref = 'auto';
/** @type {any} */
let overrides = { postOff: false, aoOff: false, dprScale: 1, particlesCapped: false };
let tier = 'high';
/** @type {any} */ let underwater = null;
let installedScene = /** @type {any} */ (null);
/** @type {any} */ let prevBefore = null;
/** @type {any} */ let prevAfter = null;
let renderDepth = 0;
/** @type {any[]} */
const swapped = [];

objectsGroup.subscribe(() => (dirty = true));
waterQuality.subscribe((v) => (qualityPref = v));
qualityOverrides.subscribe((o) => (overrides = o));

const invisible = new THREE.MeshBasicMaterial({ visible: false });

// ── shared uniforms (one object per uniform, referenced by every material) ─────────────
const shared = {
	uTime: { value: 0 },
	uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
	uSunColor: { value: new THREE.Color(1, 1, 1) },
	uSkyTop: { value: new THREE.Color(0.55, 0.7, 0.9) },
	uSkyHorizon: { value: new THREE.Color(0.75, 0.82, 0.9) },
	uSkyBottom: { value: new THREE.Color(0.25, 0.27, 0.3) },
	uNormalMap: { value: /** @type {any} */ (null) },
	uSceneColor: { value: /** @type {any} */ (null) },
	uSceneDepth: { value: /** @type {any} */ (null) },
	uViewport: { value: new THREE.Vector2(1, 1) },
	uSSActive: { value: 0 },
	// 36-fb-water F13b: where the selection is (soft mask, pre-pass size / 2); 0 = nothing selected
	uSelMask: { value: /** @type {any} */ (null) },
	uSelActive: { value: 0 },
	uCamNear: { value: 0.1 },
	uCamFar: { value: 1000 },
	uProjInv: { value: new THREE.Matrix4() },
	uCamWorld: { value: new THREE.Matrix4() }
};

// ── quality tier ──────────────────────────────────────────────────────────────────────
/** @param {any} renderer */
function resolveTier(renderer) {
	if (renderer?.xr?.isPresenting) return 'quest';
	if (qualityPref === 'low') return 'quest';
	if (qualityPref === 'high') return 'high';
	if (qualityPref === 'medium') return 'medium';
	// 36-fb-water F27: a PHONE follows the current quality level like any device (it used to be
	// pinned to the Quest tier, so Aquarium never refracted on a phone even at Full quality): the
	// governor's phone start (AO off, 72 %) is the half-res screen-space tier, a phone that steps
	// up gets full refraction, one that steps down past "post off" gets the Quest tier
	if (overrides.postOff) return 'quest';
	if (overrides.aoOff || overrides.dprScale < 0.8) return 'medium';
	return 'high';
}

// ── geometry ──────────────────────────────────────────────────────────────────────────
/** world size of a local extent along a matrix column @param {number[]} m @param {number} col */
function axisScale(m, col) {
	return Math.hypot(m[col * 4], m[col * 4 + 1], m[col * 4 + 2]) || 1;
}

/** segment count for a world length @param {number} worldLen @param {number} cell @param {number} cap */
function segs(worldLen, cell, cap) {
	return Math.max(4, Math.min(cap, Math.ceil(worldLen / cell)));
}

/**
 * Surface grid in the object's LOCAL frame at y = level. aEdge ramps 0 → 1 over two cells
 * from the rim so the rim moves only vertically (it must meet the body's top edge).
 * @param {string} shape @param {any} b bounds @param {number} level @param {number} sx @param {number} sz
 */
function surfaceGeometry(shape, b, level, sx, sz) {
	const g = new THREE.BufferGeometry();
	/** @type {number[]} */ const pos = [];
	/** @type {number[]} */ const uv = [];
	/** @type {number[]} */ const edge = [];
	/** @type {number[]} */ const index = [];
	if (shape === 'cylinder') {
		const cx = (b.minX + b.maxX) / 2;
		const cz = (b.minZ + b.maxZ) / 2;
		const rx = (b.maxX - b.minX) / 2;
		const rz = (b.maxZ - b.minZ) / 2;
		const rings = Math.max(4, Math.round(Math.max(sx, sz) / 2));
		const around = Math.max(24, Math.min(160, Math.round(Math.max(sx, sz) * 2)));
		pos.push(cx, level, cz);
		uv.push(0.5, 0.5);
		edge.push(1);
		for (let r = 1; r <= rings; r++) {
			const f = r / rings;
			for (let a = 0; a < around; a++) {
				const th = (a / around) * Math.PI * 2;
				pos.push(cx + Math.cos(th) * rx * f, level, cz + Math.sin(th) * rz * f);
				uv.push(0.5 + Math.cos(th) * f * 0.5, 0.5 + Math.sin(th) * f * 0.5);
				edge.push(Math.min(1, (rings - r) / 2));
			}
		}
		for (let a = 0; a < around; a++) index.push(0, 1 + ((a + 1) % around), 1 + a);
		for (let r = 1; r < rings; r++) {
			const o = 1 + (r - 1) * around;
			const n = 1 + r * around;
			for (let a = 0; a < around; a++) {
				const a1 = (a + 1) % around;
				index.push(o + a, o + a1, n + a, o + a1, n + a1, n + a);
			}
		}
	} else {
		for (let j = 0; j <= sz; j++) {
			for (let i = 0; i <= sx; i++) {
				const u = i / sx;
				const v = j / sz;
				pos.push(b.minX + (b.maxX - b.minX) * u, level, b.minZ + (b.maxZ - b.minZ) * v);
				uv.push(u, v);
				const rim = Math.min(i, sx - i, j, sz - j);
				edge.push(shape === 'plane' ? Math.min(1, rim / 2) : Math.min(1, rim / 2));
			}
		}
		for (let j = 0; j < sz; j++) {
			for (let i = 0; i < sx; i++) {
				const a = j * (sx + 1) + i;
				const c = a + sx + 1;
				index.push(a, c, a + 1, a + 1, c, c + 1);
			}
		}
	}
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute(
		'normal',
		new THREE.Float32BufferAttribute(
			new Array((pos.length / 3) * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)),
			3
		)
	);
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
	g.setAttribute('aTop', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(0), 1));
	g.setIndex(index);
	return g;
}

/**
 * Tank walls + floor (LOCAL frame), top edge at `level` and flagged aTop = 1 so it follows
 * the waves. Walls are split along their width so that edge can bend.
 * @param {string} shape @param {any} b @param {number} level @param {number} sx @param {number} sz
 */
function bodyGeometry(shape, b, level, sx, sz) {
	const g = new THREE.BufferGeometry();
	/** @type {number[]} */ const pos = [];
	/** @type {number[]} */ const nrm = [];
	/** @type {number[]} */ const top = [];
	/** @type {number[]} */ const index = [];
	const y0 = b.minY;
	const y1 = level;
	/** @param {number[][]} pts @param {number[]} n @param {number[]} tops */
	const quadStrip = (pts, n, tops) => {
		const base = pos.length / 3;
		for (let k = 0; k < pts.length; k++) {
			pos.push(...pts[k]);
			nrm.push(...n);
			top.push(tops[k]);
		}
		return base;
	};
	if (shape === 'cylinder') {
		const cx = (b.minX + b.maxX) / 2;
		const cz = (b.minZ + b.maxZ) / 2;
		const rx = (b.maxX - b.minX) / 2;
		const rz = (b.maxZ - b.minZ) / 2;
		const around = Math.max(24, Math.min(160, Math.round(Math.max(sx, sz) * 2)));
		const base = pos.length / 3;
		for (let a = 0; a <= around; a++) {
			const th = (a / around) * Math.PI * 2;
			const c = Math.cos(th);
			const s = Math.sin(th);
			pos.push(cx + c * rx, y0, cz + s * rz, cx + c * rx, y1, cz + s * rz);
			nrm.push(c, 0, s, c, 0, s);
			top.push(0, 1);
		}
		for (let a = 0; a < around; a++) {
			const i = base + a * 2;
			index.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
		}
		const cb = pos.length / 3;
		pos.push(cx, y0, cz);
		nrm.push(0, -1, 0);
		top.push(0);
		for (let a = 0; a < around; a++) {
			const th = (a / around) * Math.PI * 2;
			pos.push(cx + Math.cos(th) * rx, y0, cz + Math.sin(th) * rz);
			nrm.push(0, -1, 0);
			top.push(0);
		}
		for (let a = 0; a < around; a++) index.push(cb, cb + 1 + a, cb + 1 + ((a + 1) % around));
	} else {
		// four walls: each a strip of `n` columns, outward normals
		const walls = [
			{ n: [0, 0, -1], from: [b.minX, b.minZ], to: [b.maxX, b.minZ], cols: sx },
			{ n: [1, 0, 0], from: [b.maxX, b.minZ], to: [b.maxX, b.maxZ], cols: sz },
			{ n: [0, 0, 1], from: [b.maxX, b.maxZ], to: [b.minX, b.maxZ], cols: sx },
			{ n: [-1, 0, 0], from: [b.minX, b.maxZ], to: [b.minX, b.minZ], cols: sz }
		];
		for (const w of walls) {
			/** @type {number[][]} */ const pts = [];
			/** @type {number[]} */ const tops = [];
			for (let k = 0; k <= w.cols; k++) {
				const f = k / w.cols;
				const x = w.from[0] + (w.to[0] - w.from[0]) * f;
				const z = w.from[1] + (w.to[1] - w.from[1]) * f;
				pts.push([x, y0, z], [x, y1, z]);
				tops.push(0, 1);
			}
			const base = quadStrip(pts, w.n, tops);
			for (let k = 0; k < w.cols; k++) {
				const i = base + k * 2;
				index.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
			}
		}
		const fb = quadStrip(
			[
				[b.minX, y0, b.minZ],
				[b.maxX, y0, b.minZ],
				[b.maxX, y0, b.maxZ],
				[b.minX, y0, b.maxZ]
			],
			[0, -1, 0],
			[0, 0, 0, 0]
		);
		index.push(fb, fb + 1, fb + 2, fb, fb + 2, fb + 3);
	}
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
	g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
	g.setAttribute('aEdge', new THREE.Float32BufferAttribute(new Array(top.length).fill(0), 1));
	g.setIndex(index);
	return g;
}

// ── materials ─────────────────────────────────────────────────────────────────────────
function entryUniforms() {
	const wavesA = [];
	const wavesB = [];
	for (let i = 0; i < MAX_SHADER_WAVES; i++) {
		wavesA.push(new THREE.Vector4());
		wavesB.push(new THREE.Vector2());
	}
	const ripples = [];
	const ages = [];
	for (let i = 0; i < MAX_SHADER_RIPPLES; i++) {
		ripples.push(new THREE.Vector4());
		ages.push(0);
	}
	return {
		...shared,
		...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
		uWaveA: { value: wavesA },
		uWaveB: { value: wavesB },
		uWaveCount: { value: 0 },
		uRipple: { value: ripples },
		uRippleAge: { value: ages },
		uRippleCount: { value: 0 },
		uFrozen: { value: 0 },
		uShallow: { value: new THREE.Color() },
		uDeep: { value: new THREE.Color() },
		uClarity: { value: 3 },
		uOpacity: { value: 0.85 },
		uRefraction: { value: 0.5 },
		uChromatic: { value: 0.1 },
		uReflectivity: { value: 0.6 },
		uReflectOn: { value: 1 },
		uFresnel: { value: 4 },
		uRoughness: { value: 0.08 },
		uFoam: { value: 0.4 },
		uFoamColor: { value: new THREE.Color(1, 1, 1) },
		uFoamWidth: { value: 0.25 },
		uCaustics: { value: 0.5 },
		uCausticScale: { value: 1.2 },
		uCausticSpeed: { value: 0.6 },
		uEmissive: { value: new THREE.Color(0, 0, 0) },
		uDetail: { value: 0.5 },
		uDetailScale: { value: 2 },
		uDetailSpeed: { value: 0.4 },
		uFlow: { value: new THREE.Vector2() },
		uFogColor: { value: new THREE.Color() },
		uFogDistance: { value: 10 },
		uUnderwater: { value: 0 },
		uWorldToLocal: { value: new THREE.Matrix4() },
		uBoxMin: { value: new THREE.Vector3() },
		uBoxMax: { value: new THREE.Vector3() },
		uOpen: { value: 0 },
		uRound: { value: 0 }, // 36-fb-water F13: cylinder footprint (rim foam measures to the ellipse)
		uReflTex: { value: /** @type {any} */ (null) },
		uReflMatrix: { value: new THREE.Matrix4() }
	};
}

/** @param {any} uniforms @param {number} body @param {string} t tier @param {boolean} planar */
function surfaceMaterial(uniforms, body, t, planar) {
	/** @type {Record<string, any>} */
	const defines = {};
	const ss = t !== 'quest';
	if (ss) defines.WATER_SS = '';
	if (ss && planar && !body) defines.WATER_PLANAR = '';
	const m = new THREE.ShaderMaterial({
		name: body ? 'water-body' : 'water-surface',
		vertexShader: surfaceVertex,
		fragmentShader: surfaceFragment,
		uniforms: { ...uniforms, uBody: { value: body } },
		defines,
		fog: true,
		side: THREE.DoubleSide,
		transparent: !ss,
		depthWrite: ss
	});
	if (body) {
		// a tank floor usually lies ON the ground: lose that tie rather than z-fight it
		m.polygonOffset = true;
		m.polygonOffsetFactor = 1;
		m.polygonOffsetUnits = 4;
	}
	return m;
}

// ── entries ───────────────────────────────────────────────────────────────────────────
/** @param {any} volume */
function geometryKey(volume) {
	const m = volume.object.matrixWorld.elements;
	const b = volume.bounds;
	const look = volume.spec.waves ?? {};
	return [
		volume.shape,
		b.minX,
		b.minY,
		b.minZ,
		b.maxX,
		b.maxY,
		b.maxZ,
		volume.level,
		axisScale(m, 0).toFixed(2),
		axisScale(m, 2).toFixed(2),
		look.wavelength ?? 0,
		tier === 'quest' ? 'q' : 'd'
	].join('|');
}

/** @param {any} entry @param {any} volume */
function buildGeometry(entry, volume) {
	const m = volume.object.matrixWorld.elements;
	const b = volume.bounds;
	const wx = (b.maxX - b.minX) * axisScale(m, 0);
	const wz = (b.maxZ - b.minZ) * axisScale(m, 2);
	const comps = waveComponents(volume.spec.waves);
	const shortest = comps.length ? Math.min(...comps.map((c) => (2 * Math.PI) / c.k)) : 8;
	const cap = tier === 'quest' ? 64 : 160;
	const cell = Math.max(0.04, Math.min(Math.max(wx, wz) / 24, shortest / 5));
	const sx = segs(wx, cell, cap);
	const sz = segs(wz, cell, cap);
	entry.surface.geometry?.dispose();
	entry.surface.geometry = surfaceGeometry(volume.shape, b, volume.level, sx, sz);
	if (volume.shape === 'plane') {
		if (entry.body) {
			entry.body.geometry.dispose();
			root?.remove(entry.body);
			entry.body.material.dispose();
			entry.body = null;
		}
	} else {
		if (!entry.body) {
			entry.body = new THREE.Mesh(undefined, surfaceMaterial(entry.uniforms, 1, tier, false));
			entry.body.name = 'water-body';
			setupVisual(entry.body);
			root?.add(entry.body);
		}
		entry.body.geometry?.dispose();
		entry.body.geometry = bodyGeometry(
			volume.shape,
			b,
			volume.level,
			Math.max(4, Math.round(sx / 2)),
			Math.max(4, Math.round(sz / 2))
		);
	}
	// waves lift the surface past its flat bounds: widen the culling sphere
	const lift = comps.reduce((s, c) => s + c.a, 0) * 1.5 + 0.1;
	for (const mesh of [entry.surface, entry.body]) {
		if (!mesh) continue;
		mesh.geometry.computeBoundingSphere();
		mesh.geometry.boundingSphere.radius +=
			lift / Math.max(1e-6, Math.min(axisScale(m, 0), axisScale(m, 1), axisScale(m, 2)));
	}
	entry.geomKey = geometryKey(volume);
}

/** @param {any} mesh */
function setupVisual(mesh) {
	mesh.matrixAutoUpdate = false;
	mesh.castShadow = false;
	mesh.receiveShadow = false;
	mesh.userData.__waterVisual = true;
	mesh.renderOrder = 0;
	mesh.onBeforeRender = onVisualBeforeRender;
}

/** per-draw: is the pre-pass this camera's, this frame? @param {any} renderer @param {any} _scene @param {any} camera */
function onVisualBeforeRender(renderer, _scene, camera) {
	const active = prepass.frame === frameNo && prepass.camera === camera ? 1 : 0;
	shared.uSSActive.value = active;
	const rt = renderer.getRenderTarget();
	if (rt) shared.uViewport.value.set(rt.width, rt.height);
	else renderer.getDrawingBufferSize(shared.uViewport.value);
}

/** @param {any} volume */
function createEntry(volume) {
	const uniforms = entryUniforms();
	const entry = {
		uuid: volume.uuid,
		object: volume.object,
		volume,
		uniforms,
		surface: new THREE.Mesh(undefined, surfaceMaterial(uniforms, 0, tier, false)),
		body: /** @type {any} */ (null),
		bubbles: /** @type {any} */ (null),
		matTier: tier,
		planar: false,
		geomKey: '',
		lookKey: '',
		wavesKey: '',
		comps: /** @type {any[]} */ ([]),
		visible: true
	};
	entry.surface.name = 'water-surface';
	setupVisual(entry.surface);
	root?.add(entry.surface);
	buildGeometry(entry, volume);
	return entry;
}

/** @param {any} entry */
function disposeEntry(entry) {
	for (const mesh of [entry.surface, entry.body, entry.bubbles]) {
		if (!mesh) continue;
		mesh.parent?.remove(mesh);
		mesh.geometry?.dispose();
		mesh.material?.dispose();
	}
}

/** colour uniform from a hex (linear working space) @param {any} c @param {string} hex */
function setColor(c, hex) {
	try {
		c.set(hex || '#000000');
	} catch {
		c.set('#000000');
	}
}

/** @param {any} entry */
function applyLook(entry) {
	const spec = entry.volume.spec;
	const key = JSON.stringify([spec.look, spec.flow]);
	if (key === entry.lookKey) return;
	entry.lookKey = key;
	const L = resolveLook(spec);
	const u = entry.uniforms;
	setColor(u.uShallow.value, L.shallowColor);
	setColor(u.uDeep.value, L.deepColor);
	setColor(u.uFoamColor.value, L.foamColor);
	// 36-fb-water F13: an empty fog colour means "the deep colour" (as underwater already did);
	// it was read as BLACK here, so Visibility from outside would have fogged to black
	setColor(u.uFogColor.value, L.fogColor || L.deepColor);
	setColor(u.uEmissive.value, L.emissive);
	u.uEmissive.value.multiplyScalar(Math.max(0, Number(L.emissiveStrength) || 0));
	u.uClarity.value = Math.max(0.01, Number(L.clarity) || 1);
	u.uOpacity.value = clamp01(L.opacity);
	u.uRefraction.value = Math.max(0, Number(L.refraction) || 0);
	u.uChromatic.value = clamp01(L.chromatic);
	u.uReflectivity.value = clamp01(L.reflectivity);
	u.uReflectOn.value = L.reflection === 'none' ? 0.15 : 1;
	u.uFresnel.value = Math.max(0.5, Number(L.fresnel) || 4);
	u.uRoughness.value = Math.max(0.01, Math.min(1, Number(L.roughness) || 0.08));
	u.uFoam.value = clamp01(L.foam);
	u.uFoamWidth.value = Math.max(0.01, Number(L.foamWidth) || 0.25);
	u.uCaustics.value = Math.max(0, Number(L.caustics) || 0);
	u.uCausticScale.value = Math.max(0.05, Number(L.causticScale) || 1);
	u.uCausticSpeed.value = Number(L.causticSpeed) || 0;
	u.uDetail.value = Math.max(0, Number(L.detail) || 0);
	u.uDetailScale.value = Math.max(0.05, Number(L.detailScale) || 2);
	u.uDetailSpeed.value = Number(L.detailSpeed) || 0;
	u.uFogDistance.value = Math.max(0.1, Number(L.fogDistance) || 10);
	u.uFrozen.value = L.frozen ? 1 : 0;
	const f = spec.flow ?? [0, 0, 0];
	// the flow is LOCAL; the scroll runs in world x/z
	const m = entry.object.matrixWorld.elements;
	const sx = axisScale(m, 0);
	const sz = axisScale(m, 2);
	u.uFlow.value.set(
		(m[0] / sx) * f[0] + (m[8] / sz) * f[2],
		(m[2] / sx) * f[0] + (m[10] / sz) * f[2]
	);
	entry.wantsPlanar = L.reflection === 'planar';
}

/** @param {any} v */
function clamp01(v) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** @param {any} entry @param {number} t clock seconds (double) */
function applyWaves(entry, t) {
	const spec = entry.volume.spec;
	const key = JSON.stringify(spec.waves ?? {});
	if (key !== entry.wavesKey) {
		entry.wavesKey = key;
		entry.comps = resolveLook(spec).frozen ? [] : waveComponents(spec.waves);
	}
	const u = entry.uniforms;
	const comps = entry.comps;
	u.uWaveCount.value = comps.length;
	for (let i = 0; i < comps.length; i++) {
		const c = comps[i];
		// phase = w·t mod 2π in DOUBLE precision: seconds-of-day are too big for a float32 uniform
		const phase = (c.w * t) % (Math.PI * 2);
		u.uWaveA.value[i].set(c.dx, c.dz, c.k, phase);
		u.uWaveB.value[i].set(c.a, c.q);
	}
	const ripples = waterVolumes.ripplesOf(entry.uuid);
	const n = Math.min(MAX_SHADER_RIPPLES, ripples.length, tier === 'quest' ? 4 : MAX_SHADER_RIPPLES);
	u.uRippleCount.value = n;
	for (let i = 0; i < n; i++) {
		const r = ripples[ripples.length - n + i];
		u.uRipple.value[i].set(r.x, r.z, r.radius, r.strength);
		u.uRippleAge.value[i] = t - r.t;
	}
}

/** is the object (and every ancestor up to the scene) visible? @param {any} o */
function shown(o) {
	for (let p = o; p; p = p.parent) if (p.visible === false) return false;
	return true;
}

// ── bubbles ───────────────────────────────────────────────────────────────────────────
const bubbleGeometry = new THREE.PlaneGeometry(2, 2);

/** @param {number} count */
function bubbleMesh(count) {
	const geo = new THREE.InstancedBufferGeometry();
	geo.index = bubbleGeometry.index;
	geo.setAttribute('position', bubbleGeometry.getAttribute('position'));
	geo.setAttribute('uv', bubbleGeometry.getAttribute('uv'));
	const seeds = new Float32Array(MAX_BUBBLES * 4);
	let h = 2166136261;
	for (let i = 0; i < seeds.length; i++) {
		h = Math.imul(h ^ (i + 0x9e3779b9), 16777619) >>> 0;
		seeds[i] = (h % 100000) / 100000;
	}
	geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
	geo.instanceCount = count;
	const material = new THREE.ShaderMaterial({
		name: 'water-bubbles',
		vertexShader: bubbleVertex,
		fragmentShader: bubbleFragment,
		uniforms: {
			uTime: shared.uTime,
			uOrigin: { value: new THREE.Vector3() },
			uAxisX: { value: new THREE.Vector3() },
			uAxisZ: { value: new THREE.Vector3() },
			uRiseH: { value: 1 },
			uSpeed: { value: 0.5 },
			uSizeMin: { value: 0.02 },
			uSizeMax: { value: 0.05 },
			uWobble: { value: 0.3 },
			uCount: { value: count },
			uRate: { value: 8 },
			uBurstMode: { value: 0 },
			uBurstAge: { value: -100 },
			uPop: { value: 1 },
			uColor: { value: new THREE.Color(1, 1, 1) },
			uOpacity: { value: 0.7 }
		},
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide
	});
	const mesh = new THREE.Mesh(geo, material);
	mesh.name = 'water-bubbles';
	mesh.frustumCulled = false;
	mesh.matrixAutoUpdate = false;
	mesh.renderOrder = 2;
	mesh.userData.__waterVisual = true;
	return mesh;
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * Place an emitter's spawn area in WORLD space and push its params.
 * @param {any} mesh @param {any} B resolved bubbles @param {number} t
 * @param {{origin: any, axisX: any, axisZ: any, riseH: number}} area
 */
function updateBubbles(mesh, B, t, area) {
	const u = mesh.material.uniforms;
	const count = Math.min(
		B.count,
		overrides.particlesCapped || tier === 'quest' ? Math.min(B.count, 120) : B.count
	);
	mesh.geometry.instanceCount = count;
	u.uCount.value = count;
	u.uOrigin.value.copy(area.origin);
	u.uAxisX.value.copy(area.axisX);
	u.uAxisZ.value.copy(area.axisZ);
	u.uRiseH.value = Math.max(0.02, area.riseH);
	u.uSpeed.value = B.riseSpeed;
	u.uSizeMin.value = B.sizeMin;
	u.uSizeMax.value = B.sizeMax;
	u.uWobble.value = B.wobble;
	u.uRate.value = B.rate;
	u.uBurstMode.value = B.mode === 'burst' ? 1 : 0;
	u.uBurstAge.value = B.mode === 'burst' && B.burstAt >= 0 ? t - B.burstAt : -100;
	u.uPop.value = B.pop ? 1 : 0;
	setColor(u.uColor.value, B.color);
	u.uOpacity.value = B.opacity;
}

/** volume bubbles: rise from the floor (an ocean: 3 m down) to the level @param {any} entry @param {number} t */
function volumeBubbles(entry, t) {
	const B = resolveBubbles(entry.volume.spec.bubbles);
	if (!B.enabled || !entry.visible) {
		if (entry.bubbles) entry.bubbles.visible = false;
		return;
	}
	if (!entry.bubbles) {
		entry.bubbles = bubbleMesh(MAX_BUBBLES);
		root?.add(entry.bubbles);
	}
	entry.bubbles.visible = true;
	const v = entry.volume;
	const b = v.bounds;
	const m = entry.object.matrixWorld;
	const cx = (b.minX + b.maxX) / 2;
	const cz = (b.minZ + b.maxZ) / 2;
	const surface = _a.set(cx, v.level, cz).applyMatrix4(m);
	let floorY;
	if (v.shape === 'plane') floorY = surface.y - 3;
	else floorY = _b.set(cx, b.minY, cz).applyMatrix4(m).y;
	const origin = _v.set(cx, 0, cz).applyMatrix4(m);
	origin.y = floorY + 0.02;
	const spread = Math.min(1, B.spread);
	const hx = ((b.maxX - b.minX) / 2) * spread;
	const hz = ((b.maxZ - b.minZ) / 2) * spread;
	const e = m.elements;
	const axisX = new THREE.Vector3(e[0], e[1], e[2]).multiplyScalar(hx);
	const axisZ = new THREE.Vector3(e[8], e[9], e[10]).multiplyScalar(hz);
	updateBubbles(entry.bubbles, B, t, { origin, axisX, axisZ, riseH: surface.y - origin.y });
}

/**
 * a standalone emitter (userData.bubbles on any object) @param {any} em @param {number} t
 * 36-fb-water F18: the bubbles leave from the object's TOP (they used to start at its centre,
 * inside the object, and the first half of every rise was hidden), and the spread covers at
 * least its footprint — an emitter on a 1 m crate rises off the whole lid, not a 30 cm dot.
 */
function emitterBubbles(em, t) {
	const B = resolveBubbles({ enabled: true, ...em.object.userData.bubbles });
	const on = B.enabled && shown(em.object);
	em.mesh.visible = on;
	if (!on) return;
	const o = em.object;
	const m = o.matrixWorld;
	const b = localBounds(o);
	const cx = (b[0] + b[3]) / 2;
	const cz = (b[2] + b[5]) / 2;
	const p = new THREE.Vector3(cx, b[4], cz).applyMatrix4(m);
	const q = volumeList.length ? waterVolumes.query(p, { volumes: volumeList, time: t }) : null;
	const riseH = q ? q.depth : B.height;
	const sx = new THREE.Vector3().setFromMatrixColumn(m, 0).length();
	const sz = new THREE.Vector3().setFromMatrixColumn(m, 2).length();
	const hx = Math.max(B.spread * 0.5, ((b[3] - b[0]) / 2) * sx * 0.8);
	const hz = Math.max(B.spread * 0.5, ((b[5] - b[2]) / 2) * sz * 0.8);
	updateBubbles(em.mesh, B, t, {
		origin: p,
		axisX: new THREE.Vector3(hx, 0, 0),
		axisZ: new THREE.Vector3(0, 0, hz),
		riseH
	});
}

// ── editor helpers never enter the water's own renders (W-BUG-1) ─────────────────────
// The pre-pass and the planar reflection draw the scene through the MAIN camera, so every
// editor helper it sees used to land in the refraction texture: the gizmo was drawn once on
// top and once more refracted a few pixels off ("the gizmo looks doubled"). For the nested
// renders the helper layer is switched off and every named editor helper is hidden; the
// outer render then draws them once, as always. (The selection outline is a post pass, not
// in the scene, so it never reached the pre-pass.)
const EDITOR_HELPER_NAMES = new Set([
	'editor-grid',
	'camera-frustums',
	'collider-proxies',
	'collider-edit-proxy',
	'collider-ground',
	'lock-highlights',
	'ping-highlights',
	'vertex-handles',
	'face-edit-overlay',
	'face-edit-hover',
	'edge-edit-overlay',
	'mesh-pivot-marker',
	'proportional-ring',
	'sculpt-cursor',
	'slide-landing-marker',
	'snap-anchor-marker',
	'spline-handles',
	'draw-preview',
	'module-content-proxy',
	'lod-level-proxy',
	'vr-selection-shell',
	'vrsleeve-preview',
	'vr-patch-preview'
]);
const EDITOR_HELPER_PREFIXES = ['spline-preview', 'lod-overlay-', 'light-proxy', 'camera-frustum'];
/** @param {any} n */
function isEditorHelper(n) {
	const name = n.name;
	if (typeof name !== 'string' || !name) return false;
	if (EDITOR_HELPER_NAMES.has(name) || isEditOverlay(n)) return true;
	for (const p of EDITOR_HELPER_PREFIXES) if (name.startsWith(p)) return true;
	return false;
}
/** named helpers found by the last scan (gizmo + edit sessions come and go: rescanned ≤ 1 s) @type {any[]} */
let helperNodes = [];
function collectHelpers() {
	/** @type {any[]} */
	const found = [];
	sceneRef?.traverse((/** @type {any} */ n) => {
		if (n !== root && isEditorHelper(n)) found.push(n);
	});
	helperNodes = found;
}
/** hide every editor helper for a nested render; returns the undo @param {any} camera */
function hideEditorHelpers(camera) {
	/** @type {any[]} */
	const hidden = [];
	const tc = /** @type {any} */ (get(TControls));
	const gizmo = tc?.getHelper?.() ?? tc;
	for (const n of [gizmo, ...helperNodes]) {
		if (n?.visible) {
			n.visible = false;
			hidden.push(n);
		}
	}
	const mask = camera?.layers?.mask;
	camera?.layers?.disable(HELPER_LAYER);
	lastHiddenHelpers = hidden.length;
	return () => {
		for (const n of hidden) n.visible = true;
		if (camera?.layers && mask !== undefined) camera.layers.mask = mask;
	};
}
let lastHiddenHelpers = 0;

// ── 36-fb-water F13b: the selection stays under its OUTLINE ──────────────────────────
// The outline (a postprocessing pass) traces an object's TRUE silhouette, while the water
// shows it through screen-space refraction — shifted by the ripples, so a selected fish or a
// toy in a pool sat beside its own outline (reported in Aquarium). Engines handle a selected
// object behind a refractive surface by drawing it un-refracted: here the selected (and
// peer-locked) meshes are rendered into a small SOFT mask during the pre-pass, and the water
// shader fades its refraction offset to zero inside it. The selection then reads exactly where
// the outline is; everything else still refracts. Quest tier (no screen-space refraction)
// and the underwater view (no surface in between) were never offset.
const SEL_LAYER = 29;
const selMaskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
/** @type {any} */ let selMaskTarget = null;
/** @type {string[]} */ let selectionUuids = [];
/** @type {string[]} */ let lockedUuids = [];
selectedObjects.subscribe((v) => (selectionUuids = [...(/** @type {any} */ (v) ?? [])].filter((u) => typeof u === 'string')));
lockedObjects.subscribe((v) => (lockedUuids = (/** @type {any[]} */ (v) ?? []).map((r) => r?.[1]).filter((u) => typeof u === 'string')));
const _clearColor = new THREE.Color();
let selectionUnrefract = true;
/** TEST/EVIDENCE: switch the F13b mask off (the counterfactual — the old offset outline) @param {boolean} on */
export function setSelectionUnrefract(on) {
	selectionUnrefract = !!on;
}

/** @param {any} renderer @param {any} scene @param {any} camera @param {number} w @param {number} h */
function renderSelectionMask(renderer, scene, camera, w, h) {
	/** @type {any[]} */
	const meshes = [];
	if (objectsRoot && (selectionUuids.length || lockedUuids.length))
		for (const uuid of [...selectionUuids, ...lockedUuids])
			objectsRoot.getObjectByProperty('uuid', uuid)?.traverse((/** @type {any} */ n) => {
				if (n.isMesh && n.visible && !n.userData?.__waterVisual && !n.userData?.__fluidVisual) meshes.push(n);
			});
	shared.uSelActive.value = meshes.length && selectionUnrefract ? 1 : 0;
	if (!meshes.length || !selectionUnrefract) return;
	const mw = Math.max(1, w >> 1);
	const mh = Math.max(1, h >> 1);
	if (!selMaskTarget || selMaskTarget.width !== mw || selMaskTarget.height !== mh) {
		selMaskTarget?.dispose();
		// half size + linear filtering = a soft edge, so the un-refracted object blends into the
		// refracted water around it instead of being cut out with a hard line
		selMaskTarget = new THREE.WebGLRenderTarget(mw, mh, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
	}
	const masks = meshes.map((m) => m.layers.mask);
	for (const m of meshes) m.layers.enable(SEL_LAYER);
	const camMask = camera.layers.mask;
	camera.layers.set(SEL_LAYER);
	const bg = scene.background;
	const fog = scene.fog;
	const override = scene.overrideMaterial;
	renderer.getClearColor(_clearColor);
	const clearAlpha = renderer.getClearAlpha();
	scene.background = null;
	scene.fog = null;
	scene.overrideMaterial = selMaskMaterial;
	renderer.setRenderTarget(selMaskTarget);
	renderer.setClearColor(0x000000, 1);
	renderer.clear();
	renderer.render(scene, camera);
	scene.background = bg;
	scene.fog = fog;
	scene.overrideMaterial = override;
	renderer.setClearColor(_clearColor, clearAlpha);
	camera.layers.mask = camMask;
	meshes.forEach((m, i) => (m.layers.mask = masks[i]));
	shared.uSelMask.value = selMaskTarget.texture;
}

// ── the pre-pass (desktop tiers) ──────────────────────────────────────────────────────
const prepass = {
	/** @type {any} */ target: null,
	/** @type {any} */ camera: null,
	frame: -1,
	scale: 1,
	/** @type {any} */ refl: null,
	/** @type {any} */ reflCamera: null
};
/** @type {any} */ let trigger = null;
/** @type {any} */ let overlay = null;
const _size = new THREE.Vector2();

function needsPrepass() {
	if (tier === 'quest') return false;
	for (const e of entries.values()) if (e.visible) return true;
	return false;
}

/** @param {number} w @param {number} h */
function ensureTarget(w, h) {
	if (prepass.target && prepass.target.width === w && prepass.target.height === h)
		return prepass.target;
	prepass.target?.dispose();
	prepass.target?.depthTexture?.dispose();
	const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 });
	t.depthTexture = new THREE.DepthTexture(w, h);
	t.depthTexture.type = THREE.UnsignedIntType;
	t.texture.minFilter = THREE.LinearFilter;
	t.texture.generateMipmaps = false;
	prepass.target = t;
	shared.uSceneColor.value = t.texture;
	shared.uSceneDepth.value = t.depthTexture;
	return t;
}

/**
 * Render the scene WITHOUT water into the colour + depth target, once per frame per camera
 * (the trigger mesh fires this from inside the outer render — three's nested-render support,
 * the Reflector/Refractor pattern). @param {any} renderer @param {any} scene @param {any} camera
 */
function runPrepass(renderer, scene, camera) {
	if (!needsPrepass() || renderer.xr.isPresenting) return;
	if (prepass.frame === frameNo && prepass.camera === camera) return;
	const rt = renderer.getRenderTarget();
	if (rt) _size.set(rt.width, rt.height);
	else renderer.getDrawingBufferSize(_size);
	const scale = tier === 'high' ? 1 : 0.5;
	const target = ensureTarget(
		Math.max(1, Math.round(_size.x * scale)),
		Math.max(1, Math.round(_size.y * scale))
	);
	const xrOn = renderer.xr.enabled;
	const shadowAuto = renderer.shadowMap.autoUpdate;
	const fog = scene.fog;
	const bg = scene.background;
	if (underwater) {
		scene.fog = underwater.savedFog;
		scene.background = underwater.savedBg;
	}
	// hide the water SURFACES (and the trigger/overlay) but keep the bubbles: from outside a
	// tank they are only ever seen through the refraction, so they belong in the pre-pass
	/** @type {any[]} */
	const hidden = [];
	for (const e of entries.values())
		for (const m of [e.surface, e.body]) if (m?.visible) hidden.push(m);
	if (trigger?.visible) hidden.push(trigger);
	if (overlay?.visible) hidden.push(overlay);
	for (const m of hidden) m.visible = false;
	const showHelpers = hideEditorHelpers(camera);
	renderer.xr.enabled = false;
	renderer.shadowMap.autoUpdate = false;
	renderer.setRenderTarget(target);
	renderer.state.buffers.depth.setMask(true);
	renderer.clear();
	renderer.render(scene, camera);
	renderSelectionMask(renderer, scene, camera, target.width, target.height);
	// planar reflection for the nearest volume that asks for it
	const planar = planarCandidate(camera);
	if (planar) renderReflection(renderer, scene, camera, planar);
	renderer.setRenderTarget(rt);
	renderer.xr.enabled = xrOn;
	renderer.shadowMap.autoUpdate = shadowAuto;
	for (const m of hidden) m.visible = true;
	showHelpers();
	scene.fog = fog;
	scene.background = bg;
	prepass.frame = frameNo;
	prepass.camera = camera;
	shared.uCamNear.value = camera.near ?? 0.1;
	shared.uCamFar.value = camera.far ?? 1000;
	shared.uProjInv.value.copy(camera.projectionMatrixInverse);
	shared.uCamWorld.value.copy(camera.matrixWorld);
}

/** @param {any} camera */
function planarCandidate(camera) {
	/** @type {any} */ let best = null;
	let bestD = Infinity;
	const cp = _v.setFromMatrixPosition(camera.matrixWorld);
	for (const e of entries.values()) {
		const want = !!e.wantsPlanar && e.visible;
		if (!want) {
			if (e.planar) setPlanar(e, false);
			continue;
		}
		const s = _a.setFromMatrixPosition(e.object.matrixWorld);
		const d = s.distanceToSquared(cp);
		if (d < bestD) {
			bestD = d;
			best = e;
		}
	}
	for (const e of entries.values()) if (e !== best && e.planar) setPlanar(e, false);
	if (best && !best.planar) setPlanar(best, true);
	return best;
}

/** @param {any} entry @param {boolean} on */
function setPlanar(entry, on) {
	entry.planar = on;
	entry.surface.material.dispose();
	entry.surface.material = surfaceMaterial(entry.uniforms, 0, tier, on);
}

const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
const _n = new THREE.Vector3(0, 1, 0);
const _look = new THREE.Vector3();
const _target = new THREE.Vector3();
const _rot = new THREE.Matrix4();

/** mirrored-camera render about the entry's surface plane (three's Reflector maths) @param {any} renderer @param {any} scene @param {any} camera @param {any} entry */
function renderReflection(renderer, scene, camera, entry) {
	const w = Math.max(1, Math.round(_size.x * 0.5));
	const h = Math.max(1, Math.round(_size.y * 0.5));
	if (!prepass.refl || prepass.refl.width !== w || prepass.refl.height !== h) {
		prepass.refl?.dispose();
		prepass.refl = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
	}
	const rc = (prepass.reflCamera ??= new THREE.PerspectiveCamera());
	const v = entry.volume;
	const b = v.bounds;
	const surfacePoint = _a
		.set((b.minX + b.maxX) / 2, v.level, (b.minZ + b.maxZ) / 2)
		.applyMatrix4(entry.object.matrixWorld);
	const camPos = _b.setFromMatrixPosition(camera.matrixWorld);
	const view = new THREE.Vector3().subVectors(surfacePoint, camPos);
	if (view.dot(_n) > 0) return; // looking from below: no reflection pass
	view.reflect(_n).negate().add(surfacePoint);
	_rot.extractRotation(camera.matrixWorld);
	_look.set(0, 0, -1).applyMatrix4(_rot).add(camPos);
	_target.subVectors(surfacePoint, _look).reflect(_n).negate().add(surfacePoint);
	rc.position.copy(view);
	rc.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_n);
	rc.lookAt(_target);
	rc.far = camera.far;
	rc.updateMatrixWorld();
	rc.projectionMatrix.copy(camera.projectionMatrix);
	const tm = entry.uniforms.uReflMatrix.value;
	tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
	tm.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
	_plane.setFromNormalAndCoplanarPoint(_n, surfacePoint).applyMatrix4(rc.matrixWorldInverse);
	_clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
	const pm = rc.projectionMatrix;
	_q.x = (Math.sign(_clip.x) + pm.elements[8]) / pm.elements[0];
	_q.y = (Math.sign(_clip.y) + pm.elements[9]) / pm.elements[5];
	_q.z = -1;
	_q.w = (1 + pm.elements[10]) / pm.elements[14];
	_clip.multiplyScalar(2 / _clip.dot(_q));
	pm.elements[2] = _clip.x;
	pm.elements[6] = _clip.y;
	pm.elements[10] = _clip.z + 1;
	pm.elements[14] = _clip.w;
	renderer.setRenderTarget(prepass.refl);
	renderer.state.buffers.depth.setMask(true);
	renderer.clear();
	renderer.render(scene, rc);
	entry.uniforms.uReflTex.value = prepass.refl.texture;
}

// ── scene hooks: hide the source meshes, swap in the underwater fog ─────────────────────
const _cam = new THREE.Vector3();
/** @type {any} */ let waterFog = null;
const fogColor = new THREE.Color();

/** @param {any} renderer @param {any} scene @param {any} camera @param {any} target */
function beforeSceneRender(renderer, scene, camera, target) {
	prevBefore?.(renderer, scene, camera, target);
	if (renderDepth++ > 0) return;
	swapped.length = 0;
	if (!entries.size) return;
	for (const e of entries.values()) {
		const o = e.object;
		if (o.isMesh && o.material) {
			swapped.push(o, o.material);
			o.material = invisible;
		}
	}
	// underwater: the camera inside a volume (waves included)
	underwater = null;
	if (camera?.matrixWorld) {
		_cam.setFromMatrixPosition(camera.matrixWorld);
		const q = waterVolumes.query(_cam, { volumes: volumeList, time: currentT });
		const e = q ? entries.get(q.volume.uuid) : null;
		if (e && e.visible) {
			const L = resolveLook(e.volume.spec);
			fogColor.set(L.fogColor || L.deepColor);
			waterFog ??= new THREE.Fog(fogColor, 0.05, 10);
			waterFog.color.copy(fogColor);
			waterFog.near = 0.05;
			waterFog.far = Math.max(0.2, Number(L.fogDistance) || 10);
			underwater = {
				entry: e,
				savedFog: scene.fog,
				savedBg: scene.background,
				look: L,
				surfaceY: q?.surfaceY ?? 0
			};
			scene.fog = waterFog;
			scene.background = fogColor;
		}
	}
	for (const e of entries.values()) {
		const inside = underwater?.entry === e;
		e.uniforms.uUnderwater.value = inside ? 1 : 0;
		// the tank body shows its OUTER faces from outside and its INNER ones from inside, so
		// a floor lying on the ground is culled from above (no z-fight with the ground)
		if (e.body) e.body.material.side = inside ? THREE.BackSide : THREE.FrontSide;
	}
	if (overlay) {
		overlay.visible = !!underwater;
		if (underwater) {
			const ou = overlay.material.uniforms;
			ou.uTint.value.copy(fogColor);
			ou.uStrength.value = 0.18;
			ou.uCaustics.value = Math.max(0, Number(underwater.look.caustics) || 0);
			ou.uCausticScale.value = Math.max(0.05, Number(underwater.look.causticScale) || 1);
			ou.uCausticSpeed.value = Number(underwater.look.causticSpeed) || 0;
			ou.uSurfaceY.value = underwater.surfaceY;
			ou.uSun.value =
				Math.min(
					1.5,
					shared.uSunColor.value.r + shared.uSunColor.value.g + shared.uSunColor.value.b
				) / 1.5;
		}
	}
}

/** @param {any[]} args */
function afterSceneRender(...args) {
	if (--renderDepth > 0) return;
	renderDepth = 0;
	for (let i = swapped.length - 2; i >= 0; i -= 2) swapped[i].material = swapped[i + 1];
	swapped.length = 0;
	if (underwater) {
		const scene = args[1];
		scene.fog = underwater.savedFog;
		scene.background = underwater.savedBg;
	}
	prevAfter?.(...args);
}

/** @param {any} scene */
function installHooks(scene) {
	if (!scene || installedScene === scene) return;
	if (installedScene) uninstallHooks();
	const proto = THREE.Object3D.prototype;
	prevBefore =
		scene.onBeforeRender && scene.onBeforeRender !== proto.onBeforeRender
			? scene.onBeforeRender
			: null;
	prevAfter =
		scene.onAfterRender && scene.onAfterRender !== proto.onAfterRender ? scene.onAfterRender : null;
	scene.onBeforeRender = beforeSceneRender;
	scene.onAfterRender = afterSceneRender;
	installedScene = scene;
}

function uninstallHooks() {
	for (let i = swapped.length - 2; i >= 0; i -= 2) swapped[i].material = swapped[i + 1];
	swapped.length = 0;
	if (!installedScene) return;
	const proto = THREE.Object3D.prototype;
	// a hook installed after ours wraps ours as ITS prev: leave the chain alone then and make
	// ours inert instead (entries are cleared by stopWater)
	if (installedScene.onBeforeRender === beforeSceneRender)
		installedScene.onBeforeRender = prevBefore ?? proto.onBeforeRender;
	if (installedScene.onAfterRender === afterSceneRender)
		installedScene.onAfterRender = prevAfter ?? proto.onAfterRender;
	installedScene = null;
	prevBefore = null;
	prevAfter = null;
	renderDepth = 0;
}

// ── sky + sun from the scene's own lights (no import of environment.js: cycle-free) ─────
/** @type {any} */ let sunLight = null;
/** @type {any} */ let hemiLight = null;
function findLights() {
	sunLight = sceneRef?.getObjectByName('env-rig-sun') ?? null;
	hemiLight = sceneRef?.getObjectByName('env-rig-hemi') ?? null;
	if (!sunLight || !hemiLight) {
		sceneRef?.traverse((/** @type {any} */ o) => {
			if (!sunLight && o.isDirectionalLight && o.visible) sunLight = o;
			if (!hemiLight && o.isHemisphereLight && o.visible) hemiLight = o;
		});
	}
}

const _sp = new THREE.Vector3();
const _tp = new THREE.Vector3();
function updateSky() {
	if (sunLight && sunLight.visible) {
		_sp.setFromMatrixPosition(sunLight.matrixWorld);
		_tp.setFromMatrixPosition(sunLight.target?.matrixWorld ?? new THREE.Matrix4());
		const d = _sp.sub(_tp);
		if (d.lengthSq() > 1e-8) shared.uSunDir.value.copy(d.normalize());
		shared.uSunColor.value
			.copy(sunLight.color)
			.multiplyScalar(Math.min(3, sunLight.intensity) * 0.6);
	} else {
		shared.uSunDir.value.set(0.4, 0.8, 0.3).normalize();
		shared.uSunColor.value.setRGB(0.8, 0.8, 0.8);
	}
	const bg = sceneRef?.background;
	if (hemiLight) {
		shared.uSkyTop.value
			.copy(hemiLight.color)
			.multiplyScalar(Math.min(1.5, hemiLight.intensity) * 0.7);
		shared.uSkyBottom.value.copy(hemiLight.groundColor).multiplyScalar(0.6);
	}
	if (bg?.isColor) shared.uSkyHorizon.value.copy(bg);
	else if (sceneRef?.fog?.color) shared.uSkyHorizon.value.copy(sceneRef.fog.color);
	else if (hemiLight)
		shared.uSkyHorizon.value.copy(hemiLight.color).lerp(hemiLight.groundColor, 0.35);
	if (underwater) {
		// the sky colours are read in the next frame's tick: never take the water fog for them
		shared.uSkyHorizon.value.copy(
			underwater.savedBg?.isColor ? underwater.savedBg : shared.uSkyHorizon.value
		);
	}
}

// ── per-frame ─────────────────────────────────────────────────────────────────────────
let currentT = 0;

function scan() {
	dirty = false;
	lastScan = performance.now();
	volumeList = waterVolumes.list();
	waterVolumes.refresh();
	/** @type {Set<string>} */
	const seen = new Set();
	for (const v of volumeList) {
		seen.add(v.uuid);
		let e = entries.get(v.uuid);
		if (e && e.object !== v.object) {
			disposeEntry(e);
			entries.delete(v.uuid);
			e = null;
		}
		if (!e) entries.set(v.uuid, createEntry(v));
		else e.volume = v;
	}
	for (const [uuid, e] of entries) {
		if (!seen.has(uuid)) {
			disposeEntry(e);
			entries.delete(uuid);
		}
	}
	// standalone bubble emitters
	/** @type {Set<string>} */
	const seenEm = new Set();
	walkEmitters((o) => {
		seenEm.add(o.uuid);
		let em = emitters.get(o.uuid);
		if (em && em.object !== o) {
			disposeEmitter(em);
			emitters.delete(o.uuid);
			em = null;
		}
		if (!em) {
			const mesh = bubbleMesh(MAX_BUBBLES);
			root?.add(mesh);
			emitters.set(o.uuid, { uuid: o.uuid, object: o, mesh });
		}
	});
	for (const [uuid, em] of emitters) {
		if (!seenEm.has(uuid)) {
			disposeEmitter(em);
			emitters.delete(uuid);
		}
	}
	findLights();
	collectHelpers();
}

/** @type {any} */ let objectsRoot = null;
objectsGroup.subscribe((g) => (objectsRoot = g));

/** @param {(o: any) => void} fn */
function walkEmitters(fn) {
	/** @param {any} o */
	const walk = (o) => {
		if (!o) return;
		if (
			o !== objectsRoot &&
			o.userData?.bubbles &&
			typeof o.userData.bubbles === 'object' &&
			!o.userData.water
		)
			fn(o);
		for (const c of o.children ?? []) walk(c);
	};
	walk(objectsRoot);
}

/** @param {any} em */
function disposeEmitter(em) {
	em.mesh.parent?.remove(em.mesh);
	em.mesh.geometry.dispose();
	em.mesh.material.dispose();
}

/**
 * The frame loop (WaterLayer's useTask): rescan when the scene changed (≤ 1 Hz otherwise),
 * follow every volume's transform, push the clock-driven uniforms.
 * @param {number} [_delta]
 */
export function tickWater(_delta) {
	if (!root) return;
	frameNo++;
	const t = waterClock();
	currentT = t;
	shared.uTime.value = t % 3600;
	const nextTier = resolveTier(rendererRef);
	if (nextTier !== tier) {
		tier = nextTier;
		for (const e of entries.values()) e.geomKey = '';
	}
	const now = performance.now();
	if (dirty || now - lastScan > 1000) scan();
	if (!entries.size && !emitters.size) {
		if (trigger) trigger.visible = false;
		noteSimplified('water', false);
		return;
	}
	// 36-fb-water F27: the QUALITY LEVEL (not a headset, not the user's own Low) took the
	// refraction away from water on screen — SimplifiedWaterNotice says so, once a session
	noteSimplified(
		'water',
		tier === 'quest' && qualityPref === 'auto' && !rendererRef?.xr?.isPresenting && [...entries.values()].some((e) => shown(e.object))
	);
	if (!shared.uNormalMap.value) shared.uNormalMap.value = waterDetailTexture();
	updateSky();
	for (const e of entries.values()) {
		const o = e.object;
		e.visible = shown(o);
		if (e.matTier !== tier) {
			e.matTier = tier;
			e.surface.material.dispose();
			e.surface.material = surfaceMaterial(e.uniforms, 0, tier, e.planar && tier !== 'quest');
			if (e.body) {
				e.body.material.dispose();
				e.body.material = surfaceMaterial(e.uniforms, 1, tier, false);
			}
		}
		const key = geometryKey(e.volume);
		if (key !== e.geomKey) buildGeometry(e, e.volume);
		for (const mesh of [e.surface, e.body]) {
			if (!mesh) continue;
			mesh.visible = e.visible;
			mesh.matrix.copy(o.matrixWorld);
			mesh.matrixWorldNeedsUpdate = true;
		}
		const inv = invertAffine(o.matrixWorld.elements);
		if (inv) e.uniforms.uWorldToLocal.value.fromArray(inv);
		const b = e.volume.bounds;
		e.uniforms.uBoxMin.value.set(b.minX, b.minY, b.minZ);
		e.uniforms.uBoxMax.value.set(b.maxX, e.volume.level, b.maxZ);
		e.uniforms.uOpen.value = e.volume.shape === 'plane' ? 1 : 0;
		e.uniforms.uRound.value = e.volume.shape === 'cylinder' ? 1 : 0;
		applyLook(e);
		applyWaves(e, t);
		volumeBubbles(e, t);
	}
	for (const em of emitters.values()) emitterBubbles(em, t);
	if (trigger) trigger.visible = needsPrepass();
}

/**
 * Mount: the scene-root group, the scene + renderer (WaterLayer passes threlte's).
 * @param {any} group @param {any} scene @param {any} renderer
 */
export function startWater(group, scene, renderer) {
	root = group;
	sceneRef = scene;
	rendererRef = renderer;
	waterVolumes.setRoot(objectsRoot);
	// the pre-pass trigger: drawn first among the opaques (renderOrder), draws nothing itself
	const tg = new THREE.BufferGeometry();
	tg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
	trigger = new THREE.Mesh(
		tg,
		new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false })
	);
	trigger.name = 'water-prepass';
	trigger.frustumCulled = false;
	trigger.renderOrder = -1e9;
	trigger.visible = false;
	trigger.userData.__waterVisual = true;
	trigger.onBeforeRender = (/** @type {any} */ r, /** @type {any} */ s, /** @type {any} */ c) =>
		runPrepass(r, s, c);
	root.add(trigger);
	// the underwater full-screen tint (+ caustics on desktop)
	const og = new THREE.BufferGeometry();
	og.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
	overlay = new THREE.Mesh(
		og,
		new THREE.ShaderMaterial({
			name: 'water-underwater',
			vertexShader: overlayVertex,
			fragmentShader: overlayFragment,
			defines: { WATER_SS: '' },
			uniforms: {
				uTint: { value: new THREE.Color() },
				uStrength: { value: 0.18 },
				uTime: shared.uTime,
				uCaustics: { value: 0.5 },
				uCausticScale: { value: 1 },
				uCausticSpeed: { value: 0.5 },
				uSurfaceY: { value: 0 },
				uSun: { value: 1 },
				uSceneDepth: shared.uSceneDepth,
				uCamNear: shared.uCamNear,
				uCamFar: shared.uCamFar,
				uProjInv: shared.uProjInv,
				uCamWorld: shared.uCamWorld,
				uSSActive: shared.uSSActive
			},
			transparent: true,
			depthTest: false,
			depthWrite: false,
			blending: THREE.CustomBlending,
			blendSrc: THREE.OneFactor,
			blendDst: THREE.OneMinusSrcAlphaFactor
		})
	);
	overlay.name = 'water-underwater';
	overlay.frustumCulled = false;
	overlay.renderOrder = 1e9;
	overlay.visible = false;
	overlay.userData.__waterVisual = true;
	overlay.onBeforeRender = onVisualBeforeRender;
	root.add(overlay);
	installHooks(scene);
	dirty = true;
}

/** Unmount: drop every visual and the hooks. */
export function stopWater() {
	for (const e of entries.values()) disposeEntry(e);
	entries.clear();
	for (const em of emitters.values()) disposeEmitter(em);
	emitters.clear();
	uninstallHooks();
	for (const m of [trigger, overlay]) {
		if (!m) continue;
		m.parent?.remove(m);
		m.geometry.dispose();
		m.material.dispose();
	}
	trigger = null;
	overlay = null;
	prepass.target?.dispose();
	prepass.target?.depthTexture?.dispose();
	prepass.refl?.dispose();
	prepass.target = null;
	prepass.refl = null;
	root = null;
}

objectsGroup.subscribe((g) => {
	if (root) waterVolumes.setRoot(g);
});

/** The pre-pass colour + depth target (the suite reads it back). */
export function waterPrepassTarget() {
	return prepass.target;
}

/** For the suite and the profiler: what the renderer is doing right now. */
export function waterDebug() {
	return {
		tier,
		quality: qualityPref,
		volumes: entries.size,
		emitters: emitters.size,
		underwater: underwater?.entry?.uuid ?? null,
		prepass: {
			frame: prepass.frame,
			ours: frameNo,
			size: prepass.target ? [prepass.target.width, prepass.target.height] : null
		},
		planar: [...entries.values()].filter((e) => e.planar).map((e) => e.uuid),
		helpersHidden: lastHiddenHelpers,
		drawCalls:
			[...entries.values()].reduce(
				(n, e) => n + (e.visible ? 1 + (e.body ? 1 : 0) + (e.bubbles?.visible ? 1 : 0) : 0),
				0
			) + [...emitters.values()].filter((em) => em.mesh.visible).length,
		entries: [...entries.values()].map((e) => ({
			uuid: e.uuid,
			shape: e.volume.shape,
			visible: e.visible,
			body: !!e.body,
			bubbles: !!e.bubbles?.visible,
			vertices: e.surface.geometry?.attributes?.position?.count ?? 0,
			waves: e.comps.length,
			ripples: e.uniforms.uRippleCount.value,
			material: e.surface.material.name,
			defines: Object.keys(e.surface.material.defines ?? {})
		}))
	};
}
