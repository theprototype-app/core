// 68 V4 — the Film RECORDER: ● Record samples the viewfinder into the sequencer, ❚❚ Pause commits
// the shot, resuming asks Cut (a new shot, the default) or Move (the camera flies from the last
// frame to where you are now, then the shot carries on); Retake re-films any shot.
//
// THE TIMELINE PLAYS DURING THE TAKE: each segment runs the sequence as an OPEN preview run
// (animations, sounds and other prop tracks play as they would; the run does not end at the
// duration — a take may film past it and the commit grows the sequence). Film holds the camera,
// so the sequence's own shots never cut away from the viewfinder. Samples are stamped in
// SEQUENCE time on the same synced clock the run uses, so what was filmed lines up with what
// played, and resampled to 30 Hz at the commit (F2).
//
// ONE UNDO STEP AND ONE BROADCAST PER SEGMENT: the commit is a single sequence write inside a
// sequence gesture (the pure fold is filmTake.commitTake). The live pose never edits the scene;
// peers see it as presence (V7). The raw 30 Hz samples (smoothed AND unfiltered, F3) go to the
// Library's hidden shelf as a content-hashed blob the take's RawRef names — re-smoothing reads it.
import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import { sessionNow } from '../sessionClock';
import { activeSequence, sequenceOf, createSequence, setSequence } from '../sequences';
import { beginSequenceGesture, endSequenceGesture } from '../sequenceSync';
import { playSequence, stopSequence, scrubSequence, releaseScrub, seqTransport } from '../sequencePlayer';
import { findCameraObject } from '../cameraObjects';
import { isViewer } from '../objectPermissions';
import { showToast } from '../../stores/appStore';
import { onFilmFrame, setPoseFilter, liveState, placeCamera } from './filmMode';
import { commitTake, uniformSamples, filmShots, DEFAULT_BUDGET } from './filmTake';
import { packRaw, moveEase, RAW_LAYOUT } from './filmCore';
import { sampleCurve } from '../curveCore';
import { propTrackOf } from '../sequenceCore';

/** the Move fly's length, seconds */
export const FLY_SECONDS = 1.5;

/**
 * What the overlay shows. `state`: idle | recording | paused. `choosing` = the Cut / Move ask
 * is up. `t` = the sequence time under the playhead, `shots` = shots committed this session.
 * @typedef {{state: 'idle'|'recording'|'paused', seq: string|null, t: number, segStart: number,
 *   shots: number, choosing: boolean, saving: boolean, mode: string, markers?: number}} TakeUi
 */
/** @type {import('svelte/store').Writable<TakeUi>} */
export const take = writable(idleUi());

function idleUi() {
	return { state: /** @type {'idle'} */ ('idle'), seq: null, t: 0, segStart: 0, shots: 0, choosing: false, saving: false, mode: 'cut' };
}

/** @typedef {{seqId: string, camera: string, name: string, sessionStart: number, pausedAt: number,
 *   lastItemId: string|null, lastPose: any, base: Record<string, number>}} Session */
/** @type {Session | null} */
let session = null;
/** @typedef {{mode: 'cut'|'move'|'retake', itemId: string|null, t0: number, runAt: number, frames: any[], markers: number[]}} Segment */
/** @type {Segment | null} */
let segment = null;
/** @type {(() => void) | null} */
let unlisten = null;
/** the commit in flight (a resume waits for it: the sequence must hold the shot first) */
let saving = Promise.resolve();
let lastUiAt = 0;

/** flow seconds of day — the player's clock (sequencePlayer.syncedNow) */
function syncedNow() {
	return (sessionNow() % 86400000) / 1000;
}

/** @param {Partial<TakeUi>} patch */
function patch(patch) {
	take.update((s) => ({ ...s, ...patch }));
}

/** @param {any} pose @param {number} dt */
function onFrame(pose, dt) {
	if (!segment) return;
	const t = segment.t0 + Math.max(0, syncedNow() - segment.runAt);
	segment.frames.push({
		t,
		pos: pose.pos.slice(),
		quat: pose.qBase.slice(),
		fov: pose.fov,
		roll: pose.roll,
		...(Number.isFinite(pose.focus) ? { focus: pose.focus } : {}),
		...(Number.isFinite(pose.aperture) ? { aperture: pose.aperture } : {}),
		rawPos: (pose.rawPos ?? pose.pos).slice(),
		rawQuat: (pose.rawQBase ?? pose.qBase).slice()
	});
	const now = performance.now();
	if (now - lastUiAt > 100) {
		lastUiAt = now;
		patch({ t });
	}
}

