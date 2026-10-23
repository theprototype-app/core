// Roadmap 55 A2 — IS THIS PAGE DRIVEN BY AN AGENT? A LEAF (safeStorage only), the one part of the agent
// API that is in the boot graph, and on purpose tiny: everything else is `tpAgent.js`, imported only
// when this says yes.
//
// Two ways in, both explicit: `&agent` as a segment of the URL hash (`#F0FD3&agent`, also
// `#F0FD3&agent&invite=…`, or a bare `#agent`), or `agentApi` in safeStorage (what a driver sets with an
// init script, and what survives the reload of a page whose hash was already consumed).
//
// THE HASH IS READ ONCE, AT MODULE EVALUATION. The app consumes the hash early (peerHandler's `open`
// dial, inviteLinks' replaceState), so a check made later finds it gone. App.svelte imports this file,
// which evaluates it before any of that runs.

import { safeStorage } from '../safeStorage';

/** the storage key a driver sets to turn the API on without a hash */
export const AGENT_API_KEY = 'agentApi';

/**
 * Does this hash carry the `agent` flag? A segment, never a substring: `#agentsmith` is a peer id.
 * Pure, exported for the unit test.
 * @param {string} hash e.g. `#f0fd3&agent&invite=abc~srv=host`
 */
export function hashWantsAgent(hash) {
	const h = String(hash || '').replace(/^#/, '');
	const tilde = h.indexOf('~');
	const head = tilde < 0 ? h : h.slice(0, tilde);
	return head.split('&').some((seg, i) => {
		const key = seg.split('=')[0].toLowerCase();
		// the first segment is the peer id unless the hash is ONLY the flag (`#agent`)
		return key === 'agent' && (i > 0 || head === seg);
	});
}

/** @param {string|null|undefined} value */
function storageSaysYes(value) {
	return value != null && value !== '' && value !== '0' && value !== 'false';
}

const fromHash = typeof location !== 'undefined' && hashWantsAgent(location.hash);

/** True when this page should expose `window.tpAgent`. */
export function agentRequested() {
	if (fromHash) return true;
	try {
		return storageSaysYes(safeStorage.getItem(AGENT_API_KEY));
	} catch {
		return false;
	}
}
