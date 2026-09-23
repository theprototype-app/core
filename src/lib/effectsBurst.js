// 30b (vr-play) C6 — `api.effects.burst([x,y,z], {kind, color, count})`: a short-lived
// particle burst for a game's moments — the sparkle when a Towers ring is reached, the
// confetti on a goal, smoke off an explosion, sparks off a hit.
//
// POOLED: a fixed set of THREE.Points systems (POOL_SIZE x MAX_COUNT particles) built on
// first use and recycled oldest-first, so a burst per frame costs no allocation and no GPU
// upload of a new geometry — only the attribute ranges it rewrites. LOCAL by contract:
// nothing is sent (a module that wants peers to see it broadcasts its own op), and the
// systems live at the SCENE ROOT under fixed names (golden rule 5: objectsGroup is
// replicated, the scene root is local), so no burst can leak into a save or a GLTF sync.
//
// Ticked from the flow runtime's frame loop (the module frame-task list — it runs on the
// desktop AND in a headset, where window rAF stops), and parked invisible between bursts.
// `depthWrite: false` is right for soft sprites; a burst is short enough that the AO/outline
// trade-off (the documented depthWrite trap) does not matter.
//
// Kinds (the motion model per kind is the only thing that differs):
//  sparkle  gold twinkling stars that drift up, additive
//  confetti many-coloured flakes thrown up, falling under gravity, normal blending
//  smoke    grey puffs that rise, swell and thin
//  sparks   fast orange streaks, gravity, very short
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene } from '../stores/sceneStore';
import { moduleFrameTasks } from './moduleSDK';

export const BURST_KINDS = ['sparkle', 'confetti', 'smoke', 'sparks'];
export const POOL_SIZE = 12;
export const MAX_COUNT = 96;

/**
 * The per-kind recipe. Pure data; `life` in seconds, speeds in m/s, `size` in metres.
 * @type {Record<string, {count: number, life: number, speed: number, up: number, gravity: number, drag: number, size: number, grow: number, additive: boolean, color: string, palette?: string[]}>}
 */
