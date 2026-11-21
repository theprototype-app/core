// Module SDK — 61-nav (roadmap 61 G1/G5/G7/G10): what a navigation module needs from the live scene
// and the editor chrome, as small additive reads + two registries. One slice of the api object
// makeApi() assembles (sdk/index.js, the ONE table). Logged in the modules repo's devx/ requests.
//
//   paths.of(uuid) / paths.list()   78's Path object, through its ONE read api (path/pathRuntime.js
//                                   pathOf, F9): a Patrol node never keeps a fourth list of points.
//   paths.create({points, closed})  a new Path through 78's own createPath (one replicated undo step).
//   colliderGeometry(opts)          the STATIC colliders + terrain as world triangles (a navmesh bake's
//                                   input), plus the MOVING solids (dynamic bodies, flow-animated
//                                   objects) a bake must treat as temporary obstacles, and a cheap
//                                   signature so a module can rebake on edit (debounced) only.
//   players()                       every player's place: this peer's camera + every open peer's
//                                   avatar (the kit's nearestPlayer rule, kit/entityApp.js).
//   isAuthority()                   the kit authority (physics initiator, else the lowest peer id) —
//                                   the one peer that steps a shared simulation (kit/runtime.js).
//   isExport()                      an exported game (debug views must never draw there).
//   registerViewToggle(spec)        a row in the viewport menu's View submenu (LOCAL state).
//   registerObjectAction(spec)      a row in the object menu + a UI-less `apply` for the agent tools.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { pathOf, pathObjectsIn } from '../path/pathRuntime.js';
import { kitIsAuthority } from '../kit/runtime.js';
import { exportMode } from '../export/exportBoot.js';
import { addViewToggle, addObjectAction } from '../moduleWorldItems.js';

/** `api.colliderGeometry` — the reader lives in a lazy chunk (gameWorldColliders.js)
 * @param {{exclude?: string[], maxTriangles?: number, signatureOnly?: boolean}} [opts] */
async function colliderGeometry(opts) {
	return (await import('./gameWorldColliders.js')).colliderGeometry(opts);
}

/** every player's place in WORLD space: this peer's camera + each open peer's avatar
 * @returns {{id: string, pos: number[], me: boolean}[]} */
function players() {
	/** @type {{id: string, pos: number[], me: boolean}[]} */
	const out = [];
	const p = /** @type {any} */ (get(peers));
	const myId = p?.peer?.id ?? '';
	const cam = /** @type {any} */ (get(globalCamera));
	if (cam?.getWorldPosition)
		out.push({
			id: myId || 'me',
			pos: cam.getWorldPosition(new THREE.Vector3()).toArray(),
			me: true
		});
	const scene = /** @type {any} */ (get(globalScene));
	for (const id of p?.openedPeers ?? []) {
		const avatar = scene?.getObjectByName(String(id));
		if (avatar?.getWorldPosition)
			out.push({
				id: String(id),
				pos: avatar.getWorldPosition(new THREE.Vector3()).toArray(),
				me: false
			});
	}
	return out;
}

/** @param {import('./context.js').SdkContext} ctx */
export function sdkGameWorld(ctx) {
	const { moduleId, onDispose } = ctx;
	return {
		/** 61-nav: 78's Path objects, read through pathOf (F9) — `{uuid, name, points: [{pos (WORLD), …extras}], closed, mode,
		 * speed, length, period, poseAt(t, {start, offset}), eventsBetween(a, b, o)}` or null. */
		paths: Object.freeze({
			/** @param {string} uuid */
			of: (uuid) => pathOf(get(objectsGroup), String(uuid ?? '')),
			/** every Path object: `[{uuid, name}]` (a sheet's picker) */
			list: () =>
				pathObjectsIn(get(objectsGroup)).map((o) => ({ uuid: o.uuid, name: o.name || 'Path' })),
			/**
			 * A new Path object through 78's own `createPath` (the replicated `/create Path` + one spline
			 * edit, ONE undo step): `points` are WORLD `[x, y, z]` (2..200).
			 * @param {{points: number[][], closed?: boolean, name?: string}} spec
			 * @returns {Promise<string | null>} the new path's uuid
			 */
			async create(spec) {
				const { createPath } = await import('../path/pathActions.js');
				const points = (Array.isArray(spec?.points) ? spec.points : [])
					.slice(0, 200)
					.map((p) => [+p?.[0] || 0, +p?.[1] || 0, +p?.[2] || 0]);
				if (points.length < 2) return null;
				const r = /** @type {any} */ (
					createPath({
						points,
						closed: !!spec?.closed,
						name: spec?.name ? String(spec.name).slice(0, 60) : undefined
					})
				);
				return r?.object?.uuid ?? null;
			}
		}),
		colliderGeometry,
		players,
		/** is THIS peer the kit authority (physics initiator, else the lowest peer id; alone = yes)? */
		isAuthority() {
			return kitIsAuthority();
		},
		/** an exported game (the play-only runtime)? Debug views never draw there. */
		isExport() {
			return !!exportMode;
		},
		/**
		 * A row in the viewport menu's View submenu. LOCAL: `get()` says whether it is on for this
		 * viewer, `set(on)` changes it; core never stores it. Re-registering the same id replaces it.
		 * @param {{id: string, label: string, tooltip?: string, get: () => boolean, set: (on: boolean) => void}} spec
		 * @returns {string} the namespaced key
		 */
		registerViewToggle(spec) {
			const id = String(spec?.id ?? 'toggle');
			const key = 'mod-' + moduleId + '-' + id;
			const off = addViewToggle({
				key,
				moduleId,
				id,
				label: String(spec?.label ?? id).slice(0, 60),
				tooltip: spec?.tooltip ? String(spec.tooltip).slice(0, 200) : '',
				get: () => {
					try {
						return !!spec.get();
					} catch {
						return false;
					}
				},
				set: (on) => spec.set(!!on)
			});
			onDispose(off, 'viewToggle', { key: 'viewToggle:' + key });
			return key;
		},
		/**
		 * A row in the object menu ("Make this an enemy…"): `open(uuid)` is the person's door (your
		 * sheet), `apply(uuid, spec)` the same recipe without UI (the agent tools call it), `when(uuid)`
		 * hides the row for objects it does not fit. The key is `<moduleId>:<id>`.
		 * @param {{id: string, label: string, icon?: string, tooltip?: string, when?: (uuid: string) => boolean,
		 *   open: (uuid: string) => void, apply?: (uuid: string, spec: any) => any}} spec
		 * @returns {string}
		 */
		registerObjectAction(spec) {
			const id = String(spec?.id ?? 'action');
			const key = moduleId + ':' + id;
			const off = addObjectAction({
				key,
				moduleId,
				id,
				label: String(spec?.label ?? id).slice(0, 60),
				icon: spec?.icon ? String(spec.icon) : 'box',
				tooltip: spec?.tooltip ? String(spec.tooltip).slice(0, 200) : '',
				when: typeof spec?.when === 'function' ? spec.when : undefined,
				open: spec.open,
				apply: typeof spec?.apply === 'function' ? spec.apply : undefined
			});
			onDispose(off, 'objectAction', { key: 'objectAction:' + key });
			return key;
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle (sdk/lifecycle.js SURFACE_KINDS). */
sdkGameWorld.surface = {
	'paths.of': 'read',
	'paths.list': 'read',
	'paths.create': 'content',
	colliderGeometry: 'read',
	players: 'read',
	isAuthority: 'read',
	isExport: 'read',
	registerViewToggle: 'registers',
	registerObjectAction: 'registers'
};
