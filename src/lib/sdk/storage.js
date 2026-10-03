// Module SDK — api.storage (per-module, capped) and api.lod.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { showToast } from '../../stores/appStore';
import { makeModuleStorage } from '../gameStorage';
import { lodObject } from '../lod';

/** modules already told they hit the storage cap this session (ONE toast each, never
 * one per write — a game saving every frame would otherwise bury the screen) */
const storageCapWarned = new Set();

/** @param {import('./context.js').SdkContext} ctx */
export function sdkStorage(ctx) {
	const { moduleId, moduleName, onDispose } = ctx;
	return {
		/**
		 * R3a: PEER-OWNED variables (21-G4). One writer per row BY CONSTRUCTION — this api
		 * only ever writes YOUR row (`setMine`), which is what makes per-player counting
		 * immune to the shared-scope add race. Rows replicate on the presence channel,
		 * late joiners converge, a row drops with its owner's disconnect.
		 */
		/**
		 * 30 P4 (roadmap 30 fork 7): what this module remembers ON THIS DEVICE — a best
		 * score, unlocked levels, a settings choice. JSON values under
		 * `tp:mod:<moduleId>:<key>` through safeStorage (never throws: a private window or a
		 * full quota falls back to memory for the session), 256 KB per module (a `set` over
		 * it returns false and says so ONCE), LOCAL: never replicated, never in a scene
		 * file, never undone — and deliberately NOT cleared when the module is disabled or
		 * removed (a reinstall keeps your progress; `clear()` is the module's own reset).
		 * `get(key, fallback)` · `set(key, value) -> bool` · `remove(key)` · `keys()` ·
		 * `clear()` · `bytes()`.
		 */
		storage: makeModuleStorage(moduleId, {
			onOverCap: () => {
				if (storageCapWarned.has(moduleId)) return;
				storageCapWarned.add(moduleId);
				showToast(`"${moduleName}" hit its 256 KB storage limit on this device — that value was not saved.`);
			}
		}),
		/**
		 * 31-perf K4: LEVELS OF DETAIL for the module's own geometry (auto LOD already covers
		 * dense meshes in objectsGroup and under the module world root). Every mesh under
		 * `object` with at least 300 triangles gets meshoptimizer-simplified levels, built ONCE
		 * per asset in a worker and drawn by distance — a RENDER-TIME swap, so the mesh keeps
		 * its geometry for everything else (picking, physics, your own code). `opts`:
		 * `{ratios?: number[], distances?: number[], minTriangles?: number}` — ratios are the
		 * share of triangles each level keeps (default [0.5, 0.25, 0.1]), distances are in
		 * world RADII of the mesh where each level takes over (default [8, 20, 50]); the quality
		 * level pulls the distances in on a struggling device. Returns `{meshes, ready, remove}`;
		 * LOCAL, never replicated, and released when the module is disabled. Skinned meshes and
		 * morph targets are skipped (the simplifier cannot carry weights). Set
		 * `mesh.userData.lod = false` on a mesh to keep it out of auto LOD.
		 * @param {any} object @param {{ratios?: number[], distances?: number[], minTriangles?: number}} [opts]
		 */
		lod(object, opts = {}) {
			const handle = lodObject(object, opts, moduleId);
			onDispose(() => handle.remove());
			return handle;
		}
	};
}
