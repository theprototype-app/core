// Module SDK — api.water (36-water): create, configure and query water volumes (contract
// W1) and disturb their surface (W2). One slice of the api object makeApi() assembles
// (sdk/index.js, the ONE table).
//
// Water is ordinary SHARED content: a volume a module creates or configures replicates
// through userData like a user's edit (objectParameters, undoable), so nothing here needs a
// teardown — except `onChange`, which is journalled (34 R6 / T2). `disturb` is LOCAL and
// visual only: call it on every peer from shared physics (a splash), never from one.

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { waterVolumes, normalizeWater } from '../water/volumes.js';
import { WATER_PRESETS } from '../water/presets.js';
import { addObjectsRef, waterActionsRef } from './refs.js';

/** a volume as a module sees it (plain data, no THREE objects) @param {any} v */
function plain(v) {
	return {
		uuid: v.uuid,
		name: v.object?.name ?? '',
		shape: v.shape,
		level: v.level,
		spec: v.spec,
		bounds: { ...v.bounds }
	};
}

/** @param {import('./context.js').SdkContext} ctx */
export function sdkWater(ctx) {
	const { owned } = ctx;
	return {
		water: {
			/** The preset lineup: [{key, name, shape}]. */
			presets() {
				return WATER_PRESETS.map((p) => ({ key: p.key, name: p.name, shape: p.shape ?? 'box' }));
			},
			/**
			 * Create a water volume in the SHARED scene (replicated like Create → Water).
			 * `kind`: 'tank' | 'pool' | 'ocean' | 'cylinder'; `preset` overrides the kind's look;
			 * `size` = [w, h, d] metres (a cylinder reads w as the diameter); `at` places it.
			 * @param {{kind?: string, preset?: string, size?: number[], at?: number[]}} [opts]
			 * @returns {Promise<string|null>} the new object's uuid
			 */
			async create(opts = {}) {
				const wa = waterActionsRef ?? (await import('../water/waterActions.js'));
				const kind =
					wa.WATER_KINDS.find((/** @type {any} */ k) => k.key === opts.kind) ?? wa.WATER_KINDS[0];
				let command = kind.command;
				const s = Array.isArray(opts.size) ? opts.size.map(Number) : null;
				if (s && s.every((n) => Number.isFinite(n) && n > 0))
					command =
						kind.shape === 'cylinder'
							? `/create Cylinder ${s[0] / 2} ${s[0] / 2} ${s[1]}`
							: `/create Box ${s[0]} ${s[1]} ${s[2] ?? s[0]}`;
				const group = get(objectsGroup);
				const before = new Set((group?.children ?? []).map((/** @type {any} */ c) => c.uuid));
				if (opts.at && addObjectsRef) addObjectsRef.spawnAtPoint(command, opts.at);
				else (await import('../commandsHandler.svelte')).sceneCommand(command);
				const made = (get(objectsGroup)?.children ?? []).find(
					(/** @type {any} */ c) => !before.has(c.uuid)
				);
				if (!made) return null;
				wa.makeWater(made, kind.key);
				if (opts.preset && opts.preset !== kind.preset) wa.applyWaterPreset(made.uuid, opts.preset);
				return made.uuid;
			},
			/**
			 * Merge a patch into a volume (top-level keys replace; look/waves/bubbles merge one
			 * level), or make any object water by passing a whole blob. Replicated + undoable.
			 * @param {string} uuid @param {any} patch @returns {boolean}
			 */
			configure(uuid, patch) {
				const wa = waterActionsRef;
				if (!wa) return false;
				const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
				if (!object) return false;
				if (!object.userData.water) return wa.setObjectWater(uuid, normalizeWater(patch));
				return wa.updateObjectWater(uuid, patch ?? {}, { immediate: true });
			},
			/** Apply a built-in preset (keeps shape + level). @param {string} uuid @param {string} key */
			preset(uuid, key) {
				return !!waterActionsRef?.applyWaterPreset(uuid, key);
			},
			/** Remove the water from an object (it stays as a plain mesh). @param {string} uuid */
			remove(uuid) {
				return !!waterActionsRef?.removeObjectWater(uuid);
			},
			/** Fire the volume's bubble burst for every peer. @param {string} uuid */
			burst(uuid) {
				return !!waterActionsRef?.burstWaterBubbles(uuid);
			},
			/** Every water volume: [{uuid, name, shape, level, spec, bounds}]. */
			list() {
				return waterVolumes.list().map(plain);
			},
			/**
			 * The volume containing a world point (waves included), or null:
			 * {uuid, depth, surfaceY, flow:[x,y,z]}. Deterministic: same scene + clock → same answer.
			 * @param {number[]|{x: number, y: number, z: number}} point @param {{flat?: boolean}} [opts]
			 */
			query(point, opts = {}) {
				const q = waterVolumes.query(point, { flat: !!opts.flat });
				return q
					? { uuid: q.volume.uuid, depth: q.depth, surfaceY: q.surfaceY, flow: q.flow }
					: null;
			},
			/** World Y of a volume's surface above world x/z (waves included unless flat). @param {string} uuid @param {number} x @param {number} z @param {{flat?: boolean}} [opts] */
			surfaceY(uuid, x, z, opts = {}) {
				return waterVolumes.surfaceY(uuid, x, z, { flat: !!opts.flat });
			},
			/** A LOCAL ripple ring (W2) — visual only, call it on every peer. @param {string} uuid @param {number[]|{x: number, y: number, z: number}} point @param {number} [radius] @param {number} [strength] */
			disturb(uuid, point, radius = 0.3, strength = 0.5) {
				return waterVolumes.disturb(uuid, point, radius, strength);
			},
			/**
			 * `fn(volumes)` whenever a volume appears, goes, is edited or moves (within ~250 ms of
			 * the change while the renderer runs). Returns `off()`; released with the module.
			 * @param {(volumes: any[]) => void} fn
			 */
			onChange(fn) {
				const off = waterVolumes.onChange((list) => {
					try {
						fn(list.map(plain));
					} catch (error) {
						console.log('module water listener failed', error);
					}
				});
				return owned('water.onChange', off);
			}
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle (sdk/lifecycle.js SURFACE_KINDS). */
sdkWater.surface = {
	'water.presets': 'read',
	'water.create': 'content',
	'water.configure': 'content',
	'water.preset': 'content',
	'water.remove': 'content',
	'water.burst': 'action',
	'water.list': 'read',
	'water.query': 'read',
	'water.surfaceY': 'read',
	'water.disturb': 'action',
	'water.onChange': 'registers'
};
