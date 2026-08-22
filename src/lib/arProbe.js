import { writable } from 'svelte/store';

// CO0 — the on-device WebXR capability probe.
//
// It exists because CO3 (persistent anchors) is the one colocation phase betting on
// browser API BEHAVIOUR rather than on our own maths, and the persistence half of the
// WebXR anchor module is a Meta extension that no desktop browser exposes — there is
// nothing to read from here. So the user runs this inside the headset and reads the
// answers back off the screen, and CO3 is designed against what it says.
//
// A DELIBERATE LEAF: svelte/store is the only import — no three, no threlte, nothing
// from the history family. The probe also brings its OWN throwaway canvas and WebGL
// context instead of borrowing the app's renderer: an XRSession needs a base layer, a
// context can only belong to one session at a time, and handing threlte's context to a
// second session would tear down whatever the editor was drawing into. A probe run must
// not be able to disturb the scene.
//
// EVERY finding is written to localStorage THE MOMENT IT IS RECORDED. An immersive
// session paints over the whole display, the user may take the headset off or kill the
// browser at any point, and the report has to survive both — a full browser restart is
// precisely the event the persistence test turns on.

const FINDINGS_KEY = 'arprobe-findings-v1';
const ANCHOR_KEY = 'arprobe-anchor-v1';

/**
 * Requested as OPTIONAL, all four of them: a REQUIRED feature that the runtime does not
 * have refuses the session outright, and a probe that cannot start a session learns
 * nothing at all. `session.enabledFeatures` is then the answer to "what did we get".
 */
const OPTIONAL_FEATURES = ['anchors', 'local-floor', 'hit-test', 'plane-detection'];

/** Total frame budget (~2s at 60Hz) — the loop exits EARLY once every step has settled. */
const MAX_FRAMES = 120;
/** Tracking needs a moment: the first frames of an AR session have no viewer pose. */
const SETTLE_FRAMES = 10;
/** Give up waiting for a viewer pose here (still well inside the budget). */
const POSE_DEADLINE = 60;
/** Give up waiting for an anchor's space to resolve to a pose. */
const ANCHOR_POSE_DEADLINE = 100;
/** A restore promise that never settles must not starve the create/persist half. */
const RESTORE_DEADLINE = 45;

/* -------------------------------------------------------------------------- */
/* findings                                                                   */
/* -------------------------------------------------------------------------- */

function loadFindings() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(FINDINGS_KEY) : null;
		const stored = raw ? JSON.parse(raw) : null;
		return Array.isArray(stored) ? stored : [];
	} catch {
		return [];
	}
}

/**
 * `{step, ok, detail}` per line, in the order they happened.
 * @type {import('svelte/store').Writable<any>}
 */
export const probeFindings = writable(loadFindings());

/** True while a probe run is in flight, so the UI can say so. */
export const probeRunning = writable(false);

/** @param {any} list */
function persistFindings(list) {
	try {
		if (typeof localStorage !== 'undefined') localStorage.setItem(FINDINGS_KEY, JSON.stringify(list));
	} catch {
		// private mode / quota: the on-screen report still works for this run
	}
}

/**
 * The ONE place a finding is recorded — and the one place the report is written out,
 * synchronously, so whatever happened up to the instant the browser died is on disk.
 * @param {string} step
 * @param {boolean} ok
 * @param {string} detail
 */
function add(step, ok, detail) {
	/** @type {any} */
	let next = [];
	probeFindings.update((list) => {
		next = [...(Array.isArray(list) ? list : []), { step, ok, detail }];
		return next;
	});
	persistFindings(next);
}

function resetFindings() {
	probeFindings.set([]);
	persistFindings([]);
}

/* -------------------------------------------------------------------------- */
/* small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** @param {any} err */
function msg(err) {
	if (!err) return 'unknown error';
	if (typeof err === 'string') return err;
	const name = err.name ? String(err.name) : '';
	const text = err.message ? String(err.message) : String(err);
	return name && !text.startsWith(name) ? `${name}: ${text}` : text;
}

/** A handle is a long opaque string — 8 characters is enough to compare two runs. */
/** @param {any} handle */
function short(handle) {
	const text = String(handle ?? '');
	return text.length > 8 ? `${text.slice(0, 8)}…` : text;
}

