// Module SDK — possess / release (drive an object).
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { possessRef } from './refs.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkPossess(ctx) {
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
			return possessRef?.possess(uuid, opts) ?? false;
		},
		releasePossess() {
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
