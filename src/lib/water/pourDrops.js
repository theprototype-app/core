// 36-fb-water F16 + F17: POUR EMITTERS and TANK SPILLS — one cheap drop system.
//
// A pour emitter (`userData.pour` on ANY object: Add ▸ Water ▸ Pour, or "Add pour emitter" in
// the Water section — a plain Water tank can carry one) throws drops out of a spout; a fluid
// tank that is tipped spills the particles that leave over its rim (fluidRuntime hands them
// here). Either way a drop is BALLISTIC — no solver, the Quest-friendly half of the water
// story (36-fb-fluid's PBF emitter is the "real fluid" half): it falls under the scene's
// gravity, SPLASHES into any W1 water it reaches (a W2 ripple, then it is absorbed), SETTLES on
// the ground or the top of whatever it lands on and fades away there.
//
// LIMITS, so it never grows without bound: every source has its own pool (`maxParticles`,
// hard-capped at MAX_DROPS_PER_SOURCE) and its drops die at `lifetime`; the whole system is
// capped at MAX_DROPS_TOTAL (a source simply stops spawning while it is at the cap). One
// THREE.Points draw call per source.
//
// REPLICATION: `userData.pour` is plain JSON (objectParameters 'pour', undo kind 'props');
// the drops are each peer's own visual, like ripples and bubbles — the inputs are shared, the
// splashes are local.
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { sceneGravity, scenePhysicsGround } from '../scenePhysics';
import { waterVolumes, localBounds } from './volumes.js';

export const MAX_DROPS_PER_SOURCE = 2000;
export const MAX_DROPS_TOTAL = 6000;
const SETTLE_FADE = 1.2; // s a settled drop takes to fade out at the end of its life

/** @type {Readonly<Record<string, any>>} */
export const POUR_DEFAULTS = Object.freeze({
	version: 1,
	enabled: true,
	rate: 60, // drops per second
	speed: 2.2, // m/s out of the spout
	spread: 10, // degrees: the cone around `dir`
	dir: [1, 0.35, 0], // LOCAL direction (normalised at use)
	at: [0.5, 0.5, 0.5], // spout position, fractions of the object's local bounds
	color: '#4aa8e8',
	size: 0.045, // m, drop diameter
	maxParticles: 300,
	lifetime: 6 // s, a drop is gone this long after it left
});

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** @param {any} a @param {readonly number[]} d @param {number} lo @param {number} hi */
const vec3 = (a, d, lo, hi) => (Array.isArray(a) && a.length === 3 ? a.map((x, i) => num(x, d[i], lo, hi)) : d.slice());

/**
 * The ONE boundary for `userData.pour` (a peer's bytes, a file): typed, clamped.
 * @param {any} raw
 */
export function normalizePour(raw) {
	const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	const d = POUR_DEFAULTS;
	return {
		version: 1,
		enabled: r.enabled !== false,
		rate: num(r.rate, d.rate, 0, 500),
		speed: num(r.speed, d.speed, 0, 12),
		spread: num(r.spread, d.spread, 0, 60),
		dir: vec3(r.dir, d.dir, -1, 1),
		at: vec3(r.at, d.at, -0.5, 1.5),
		color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : d.color,
		size: num(r.size, d.size, 0.005, 0.3),
		maxParticles: Math.round(num(r.maxParticles, d.maxParticles, 1, MAX_DROPS_PER_SOURCE)),
		lifetime: num(r.lifetime, d.lifetime, 0.3, 60)
	};
}

