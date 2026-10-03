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

/** @param {import('./context.js').SdkContext} ctx */
export function sdkKit(ctx) {
	/** T2: the one registration seam @param {() => void} off */
	const track = (off) => ctx.onDispose(off);
	return {
		/** 34 R2: the game kit — `api.kit.round`, `.levels`, `.score`, `.pickups`, `.rules` (and
		 * the pieces 34-kit-entities adds). Every action routes to the ONE authority peer, so call
		 * it wherever the input happened; reads are replicated state; `on<Event>(fn)` hears an
		 * event on EVERY peer (local feel) and returns `off`. */
		kit: kit.api({ onDispose: track, moduleId: ctx.moduleId })
	};
}
