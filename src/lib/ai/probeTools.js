// Roadmap 104 B1 (lane 104-world) — `probe`: WHAT IS UNDER THIS POINT. A read-only tool (viewers may call it,
// the connector's read scope allows it) that answers the question `list_scene` cannot: the height and kind of
// the surface straight under an x/z (or along a ray), and the water above it. It never changes anything.
//
//   probe {at: [x, z]}                 one point
//   probe {points: [[x, z], …]}        up to PROBE_MAX_POINTS at once (a row of fence posts, a grid)
//   probe {ray: {from, dir, max}}      the first thing a ray meets
//   include: "solid" (default)         water bodies and sensor volumes are looked THROUGH (they are not ground)
//            "all"                     they count too, and each point lists every surface top-down (`hits`)
//
// Everything is in the frame create_objects builds in (objectsGroup-local), like where_are_users. The pure half
// (`probeScene`) takes the group and the ground config, so tests/unit/probe.test.js drives it with three only.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore.js';
import { scenePhysicsGround } from '$lib/scenePhysics.js';
import { waterVolumes, isWaterBlob } from '$lib/water/volumes.js';
import { waterHoles } from '$lib/sim/groundHoles.js';

export const PROBE_TOOL_NAMES = ['probe'];
export const PROBE_MAX_POINTS = 64;
/** a downward probe starts this far above the highest thing in the scene */
const ABOVE = 1;
const MAX_HITS = 8;
const RAY_MAX = 1000;

const r3 = (/** @type {number} */ v) => Math.round(v * 1000) / 1000 + 0; // + 0: no -0 in the JSON

/** the top-level scene object a hit belongs to (what list_scene lists) @param {any} o @param {any} group */
function topOf(o, group) {
	let t = o;
	while (t.parent && t.parent !== group) t = t.parent;
	return t;
}

/** the nearest ancestor (or self) carrying `key` in userData @param {any} o @param {any} group @param {string} key */
function withData(o, group, key) {
	for (let p = o; p && p !== group; p = p.parent) if (p.userData?.[key]) return p;
	return null;
}

/** @param {any} o @param {any} group */
function visible(o, group) {
	for (let p = o; p && p !== group; p = p.parent) if (!p.visible) return false;
	return true;
}

/**
 * What one ray hit is: water, a sensor volume (a trigger, not ground), a terrain or a mesh.
 * @param {any} hit a three Intersection @param {any} group
 */
function kindOf(hit, group) {
	if (withData(hit.object, group, 'water') && isWaterBlob(withData(hit.object, group, 'water').userData.water)) return 'water';
	const top = topOf(hit.object, group);
	if (withData(hit.object, group, 'terrain')) return 'terrain';
	if (top.userData?.physics?.sensor === true || hit.object.userData?.physics?.sensor === true) return 'sensor';
	return 'mesh';
}

/** a world normal of a hit, in the build frame @param {any} hit @param {THREE.Matrix4} inv */
function normalOf(hit, inv) {
	if (!hit.face) return [0, 1, 0];
	const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
	n.transformDirection(inv);
	return n.toArray().map(r3);
}

/**
 * The water at a build-frame x/z: the top-most water body whose footprint holds the point, its still surface
 * (waves left out) and the wave height there right now.
 * @param {any} group @param {number} x @param {number} z
 * @returns {{object: any, surface: number, now: number} | null} heights in WORLD y
 */
function waterAt(group, x, z) {
	const w = group.localToWorld(new THREE.Vector3(x, 0, z));
	/** @type {{object: any, surface: number, now: number} | null} */
	let best = null;
	group.traverse((/** @type {any} */ o) => {
		if (o === group || !isWaterBlob(o.userData?.water) || !visible(o, group)) return;
		const v = waterVolumes.get(o);
		if (!v) return;
		const still = waterVolumes.surfaceY(v, w.x, w.z, { flat: true });
		if (still === null || !Number.isFinite(still)) return;
		// inside the footprint: a point just under the still surface is IN this body
		const inside = waterVolumes.query([w.x, still - 1e-3, w.z], { flat: true, volumes: [v] });
		if (!inside || (best && best.surface >= still)) return;
		const now = waterVolumes.surfaceY(v, w.x, w.z, { flat: false }) ?? still;
		best = { object: o, surface: still, now };
	});
	return best;
}

/**
 * 104 B3: the water at a build-frame x/z in the build frame — what set_physics's waterline answer reads.
 * @param {any} group @param {number} x @param {number} z @returns {{uuid: string, name: string, surface: number} | null}
 */
export function waterUnder(group, x, z) {
	const wet = waterAt(group, x, z);
	if (!wet) return null;
	return { uuid: wet.object.uuid, name: wet.object.name || '', surface: r3(group.worldToLocal(new THREE.Vector3(0, wet.surface, 0)).y) };
}

