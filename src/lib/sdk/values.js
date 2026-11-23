// Module SDK — api.values — 102b-hud (row 4): publish a game value for the core Game Value node.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { setGameValue, gameValueOf, clearGameValue, clearGameValuesOf } from '../gameValues.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkValues(ctx) {
	const { moduleId, onDispose } = ctx;
	/** the teardown is journalled once, on the first publish */
	let journalled = false;
	return {
		/**
		 * 102b-hud: PUBLISHED VALUES. What your game knows and a HUD should show — coins, falls, the
		 * best run, an inventory line — without an `info` node of your own: publish the RAW value
		 * and the scene shows it with the core Game Value node (source "published", its own format:
		 * number, clock, "3 / 10", stars, prefix / suffix). LOCAL per peer (each peer's copy of your
		 * module publishes its own answer) and never saved; cleared when the module is disabled.
		 * `set(name, value, {max?})` (a number, or text up to 200 characters) · `get(name, fallback)` ·
		 * `clear(name)`.
		 */
		values: {
			/** @param {string} name @param {any} value @param {{max?: number}} [opts] @returns {boolean} */
			set(name, value, opts) {
				if (!journalled) {
					journalled = true;
					onDispose(() => {
						clearGameValuesOf(moduleId);
						journalled = false;
					}, 'values');
				}
				return setGameValue(name, value, opts, moduleId);
			},
			/** @param {string} name @param {any} [fallback] */
			get(name, fallback = 0) {
				return gameValueOf(name, fallback);
			},
			/** @param {string} name */
			clear(name) {
				clearGameValue(name);
			}
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in sdk/lifecycle.js */
sdkValues.surface = {
	'values.set': 'registers',
	'values.get': 'read',
	'values.clear': 'action'
};
