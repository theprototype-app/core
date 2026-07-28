// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { colliderSpecOf } from './colliderSpec';
import { wireframeActive } from './viewMode';

// CL-A A7: collider visualization (the lightHelpers pattern). Per tracked
// object a wireframe built FROM colliderSpecOf — the SAME spec physics
// consumes, so what you see is what rapier gets. Proxies live at the SCENE
// ROOT (never in objectsGroup) so they stay out of GLTF saves and peer sync;
// they follow the object per frame from Scene's useTask.

/** global toggle (scene ▸ View), LOCAL pref, default OFF */
export const showColliders = writable(
	typeof localStorage !== 'undefined' && localStorage.getItem('showColliders') === 'true'
);
/** per-object opt-in (Inspector ▸ Physics "Show collider") — session-local,
 * NOT persisted or replicated. @type {import('svelte/store').Writable<Set<string>>} */
export const colliderVizObjects = writable(new Set());

/** @type {Map<string, {object: any, group: any, key: string, localCenter: any}>} */
const entries = new Map();
/** @type {any} */ let proxyRoot = null;
let started = false;

const COLLIDER_COLOR = 0x22c55e; // green
const SENSOR_COLOR = 0xf59e0b; // amber

/** @param {number} color */
function lineMaterial(color) {
	return new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
}

/**
 * Wireframe group for one object's collider spec. Geometry mirrors
 * physics.shapeDesc: sphere = max extent, capsule/cylinder along local Y,
 * hull/custom = one convex piece each.
 * @param {any} spec @param {boolean} sensor @returns {any}
 */
function buildWireframe(spec, sensor) {
	const group = new THREE.Group();
	group.name = 'collider-proxy';
	const material = lineMaterial(sensor ? SENSOR_COLOR : COLLIDER_COLOR);
	const he = spec.halfExtents;
	/** @type {any[]} */
	const geometries = [];
	if (spec.pieces) {
		for (const piece of spec.pieces) {
			const points = [];
			for (let i = 0; i < piece.verts.length; i += 3)
				points.push(new THREE.Vector3(piece.verts[i], piece.verts[i + 1], piece.verts[i + 2]));
			try {
				geometries.push(new THREE.EdgesGeometry(new ConvexGeometry(points)));
			} catch {
				// degenerate piece (coplanar verts): skip its wireframe
			}
		}
	} else if (spec.kind === 'sphere') {
		const r = Math.max(he.x, he.y, he.z);
		geometries.push(new THREE.WireframeGeometry(new THREE.SphereGeometry(r, 12, 8)));
	} else if (spec.kind === 'capsule') {
		const radius = Math.max(he.x, he.z, 0.02);
		const half = Math.max(he.y - radius, 0.01);
		geometries.push(new THREE.WireframeGeometry(new THREE.CapsuleGeometry(radius, half * 2, 4, 8)));
	} else if (spec.kind === 'cylinder') {
		const r = Math.max(he.x, he.z, 0.02);
		geometries.push(new THREE.EdgesGeometry(new THREE.CylinderGeometry(r, r, he.y * 2, 16)));
	} else {
		geometries.push(new THREE.EdgesGeometry(new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2)));
	}
	geometries.forEach((geometry) => {
		const lines = new THREE.LineSegments(geometry, material);
		lines.raycast = () => {}; // decorative — never a pick target (the D8 rule)
		group.add(lines);
	});
	return group;
}

/** change-detection key: rebuild the wireframe only when the SHAPE changed
 * @param {any} object @param {any} spec @param {boolean} sensor */
function keyOf(object, spec, sensor) {
	const r = (/** @type {number} */ v) => Math.round(v * 1000);
	return [
		spec.kind,
		r(spec.halfExtents.x),
		r(spec.halfExtents.y),
		r(spec.halfExtents.z),
		spec.pieces ? spec.pieces.map((/** @type {any} */ p) => p.verts.length).join(',') : '',
		Array.isArray(object.userData?.physics?.colliderVerts)
			? object.userData.physics.colliderVerts.length
			: 0,
		sensor ? 's' : ''
	].join('|');
}

