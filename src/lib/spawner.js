// 21-B B7 — THE SPAWNER: the caller half. Turns "fire" into real, replicated, physics-
// simulated copies of a template object, and bounds them.
//
// WHO SPAWNS, and why it is not "every peer derives it" (golden rule 8). A spawned object
// is authoritative-simulated: physics has one stepping peer, and object CREATION is
// already single-writer — `crypto.randomUUID()` cannot agree across peers and
// `duplicateObject` broadcasts. So the INITIATOR spawns and everybody else receives the
// existing `duplicate` message. That adds NO message type, and it is the same rule the
// physics action nodes already use: a non-initiator does nothing here and stays silent
// (correct), and the node's own updater warns only when nothing is simulating anywhere.
//
// WHY duplicateObject AND NOT instantiatePrefab: the template is an ordinary object in the
// scene. It is visible, editable, has its own Inspector ▸ Physics row, and travels with
// the .tpscene — which makes a template file self-documenting, where a prefab reference
// would be a name pointing at a local library the recipient may not have.
//
// THE CAPS ARE NON-NEGOTIABLE. An unbounded spawner in a shared session is both an OOM
// and a griefing vector, and every spawn is a broadcast to every peer. Three limits, all
// enforced here rather than trusted to the node's params: per-node `maxAlive` with
// oldest-out recycling, a GLOBAL ceiling over every spawner in the scene, and a rate
// limit. History is not a fourth limit — a spawn records no undo entry at all.
//
// This module imports objectActions and physics, both of which reach `history`, so
// flowRuntime must reach IT through a primed dynamic import (the physicsRef precedent).

import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { duplicateObject } from './objectActions';
import { physicsAddBody, physicsRemoveBody, physicsDebug, isInitiator } from './physics';
import { transientUuids, removeTransientObject } from './transientObjects';

/** what a fresh Spawn node asks for */
export const SPAWN_MAX_ALIVE_DEFAULT = 32;
/** the hard ceiling on live spawned objects ACROSS every spawner in the scene. Per-node
 * would not bound anything: three spawners at 200 each is six hundred bodies. */
export const SPAWN_HARD_CEILING = 200;
/** most copies ONE fire may make */
export const SPAWN_MAX_PER_FIRE = 20;
/** floor under the authored interval. A trigger stamp cannot repeat per frame, but a HELD
 * key re-stamps several times a second, so the edge alone is not a rate limit. */
export const SPAWN_MIN_INTERVAL_MS = 100;

/** @type {Map<string, string[]>} spawn node id -> its live copies, OLDEST FIRST */
const alive = new Map();
/** @type {Map<string, number>} spawn node id -> performance.now() of its last fire */
const lastFireAt = new Map();
let ceilingWarnedAt = 0;
/** @type {Set<string>} nodes already told their template has no physics */
const inertWarned = new Set();

/** @param {any} value an AUTHORED param — it may be absent, or a peer's string
 * @param {number} min @param {number} max @param {number} fallback */
