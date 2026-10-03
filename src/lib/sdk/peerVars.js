// Module SDK — api.peerVars — per-player replicated numbers.
// One slice of the api object makeApi() assembles (sdk/index.js, the ONE table).

import { coalescedSubscribe } from '../coalesce';
import { setPeerVar, myPeerVar, leaderboardRows, peerVarsMine, peerVarsRemote } from '../peerVars';

/** @param {import('./context.js').SdkContext} ctx */
export function sdkPeerVars(ctx) {
	const { owned } = ctx;
	return {
		peerVars: {
			/** Write MY OWN row. @param {string} name @param {number} value */
			setMine(name, value) {
				setPeerVar(name, value);
			},
			/** My own number. @param {string} name @param {number=} fallback @returns {number} */
			mine(name, fallback = 0) {
				return myPeerVar(name, fallback);
			},
			/** Everyone's rows for one name, roster-resolved and deterministically ordered —
			 * `[{id, name, value, me, rank}]`, the leaderboard shape. @param {string} name
			 * @param {{order?: 'desc'|'asc'}=} opts */
			all(name, opts) {
				return leaderboardRows(name, opts);
			},
			/** R29 S2: `fn()` runs after ANY peer's row changes (mine or a remote one) —
			 * coalesced to one call per frame, torn down with the module or by the returned
			 * `off`. @param {() => void} fn @returns {() => void} off */
			onChange(fn) {
				return owned('peerVars.onChange', coalescedSubscribe([peerVarsMine, peerVarsRemote], fn));
			}
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle — see SURFACE_KINDS in
 * sdk/lifecycle.js. tests/unit/moduleLifecycle.test.js holds every 'registers' member to a
 * teardown path; a member missing here fails it. */
sdkPeerVars.surface = {
	'peerVars.setMine': 'content',
	'peerVars.mine': 'read',
	'peerVars.all': 'read',
	'peerVars.onChange': 'registers'
};
