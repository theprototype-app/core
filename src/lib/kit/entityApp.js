// 34 R2 (kit-entities) — KIT ENTITIES IN THE APP: what the pure runtime (kit/entities.js) needs
// from the live session, and what every peer draws.
//
//   draw       each entity is drawn as a COPY of its template object (`tpl`, an ordinary object
//              in the scene — visible, editable, saved with the .tpscene, the spawner.js rule)
//              inside ONE scene-root group (`kit-entities`) that follows objectsGroup's frame.
//              Copies are LOCAL (golden rule 5: objectsGroup = replicated, scene root = local):
//              no `duplicate`, no physics body, never saved, nothing on the wire but the
//              `kitentity` records. A template that is missing draws a plain capsule. The
//              authority draws the live pose; every other peer eases between flushed poses
//              (entityCore.renderPos — golden rule 11). A dead entity sinks and shrinks until it
//              is removed.
//   world      the movers' obstacles: the top-level objects of the scene that stand in the
//              walking band of the entities (a floor is below it, a canopy above it), minus
//              dynamic bodies, transient copies, the templates themselves, anything an entity
//              stands INSIDE (a decoration group's box around the whole level) and anything
//              marked `userData.kitWalkable`; the play block's `bounds` (objectsGroup frame).
//              Rebuilt at most once a second while the scene changes.
//   targets    'player' / 'nearestPlayer' = the nearest player to the follower (this peer's
//              camera and every connected peer's avatar), 'player:<id>' = that one, anything
//              else = an object uuid's position
//   pulse      an event the authority witnessed pulses its `kit-<piece>-<event>` node once
//              (flowRuntime.fireModuleTrigger, replicated like every pulse)
//
// Started from flowRuntime's start (a primed dynamic import, the kit/runtime.js rule).

import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, objectsGroup, globalCamera } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import {
	moduleFrameTasks,
	moduleInteractiveGroups,
	registerSystemGroup,
	sceneClearHandlers
} from '../sdk/registries.js';
import { sessionNow } from '../sessionClock';
import { resolvePlaySettings } from '../playSettings';
import { kit } from './runtime.js';
import { setEntityHost, entitiesOfKit } from './entityHub.js';
import { renderPos } from './entityCore.js';
import { kitNodeType } from './spec.js';

/** the scene-root group every peer draws its entity copies in */
export const KIT_ENTITY_GROUP = 'kit-entities';
/** how long a dead entity takes to sink out of sight, s */
const SINK_TIME = 0.6;
/** the walking band an obstacle must reach into, above the entities' feet, m */
const BAND_LOW = 0.15;
const BAND_HIGH = 1.6;

/** @type {any} */ let flowRef = null;
/** @type {THREE.Group | null} */ let root = null;
/** entity id -> its drawn copy @type {Map<string, THREE.Object3D>} */
const drawn = new Map();
/** the obstacle cache */
let worldCache = /** @type {any} */ ({ obstacles: [] });
let worldAt = -Infinity;
let worldDirty = true;
let started = false;
const tmpBox = new THREE.Box3();
const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
/** @type {number[]} */
const outPos = [0, 0, 0];
const stats = { drawn: 0, created: 0, removed: 0, fallback: 0, obstacles: 0, pulses: 0 };

const rt = () => entitiesOfKit(kit);
const nowSec = () => sessionNow() / 1000;
const me = () => /** @type {any} */ (get(peers))?.peer?.id ?? null;

/** a place in objectsGroup's frame for a world point @param {THREE.Vector3} v */
function toGroupFrame(v) {
	const g = get(objectsGroup);
	if (g) {
		g.updateWorldMatrix(true, false);
		g.worldToLocal(v);
	}
	return v;
}

/** every player's place (objectsGroup frame): this peer's camera + each open peer's avatar
 * @returns {{id: string, pos: number[]}[]} */
function players() {
	/** @type {{id: string, pos: number[]}[]} */
	const out = [];
	const cam = /** @type {any} */ (get(globalCamera));
	if (cam?.getWorldPosition)
		out.push({
			id: me() ?? 'me',
			pos: toGroupFrame(cam.getWorldPosition(new THREE.Vector3())).toArray()
		});
	const scene = /** @type {any} */ (get(globalScene));
	for (const id of /** @type {any} */ (get(peers))?.openedPeers ?? []) {
		const avatar = scene?.getObjectByName(String(id));
		if (avatar?.getWorldPosition)
			out.push({
				id: String(id),
				pos: toGroupFrame(avatar.getWorldPosition(new THREE.Vector3())).toArray()
			});
	}
	return out;
}

