// Module SDK — api.loadModel (34 R7 / E1): a glTF through the app's own loader.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { moduleAssets } from './registries.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkModels(ctx) {
	const { moduleId, onDispose } = ctx;
	/** the loader module once this module has used it (teardown must stay synchronous) @type {any} */
	let loader = null;
	let dead = false;
	onDispose(() => {
		dead = true;
		loader?.releaseModelsOf(moduleId);
	});
	return {
		/**
		 * 34 R7: LOAD A MODEL (.glb / .gltf) with core's loader — Draco, Meshopt and KTX2 (the
		 * transcoder is fetched only for a file that needs it), THE SAME `THREE` as the scene,
		 * parsed ONCE per URL and shared by every module that asks. `url` is a file your module
		 * PACKAGED (`'assets/enemy.glb'` — listed in the manifest's `files`) or any URL.
		 * Resolves to a HANDLE:
		 *   `scene`        your own copy (add it to your group)
		 *   `instance(o?)` another copy of `scene` as it is now — its own bones when skinned;
		 *                  `{ownMaterials: true}` gives that copy its own materials
		 *   `animations`   the clips (bind a THREE.AnimationMixer per copy)
		 *   `info`         {meshes, triangles, materials, textures, skinned}
		 *   `release(obj)` forget one copy · `dispose()` forget them all
		 * Options: `lod` — absent/'auto' = automatic levels (31-perf; a pack item URL whose row
		 * lists `lods` uses those files), `false` = none, `{ratios, distances, minTriangles}` =
		 * tuned automatic levels, `[{file, ratio}]` = pre-built level files beside the model;
		 * `castShadow`/`receiveShadow` (every mesh; absent = as the file says, which is off);
		 * `collider: 'box'|'sphere'|'capsule'|'cylinder'|'cone'|'hull'` = the physics shape a
		 * copy takes once it is SCENE content with physics; `ownMaterials`. Rejects when the
		 * file is missing or cannot be parsed. LOCAL; everything is released when the module
		 * is disabled or unloaded (copies you put in objectsGroup stay — they are the scene's).
		 * @param {string} url
		 * @param {{lod?: any, castShadow?: boolean, receiveShadow?: boolean, collider?: string, ownMaterials?: boolean}} [options]
		 */
		async loadModel(url, options) {
			// the module's files as the CALL found them (an unload deletes them)
			const assets = moduleAssets[moduleId] ?? null;
			const unloaded = () => new Error('loadModel: the module was unloaded while "' + url + '" loaded');
			if (dead) throw unloaded();
			let handle;
			try {
				loader ??= await import('../modelLoader');
				if (dead) throw unloaded();
				handle = await loader.loadModel(url, options ?? {}, moduleId, assets);
			} catch (error) {
				// an unload revokes the module's blob URLs, so a fetch under way fails: say why
				throw dead ? unloaded() : error;
			}
			if (dead) {
				// unloaded while the file was on its way: nothing may outlive the module
				handle.dispose();
				throw unloaded();
			}
			return handle;
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. A loaded model is held per module and released on unload. */
sdkModels.surface = {
	loadModel: 'registers'
};
