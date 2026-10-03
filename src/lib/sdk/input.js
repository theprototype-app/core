// Module SDK — key bindings, the input snapshot, key events and input-scope claims.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { keyOf, letterOf } from '../keyOf';
import { inputRuntimeRef, inputApi } from './refs.js';

/** the input scopes `api.claimInput` pauses (33: 'sticks' = both VR sticks) */
const INPUT_SCOPES = ['keys', 'locomotion', 'sticks'];

/** @param {import('./context.js').SdkContext} ctx */
export function sdkInput(ctx) {
	const { moduleId, onDispose, claimedScopes } = ctx;
	return {
		/**
		 * Declare key bindings so they list in Settings ▸ Shortcuts under this
		 * module (display-only — poll api.input() / subscribe api.onInput).
		 * @param {{label: string, keys: string}[]} bindings
		 */
		registerBindings(bindings) {
			if (inputRuntimeRef) inputRuntimeRef.registerBindings(moduleId, bindings);
			else import('../inputRuntime').then((m) => m.registerBindings(moduleId, bindings));
		},
		/** Per-frame input snapshot: {codes: Set<'KeyW'...>, axes: {lx,ly,rx,ry}, vrButtons} */
		input() {
			return inputApi().getInput();
		},
		/**
		 * 24-A1: the key token the EDITOR's shortcuts resolve by — `event.key` when it is
		 * an ASCII letter/digit, else the physical `event.code` position — so a module
		 * reading the keyboard itself works on a Cyrillic/Greek/Hebrew layout too.
		 * `'G'`, `'7'`, `'Escape'`; `letterOf` gives the lowercase form (`'g'`).
		 * @param {KeyboardEvent} event
		 */
		keyOf(event) {
			return keyOf(event);
		},
		/** @param {KeyboardEvent} event */
		letterOf(event) {
			return letterOf(event);
		},
		/** Key down/up events; returns an unsubscribe. @param {(kind: 'down'|'up', code: string) => void} fn */
		onInput(fn) {
			// DEVX #8: subscribe SYNCHRONOUSLY through the primed ref (it resolves
			// at boot, before any module registers) — routing through a fresh
			// import().then() dropped keys pressed in the first seconds after a
			// user-module install. The promise path stays as an SSR-safe fallback,
			// and unsubscribing before it settles must stick (the `dead` flag).
			let unsub = () => {};
			let dead = false;
			if (inputRuntimeRef) {
				unsub = inputRuntimeRef.onInput(fn);
			} else {
				import('../inputRuntime').then((m) => {
					if (!dead) unsub = m.onInput(fn);
				});
			}
			const off = () => {
				dead = true;
				unsub(); // idempotent (Set.delete)
			};
			onDispose(off);
			return off;
		},
		/** Pause the host's own use of an input scope while your module drives:
		 * 'keys' (WASD camera fly / play movement), 'locomotion' (VR left stick), or
		 * 'sticks' (33: BOTH VR sticks — left-stick move, right-stick turn and teleport — for a
		 * module that reads `input().axes` itself, e.g. reel/scale a held thing on the sticks).
		 * ALWAYS release (module disable/error releases everything). Returns true when this
		 * core knows the scope (an older core answers undefined: feature-detect 'sticks' so).
		 * @param {'keys'|'locomotion'|'sticks'} scope */
		claimInput(scope) {
			claimedScopes.add(scope);
			if (inputRuntimeRef) inputRuntimeRef.claimInput(scope);
			else import('../inputRuntime').then((m) => m.claimInput(scope));
			return INPUT_SCOPES.includes(scope);
		},
		/** @param {'keys'|'locomotion'|'sticks'} scope */
		releaseInput(scope) {
			claimedScopes.delete(scope);
			if (inputRuntimeRef) inputRuntimeRef.releaseInput(scope);
			else import('../inputRuntime').then((m) => m.releaseInput(scope));
		}
	};
}