/** the uuids we should be showing right now */
function trackedUuids() {
	const group = get(objectsGroup);
	if (!group) return new Set();
	const set = new Set(get(colliderVizObjects));
	if (get(showColliders)) {
		group.children.forEach((/** @type {any} */ object) => {
			// everything that would participate with a real shape: userData.physics
			// (fun primitives get it at creation) — scenery without it still gets a
			// box at sim time, but drawing EVERY object is noise, not signal
			if (object.userData?.physics) set.add(object.uuid);
		});
	}
	return set;
}

/** @param {string} uuid @param {any} entry */
function disposeEntry(uuid, entry) {
	proxyRoot?.remove(entry.group);
	entry.group.children.forEach((/** @type {any} */ lines) => {
		lines.geometry.dispose();
		lines.material.dispose();
	});
	entries.delete(uuid);
}

function sync() {
	const scene = get(globalScene);
	const group = get(objectsGroup);
	if (!scene || !group) return;
	if (!proxyRoot) {
		proxyRoot = new THREE.Group();
		proxyRoot.name = 'collider-proxies';
		scene.add(proxyRoot);
	}
	const tracked = trackedUuids();
	tracked.forEach((uuid) => {
		const object = group.getObjectByProperty('uuid', uuid);
		if (!object) return;
		const p = object.userData?.physics;
		const spec = colliderSpecOf(object, p?.collider);
		if (!spec) return;
		const sensor = !!p?.sensor;
		const key = keyOf(object, spec, sensor);
		const existing = entries.get(uuid);
		if (existing && existing.key === key) return;
		if (existing) disposeEntry(uuid, existing);
		const proxy = buildWireframe(spec, sensor);
		proxyRoot.add(proxy);
		entries.set(uuid, {
			object,
			group: proxy,
			key,
			// primitives: the AABB center in OBJECT-local coords (world center
			// re-derived per frame via localToWorld); pieces sit at the origin
			localCenter: spec.pieces ? new THREE.Vector3() : object.worldToLocal(spec.center.clone())
		});
	});
	[...entries.entries()].forEach(([uuid, entry]) => {
		if (!tracked.has(uuid) || !group.getObjectByProperty('uuid', uuid)) disposeEntry(uuid, entry);
	});
}

const followPos = new THREE.Vector3();
const followQuat = new THREE.Quaternion();

/** Per-frame from Scene's useTask: proxies follow their object (mid-sim the
 * object pose already mirrors the body — no body access needed). Hidden
 * entirely in wireframe view mode (they'd render as junk). */
export function updateColliderHelpers() {
	if (!proxyRoot) return;
	proxyRoot.visible = entries.size > 0 && !wireframeActive();
	if (!proxyRoot.visible) return;
	entries.forEach((entry) => {
		entry.object.updateMatrixWorld();
		entry.object.localToWorld(followPos.copy(entry.localCenter));
		entry.object.getWorldQuaternion(followQuat);
		entry.group.position.copy(followPos);
		entry.group.quaternion.copy(followQuat);
	});
}

/** Inspector ▸ Physics per-object toggle. @param {string} uuid @param {boolean} on */
export function setColliderViz(uuid, on) {
	colliderVizObjects.update((set) => {
		const next = new Set(set);
		if (on) next.add(uuid);
		else next.delete(uuid);
		return next;
	});
}

/** @type {any} */ let syncTimer = null;

export function startColliderHelpers() {
	if (started || typeof window === 'undefined') return;
	started = true;
	objectsGroup.subscribe(() => {
		clearTimeout(syncTimer);
		syncTimer = setTimeout(sync, 100);
	});
	showColliders.subscribe((value) => {
		try {
			localStorage.setItem('showColliders', String(value));
		} catch {}
		sync();
	});
	colliderVizObjects.subscribe(() => sync());
}

/** test/debug view of the live proxies */
export function colliderHelpersDebug() {
	return [...entries.entries()].map(([uuid, entry]) => ({
		uuid,
		key: entry.key,
		pieces: entry.group.children.length,
		visible: !!proxyRoot?.visible
	}));
}