// ── the drops ────────────────────────────────────────────────────────────────────────────
const VS = /* glsl */ `
attribute float aFade;
uniform float uSize;
uniform float uScale;
varying float vFade;
void main() {
	vFade = aFade;
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * mv;
	gl_PointSize = uSize * uScale / max(-mv.z, 0.01);
}`;
const FS = /* glsl */ `
uniform vec3 uColor;
varying float vFade;
void main() {
	vec2 c = gl_PointCoord * 2.0 - 1.0;
	float r2 = dot(c, c);
	if (r2 > 1.0 || vFade <= 0.0) discard;
	vec3 n = vec3(c.x, -c.y, sqrt(1.0 - r2));
	float diff = max(dot(n, normalize(vec3(0.4, 0.8, 0.5))), 0.0);
	float spec = pow(max(dot(reflect(-normalize(vec3(0.4, 0.8, 0.5)), n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
	vec3 col = uColor * (0.45 + 0.55 * diff) + vec3(spec * 0.7);
	gl_FragColor = vec4(col, 0.9 * vFade);
	#include <colorspace_fragment>
}`;

/**
 * One source's pool. Positions/velocities/ages in flat arrays; `state` 0 = flying, 1 = settled.
 */
class DropPool {
	/** @param {number} capacity @param {string} name */
	constructor(capacity, name) {
		this.capacity = capacity;
		this.count = 0;
		this.pos = new Float32Array(capacity * 3);
		this.vel = new Float32Array(capacity * 3);
		this.age = new Float32Array(capacity);
		this.life = new Float32Array(capacity);
		this.state = new Uint8Array(capacity);
		this.fade = new Float32Array(capacity);
		this.carry = 0; // fractional drops owed to the next frame
		this.splashes = 0;
		this.settled = 0;
		this.geometry = new THREE.BufferGeometry();
		this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
		this.fadeAttr = new THREE.BufferAttribute(this.fade, 1).setUsage(THREE.DynamicDrawUsage);
		this.geometry.setAttribute('position', this.posAttr);
		this.geometry.setAttribute('aFade', this.fadeAttr);
		this.geometry.setDrawRange(0, 0);
		this.material = new THREE.ShaderMaterial({
			vertexShader: VS,
			fragmentShader: FS,
			uniforms: { uSize: { value: 0.045 }, uScale: { value: 800 }, uColor: { value: new THREE.Color('#4aa8e8') } },
			transparent: true,
			depthWrite: false
		});
		this.points = new THREE.Points(this.geometry, this.material);
		this.points.name = name;
		this.points.frustumCulled = false;
		this.points.renderOrder = 3;
		this.points.userData.__fluidVisual = true; // not content: saves, picking, physics skip it
		this.points.userData.__waterVisual = true;
	}
	/** @param {number} n */
	resize(n) {
		if (n === this.capacity) return;
		const keep = Math.min(this.count, n);
		const grow = (/** @type {any} */ a, /** @type {number} */ k) => {
			const b = new a.constructor(n * k);
			b.set(a.subarray(0, keep * k));
			return b;
		};
		this.pos = grow(this.pos, 3);
		this.vel = grow(this.vel, 3);
		this.age = grow(this.age, 1);
		this.life = grow(this.life, 1);
		this.state = grow(this.state, 1);
		this.fade = grow(this.fade, 1);
		this.capacity = n;
		this.count = keep;
		this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
		this.fadeAttr = new THREE.BufferAttribute(this.fade, 1).setUsage(THREE.DynamicDrawUsage);
		this.geometry.setAttribute('position', this.posAttr);
		this.geometry.setAttribute('aFade', this.fadeAttr);
	}
	/** @param {number} x @param {number} y @param {number} z @param {number} vx @param {number} vy @param {number} vz @param {number} life */
	spawn(x, y, z, vx, vy, vz, life) {
		if (this.count >= this.capacity || totalDrops >= MAX_DROPS_TOTAL) return false;
		const i = this.count++;
		totalDrops++;
		this.pos[i * 3] = x;
		this.pos[i * 3 + 1] = y;
		this.pos[i * 3 + 2] = z;
		this.vel[i * 3] = vx;
		this.vel[i * 3 + 1] = vy;
		this.vel[i * 3 + 2] = vz;
		this.age[i] = 0;
		this.life[i] = life;
		this.state[i] = 0;
		this.fade[i] = 1;
		return true;
	}
	/** swap-remove @param {number} i */
	kill(i) {
		const j = --this.count;
		totalDrops--;
		if (i === j) return;
		for (let k = 0; k < 3; k++) {
			this.pos[i * 3 + k] = this.pos[j * 3 + k];
			this.vel[i * 3 + k] = this.vel[j * 3 + k];
		}
		this.age[i] = this.age[j];
		this.life[i] = this.life[j];
		this.state[i] = this.state[j];
		this.fade[i] = this.fade[j];
	}
	dispose() {
		totalDrops -= this.count;
		this.count = 0;
		this.points.parent?.remove(this.points);
		this.geometry.dispose();
		this.material.dispose();
	}
}