/** @param {any} ref @param {number[]} [from] @returns {number[] | null} */
function resolveTarget(ref, from) {
	if (typeof ref !== 'string' || !ref) return null;
	if (ref === 'player' || ref === 'nearestPlayer') {
		const list = players();
		if (!list.length) return null;
		if (!from) return list[0].pos;
		let best = list[0].pos;
		let bd = Infinity;
		for (const p of list) {
			const d = Math.hypot(p.pos[0] - from[0], p.pos[2] - from[2]);
			if (d < bd) {
				bd = d;
				best = p.pos;
			}
		}
		return best;
	}
	if (ref.startsWith('player:')) return players().find((p) => p.id === ref.slice(7))?.pos ?? null;
	const obj = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', ref);
	return obj ? toGroupFrame(obj.getWorldPosition(new THREE.Vector3())).toArray() : null;
}

/** the movers' world: obstacles + bounds in objectsGroup's frame, cached */
function world() {
	const t = performance.now();
	if (!worldDirty && t - worldAt < 1000) return worldCache;
	if (worldDirty && t - worldAt < 250) return worldCache; // a burst of edits rebuilds once
	worldAt = t;
	worldDirty = false;
	const g = /** @type {any} */ (get(objectsGroup));
	const r = rt();
	if (!g || !r) return (worldCache = { obstacles: [] });
	const ents = [...r.store.ents.values()].filter((e) => !e.dead);
	const feet = ents.length ? ents.map((e) => e.pos[1]).sort((a, b) => a - b)[ents.length >> 1] : 0;
	const templates = new Set(ents.map((e) => e.tpl));
	g.updateWorldMatrix(true, false);
	tmpM.copy(g.matrixWorld).invert();
	/** @type {any[]} */
	const obstacles = [];
	for (const child of g.children) {
		const ud = child.userData ?? {};
		if (!child.visible || ud.kitWalkable || ud.transient || templates.has(child.uuid)) continue;
		if (ud.physics?.mode === 'dynamic') continue;
		tmpBox.setFromObject(child).applyMatrix4(tmpM);
		if (tmpBox.isEmpty() || !Number.isFinite(tmpBox.min.x)) continue;
		if (tmpBox.max.y < feet + BAND_LOW || tmpBox.min.y > feet + BAND_HIGH) continue;
		const box = { minX: tmpBox.min.x, maxX: tmpBox.max.x, minZ: tmpBox.min.z, maxZ: tmpBox.max.z };
		// a box an entity stands INSIDE is a container (a level-wide group, a room), not a wall
		if (
			ents.some(
				(e) =>
					e.pos[0] > box.minX && e.pos[0] < box.maxX && e.pos[2] > box.minZ && e.pos[2] < box.maxZ
			)
		)
			continue;
		obstacles.push(box);
	}
	stats.obstacles = obstacles.length;
	/** @type {any} */
	const w = { obstacles };
	const play = resolvePlaySettings(get(globalScene));
	if (play?.bounds && !play.boundsOwner)
		w.bounds = {
			minX: play.bounds.min[0],
			maxX: play.bounds.max[0],
			minZ: play.bounds.min[2],
			maxZ: play.bounds.max[2]
		};
	return (worldCache = w);
}

/** @param {string} piece @param {string} event */
function pulse(piece, event) {
	stats.pulses++;
	const type = kitNodeType(piece, event);
	if (flowRef) flowRef.fireModuleTrigger(type);
	else import('../flowRuntime').then((m) => m.fireModuleTrigger(type)).catch(() => {});
}

/** the scene-root group, (re)attached @returns {THREE.Group | null} */
function ensureRoot() {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return null;
	if (!root) {
		root = new THREE.Group();
		root.name = KIT_ENTITY_GROUP;
		root.matrixAutoUpdate = false;
	}
	if (root.parent !== scene) scene.add(root);
	return root;
}

/** a capsule for an entity whose template is missing (so it is never invisible) */
let fallbackGeo = /** @type {THREE.CapsuleGeometry | null} */ (null);
let fallbackMat = /** @type {THREE.MeshStandardMaterial | null} */ (null);
function fallbackCopy() {
	fallbackGeo ??= new THREE.CapsuleGeometry(0.35, 0.9, 4, 12);
	fallbackMat ??= new THREE.MeshStandardMaterial({ color: 0xd2523c, roughness: 0.6 });
	const m = new THREE.Mesh(fallbackGeo, fallbackMat);
	m.position.y = 0.8;
	const g = new THREE.Group();
	g.add(m);
	stats.fallback++;
	return g;
}

