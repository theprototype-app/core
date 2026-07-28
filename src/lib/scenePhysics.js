import { writable, get } from 'svelte/store';
import { peers } from '../stores/appStore';

// CL-A A6: scene-wide physics settings — today just GRAVITY. ONE shared value
// for the whole session, replicated as its OWN latest-wins singleton message
// (the sceneMusic pattern: a changedAt stamp resolves races; deliberately NOT
// piggybacked on environment, which round-trips through preset export/import).
// physics.js reads sceneGravity at world creation AND subscribes during a run,
// so a mid-sim change applies live on the stepping peer.

export const DEFAULT_GRAVITY = -9.81;

/** the shared scene state (gravity m/s^2 along Y) */
export const scenePhysicsState_ = writable({ gravity: DEFAULT_GRAVITY, changedAt: 0 });

/** convenience view: just the gravity number (physics + UI read this) */
export const sceneGravity = writable(DEFAULT_GRAVITY);
scenePhysicsState_.subscribe((s) => sceneGravity.set(s.gravity));

/** Apply a change locally + replicate (latest-wins). @param {any} partial */
function commitScenePhysics(partial) {
	const state = { ...get(scenePhysicsState_), ...partial, changedAt: Date.now() };
	scenePhysicsState_.set(state);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'scenephysics', ...state });
}

/** Scene gravity (Inspector scene ▸ Physics slider). @param {number} g */
export function setSceneGravity(g) {
	const clamped = Math.max(-20, Math.min(5, +g || 0));
	commitScenePhysics({ gravity: clamped });
}

/** Back to earth. */
export function resetSceneGravity() {
	commitScenePhysics({ gravity: DEFAULT_GRAVITY });
}

/** Remote/handshake apply: newest change wins (env pattern). @param {any} data */
export function applyRemoteScenePhysics(data) {
	if ((data?.changedAt ?? 0) <= (get(scenePhysicsState_).changedAt ?? 0)) return;
	scenePhysicsState_.set({
		gravity: typeof data.gravity === 'number' ? data.gravity : DEFAULT_GRAVITY,
		changedAt: data.changedAt
	});
}

/** Handshake payload (singleton push, like environmentState/musicState). */
export function scenePhysicsState() {
	return { type: 'scenephysics', ...get(scenePhysicsState_) };
}

/** test/debug view */
export function scenePhysicsDebug() {
	return { ...get(scenePhysicsState_) };
}