let totalDrops = 0;
/** @type {Map<string, {pool: DropPool, object: any, kind: 'pour'|'spill', seen: number}>} */
const sources = new Map();
/** @type {any} */ let visualParent = null;
/** top-level object boxes drops can settle on (refreshed ~2 Hz) @type {{minX: number, maxX: number, minZ: number, maxZ: number, top: number}[]} */
let landing = [];
let landingAt = 0;
let ripplesThisFrame = 0;
let lastTick = 0;
let frameNo = 0;
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = { x: 0, y: 0, z: 0 };
const _box = new THREE.Box3();

/** @param {any} root */
function refreshLanding(root) {
	landing = [];
	for (const o of root.children) {
		if (!o.visible || o.userData?.water || o.userData?.pour || o.userData?.fluid) continue;
		if (!o.isMesh && !o.children?.length) continue;
		_box.setFromObject(o);
		if (!Number.isFinite(_box.min.x)) continue;
		landing.push({ minX: _box.min.x, maxX: _box.max.x, minZ: _box.min.z, maxZ: _box.max.z, top: _box.max.y });
	}
}

/** the highest surface under (x, z) at or below y (ground or an object's top) */
function floorUnder(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ z) {
	const g = get(scenePhysicsGround);
	let best = g?.enabled ? Number(g.height ?? 0) || 0 : -Infinity;
	for (const b of landing) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && b.top <= y + 0.05 && b.top > best) best = b.top;
	return best;
}

/** @param {DropPool} pool @param {number} dt @param {any[]} vols @param {number} lifetimeFade */
function stepPool(pool, dt, vols, lifetimeFade) {
	const gy = get(sceneGravity);
	for (let i = 0; i < pool.count; ) {
		pool.age[i] += dt;
		if (pool.age[i] >= pool.life[i]) {
			pool.kill(i);
			continue;
		}
		const k = i * 3;
		if (pool.state[i] === 0) {
			pool.vel[k + 1] += gy * dt;
			const ox = pool.pos[k], oy = pool.pos[k + 1], oz = pool.pos[k + 2];
			const nx = ox + pool.vel[k] * dt;
			const ny = oy + pool.vel[k + 1] * dt;
			const nz = oz + pool.vel[k + 2] * dt;
			// into water: a ripple, and the drop is the water now
			if (vols.length) {
				_p.x = nx;
				_p.y = ny;
				_p.z = nz;
				const hit = waterVolumes.query(_p, { volumes: vols });
				if (hit && pool.vel[k + 1] < 0) {
					if (ripplesThisFrame < 6 && (frameNo + i) % 3 === 0) {
						ripplesThisFrame++;
						waterVolumes.disturb(hit.volume, [nx, hit.surfaceY, nz], 0.12, Math.min(0.6, -pool.vel[k + 1] * 0.12));
					}
					pool.splashes++;
					pool.kill(i);
					continue;
				}
			}
			const floor = floorUnder(nx, oy, nz);
			if (ny <= floor && oy >= floor - 0.05) {
				pool.pos[k] = nx;
				pool.pos[k + 1] = floor + 0.004;
				pool.pos[k + 2] = nz;
				pool.state[i] = 1;
				pool.settled++;
				// a settled drop lives at most SETTLE_FADE + 1.5 s more: a puddle that dries
				pool.life[i] = Math.min(pool.life[i], pool.age[i] + 1.5 + SETTLE_FADE);
			} else {
				pool.pos[k] = nx;
				pool.pos[k + 1] = ny;
				pool.pos[k + 2] = nz;
				// fell off the world
				if (ny < -200) {
					pool.kill(i);
					continue;
				}
			}
		}
		const left = pool.life[i] - pool.age[i];
		pool.fade[i] = Math.min(1, left / lifetimeFade);
		i++;
	}
	pool.geometry.setDrawRange(0, pool.count);
	pool.posAttr.needsUpdate = true;
	pool.fadeAttr.needsUpdate = true;
}