/** ● — start a take, or (paused) ask Cut / Move. */
export function record() {
	const ui = get(take);
	if (ui.state === 'recording') return false;
	if (ui.state === 'paused') {
		patch({ choosing: true });
		return true;
	}
	const live = liveState();
	if (!live.uuid) return false;
	if (isViewer()) {
		showToast('Only editors can record — ask the host for editor access');
		return false;
	}
	let seqId = get(activeSequence);
	if (!seqId || !sequenceOf(seqId)) seqId = createSequence('Film');
	const t0 = Math.max(0, get(seqTransport)[seqId]?.t ?? 0);
	const object = findCameraObject(live.uuid);
	session = {
		seqId,
		camera: live.uuid,
		name: object?.name || 'Camera',
		sessionStart: t0,
		pausedAt: t0,
		lastItemId: null,
		lastPose: null,
		base: { ...live.base }
	};
	if (!unlisten) unlisten = onFilmFrame(onFrame);
	startSegment('cut', t0, null);
	return true;
}

/** Resume after a pause: 'cut' (a new shot) or 'move' (fly from the last frame, same shot). @param {'cut'|'move'} mode */
export async function resume(mode) {
	if (!session || get(take).state !== 'paused') return false;
	patch({ choosing: false });
	await saving;
	if (!session) return false;
	if (mode === 'move' && session.lastPose && session.lastItemId) {
		const from = session.lastPose;
		const start = performance.now() / 1000;
		setPoseFilter((/** @type {any} */ pose, /** @type {number} */ now) => {
			const s = moveEase((now - start) / FLY_SECONDS);
			if (s >= 1) {
				setPoseFilter(null);
				return pose;
			}
			return {
				...pose,
				pos: from.pos.map((/** @type {number} */ v, /** @type {number} */ i) => v + (pose.pos[i] - v) * s),
				qBase: slerp(from.qBase, pose.qBase, s),
				fov: from.fov + (pose.fov - from.fov) * s,
				roll: from.roll + (pose.roll - from.roll) * s
			};
		});
		startSegment('move', session.pausedAt, session.lastItemId);
	} else startSegment('cut', session.pausedAt, null);
	return true;
}

/** @param {'cut'|'move'|'retake'} mode @param {number} t0 @param {string|null} itemId */
function startSegment(mode, t0, itemId) {
	if (!session) return;
	const runAt = syncedNow();
	segment = { mode, itemId, t0, runAt, frames: [], markers: [] };
	releaseScrub(); // the paused moment's pose hands over to the run
	playSequence(session.seqId, { mode: 'preview', from: t0, at: runAt, open: true });
	patch({ state: 'recording', seq: session.seqId, t: t0, segStart: t0, choosing: false, mode, shots: get(take).shots });
}

/** ❚❚ — stop sampling and commit the segment (one undo step). */
export function pause() {
	if (!session || !segment) return false;
	const seg = segment;
	segment = null;
	setPoseFilter(null);
	const s = session;
	stopSequence(s.seqId, { restore: false });
	const tEnd = seg.frames.length ? seg.frames[seg.frames.length - 1].t : seg.t0;
	s.pausedAt = tEnd;
	patch({ state: 'paused', saving: true, t: tEnd });
	saving = commitSegment(s, seg)
		.catch((error) => {
			console.warn('film take:', error);
			showToast('The take could not be saved');
		})
		.finally(() => {
			patch({ saving: false });
			// the world freezes at the cut while you reposition (the scrub shows that moment)
			if (session === s && get(take).state === 'paused') scrubSequence(s.seqId, s.pausedAt);
		});
	return true;
}

/** Done: commit what is recording and end the take session (Film stays open). */
export async function finishTake() {
	if (segment) pause();
	await saving;
	session = null;
	unlisten?.();
	unlisten = null;
	releaseScrub();
	take.set(idleUi());
}

/**
 * Retake a shot of this session's sequence: the playhead goes to its start, the camera to the
 * pose it had there, and recording overwrites the shot (later shots it runs into are trimmed).
 * @param {string} itemId
 */
export async function retake(itemId) {
	if (get(take).state === 'recording') return false;
	await saving;
	const live = liveState();
	const seqId = session?.seqId ?? get(activeSequence);
	const seq = seqId ? sequenceOf(seqId) : null;
	if (!seq || !live.uuid) return false;
	const shot = filmShots(seq, live.uuid).find((/** @type {any} */ it) => it.id === itemId);
	if (!shot) return false;
	if (!session || session.seqId !== seq.id) {
		const object = findCameraObject(live.uuid);
		session = {
			seqId: seq.id,
			camera: live.uuid,
			name: object?.name || 'Camera',
			sessionStart: shot.t,
			pausedAt: shot.t,
			lastItemId: null,
			lastPose: null,
			base: { ...live.base }
		};
	}
	if (!unlisten) unlisten = onFilmFrame(onFrame);
	const at = poseAt(seq, live.uuid, shot.t);
	if (at) placeCamera(at);
	startSegment('retake', shot.t, itemId);
	return true;
}

