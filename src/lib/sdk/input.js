// Module SDK — key bindings, the input snapshot, key events and input-scope claims.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { keyOf, letterOf } from '../keyOf';
import { inputRuntimeRef, inputApi } from './refs.js';
import { declareTouchActions } from '../touchActions';

/** the input scopes `api.claimInput` pauses (33: 'sticks' = both VR sticks) */
const INPUT_SCOPES = ['keys', 'locomotion', 'sticks'];

/** @param {import('./context.js').SdkContext} ctx */
export function sdkInput(ctx) {
	const { moduleId, onDispose, owned, claimedScopes } = ctx;
	/** scope -> its journal entry's release, so an explicit releaseInput drops the entry
	 * @type {Map<string, () => void>} */
	const claimEntries = new Map();
	/** Per-frame input snapshot: {codes: Set<'KeyW'...>, axes: {lx,ly,rx,ry}, vrButtons} */
	const input = () => inputApi().getInput();
	/**
	 * 36 U8: declare the game's INPUT ACTIONS — what a touch screen draws as on-screen buttons
	 * (and the layout editor lets the player move). Each is a built-in id ('jump', 'fire',
	 * 'interact', 'crouch', 'sprint', 'reload', 'up', 'down') or
	 * `{id, label?, icon?, keys?: ['KeyF'], pointer?: 'press'|'tap', onPress?, onRelease?}`.
	 * `keys` are dispatched as real key events while the button is held (so anything that
	 * reads the keyboard just works); `onPress`/`onRelease` run on THIS peer only. The preset
	 * frames the buttons: 'platformer' (stick + jump), 'shooter' (stick + look + fire +
	 * jump), 'toss' / 'golf' (the action alone), 'fly', 'explore', 'custom'.
	 * Re-callable (a second call replaces this module's set); torn down with the module.
	 * @param {any[]} actions @param {{preset?: string, stick?: boolean, look?: boolean}} [opts]
	 * @returns {() => void} off
	 */
	input.actions = (actions, opts) =>
		owned('input.actions', declareTouchActions(moduleId, actions, opts), { key: 'input.actions' });
	return {
		/**
		 * Declare key bindings so they list in Settings ▸ Shortcuts under this
		 * module (display-only — poll api.input() / subscribe api.onInput).
		 * @param {{label: string, keys: string}[]} bindings
		 */
		registerBindings(bindings) {
			if (inputRuntimeRef) inputRuntimeRef.registerBindings(moduleId, bindings);
			else import('../inputRuntime').then((m) => m.registerBindings(moduleId, bindings));
			// one entry however often it is called: unregisterBindings drops the module's group
			onDispose(
				() =>
					inputRuntimeRef
						? inputRuntimeRef.unregisterBindings(moduleId)
						: import('../inputRuntime').then((m) => m.unregisterBindings(moduleId)),
				'bindings',
				{ key: 'bindings' }
			);
		},
		input,
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
			return owned('inputListener', () => {
				dead = true;
				unsub(); // idempotent (Set.delete)
			});
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
			// SYNCHRONOUS through the primed ref at teardown: an unload followed at once by
			// a re-register (a dev reload) must not have the release land after the new claim
			const release = onDispose(
				() => {
					claimEntries.delete(scope);
					if (!claimedScopes.delete(scope)) return;
					if (inputRuntimeRef) inputRuntimeRef.releaseInput(scope);
					else import('../inputRuntime').then((m) => m.releaseInput(scope));
				},
				'inputClaim',
				{ key: 'claim:' + scope }
			);
			claimEntries.set(scope, release);
			return INPUT_SCOPES.includes(scope);
		},
		/** @param {'keys'|'locomotion'|'sticks'} scope */
		releaseInput(scope) {
			claimEntries.get(scope)?.();
			claimEntries.delete(scope);
			claimedScopes.delete(scope);
			if (inputRuntimeRef) inputRuntimeRef.releaseInput(scope);
			else import('../inputRuntime').then((m) => m.releaseInput(scope));
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkInput.surface = {
	registerBindings: 'registers',
	input: 'read',
	'input.actions': 'registers',
	keyOf: 'read',
	letterOf: 'read',
	onInput: 'registers',
	claimInput: 'registers',
	releaseInput: 'action'
};
