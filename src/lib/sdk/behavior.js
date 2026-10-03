// Module SDK — api.behavior — pack-item behaviours (33 P2).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { packBehaviorRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkBehavior(ctx) {
	return {
		/**
		 * 33 P2: FUNCTIONAL PACK ITEMS — a door, a chest lid, a lever, a fan placed from a pack
		 * (an item carrying a `behavior`). `list()` -> `[{uuid, type, trigger, open}]`;
		 * `state(uuid)` -> `{on, at, n}` or null before anything triggered it;
		 * `trigger(uuid, open?)` toggles it (or forces `open` true/false) exactly as a player's
		 * click would — REPLICATED (one `behavior` message, every peer poses it from the same
		 * stamp), so call it on ONE peer. Returns whether anything changed. Nothing here moves in
		 * Edit: a peer in Edit renders the rest pose whatever the state says.
		 */
		behavior: {
			list() {
				const ref = packBehaviorRef;
				if (!ref) return [];
				return ref.packBehaviorDebug().items.map((/** @type {any} */ it) => ({
					uuid: it.uuid,
					type: it.spec?.type,
					trigger: it.spec?.trigger,
					open: !!it.state?.on
				}));
			},
			/** @param {string} uuid */
			state(uuid) {
				const s = packBehaviorRef?.behaviorState(uuid);
				return s ? { on: s.on, at: s.at, n: s.n } : null;
			},
			/** @param {string} uuid @param {boolean} [open] */
			trigger(uuid, open) {
				return !!packBehaviorRef?.triggerBehavior(String(uuid), typeof open === 'boolean' ? open : undefined);
			}
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkBehavior.surface = {
	'behavior.list': 'read',
	'behavior.state': 'read',
	'behavior.trigger': 'content'
};