/** @param {string} key @param {'pour'|'spill'} kind @param {any} object */
function sourceFor(key, kind, object) {
	let s = sources.get(key);
	if (!s) {
		s = { pool: new DropPool(POUR_DEFAULTS.maxParticles, kind === 'pour' ? 'pour-drops' : 'spill-drops'), object, kind, seen: frameNo };
		sources.set(key, s);
	}
	s.object = object;
	s.seen = frameNo;
	if (visualParent && s.pool.points.parent !== visualParent) visualParent.add(s.pool.points);
	return s;
}

/** @param {any} o */
function shown(o) {
	for (let p = o; p; p = p.parent) if (p.visible === false) return false;
	return true;
}

/** @param {any} object @param {ReturnType<typeof normalizePour>} P @param {DropPool} pool @param {number} dt */
function emit(object, P, pool, dt) {
	pool.carry += P.rate * dt;
	const n = Math.floor(pool.carry);
	pool.carry -= n;
	if (n <= 0) return;
	object.updateWorldMatrix(true, false);
	const b = localBounds(object);
	_v.set(b[0] + (b[3] - b[0]) * P.at[0], b[1] + (b[4] - b[1]) * P.at[1], b[2] + (b[5] - b[2]) * P.at[2]).applyMatrix4(object.matrixWorld);
	object.matrixWorld.decompose(_d, _q, _s);
	const dir = new THREE.Vector3(P.dir[0], P.dir[1], P.dir[2]);
	if (dir.lengthSq() < 1e-6) dir.set(0, -1, 0);
	dir.normalize().applyQuaternion(_q);
	// an orthonormal pair around the spout direction for the cone
	const u = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(dir).normalize() : new THREE.Vector3(1, 0, 0).cross(dir).normalize();
	const w = dir.clone().cross(u);
	const cone = Math.tan((P.spread * Math.PI) / 180);
	for (let i = 0; i < n; i++) {
		// a deterministic-enough jitter (visual only): golden-angle spiral over the cone
		const t = (pool.splashes + pool.settled + pool.count + i) * 2.39996;
		const r = cone * Math.sqrt(((pool.count + i) % 17) / 17);
		const ex = dir.x + (u.x * Math.cos(t) + w.x * Math.sin(t)) * r;
		const ey = dir.y + (u.y * Math.cos(t) + w.y * Math.sin(t)) * r;
		const ez = dir.z + (u.z * Math.cos(t) + w.z * Math.sin(t)) * r;
		const len = Math.hypot(ex, ey, ez) || 1;
		const sp = P.speed * (0.9 + 0.2 * ((i * 7) % 5) / 5);
		if (!pool.spawn(_v.x, _v.y, _v.z, (ex / len) * sp, (ey / len) * sp, (ez / len) * sp, P.lifetime)) break;
	}
}

/** point size scale for a camera + canvas height (the fluid points tier's formula) */
let pointScale = 800;
/**
 * The per-frame tick (sim/runtime.tickSim). `root` = objectsGroup.
 * @param {any} root @param {any} camera @param {any} renderer @param {number} now ms
 * @param {boolean} [paused] the scene's simulation is paused (S9): drops hold still, spouts stop
 */
