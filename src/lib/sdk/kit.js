// Module SDK — api.kit — the game kit (34 R2, contract T3): one namespace per kit piece, each
// GENERATED from the piece's spec (src/lib/kit/<piece>.spec.js), the same spec that builds the
// piece's flow node group, so `api.kit.score.add(2)` and a "Kit: Score ▸ Add score" node are one
// behaviour. One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).
//
// LIFECYCLE (T2): everything a module registers through the kit — an event listener, a level
// table, a pickup, a rule — is recorded through `track`, which today is the module's teardown
// journal (`ctx.onDispose`) and is the ONE line to switch when 34-lifecycle's tracked registry
// lands. The kit's shared DOCUMENT is not module-owned (it is the session's game state, like
// the game singleton) and survives an unload.

import { kit } from '../kit/runtime.js';
import { KIT_PIECES } from '../kit/index.js';
import { provideEngine } from '../behaviours/engines.js';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkKit(ctx) {
	/** T2: the one registration seam @param {() => void} off */
	const track = (off) => ctx.onDispose(off);
	return {
		/** 34 R2: the game kit — `api.kit.round`, `.levels`, `.score`, `.pickups`, `.rules` (and
		 * the pieces 34-kit-entities adds). Every action routes to the ONE authority peer, so call
		 * it wherever the input happened; reads are replicated state; `on<Event>(fn)` hears an
		 * event on EVERY peer (local feel) and returns `off`. */
		kit: {
			...kit.api({ onDispose: track, moduleId: ctx.moduleId }),
			/**
			 * 36 (U10): lend a game's RULES (a behaviour on its Main graph) this module's engine
			 * helpers as a piece shaped like a kit piece — `{piece, group, calls}` + the functions.
			 * The behaviour calls `kit.<piece>.<action>()`, reads `kit.<piece>.<value>()`, handles
			 * `'<piece>.<event>'`; the returned `emit(event, payload)` fires an event on THIS peer
			 * (emit on every peer that saw it, or forward it — handlers run on the authority).
			 * Unloading the module removes the piece and reloads the behaviours without it.
			 * @param {any} spec @param {Record<string, any>} impl
			 * `listening(event)` says whether any rules listen (0 = let the module's built-in rule decide).
			 * @returns {{emit: (event: string, payload?: any) => number, listening: (event: string) => number, dispose: () => void}}
			 */
			provide(spec, impl) {
				const handle = provideEngine(spec, impl, ctx.moduleId);
				ctx.onDispose(() => handle.dispose(), 'engine', { key: 'engine:' + String(spec?.piece ?? '') });
				return handle;
			}
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. Each piece is one member (the walk stops at depth 1): every piece's
 * `on<Event>` and tracked extras REGISTER, so each piece has a teardown fixture. */
sdkKit.surface = { ...Object.fromEntries(KIT_PIECES.map((row) => ['kit.' + row.name, 'registers'])), 'kit.provide': 'registers' };
