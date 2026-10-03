// Module SDK — possess / release (drive an object).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { possessRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkPossess(ctx) {
	/** the journal entry's release while a possess is held @type {(() => void) | null} */
	let entry = null;
	return {
		/**
		 * Possess an object: WASD/arrows or the VR left stick drive it (tank
		 * controls) with a follow camera; Esc releases. Possessing selects it
		 * (selection = lock), suspends its flow effects and records ONE undo
		 * entry on release. @param {string} uuid
		 * @param {{camera?: 'chase'|'orbit'|'none', speed?: number, turnSpeed?: number}=} opts
		 */
		possess(uuid, opts) {
			ctx.possessing = true;
			entry = ctx.onDispose(
				() => {
					if (!ctx.possessing) return;
					ctx.possessing = false;
					possessRef?.release();
				},
				'possess',
				{ key: 'possess' }
			);
			return possessRef?.possess(uuid, opts) ?? false;
		},
		releasePossess() {
			entry?.();
			entry = null;
			ctx.possessing = false;
			possessRef?.release();
		},
		/** Camera modes this build's possess supports (DEVX #1) — feature-detect
		 * 'first' here; an unknown mode degrades silently. */
		get possessModes() {
			return possessRef?.possessModes ?? ['chase', 'orbit', 'none'];
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkPossess.surface = {
	possess: 'registers',
	releasePossess: 'action',
	possessModes: 'value'
};