/** @param {any} p */
function fmt(p) {
	if (!p) return '(none)';
	const n = (/** @type {any} */ v) => (typeof v === 'number' ? v.toFixed(3) : '?');
	return `[${n(p.x)}, ${n(p.y)}, ${n(p.z)}]`;
}

/** @param {any} a @param {any} b */
function dist(a, b) {
	if (!a || !b) return NaN;
	const dx = (a.x || 0) - (b.x || 0);
	const dy = (a.y || 0) - (b.y || 0);
	const dz = (a.z || 0) - (b.z || 0);
	return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** @param {number} ms */
function ago(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return 'an unknown time';
	const s = Math.round(ms / 1000);
	if (s < 90) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m}min`;
	return `${Math.round(m / 60)}h`;
}

function readStoredAnchor() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(ANCHOR_KEY) : null;
		const stored = raw ? JSON.parse(raw) : null;
		return stored && typeof stored.handle === 'string' && stored.handle ? stored : null;
	} catch {
		return null;
	}
}

/** @param {any} record */
function writeStoredAnchor(record) {
	try {
		if (typeof localStorage !== 'undefined') localStorage.setItem(ANCHOR_KEY, JSON.stringify(record));
		return true;
	} catch {
		return false;
	}
}

function xrSystem() {
	if (typeof navigator === 'undefined') return null;
	return /** @type {any} */ (/** @type {any} */ (navigator).xr) || null;
}

/* -------------------------------------------------------------------------- */
/* pre-checks (no user activation needed)                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the API SURFACE claims, before any session exists. Everything is feature-detected
 * because this same path runs on a desktop browser where `navigator.xr` is undefined —
 * there the report should say so plainly rather than throw.
 *
 * The synchronous surface checks are recorded FIRST, before any await, so they land in
 * the report even if the two `isSessionSupported` promises never settle.
 *
 * This is the FIRST step of a probe run, so it CLEARS the previous run's report — one
 * run, one report. That matters for the persistence test: after a browser restart the
 * user must be able to tell which lines came from the run they just did.
 */
export async function probeSupport() {
	resetFindings();
	const xr = xrSystem();
	add('navigator.xr', !!xr, xr ? 'present' : 'absent — this browser has no WebXR at all');

	const anchorProto = /** @type {any} */ (globalThis).XRAnchor?.prototype;
	const sessionProto = /** @type {any} */ (globalThis).XRSession?.prototype;

	add(
		'XRAnchor',
		!!/** @type {any} */ (globalThis).XRAnchor,
		/** @type {any} */ (globalThis).XRAnchor ? 'constructor present' : 'absent — no anchor module'
	);
	add(
		'XRAnchor.requestPersistentHandle',
		typeof anchorProto?.requestPersistentHandle === 'function',
		typeof anchorProto?.requestPersistentHandle === 'function'
			? 'present — anchors can be persisted'
			: 'absent — anchors would be session-only'
	);
	add(
		'XRSession.restorePersistentAnchor',
		typeof sessionProto?.restorePersistentAnchor === 'function',
		typeof sessionProto?.restorePersistentAnchor === 'function' ? 'present' : 'absent'
	);
	add(
		'XRSession.deletePersistentAnchor',
		typeof sessionProto?.deletePersistentAnchor === 'function',
		typeof sessionProto?.deletePersistentAnchor === 'function' ? 'present' : 'absent'
	);
	add(
		'XRSession.persistentAnchors',
		'persistentAnchors' in (sessionProto || {}),
		'persistentAnchors' in (sessionProto || {}) ? 'declared on the prototype' : 'not declared'
	);

	if (!xr) return;

	for (const mode of ['immersive-ar', 'immersive-vr']) {
		try {
			const ok = await xr.isSessionSupported(mode);
			add(`isSessionSupported('${mode}')`, !!ok, ok ? 'supported' : 'NOT supported');
		} catch (err) {
			add(`isSessionSupported('${mode}')`, false, msg(err));
		}
	}
}

/* -------------------------------------------------------------------------- */
/* the session probe                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A throwaway canvas + context, never added to the document. The layer exists ONLY so
 * the browser delivers animation frames — the probe renders nothing into it.
 * @param {any} session
 */
async function attachBaseLayer(session) {
	const XRWebGLLayerCtor = /** @type {any} */ (globalThis).XRWebGLLayer;
	if (typeof XRWebGLLayerCtor !== 'function') {
		add('base layer', false, 'XRWebGLLayer is not a constructor');
		return false;
	}
	const canvas = document.createElement('canvas');
	canvas.width = 4;
	canvas.height = 4;
	let gl = /** @type {any} */ (canvas.getContext('webgl', { xrCompatible: true }));
	if (!gl) {
		gl = /** @type {any} */ (canvas.getContext('webgl'));
		if (gl && typeof gl.makeXRCompatible === 'function') await gl.makeXRCompatible();
	}
	if (!gl) {
		add('base layer', false, 'no WebGL context available');
		return false;
	}
	session.updateRenderState({ baseLayer: new XRWebGLLayerCtor(session, gl) });
	add('base layer', true, 'throwaway 4x4 WebGL layer attached (nothing is rendered)');
	return true;
}

/**
 * @param {any} session
 * @returns {Promise<{ space: any, kind: string } | null>}
 */
async function requestRefSpace(session) {
	for (const kind of ['local-floor', 'local']) {
		try {
			const space = await session.requestReferenceSpace(kind);
			add('reference space', true, `'${kind}'`);
			return { space, kind };
		} catch (err) {
			add('reference space', false, `'${kind}' refused: ${msg(err)}`);
		}
	}
	return null;
}

/**
 * The frame loop. One pass per frame drives a small state machine: settle → viewer pose
 * → RESTORE the stored handle (first, so the create below can overwrite the record and
 * re-arm the next run) → CREATE an anchor at the viewer's floor projection → PERSIST it.
 * Each half is independent: a failure records itself and stops waiting, it never aborts
 * the other half.
 *
 * @param {any} session
 * @param {any} refSpace
 * @param {{ handle: string, createdAt?: number, pose?: any } | null} stored
 */
function runFrameLoop(session, refSpace, stored) {
	return new Promise((resolve) => {
		let frames = 0;
		let finished = false;

		/** @type {any} */
		let headPos = null;
		let poseDone = false;

		// --- restore half -------------------------------------------------------
		let restoreStarted = !stored;
		let restoreSettled = !stored;
		let restoreDeltaDone = !stored;
		/** @type {any} */
		let restoredAnchor = null;

		// --- create/persist half ------------------------------------------------
		let createStarted = false;
		let createSettled = false;
		let createPoseDone = false;
		let persistStarted = false;
		let persistSettled = false;
		/** @type {any} */
		let createdAnchor = null;
		/** @type {any} */
		let createdPos = null;

		function done() {
			if (finished) return;
			finished = true;
			resolve(undefined);
		}
		// the user can take the headset off or hit the system exit at any moment
		session.addEventListener('end', () => {
			if (!finished) add('session end', false, 'session ended before the probe finished');
			done();
		});

		/** @param {number} _t @param {any} frame */
		function onFrame(_t, frame) {
			frames += 1;
			try {
				step(frame);
			} catch (err) {
				add('frame loop', false, msg(err));
				done();
				return;
			}
			const allSettled =
				poseDone && restoreSettled && restoreDeltaDone && createSettled && createPoseDone && persistSettled;
			if (finished) return;
			if (allSettled) {
				add('probe steps', true, `all steps settled after ${frames} frames`);
				done();
				return;
			}
			if (frames >= MAX_FRAMES) {
				add('probe steps', false, `frame budget (${MAX_FRAMES}) exhausted with steps still pending`);
				done();
				return;
			}
			session.requestAnimationFrame(onFrame);
		}

		/** @param {any} frame */
		function step(frame) {
			// (e) viewer pose — the anchor position comes from it
			if (!poseDone) {
				const pose = frames >= SETTLE_FRAMES ? frame.getViewerPose(refSpace) : null;
				if (pose) {
					const p = pose.transform.position;
					headPos = { x: p.x, y: p.y, z: p.z };
					add('viewer pose', true, `available on frame ${frames} — head at ${fmt(headPos)}`);
					poseDone = true;
				} else if (frames >= POSE_DEADLINE) {
					add('viewer pose', false, `none after ${frames} frames — tracking never established`);
					poseDone = true;
				}
			}

			// (h) RESTORE — runs first, and needs no pose of its own
			if (!restoreStarted && stored) {
				restoreStarted = true;
				const handle = stored.handle;
				if (typeof session.restorePersistentAnchor !== 'function') {
					add('anchor restore', false, 'session.restorePersistentAnchor is not a function');
					restoreSettled = true;
					restoreDeltaDone = true;
				} else {
					const when = typeof stored.createdAt === 'number' ? ago(Date.now() - stored.createdAt) : 'an unknown time';
					try {
						session
							.restorePersistentAnchor(handle)
							.then((/** @type {any} */ anchor) => {
								restoredAnchor = anchor;
								restoreSettled = true;
								add('anchor restore', true, `handle ${short(handle)} restored (persisted ${when} ago)`);
							})
							.catch((/** @type {any} */ err) => {
								restoreSettled = true;
								restoreDeltaDone = true;
								add('anchor restore', false, `handle ${short(handle)}: ${msg(err)}`);
							});
					} catch (err) {
						restoreSettled = true;
						restoreDeltaDone = true;
						add('anchor restore', false, `handle ${short(handle)}: ${msg(err)}`);
					}
				}
			}
			// the number that matters: how far the restored anchor sits from where it was
			// persisted. Across a browser restart in the SAME physical room this is the
			// real accuracy of persistence — a few cm is a working feature.
			if (restoredAnchor && !restoreDeltaDone) {
				const pose = restoredAnchor.anchorSpace ? frame.getPose(restoredAnchor.anchorSpace, refSpace) : null;
				if (pose) {
					const p = pose.transform.position;
					const d = dist(p, stored?.pose);
					restoreDeltaDone = true;
					add(
						'restore delta',
						Number.isFinite(d),
						Number.isFinite(d)
							? `now ${fmt(p)} vs persisted ${fmt(stored?.pose)} — delta ${d.toFixed(3)} m`
							: `now ${fmt(p)} — no persisted pose to compare against`
					);
				} else if (frames >= ANCHOR_POSE_DEADLINE) {
					restoreDeltaDone = true;
					add('restore delta', false, 'restored anchor never resolved to a pose in this reference space');
				}
			}

			// (f) CREATE — after the restore has had its turn, so the persist below
			// overwrites the stored record only once the old one has been read. The frame
			// deadline is the independence rule: a restore promise that never settles must
			// not take the create half down with it.
			if (!createStarted && poseDone && (restoreSettled || frames >= RESTORE_DEADLINE)) {
				createStarted = true;
				const XRRigidTransformCtor = /** @type {any} */ (globalThis).XRRigidTransform;
				if (!headPos) {
					skipCreate('no viewer pose to anchor at');
				} else if (typeof frame.createAnchor !== 'function') {
					skipCreate("frame.createAnchor is not a function ('anchors' not enabled)");
				} else if (typeof XRRigidTransformCtor !== 'function') {
					skipCreate('XRRigidTransform is not a constructor');
				} else {
					// the viewer's floor projection: y = 0 in a local-floor space is the floor
					const target = { x: headPos.x, y: 0, z: headPos.z };
					try {
						frame
							.createAnchor(new XRRigidTransformCtor(target), refSpace)
							.then((/** @type {any} */ anchor) => {
								createdAnchor = anchor;
								createSettled = true;
								add('anchor create', true, `created at the viewer floor projection ${fmt(target)}`);
							})
							.catch((/** @type {any} */ err) => {
								skipCreate(msg(err));
							});
					} catch (err) {
						skipCreate(msg(err));
					}
					createdPos = target;
				}
			}
			if (createdAnchor && !createPoseDone) {
				const pose = createdAnchor.anchorSpace ? frame.getPose(createdAnchor.anchorSpace, refSpace) : null;
				if (pose) {
					const p = pose.transform.position;
					createdPos = { x: p.x, y: p.y, z: p.z };
					createPoseDone = true;
					add('anchor pose', true, `anchorSpace resolves — anchor at ${fmt(createdPos)}`);
				} else if (frames >= ANCHOR_POSE_DEADLINE) {
					createPoseDone = true;
					add('anchor pose', false, 'anchorSpace never resolved to a pose (keeping the requested position)');
				}
			}

			// (g) PERSIST — and store the pose we will compare against next run
			if (createdAnchor && createPoseDone && !persistStarted) {
				persistStarted = true;
				if (typeof createdAnchor.requestPersistentHandle !== 'function') {
					persistSettled = true;
					add('anchor persist', false, 'anchor.requestPersistentHandle is not a function — no persistence');
				} else {
					try {
						createdAnchor
							.requestPersistentHandle()
							.then((/** @type {any} */ handle) => {
								persistSettled = true;
								const wrote = writeStoredAnchor({ handle: String(handle), createdAt: Date.now(), pose: createdPos });
								add(
									'anchor persist',
									true,
									`handle ${short(handle)}${wrote ? '' : ' (localStorage write FAILED)'} — restart the browser and probe again`
								);
							})
							.catch((/** @type {any} */ err) => {
								persistSettled = true;
								add('anchor persist', false, msg(err));
							});
					} catch (err) {
						persistSettled = true;
						add('anchor persist', false, msg(err));
					}
				}
			}
		}

		/** @param {string} why */
		function skipCreate(why) {
			createSettled = true;
			createPoseDone = true;
			persistStarted = true;
			persistSettled = true;
			add('anchor create', false, why);
		}

		session.requestAnimationFrame(onFrame);
	});
}

/**
 * The full probe. MUST be called DIRECTLY from a click handler: `requestSession` for an
 * immersive mode requires transient user activation, and this function performs NO await
 * before it (the stored-handle read is a synchronous localStorage read) so the activation
 * is guaranteed intact whatever the caller did afterwards.
 */
export async function runArProbe() {
	const xr = xrSystem();
	if (!xr || typeof xr.requestSession !== 'function') {
		add('session', false, 'navigator.xr.requestSession is unavailable — nothing to probe on this device');
		return;
	}
	// read BEFORE the session exists: the create-and-persist step below overwrites this
	// record, and the restore step must compare against the PREVIOUS run
	const stored = readStoredAnchor();
	add(
		'stored handle',
		!!stored,
		stored
			? `handle ${short(stored.handle)} from ${ago(Date.now() - (stored.createdAt || 0))} ago at ${fmt(stored.pose)}`
			: 'none — this run only creates one (restart the browser, then run again to test restore)'
	);

	probeRunning.set(true);
	/** @type {any} */
	let session = null;
	// the user can exit through the system menu or take the headset off at any point —
	// calling end() on an already-ended session throws, and that is not a finding
	let sessionEnded = false;
	try {
		try {
			session = await xr.requestSession('immersive-ar', { optionalFeatures: OPTIONAL_FEATURES });
			session.addEventListener('end', () => {
				sessionEnded = true;
			});
			add('session', true, 'immersive-ar started with all four features OPTIONAL');
		} catch (err) {
			add('session', false, msg(err));
			return;
		}

		// (b) what did we actually get
		const enabled = /** @type {any} */ (session).enabledFeatures;
		if (enabled === undefined) {
			add('enabledFeatures', false, 'undefined on this build — cannot tell which features are on');
		} else {
			const list = Array.from(enabled || []).join(', ') || '(empty)';
			add('enabledFeatures', true, list);
		}
		const anchors = /** @type {any} */ (session).persistentAnchors;
		if (anchors === undefined) {
			add('session.persistentAnchors', false, 'undefined on this session');
		} else {
			const size = typeof anchors.size === 'number' ? anchors.size : Array.from(anchors || []).length;
			add('session.persistentAnchors', true, `${size} persisted anchor(s) known to this session`);
		}

		if (!(await attachBaseLayer(session))) return;
		const ref = await requestRefSpace(session);
		if (!ref) return;

		await runFrameLoop(session, ref.space, stored);
	} catch (err) {
		add('probe', false, msg(err));
	} finally {
		if (session && !sessionEnded) {
			try {
				await session.end();
				add('session end', true, 'ended cleanly');
			} catch (err) {
				add('session end', false, msg(err));
			}
		}
		probeRunning.set(false);
	}
}

/**
 * Forget everything the probe stored. `deletePersistentAnchor` lives on XRSession, so
 * with no session running there is nothing to call — the handle is dropped locally and
 * the finding says so, which is honest: the runtime may still hold the anchor.
 */
export async function clearProbeState() {
	const stored = readStoredAnchor();
	resetFindings();
	try {
		if (typeof localStorage !== 'undefined') {
			localStorage.removeItem(ANCHOR_KEY);
			localStorage.removeItem(FINDINGS_KEY);
		}
	} catch {
		// nothing to do — the store is already reset
	}
	add(
		'cleared',
		true,
		stored
			? `dropped stored handle ${short(stored.handle)} (the runtime may still hold the anchor — no session to delete it through)`
			: 'nothing was stored'
	);
}