/** @param {any} v @returns {v is number[]} */
const isVec = (v, n = 3) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * The pure half: probe `group` (objectsGroup) with `args`.
 * @param {any} group @param {any} args @param {{ground?: {enabled?: boolean, height?: number} | null}} [env]
 */
export function probeScene(group, args, env = {}) {
	const a = args && typeof args === 'object' ? args : {};
	const include = a.include === undefined ? 'solid' : a.include;
	if (include !== 'solid' && include !== 'all') return { error: 'include: "solid" (default: water and trigger volumes are looked through) or "all"' };
	group.updateWorldMatrix(true, true);
	const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
	const ray = new THREE.Raycaster();
	/** every visible mesh hit along a world ray, nearest first @param {THREE.Vector3} o @param {THREE.Vector3} d @param {number} far */
	const cast = (o, d, far) => {
		ray.set(o, d);
		ray.far = far;
		return ray.intersectObjects(group.children, true).filter((h) => /** @type {any} */ (h.object).isMesh && visible(h.object, group));
	};
	/** one hit as the answer names it @param {any} h */
	const describe = (h) => {
		const top = topOf(h.object, group);
		const p = group.worldToLocal(h.point.clone());
		return { uuid: top.uuid, name: top.name || '', surface: kindOf(h, group), point: p.toArray().map(r3), normal: normalOf(h, inv), _d: h.distance };
	};

	if (a.ray !== undefined) {
		const r = a.ray;
		if (!r || typeof r !== 'object' || !isVec(r.from) || !isVec(r.dir)) return { error: 'ray: {from: [x, y, z], dir: [x, y, z], max?: metres}' };
		const d = new THREE.Vector3().fromArray(r.dir);
		if (d.lengthSq() < 1e-12) return { error: 'ray.dir: a direction, not [0, 0, 0]' };
		const max = r.max === undefined ? RAY_MAX : r.max;
		if (typeof max !== 'number' || !(max > 0) || max > RAY_MAX) return { error: 'ray.max: metres, above 0, at most ' + RAY_MAX };
		const from = group.localToWorld(new THREE.Vector3().fromArray(r.from));
		const dw = d.clone().normalize().transformDirection(group.matrixWorld);
		// a scaled build frame: distances along the world ray, reported back in build-frame metres
		const scale = group.localToWorld(new THREE.Vector3().fromArray(r.from).add(d.clone().normalize())).sub(from).length() || 1;
		const hits = cast(from, dw, max * scale).map(describe).filter((x) => include === 'all' || (x.surface !== 'water' && x.surface !== 'sensor'));
		const first = hits[0];
		if (!first) return { hit: null, note: 'nothing within ' + max + ' m along that ray' };
		const { _d, ...rest } = first;
		return { hit: { ...rest, distance: r3(_d / scale) } };
	}

	/** @type {number[][]} */
	let pts;
	if (a.at !== undefined) {
		if (!isVec(a.at, 2) && !isVec(a.at, 3)) return { error: 'at: [x, z] (or [x, y, z]; y is ignored)' };
		pts = [a.at];
	} else if (a.points !== undefined) {
		if (!Array.isArray(a.points) || !a.points.length) return { error: 'points: [[x, z], …], 1 to ' + PROBE_MAX_POINTS };
		if (a.points.length > PROBE_MAX_POINTS) return { error: 'points: at most ' + PROBE_MAX_POINTS + ' per call (got ' + a.points.length + ')' };
		const bad = a.points.findIndex((/** @type {any} */ p) => !isVec(p, 2) && !isVec(p, 3));
		if (bad >= 0) return { error: 'points[' + bad + ']: [x, z]' };
		pts = a.points;
	} else return { error: 'give at: [x, z], points: [[x, z], …] or ray: {from, dir}' };

	const box = new THREE.Box3().setFromObject(group);
	const topY = box.isEmpty() ? 10 : box.max.y + ABOVE;
	const down = new THREE.Vector3(0, -1, 0).transformDirection(group.matrixWorld);
	const ground = env.ground?.enabled ? (Number.isFinite(env.ground.height) ? /** @type {number} */ (env.ground.height) : 0) : null;
	/** @type {any[] | null} */
	let holes = null;
	const results = pts.map((p) => {
		const x = p[0];
		const z = p.length === 3 ? p[2] : p[1];
		const start = group.localToWorld(new THREE.Vector3(x, 0, z));
		start.y = Math.max(topY, start.y + ABOVE);
		const all = cast(start, down, Infinity).map(describe);
		const solid = all.find((h) => h.surface === 'terrain' || h.surface === 'mesh');
		const wet = waterAt(group, x, z);
		/** @type {any} */
		const out = { at: [r3(x), r3(z)] };
		if (solid) Object.assign(out, { y: solid.point[1], uuid: solid.uuid, name: solid.name, normal: solid.normal, surface: solid.surface });
		else if (ground !== null) {
			// the scene's ground plane, unless a water body cut a hole in it (an ocean is bottomless)
			holes ??= waterHoles(
				[...waterVolumesUnder(group)].map((o) => waterVolumes.get(o)).filter(Boolean),
				ground
			);
			const w = group.localToWorld(new THREE.Vector3(x, 0, z));
			const hole = holes.find((hl) => w.x >= hl.minX && w.x <= hl.maxX && w.z >= hl.minZ && w.z <= hl.maxZ);
			if (hole && hole.floorY === null) Object.assign(out, { y: null, surface: 'none', note: 'open water with no floor under it: a body that sinks here falls out of the world' });
			else Object.assign(out, { y: r3(hole ? hole.floorY : ground), uuid: null, name: '', normal: [0, 1, 0], surface: 'ground' });
		} else Object.assign(out, { y: null, surface: 'none', note: 'nothing under this point (the scene has no ground plane)' });
		if (wet) {
			const s = group.worldToLocal(new THREE.Vector3(0, wet.surface, 0)).y;
			const now = group.worldToLocal(new THREE.Vector3(0, wet.now, 0)).y;
			const floorY = typeof out.y === 'number' ? out.y : null;
			if (floorY === null || floorY < s)
				out.water = {
					uuid: wet.object.uuid,
					name: wet.object.name || '',
					surface: r3(s),
					...(Math.abs(now - s) > 1e-3 ? { surfaceNow: r3(now) } : {}),
					depth: floorY === null ? null : r3(s - floorY)
				};
		}
		if (include === 'all') out.hits = all.slice(0, MAX_HITS).map(({ _d, point, ...h }) => ({ ...h, y: point[1] }));
		return out;
	});
	return a.at !== undefined ? results[0] : { points: results };
}