export const BURST_RECIPES = {
	sparkle: { count: 40, life: 1.1, speed: 1.2, up: 0.8, gravity: -0.4, drag: 1.6, size: 0.09, grow: -0.5, additive: true, color: '#ffd76a' },
	confetti: { count: 80, life: 2.2, speed: 3.2, up: 3.2, gravity: -5.5, drag: 1.2, size: 0.07, grow: 0, additive: false, color: '#ffffff', palette: ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'] },
	smoke: { count: 28, life: 2.4, speed: 0.5, up: 0.9, gravity: 0.3, drag: 0.8, size: 0.35, grow: 1.4, additive: false, color: '#9ca3af' },
	sparks: { count: 60, life: 0.55, speed: 5.5, up: 1.5, gravity: -9.8, drag: 0.6, size: 0.045, grow: -0.6, additive: true, color: '#ffa53a' }
};

/**
 * Where each particle starts heading: a deterministic spread over the sphere (a golden-
 * angle spiral), so a burst looks the same every time and the maths is testable. Returns
 * unit directions with the upward kick of the recipe folded into y later.
 * @param {number} n @returns {number[][]}
 */
export function burstDirections(n) {
	/** @type {number[][]} */
	const out = [];
	const golden = Math.PI * (3 - Math.sqrt(5));
	for (let i = 0; i < n; i++) {
		const y = 1 - (2 * (i + 0.5)) / n;
		const r = Math.sqrt(Math.max(0, 1 - y * y));
		const a = golden * i;
		out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
	}
	return out;
}

/** @type {THREE.Texture | null} */
let sprite = null;
/** a soft round dot, drawn once (a square point reads as a pixel, not a particle) */
function spriteTexture() {
	if (sprite) return sprite;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 64;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
	grad.addColorStop(0, 'rgba(255,255,255,1)');
	grad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
	grad.addColorStop(1, 'rgba(255,255,255,0)');
	g.fillStyle = grad;
	g.fillRect(0, 0, 64, 64);
	sprite = new THREE.CanvasTexture(canvas);
	sprite.colorSpace = THREE.SRGBColorSpace;
	return sprite;
}

/**
 * @typedef {object} BurstSystem
 * @property {THREE.Points} points
 * @property {Float32Array} pos @property {Float32Array} vel @property {Float32Array} col
 * @property {Float32Array} base the per-particle start colour (col fades from it)
 * @property {number} count @property {number} age @property {number} life
 * @property {any} recipe @property {number} startedAt
 */

/** @type {BurstSystem[]} */
const pool = [];
let lastTick = 0;
let ticking = false;
const stats = { fired: 0, recycled: 0 };

/** @param {number} index @returns {BurstSystem} */
function makeSystem(index) {
	const geometry = new THREE.BufferGeometry();
	const pos = new Float32Array(MAX_COUNT * 3);
	const col = new Float32Array(MAX_COUNT * 3);
	geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
	geometry.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
	geometry.setDrawRange(0, 0);
	const material = new THREE.PointsMaterial({
		size: 0.1,
		map: spriteTexture(),
		vertexColors: true,
		transparent: true,
		depthWrite: false,
		sizeAttenuation: true
	});
	const points = new THREE.Points(geometry, material);
	points.name = 'effects-burst-' + index;
	points.frustumCulled = false; // the particles fly out of any bounds computed at t=0
	points.visible = false;
	points.renderOrder = 996;
	points.userData.localOnly = true;
	return {
		points,
		pos,
		vel: new Float32Array(MAX_COUNT * 3),
		col,
		base: new Float32Array(MAX_COUNT * 3),
		count: 0,
		age: 0,
		life: 0,
		recipe: null,
		startedAt: 0
	};
}

/** the free system, or the oldest running one @returns {BurstSystem | null} */
function takeSystem() {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return null;
	while (pool.length < POOL_SIZE) pool.push(makeSystem(pool.length));
	for (const sys of pool) if (sys.points.parent !== scene) scene.add(sys.points);
	const idle = pool.find((sys) => !sys.points.visible);
	if (idle) return idle;
	stats.recycled++;
	return pool.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
}

/** @param {string | undefined} kind */
function recipeOf(kind) {
	return BURST_RECIPES[kind && BURST_RECIPES[kind] ? kind : 'sparkle'];
}

/**
 * Fire a burst at a world position. LOCAL. Returns the system's name, or null when there
 * is no scene or the position is not three finite numbers.
 * @param {number[]} position @param {{kind?: string, color?: string, count?: number}} [options]
 * @returns {string | null}
 */
export function burst(position, options = {}) {
	if (!Array.isArray(position) || position.length < 3 || !position.slice(0, 3).every((n) => Number.isFinite(Number(n)))) return null;
	const sys = takeSystem();
	if (!sys) return null;
	const recipe = recipeOf(options?.kind);
	const wanted = Number(options?.count);
	const count = Math.max(1, Math.min(MAX_COUNT, Math.round(Number.isFinite(wanted) && wanted > 0 ? wanted : recipe.count)));
	const dirs = burstDirections(count);
	const tint = new THREE.Color();
	const custom = typeof options?.color === 'string' && options.color ? options.color : null;
	for (let i = 0; i < count; i++) {
		const d = dirs[i];
		// a small per-particle speed variation from the index (deterministic)
		const speed = recipe.speed * (0.55 + 0.45 * (((i * 7919) % 97) / 97));
		sys.pos[i * 3] = Number(position[0]);
		sys.pos[i * 3 + 1] = Number(position[1]);
		sys.pos[i * 3 + 2] = Number(position[2]);
		sys.vel[i * 3] = d[0] * speed;
		sys.vel[i * 3 + 1] = d[1] * speed + recipe.up;
		sys.vel[i * 3 + 2] = d[2] * speed;
		const colour = custom ?? (recipe.palette ? recipe.palette[i % recipe.palette.length] : recipe.color);
		tint.set(colour);
		sys.base[i * 3] = sys.col[i * 3] = tint.r;
		sys.base[i * 3 + 1] = sys.col[i * 3 + 1] = tint.g;
		sys.base[i * 3 + 2] = sys.col[i * 3 + 2] = tint.b;
	}
	sys.count = count;
	sys.age = 0;
	sys.life = recipe.life;
	sys.recipe = recipe;
	sys.startedAt = performance.now();
	const material = /** @type {THREE.PointsMaterial} */ (sys.points.material);
	material.blending = recipe.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
	material.size = recipe.size;
	material.opacity = 1;
	material.needsUpdate = true;
	const geometry = sys.points.geometry;
	geometry.setDrawRange(0, count);
	geometry.attributes.position.needsUpdate = true;
	geometry.attributes.color.needsUpdate = true;
	sys.points.visible = true;
	stats.fired++;
	ensureTicking();
	return sys.points.name;
}

/**
 * Advance every live burst by `dt` seconds. Exported so the suites step it
 * deterministically; the frame task calls it with the real frame time.
 * @param {number} dt
 */
export function stepBursts(dt) {
	// the AGE runs on the real clock (a burst lives its life whatever the frame rate — a
	// throttled tab ticks five times a second); only the INTEGRATION step is capped, so a
	// long frame cannot fling a particle across the room
	const elapsed = Math.min(1, Math.max(0, dt));
	const step = Math.min(0.1, elapsed);
	for (const sys of pool) {
		if (!sys.points.visible) continue;
		sys.age += elapsed;
		const r = sys.recipe;
		if (sys.age >= sys.life) {
			sys.points.visible = false;
			sys.points.geometry.setDrawRange(0, 0);
			continue;
		}
		const damp = Math.exp(-r.drag * step);
		const fade = 1 - sys.age / sys.life;
		for (let i = 0; i < sys.count; i++) {
			const k = i * 3;
			sys.vel[k] *= damp;
			sys.vel[k + 1] = sys.vel[k + 1] * damp + r.gravity * step;
			sys.vel[k + 2] *= damp;
			sys.pos[k] += sys.vel[k] * step;
			sys.pos[k + 1] += sys.vel[k + 1] * step;
			sys.pos[k + 2] += sys.vel[k + 2] * step;
			// additive particles fade by DARKENING (black adds nothing); a sparkle twinkles
			const twinkle = r === BURST_RECIPES.sparkle ? 0.6 + 0.4 * Math.sin(sys.age * 24 + i * 1.7) : 1;
			const k2 = r.additive ? fade * twinkle : 1;
			sys.col[k] = sys.base[k] * k2;
			sys.col[k + 1] = sys.base[k + 1] * k2;
			sys.col[k + 2] = sys.base[k + 2] * k2;
		}
		const material = /** @type {THREE.PointsMaterial} */ (sys.points.material);
		if (!r.additive) material.opacity = Math.min(1, fade * 1.6);
		material.size = Math.max(0.005, r.size * (1 + r.grow * (sys.age / sys.life)));
		sys.points.geometry.attributes.position.needsUpdate = true;
		sys.points.geometry.attributes.color.needsUpdate = true;
	}
}

function frameTask() {
	const now = performance.now();
	const dt = lastTick ? (now - lastTick) / 1000 : 0;
	lastTick = now;
	stepBursts(dt);
	if (!pool.some((sys) => sys.points.visible)) {
		// nothing alive: leave the frame loop until the next burst. AFTER the loop that is
		// calling us — a splice inside its forEach would skip the next module's task
		ticking = false;
		lastTick = 0;
		queueMicrotask(() => {
			if (ticking) return; // a burst fired in the meantime
			const i = moduleFrameTasks.indexOf(frameTask);
			if (i >= 0) moduleFrameTasks.splice(i, 1);
		});
	}
}

function ensureTicking() {
	if (ticking) return;
	ticking = true;
	lastTick = 0;
	if (!moduleFrameTasks.includes(frameTask)) moduleFrameTasks.push(frameTask);
}

/** live systems for the suites @returns {{fired: number, recycled: number, live: {name: string, count: number, age: number, kind: string}[]}} */
export function burstDebug() {
	return {
		...stats,
		live: pool
			.filter((sys) => sys.points.visible)
			.map((sys) => ({
				name: sys.points.name,
				count: sys.count,
				age: sys.age,
				kind: Object.keys(BURST_RECIPES).find((k) => BURST_RECIPES[k] === sys.recipe) ?? ''
			}))
	};
}

/** Drop every live burst (a scene clear) */
export function clearBursts() {
	for (const sys of pool) {
		sys.points.visible = false;
		sys.points.geometry.setDrawRange(0, 0);
	}
}
