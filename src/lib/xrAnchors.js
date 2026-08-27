// CO3 — THE XR ANCHOR SHIM. The ONE file that touches the real XRAnchor surface
// (frame.createAnchor / anchor.requestPersistentHandle / session.restorePersistentAnchor
// / session.deletePersistentAnchor / frame.getPose on an anchorSpace — the exact shapes
// arProbe.js proved on the user's Quest, CO0). Everything above it — when to mint, what
// to store, how to follow drift — is colocationAnchors.js, and everything here is
// deliberately DUMB: no policy, no retries, no stores of its own, every method
// feature-detected and safe to call with no XR session at all (it answers null/false).
//
// THE INJECTION SEAM: `setXrAnchorApi(fake)` swaps the WHOLE implementation, which is
// what makes the persistence/restore/drift policy testable headlessly — no desktop
// browser exposes the persistence trio, so there is nothing real to drive in a suite.
// The real implementation is the default and `setXrAnchorApi(null)` restores it.
//
// `sessionContext()` is the one member beyond the five anchor calls: it answers
// {session, frame, refSpace, presenting} off three's WebXRManager, so the policy module
// never touches renderer.xr itself and the SAME seam fakes "presenting" for the suite.
// Note the WebXR validity rule the policy must honour: an XRFrame is only valid inside
// the animation-frame callback that delivered it, so `createAnchorAt`/`readAnchorPose`
// must be CALLED synchronously with a live frame (their promises may settle later —
// the results are plain arrays, valid forever).

import { get } from 'svelte/store';
import { globalRenderer } from '../stores/sceneStore';

const EMPTY_CONTEXT = { session: null, frame: null, refSpace: null, presenting: false };

/** The real implementation — three's xr manager + the raw WebXR anchor module. */
const realApi = {
	/** @returns {{session: any, frame: any, refSpace: any, presenting: boolean}} */
	sessionContext() {
		/** @type {any} */
		const renderer = get(globalRenderer);
		const xr = renderer?.xr;
		if (!xr?.isPresenting) return { ...EMPTY_CONTEXT };
		return {
			session: xr.getSession?.() ?? null,
			frame: xr.getFrame?.() ?? null,
			refSpace: xr.getReferenceSpace?.() ?? null,
			presenting: true
		};
	},

	/**
	 * Mint an XRAnchor at a pose in the given reference space. Must be called
	 * synchronously with a LIVE frame (the WebXR validity rule above).
	 * @param {any} frame @param {any} refSpace
	 * @param {{pos?: number[], quat?: number[]}} pose
	 * @returns {Promise<any|null>} the anchor, or null when the surface is absent
	 */
	async createAnchorAt(frame, refSpace, pose) {
		const XRRigidTransformCtor = /** @type {any} */ (globalThis).XRRigidTransform;
		if (
			!frame ||
			typeof frame.createAnchor !== 'function' ||
			typeof XRRigidTransformCtor !== 'function' ||
			!refSpace
		)
			return null;
		const p = pose?.pos ?? [0, 0, 0];
		const q = pose?.quat ?? [0, 0, 0, 1];
		const transform = new XRRigidTransformCtor(
			{ x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0, w: 1 },
			{ x: q[0] ?? 0, y: q[1] ?? 0, z: q[2] ?? 0, w: q[3] ?? 1 }
		);
		return frame.createAnchor(transform, refSpace);
	},

	/**
	 * @param {any} anchor
	 * @returns {Promise<string|null>} the persistent handle, or null when unsupported
	 */
	async persistHandle(anchor) {
		if (typeof anchor?.requestPersistentHandle !== 'function') return null;
		const handle = await anchor.requestPersistentHandle();
		return handle == null ? null : String(handle);
	},

	/**
	 * Restore a persisted anchor into THIS session. Rejects the way the runtime rejects
	 * (a NotFoundError means "not in this room map" — the caller reads the name).
	 * @param {any} session @param {string} handle
	 * @returns {Promise<any|null>} the anchor, or null when the surface is absent
	 */
	async restoreHandle(session, handle) {
		if (!handle || typeof session?.restorePersistentAnchor !== 'function') return null;
		return session.restorePersistentAnchor(handle);
	},

	/**
	 * The anchor's live pose in the given reference space, as plain arrays. Must be
	 * called synchronously with a LIVE frame; resolves null while tracking has not
	 * placed the anchor yet (normal in a session's first frames).
	 * @param {any} frame @param {any} anchor @param {any} refSpace
	 * @returns {Promise<{pos: number[], quat: number[]}|null>}
	 */
	async readAnchorPose(frame, anchor, refSpace) {
		if (!frame || typeof frame.getPose !== 'function' || !anchor?.anchorSpace || !refSpace)
			return null;
		const pose = frame.getPose(anchor.anchorSpace, refSpace);
		if (!pose) return null;
		const p = pose.transform.position;
		const o = pose.transform.orientation;
		return { pos: [p.x, p.y, p.z], quat: [o.x, o.y, o.z, o.w] };
	},

	/**
	 * Best-effort delete of a persisted handle. Never throws — with no session or no
	 * API there is nothing to call and the runtime simply keeps the anchor (the honest
	 * arProbe `clearProbeState` behaviour).
	 * @param {any} session @param {string} handle
	 * @returns {Promise<boolean>} whether the runtime confirmed the delete
	 */
	async deleteHandle(session, handle) {
		if (!handle || typeof session?.deletePersistentAnchor !== 'function') return false;
		try {
			await session.deletePersistentAnchor(handle);
			return true;
		} catch {
			return false;
		}
	}
};

/** @type {any} the live implementation — real by default, a fake under test */
let impl = realApi;

/**
 * THE TEST SEAM: swap the whole implementation. Pass null/undefined to restore the
 * real one. A fake provides the same six members; a member it omits answers the
 * safe default (null/false/empty context) rather than throwing.
 * @param {any} fake
 */
export function setXrAnchorApi(fake) {
	impl = fake && typeof fake === 'object' ? fake : realApi;
}

/** @returns {'real'|'fake'} which implementation is live (debug/suite premise) */
export function xrAnchorApiKind() {
	return impl === realApi ? 'real' : 'fake';
}

/** @returns {{session: any, frame: any, refSpace: any, presenting: boolean}} */
export function sessionContext() {
	try {
		return impl.sessionContext?.() ?? { ...EMPTY_CONTEXT };
	} catch {
		return { ...EMPTY_CONTEXT };
	}
}

/** @param {any} frame @param {any} refSpace @param {{pos?: number[], quat?: number[]}} pose
 * @returns {Promise<any|null>} */
export async function createAnchorAt(frame, refSpace, pose) {
	return impl.createAnchorAt ? impl.createAnchorAt(frame, refSpace, pose) : null;
}

/** @param {any} anchor @returns {Promise<string|null>} */
export async function persistHandle(anchor) {
	return impl.persistHandle ? impl.persistHandle(anchor) : null;
}

/** @param {any} session @param {string} handle @returns {Promise<any|null>} */
export async function restoreHandle(session, handle) {
	return impl.restoreHandle ? impl.restoreHandle(session, handle) : null;
}

/** @param {any} frame @param {any} anchor @param {any} refSpace
 * @returns {Promise<{pos: number[], quat: number[]}|null>} */
export async function readAnchorPose(frame, anchor, refSpace) {
	return impl.readAnchorPose ? impl.readAnchorPose(frame, anchor, refSpace) : null;
}

/** @param {any} session @param {string} handle @returns {Promise<boolean>} */
export async function deleteHandle(session, handle) {
	return impl.deleteHandle ? impl.deleteHandle(session, handle) : false;
}