/** @param {any} group */
function* waterVolumesUnder(group) {
	const stack = [...group.children];
	while (stack.length) {
		const o = stack.pop();
		if (isWaterBlob(o.userData?.water)) yield o;
		stack.push(...(o.children ?? []));
	}
}

/** the tool as the registry runs it @param {string} name @param {any} args */
export async function probeTool(name, args) {
	if (name !== 'probe') return { error: 'unknown probe tool ' + name };
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group) return { error: 'The 3D view is not ready yet.' };
	return probeScene(group, args, { ground: /** @type {any} */ (get(scenePhysicsGround)) });
}

/** the assistant's OpenAI-format schema */
export const PROBE_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'probe',
			description:
				'Read what is UNDER a point, without changing anything: the height of the ground (a terrain, a floor, a table top, the ground plane) straight under an x/z, its surface normal and which object it is, and the water there (its still surface level and how deep it is). Use it before placing things "on the ground", "on the beach", "on the water" or along a slope: put an object\'s base at y, or a floating thing at water.surface. ' +
				'at: [x, z] for one point, points: [[x, z], …] (up to ' +
				PROBE_MAX_POINTS +
				') for many (a row of posts, a path), ray: {from, dir, max} for the first thing a ray meets (what is in front of a door, under a lamp). ' +
				'Water bodies and trigger volumes are looked through unless include is "all". ' +
				'probe answers "what is under this point"; list_scene {near} answers "which objects are around here".',
			parameters: {
				type: 'object',
				properties: {
					at: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3, description: '[x, z] in metres (the frame create_objects builds in)' },
					points: {
						type: 'array',
						maxItems: PROBE_MAX_POINTS,
						items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 3 },
						description: 'many [x, z] at once; the answer lists them in the same order'
					},
					ray: {
						type: 'object',
						description: 'instead of at / points: the first surface along a ray, {uuid, name, surface, point, normal, distance}',
						properties: {
							from: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z]' },
							dir: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'direction [x, y, z] (any length)' },
							max: { type: 'number', description: 'metres, default and at most ' + RAY_MAX }
						},
						required: ['from', 'dir']
					},
					include: {
						type: 'string',
						enum: ['solid', 'all'],
						description: 'solid (default) = ground only: water and trigger volumes are looked through; all = they count too, and each point also lists every surface top-down (hits)'
					}
				}
			}
		}
	}
];

/** one line of the assistant's system prompt */
export const PROBE_PROMPT =
	'\nprobe {at: [x, z]} reads the ground height and the water under a point (read-only): use its y to stand things on terrain, water.surface to float them.';
