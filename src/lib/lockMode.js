// 80a K15: the room's LOCK MODE. "Lock while selected" (`select`, the default and the behaviour
// before 80a) or "Lock only while editing" (`edit`): selecting takes nothing, the first edit we SEND
// of an object takes it (the lock goes out ahead of the edit on the same ordered connections, so the
// K3 gate sees the claim first), and it is let go LOCK_EDIT_RELEASE_MS after the last edit.
//
// The HOST decides (an admin too, when a roles plugin says so): `lockmode` {mode, at}, latest wins on
// `at`, accepted only from the host or an admin (the connection it came on, K12), and the host's
// handshake carries it so a late joiner follows. Everyone else's copy is read-only: the Settings row
// is the host's (cloud builds: the room settings, through `cloudApi.setLockMode`).
import { writable, get } from 'svelte/store';
import { sessionHost } from './connectionState';
import { rolesInfo } from './cloudHooks';
import { myLocks, heldByOther, lockMessage, dropMyLocks } from './lockHeld';

/** @typedef {'select' | 'edit'} LockMode */
export const LOCK_MODES = /** @type {const} */ (['select', 'edit']);
export const LOCK_EDIT_RELEASE_MS = 3000;

/** @type {import('svelte/store').Writable<{mode: LockMode, at: number}>} */
export const lockMode = writable({ mode: /** @type {LockMode} */ ('select'), at: 0 });

/** @param {any} m @returns {m is LockMode} */
export const isLockMode = (m) => m === 'select' || m === 'edit';

/** is the edit-only mode on? */
export const lockOnEdit = () => get(lockMode).mode === 'edit';

/** may WE set the room's mode? the host, or an admin under a roles plugin */
export function maySetLockMode() {
	/** @type {any} */
	const ri = get(rolesInfo);
	if (ri && ri.amAdmin) return true;
	return get(sessionHost) === null && (!ri || ri.myRole !== 'viewer');
}

/** is `peerId` someone whose `lockmode` we follow? @param {string} peerId */
export function speaksForLockMode(peerId) {
	if (!peerId) return false;
	if (get(sessionHost) === peerId) return true;
	/** @type {any} */
	const ri = get(rolesInfo);
	return !!(ri && typeof ri.roleOf === 'function' && ri.roleOf(peerId) === 'admin');
}

/** @type {((data: any) => void) | null} */
let sender = null;
/** @type {((mode: LockMode, before: LockMode) => void) | null} */
let onChange = null;

/**
 * The wire and the selection side, registered by peerHandler / lockControl (keeps this module a leaf).
 * @param {{send?: (data: any) => void, changed?: (mode: LockMode, before: LockMode) => void}} hooks
 */
export function registerLockModeHooks(hooks) {
	if (hooks.send) sender = hooks.send;
	if (hooks.changed) onChange = hooks.changed;
}

/** @param {LockMode} mode @param {number} at */
function adopt(mode, at) {
	const before = get(lockMode).mode;
	lockMode.set({ mode, at });
	if (before !== mode) onChange?.(mode, before);
}

/**
 * Set the room's mode (the host's Settings row, or the cloud room settings).
 * @param {LockMode} mode @returns {boolean} false = not ours to set
 */
export function setLockMode(mode) {
	if (!isLockMode(mode) || !maySetLockMode()) return false;
	const at = Math.max(Date.now(), get(lockMode).at + 1);
	adopt(mode, at);
	sender?.({ type: 'lockmode', mode, at });
	return true;
}

/** A `lockmode` from `from` @param {any} data @param {string} from */
export function applyLockMode(data, from) {
	if (!isLockMode(data?.mode) || !speaksForLockMode(from)) return;
	const at = Number(data.at);
	if (!Number.isFinite(at) || at <= get(lockMode).at) return;
	adopt(data.mode, at);
}

/** what the host's handshake carries (null = the default never set: older peers see nothing new) */
export function lockModeMessage() {
	const m = get(lockMode);
	return m.at ? { type: 'lockmode', mode: m.mode, at: m.at } : null;
}

/** a new session (we left, or the host changed): back to the default */
export function resetLockMode() {
	if (get(lockMode).at === 0) return;
	adopt('select', 0);
}

// ---------------------------------------------------------------------------------------------
// edit mode: the claim on the first edit, and the release after the last

/** @type {Map<string, any>} uuid -> its release timer */
const releaseTimers = new Map();

/**
 * We are about to send an edit of `uuid`. In edit mode, take it (if nobody else holds it) and
 * restart its release timer. Returns the `lock` message to send FIRST, or null.
 * @param {string} uuid @param {(uuid: string) => void} release how to let go (an unlock)
 * @returns {any}
 */
export function claimForEdit(uuid, release) {
	if (!lockOnEdit() || !uuid || heldByOther(uuid)) return null;
	const had = get(myLocks).has(uuid);
	const prev = releaseTimers.get(uuid);
	if (prev) clearTimeout(prev);
	releaseTimers.set(
		uuid,
		setTimeout(() => {
			releaseTimers.delete(uuid);
			if (lockOnEdit() && get(myLocks).has(uuid)) release(uuid);
		}, LOCK_EDIT_RELEASE_MS)
	);
	return had ? null : lockMessage([...get(myLocks).keys(), uuid]);
}

/** forget the timers (a mode change, a reset) */
export function clearEditTimers() {
	for (const t of releaseTimers.values()) clearTimeout(t);
	releaseTimers.clear();
}

/** in edit mode a new selection lets go of edit locks on objects it no longer has @param {string[]} selection */
export function editLocksToDrop(selection) {
	const keep = new Set(selection);
	return [...get(myLocks).keys()].filter((u) => !keep.has(u));
}

export { dropMyLocks };