/** a drawn copy of an entity's template @param {any} e */
function makeCopy(e) {
	const g = /** @type {any} */ (get(objectsGroup));
	const tpl = e.tpl ? g?.getObjectByProperty('uuid', e.tpl) : null;
	/** @type {THREE.Object3D} */
	let copy;
	if (tpl) {
		// shares geometry and materials (cheap); its own transform and NO user data of the
		// template's (physics, flows, packRefs — a drawn copy is not scene content)
		copy = tpl.clone(true);
		copy.traverse((o) => {
			o.userData = {};
		});
		copy.visible = true;
		copy.userData.baseRotY = tpl.rotation.y;
		copy.userData.baseScale = tpl.scale.clone();
	} else {
		copy = fallbackCopy();
		copy.userData.baseRotY = 0;
		copy.userData.baseScale = new THREE.Vector3(1, 1, 1);
	}
	copy.userData.kitEntity = e.id;
	copy.name = 'kit-entity-' + e.id;
	stats.created++;
	return copy;
}

/** per frame on EVERY peer: draw the entities */
function draw() {
	const r = rt();
	const group = ensureRoot();
	if (!r || !group) return;
	const g = /** @type {any} */ (get(objectsGroup));
	if (g) {
		g.updateWorldMatrix(true, false);
		group.matrix.copy(g.matrixWorld);
		group.matrixWorldNeedsUpdate = true;
	}
	const auth = !!r.debug().authority;
	const t = nowSec();
	for (const e of r.store.ents.values()) {
		let copy = drawn.get(e.id);
		if (!copy) {
			copy = makeCopy(e);
			drawn.set(e.id, copy);
			group.add(copy);
		}
		const p = auth ? e.pos : renderPos(e, t, outPos);
		copy.position.set(p[0], p[1], p[2]);
		copy.rotation.y = (copy.userData.baseRotY ?? 0) + e.yaw;
		const base = copy.userData.baseScale;
		if (e.dead) {
			const k = Math.max(0.02, 1 - (t - (e.health.diedAt ?? t)) / SINK_TIME);
			copy.scale.set(base.x * k, base.y * k, base.z * k);
			copy.position.y -= (1 - k) * 0.5;
		} else copy.scale.copy(base);
	}
	for (const [id, copy] of drawn) {
		if (r.store.ents.has(id)) continue;
		copy.parent?.remove(copy);
		drawn.delete(id);
		stats.removed++;
	}
	stats.drawn = drawn.size;
}

/** drop every drawn copy (a scene clear) */
function clearDrawn() {
	for (const copy of drawn.values()) copy.parent?.remove(copy);
	drawn.clear();
	rt()?.reset();
}

/** The entity id a clicked object belongs to (walks up to the drawn copy), or null.
 * @param {any} object */
export function entityOfObject(object) {
	for (let o = object; o; o = o.parent)
		if (o.userData?.kitEntity) return String(o.userData.kitEntity);
	return null;
}

/** the handshake: this peer's entity snapshot (the authority's, or any peer holding entities — kit/entities.js snapshot) */
export function kitEntityPayloads() {
	return kit.snapshots().filter((/** @type {any} */ m) => m?.type === 'kitentity');
}

/** Install everything (idempotent). */
export function startKitEntities() {
	if (started) return;
	started = true;
	import('../flowRuntime').then((m) => (flowRef = m)).catch(() => {});
	setEntityHost(kit, { resolveTarget, world, pulse, entityOf: entityOfObject });
	if (!moduleInteractiveGroups.includes(KIT_ENTITY_GROUP))
		moduleInteractiveGroups.push(KIT_ENTITY_GROUP);
	registerSystemGroup(KIT_ENTITY_GROUP);
	if (!moduleFrameTasks.includes(draw)) moduleFrameTasks.push(draw);
	sceneClearHandlers.push(clearDrawn);
	objectsGroup.subscribe(() => (worldDirty = true));
}

/** the debug hook / suites */
export function kitEntitiesDebug() {
	const r = rt();
	return {
		...stats,
		runtime: r?.debug() ?? null,
		entities: r
			? [...r.store.ents.values()].map((e) => ({
					id: e.id,
					kind: e.kind,
					tpl: e.tpl,
					pos: [...e.pos],
					hp: e.health.hp,
					dead: e.dead
				}))
			: [],
		world: { obstacles: worldCache.obstacles?.length ?? 0, bounds: !!worldCache.bounds },
		drawnIds: [...drawn.keys()]
	};
}

/** suites: the kit's api the way a module sees it */
export function kitEntitiesApi() {
	return kit.api({ onDispose: () => {} });
}