function clampNum(value, min, max, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** Drop uuids whose object is gone — a user can delete a crate, undo can remove one, and
 * `stopSimulation`'s sweep clears the lot. Pruning on every fire is what keeps this map
 * from being a second, drifting source of truth. @param {string} nodeId */
function livingOf(nodeId) {
	const group = get(objectsGroup);
	const list = (alive.get(nodeId) ?? []).filter((uuid) => !!group?.getObjectByProperty('uuid', uuid));
	alive.set(nodeId, list);
	return list;
}

/** @param {string} uuid */
function despawn(uuid) {
	physicsRemoveBody(uuid); // free the body first: the object is about to leave the tree
	removeTransientObject(uuid);
}

/**
 * Fire one spawn node.
 * @param {string} nodeId
 * @param {string} templateUuid the object copies are made from
 * @param {{at?: number[], count?: number, maxAlive?: number, interval?: number, spread?: number}} opts
 * @returns {{spawned: number, reason?: string}}
 */
export function spawnFrom(nodeId, templateUuid, opts = {}) {
	if (!isInitiator()) return { spawned: 0, reason: 'not-initiator' };
	const group = get(objectsGroup);
	const template = group?.getObjectByProperty('uuid', templateUuid);
	if (!template) return { spawned: 0, reason: 'no-template' };

	const now = performance.now();
	const gap = Math.max(SPAWN_MIN_INTERVAL_MS, (Number(opts.interval) || 0) * 1000);
	if (now - (lastFireAt.get(nodeId) ?? -Infinity) < gap) return { spawned: 0, reason: 'rate' };
	lastFireAt.set(nodeId, now);

	const count = Math.round(clampNum(opts.count, 1, SPAWN_MAX_PER_FIRE, 1));
	const maxAlive = Math.round(
		clampNum(opts.maxAlive, 1, SPAWN_HARD_CEILING, SPAWN_MAX_ALIVE_DEFAULT)
	);
	const spread = clampNum(opts.spread, 0, 20, 0);
	const at = Array.isArray(opts.at) ? opts.at : [0, 0, 0];
	const base = template.position;
	let list = livingOf(nodeId);
	let spawned = 0;

	for (let i = 0; i < count; i++) {
		// oldest-out RECYCLING: at the cap the spawner keeps working and the first crate
		// leaves, which is what makes a "spawn on every press" graph safe to hold down
		while (list.length >= maxAlive) despawn(list.shift() ?? '');
		// ...and the global ceiling, which recycling cannot help with — other spawners own
		// those objects. Stop, say so once, and let the run continue.
		if (transientUuids().length >= SPAWN_HARD_CEILING) {
			if (now - ceilingWarnedAt > 5000) {
				ceilingWarnedAt = now;
				showToast(
					'Spawn limit reached (' +
						SPAWN_HARD_CEILING +
						' spawned objects) — lower max alive, or stop the simulation to clear them'
				);
			}
			break;
		}
		// jitter is the initiator's own Math.random, which is FINE precisely because the
		// position rides the `duplicate` message: peers are told where the copy is, they do
		// not derive it. Without any spread, `count > 1` puts several bodies in the same
		// place and rapier resolves the interpenetration by throwing them apart.
		const jitter = () => (spread ? (Math.random() - 0.5) * spread : 0);
		const clone = duplicateObject(templateUuid, {
			select: false,
			history: false,
			transient: true,
			// `at` is an OFFSET from the template, so an unwired node drops copies above a
			// visible object rather than at the world origin
			at: [
				base.x + (Number(at[0]) || 0) + jitter(),
				base.y + (Number(at[1]) || 0),
				base.z + (Number(at[2]) || 0) + jitter()
			]
		});
		if (!clone) break;
		// the whole point of B7: without this the copy is INERT — `startSimulation` walks
		// the children once, so anything created during a run had no body at all
		physicsAddBody(clone.uuid);
		list.push(clone.uuid);
		spawned++;
	}
	alive.set(nodeId, list);

	// A template with no physics produces copies that just hang in the air. That is the
	// template's decision to make (it is a visible, editable object with an Inspector row),
	// but silence here reads as "the spawner is broken", so say it once per node.
	if (spawned && !inertWarned.has(nodeId)) {
		const last = list[list.length - 1];
		const mode = physicsDebug().find((b) => b.uuid === last)?.mode;
		if (mode !== 'dynamic') {
			inertWarned.add(nodeId);
			showToast(
				'Spawn: "' +
					(template.name || template.type) +
					'" has no physics, so the copies will not fall — select it and set Inspector ▸ Physics to Dynamic'
			);
		}
	}
	return { spawned };
}

/** @param {string} nodeId */
export function spawnedBy(nodeId) {
	return [...(alive.get(nodeId) ?? [])];
}

/**
 * Forget every spawner's bookkeeping. The OBJECTS are swept by
 * `removeTransientObjects` (stopSimulation), so this is only the maps — and it is not
 * needed for correctness: `livingOf` prunes against the live scene on every fire, so a
 * sweep empties every list by itself. Exported for tests and for a deliberate reset,
 * which is why physics.js does not reach for it (and so needs no edge into this module).
 */
export function clearSpawnState() {
	alive.clear();
	lastFireAt.clear();
	inertWarned.clear();
	ceilingWarnedAt = 0;
}

/** test/debug view */
export function spawnerDebug() {
	return {
		nodes: [...alive.keys()].map((id) => ({ id, alive: [...(alive.get(id) ?? [])] })),
		total: transientUuids().length,
		ceiling: SPAWN_HARD_CEILING
	};
}