/** The camera's recorded WORLD position at t (its position track, through the parent). @param {any} seq @param {string} camera @param {number} t */
function poseAt(seq, camera, t) {
	const track = propTrackOf(seq, camera, 'position');
	if (!track?.keys?.length) return null;
	const local = sampleCurve('vec3', track.keys, t);
	const object = findCameraObject(camera);
	const v = new THREE.Vector3(local[0], local[1], local[2]);
	if (object?.parent) {
		object.parent.updateWorldMatrix(true, false);
		v.applyMatrix4(object.parent.matrixWorld);
	}
	return v.toArray();
}

/** @param {Session} s @param {Segment} seg */
async function commitSegment(s, seg) {
	if (seg.frames.length < 2) {
		showToast('That take was too short to keep');
		return;
	}
	const uniform = uniformSamples(seg.frames, 30);
	const object = findCameraObject(s.camera);
	if (!object) {
		showToast('The camera was deleted — the take is gone');
		return;
	}
	// prop tracks are LOCAL to the marker's parent (the pose was filmed in world space)
	const parent = object.parent;
	const inv = new THREE.Matrix4();
	const parentQ = new THREE.Quaternion();
	if (parent) {
		parent.updateWorldMatrix(true, false);
		inv.copy(parent.matrixWorld).invert();
		parent.matrixWorld.decompose(new THREE.Vector3(), parentQ, new THREE.Vector3());
		parentQ.invert();
	}
	const v = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const local = uniform.map((smp) => {
		v.fromArray(smp.pos).applyMatrix4(inv);
		q.fromArray(smp.quat).premultiply(parentQ);
		return { ...smp, pos: v.toArray(), quat: q.toArray() };
	});
	const raw = await storeRaw(s, seg, uniform);
	const doc = sequenceOf(s.seqId);
	if (!doc) return;
	const result = commitTake(doc, {
		camera: s.camera,
		cameraName: s.name,
		mode: seg.mode,
		itemId: seg.itemId ?? undefined,
		samples: local,
		base: s.base,
		sessionStart: s.sessionStart,
		raw,
		markers: seg.markers
	});
	if (!result) {
		showToast('That take was too short to keep');
		return;
	}
	beginSequenceGesture(s.seqId);
	setSequence(s.seqId, result.seq);
	endSequenceGesture(s.seqId);
	const last = uniform[uniform.length - 1];
	s.lastItemId = result.itemId;
	s.lastPose = { pos: last.pos.slice(), qBase: last.quat.slice(), fov: last.fov, roll: last.roll };
	s.pausedAt = result.t1;
	if (session === s) patch({ shots: get(take).shots + 1 });
}

/**
 * The segment's raw samples (smoothed + unfiltered) as a content-hashed blob on the Library's
 * HIDDEN shelf — kept for re-smoothing, never cluttering the visible library. Null when the
 * Library is not available (the take still commits; only re-smoothing loses its source).
 * @param {Session} s @param {Segment} seg @param {any[]} uniform
 */
async function storeRaw(s, seg, uniform) {
	try {
		const packed = packRaw(uniform);
		const bytes = /** @type {ArrayBuffer} */ (packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength));
		const explorer = await import('../explorer');
		const item = await explorer.addItemFromBytes(bytes, `${s.name} take ${seg.t0.toFixed(2)}s.tpraw`, null, { kind: 'data' });
		if (item?.id) explorer.setItemHidden(item.id, true);
		return item?.hash
			? { hash: item.hash, rate: 30, t0: uniform[0].t, n: uniform.length, layout: RAW_LAYOUT, budget: { pos: DEFAULT_BUDGET.pos, angDeg: DEFAULT_BUDGET.angDeg } }
			: null;
	} catch (error) {
		console.warn('film raw:', error);
		return null;
	}
}

/** @param {number[]} a @param {number[]} b @param {number} s */
function slerp(a, b, s) {
	const qa = new THREE.Quaternion().fromArray(a);
	return qa.slerp(new THREE.Quaternion().fromArray(b), s).toArray();
}

/** ◆ — a timeline marker at this moment of the take (committed with the shot). */
export function addMarker() {
	if (!segment) return false;
	const t = segment.t0 + Math.max(0, syncedNow() - segment.runAt);
	segment.markers.push(t);
	patch({ markers: segment.markers.length });
	try {
		navigator.vibrate?.(15);
	} catch {
		/* no haptics here */
	}
	return true;
}

/** Film closed: commit what was recording, forget the session. */
export function closeRecorder() {
	return finishTake();
}

/** test/debug view */
export function recorderDebug() {
	return {
		ui: get(take),
		session: session ? { ...session } : null,
		frames: segment?.frames.length ?? 0,
		segment: segment ? { mode: segment.mode, t0: segment.t0, itemId: segment.itemId } : null
	};
}