export function tickPours(root, camera, renderer, now, paused = false) {
	const height = renderer?.domElement?.height ?? 800;
	pointScale = camera?.isPerspectiveCamera ? height / (2 * Math.tan(((camera.fov ?? 50) * Math.PI) / 360)) : height;
	frameNo++;
	const dt = lastTick ? Math.min((now - lastTick) / 1000, 1 / 20) : 1 / 60;
	lastTick = now;
	if (!root || paused) return;
	visualParent = root.parent ?? null;
	ripplesThisFrame = 0;
	if (now - landingAt > 500) {
		landingAt = now;
		refreshLanding(root);
	}
	// pour emitters: any object (top-level or nested) carrying userData.pour
	root.traverse((/** @type {any} */ o) => {
		if (o === root || !o.userData?.pour || typeof o.userData.pour !== 'object') return;
		const P = normalizePour(o.userData.pour);
		const s = sourceFor('pour:' + o.uuid, 'pour', o);
		s.pool.resize(P.maxParticles);
		s.pool.material.uniforms.uSize.value = P.size;
		s.pool.material.uniforms.uColor.value.set(P.color);
		if (P.enabled && shown(o)) emit(o, P, s.pool, dt);
	});
	const vols = waterVolumes.list();
	for (const [key, s] of sources) {
		const gone = s.kind === 'pour' ? s.seen !== frameNo : !s.object?.parent && s.pool.count === 0;
		if (gone && s.pool.count === 0) {
			s.pool.dispose();
			sources.delete(key);
			continue;
		}
		s.pool.material.uniforms.uScale.value = pointScale;
		stepPool(s.pool, dt, vols, SETTLE_FADE);
	}
}

/**
 * F16: particles that left a fluid tank over its rim, as drops in WORLD space. `escaped` is
 * fluidCore's [x,y,z,vx,vy,vz]* in the tank frame; `frame` the tank frame matrix (world).
 * @param {any} tankObject @param {Float32Array} escaped @param {THREE.Matrix4} frame @param {THREE.Quaternion} frameQuat
 * @param {{maxDrops: number, lifetime: number, color?: string, size?: number}} spill
 */
export function spillDrops(tankObject, escaped, frame, frameQuat, spill) {
	const s = sourceFor('spill:' + tankObject.uuid, 'spill', tankObject);
	s.pool.resize(Math.max(1, Math.min(MAX_DROPS_PER_SOURCE, Math.round(spill.maxDrops))));
	if (spill.color) s.pool.material.uniforms.uColor.value.set(spill.color);
	if (spill.size) s.pool.material.uniforms.uSize.value = spill.size;
	let n = 0;
	for (let i = 0; i + 5 < escaped.length; i += 6) {
		_v.set(escaped[i], escaped[i + 1], escaped[i + 2]).applyMatrix4(frame);
		_d.set(escaped[i + 3], escaped[i + 4], escaped[i + 5]).applyQuaternion(frameQuat);
		if (!s.pool.spawn(_v.x, _v.y, _v.z, _d.x, _d.y, _d.z, spill.lifetime)) break;
		n++;
	}
	return n;
}

/** TEST/DEBUG: every source's live numbers */
export function pourDebug() {
	return [...sources.entries()].map(([key, s]) => ({
		key,
		kind: s.kind,
		count: s.pool.count,
		capacity: s.pool.capacity,
		splashes: s.pool.splashes,
		settled: s.pool.settled,
		flying: Array.from(s.pool.state.subarray(0, s.pool.count)).filter((x) => x === 0).length
	}));
}

/** TEST/DEBUG: the whole system's drop count (capped at MAX_DROPS_TOTAL) */
export function totalDropCount() {
	return totalDrops;
}

/** drop everything (scene switch / tests) */
export function resetPours() {
	for (const s of sources.values()) s.pool.dispose();
	sources.clear();
	totalDrops = 0;
}
