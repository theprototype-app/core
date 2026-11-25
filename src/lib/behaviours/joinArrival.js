// fix-agenttest 7, moved here by 102-boot-diet — HAS A JOINER HAD ITS HOST'S FIRST OBJECT BATCH?
//
// behaviours/app.js holds on.load while the scene is still arriving (see its "on.load waits for the
// scene" block). One of the three facts it reads is "the host whose first object batch we have had",
// which only a watch running SINCE BOOT can know: a batch that closed before the watch began looks
// exactly like one that has not started. app.js used to start at boot; since 102-boot-diet it loads
// when the scene first holds a behaviour (behaviours/load.js), which for a joiner is usually AFTER
// that batch, so the watch lives in this leaf, imported from boot by load.js. Without it a late
// start would hold every joiner's on.load for the full JOIN_SYNC_WAIT_MS.
//
// The rules are the ones app.js had, unchanged: a host change starts the bounded wait; any batch
// CLOSING (the last object landed, a stall clear, or an empty announcement for an empty scene) while
// a host is set ends it; the subscribe calls themselves are not a closing.
//
// A LEAF: svelte/store + two store modules that are on every page's boot already.

import { get } from 'svelte/store';
import { loading as syncBatch } from '../../stores/appStore';
import { sessionHost } from '../connectionState';

/** the joiner wait is bounded: a host that withholds its objects (another room, an open connect
 * decision) sends none, and after this the behaviours run on what is here */
export const JOIN_SYNC_WAIT_MS = 8000;
/** the host whose first object batch we have had (null = not yet, or we host) */
let syncedHost = /** @type {string | null} */ (null);
/** @type {any} */ let joinWaitTimer = null;
/** @type {Set<() => void>} */
const listeners = new Set();
let primed = false;

/** the host whose first object batch we have had (null = not yet, or we host) */
export const joinSyncedHost = () => syncedHost;

/** called on every change that may end (or start) the scene's arrival @param {() => void} fn */
export function onJoinArrivalChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
const changed = () => {
	for (const fn of listeners) fn();
};

sessionHost.subscribe((host) => {
	clearTimeout(joinWaitTimer);
	joinWaitTimer = null;
	if (!host) syncedHost = null;
	else if (host !== syncedHost) {
		joinWaitTimer = setTimeout(() => {
			syncedHost = host;
			changed();
		}, JOIN_SYNC_WAIT_MS);
	}
	if (primed) changed();
});
syncBatch.subscribe((batch) => {
	if (primed && (!Array.isArray(batch) || !batch.length)) {
		const host = get(sessionHost);
		if (host && host !== syncedHost) {
			syncedHost = host;
			clearTimeout(joinWaitTimer);
			joinWaitTimer = null;
		}
	}
	if (primed) changed();
});
primed = true;
