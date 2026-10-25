// 48 S1/S2 — the sequence PLAYER: runs a sequence's tracks against the synced clock.
//
// NETCODE (golden rule 8, the deterministic model — the playanim precedent): nothing here
// sends a message. A run started by the Play Sequence node is stamped with the replicated
// TRIGGER time, so every peer runs the same sequence from the same moment and derives the
// same shots, clip starts, sounds and events by itself. Each of those is LOCAL by nature:
// a shot is this peer's view (the house rule: a graph never moves another peer's viewpoint,
// lookThroughCamera), clips start with replicate:false at the stamped moment, audio is
// scheduled on this device, and an event pulses this peer's On Sequence Event nodes
// (replicate:false, the animmarker reasoning).
//
// Two run MODES:
//   'game'    — started by the node or by autoplay; fires graph events, ends with `end`
//   'preview' — the Timeline editor's own Play/scrub; LOCAL to the author, shows the
//               shots and plays clips + audio, but fires NO graph events (a preview must
//               not drive game logic on one peer only — the flash on the marker is the
//               author's feedback instead)
//
// Autoplay: sequences flagged `autoplay` start (mode 'game') when THIS peer enters Play —
// the same moment simOnPlay uses, which is also how an exported game starts
// (exportRuntime → requestPlay). Leaving Play stops every run started inside it.

import { writable, get } from 'svelte/store';
import * as THREE from 'three';
import { sessionNow } from './sessionClock';
import { isLocked } from '../stores/sceneStore';
import { specatorMode } from '../stores/appStore';
import { sequences } from './sequences';
import {
	findSequence,
	shotAt,
	crossedStarts,
	liveItems,
	playheadAt,
	END_EVENT,
	clamp
} from './sequenceCore';
import { findCameraObject, cameraSpec } from './cameraObjects';
import {
	cameraPreview,
	startCameraPreview,
	stopCameraPreview,
	setPreviewPoseHook
} from './cameraPreview';
import * as anim from './animationPreview';
import { clipInfo, setAnimationState } from './animatedImports';
import { fireSequenceEvent } from './flowRuntime';
// 53 (A6/A5): an audio clip's caption line (the shared caption bus)
import { showCaption } from './captions';
// 77: clips, titles and transitions draw through the lazy cut runtime (lib/cut/)
import { hasCutContent } from './sequenceCore';

/** flow seconds of day — the unit trigger stamps use (flowRuntime / animationPreview) */
function syncedNow() {
	return (sessionNow() % 86400000) / 1000;
}

/**
 * @typedef {{
 *   id: string, mode: 'game'|'preview', at: number, from: number, inPlay: boolean,
 *   lastT: number, wraps: number, voices: any[], anims: Set<string>, imported: Set<string>,
 *   shot: string, done: boolean
 * }} Run
 */

/** id -> live run @type {Map<string, Run>} */
const runs = new Map();

/**
 * What the Timeline editor draws: per sequence, the playhead and whether it runs.
 * `t` of a stopped sequence is the PARKED (scrubbed) position.
 * @type {import('svelte/store').Writable<Record<string, {t: number, playing: boolean, mode: string}>>}
 */
export const seqTransport = writable({});

/** LOCAL pref: the editor's scrub/preview looks through the shots */
export const previewShots = writable(true);

/** the last fired events, newest last (tests + the editor's flash) @type {{seq: string, name: string, at: number, mode: string}[]} */
const fired = [];
/** item ids the preview crossed, with when (the editor's marker flash) */
export const seqFlash = writable(/** @type {Record<string, number>} */ ({}));

/** The run that currently owns the camera, and the view to give back afterwards. */
let cameraOwner = /** @type {string|null} */ (null);
/** undefined = we never took the camera; null = it was the player's own view */
let priorCamera = /** @type {string|null|undefined} */ (undefined);

// ---- 77: the program (what the cut overlay draws) ---------------------------------

/** the sequence the frame shows and where: a run, or the editor's scrub @type {{id: string, t: number, scrub: boolean}|null} */
let program = null;

/** 77: which sequence the cut overlay draws, at which time (null = none). */
export function programSource() {
	return program;
}

/** @type {Promise<any>|null} */
let cutLoad = null;
/** Load the cut runtime the first time a sequence needs it (clips, titles, transitions). */
function ensureCut() {
	cutLoad ??= import('./cut/cutRuntime.js')
		.then((m) => m.startCutRuntime(programSource))
		.catch((error) => {
			cutLoad = null;
			console.warn('cut runtime:', error);
		});
	return cutLoad;
}

/**
 * 77: the cut runtime's state — null until a sequence needed it (the lazy chunk never loaded).
 * `pending` = a clip frame still decoding (what an export waits on).
 */
export async function cutState() {
	if (!cutLoad) return null;
	await cutLoad;
	const m = await import('./cut/cutRuntime.js');
	return m.cutDebug();
}

/** @param {any} seq @param {number} t @param {'game'|'preview'} mode @param {boolean} scrub */
function showProgram(seq, t, mode, scrub) {
	if (!hasCutContent(seq) || (mode === 'preview' && !get(previewShots))) {
		if (program?.id === seq.id) program = null;
		return;
	}
	program = { id: seq.id, t, scrub };
	void ensureCut();
}

// ---- transport ----------------------------------------------------------------

const TRANSPORT_REST = { t: 0, playing: false, mode: 'preview' };

/** @param {string} id @param {{t?: number, playing?: boolean, mode?: string}} patch */
function setTransport(id, patch) {
	seqTransport.update((map) => ({
		...map,
		[id]: { ...TRANSPORT_REST, ...map[id], ...patch }
	}));
}

/**
 * Start a sequence.
 * @param {string} ref id (or name) of the sequence
 * @param {{at?: number, from?: number, mode?: 'game'|'preview'}} [opts] `at` = the shared
 *   moment sequence time `from` happened (the trigger stamp), flow seconds
 * @returns {boolean}
 */
export function playSequence(ref, opts = {}) {
	const seq = findSequence(get(sequences), ref);
	if (!seq) return false;
	const existing = runs.get(seq.id);
	// a restart keeps the camera: the new run has the same id, so it inherits ownership
	// and the view to give back stays the one from BEFORE the first run
	if (existing) endRun(existing, { restore: false, keepCamera: true });
	const mode = opts.mode ?? 'game';
	const from = clamp(Number(opts.from) || 0, 0, seq.duration);
	/** @type {Run} */
	const run = {
		id: seq.id,
		mode,
		at: typeof opts.at === 'number' ? opts.at : syncedNow(),
		from,
		inPlay: get(isLocked) === true,
		// "starting now": an item exactly at `from` fires (crossedStarts' prev is exclusive)
		lastT: from - 1e-6,
		wraps: 0,
		voices: [],
		anims: new Set(),
		imported: new Set(),
		shot: '',
		done: false
	};
	runs.set(seq.id, run);
	// a mid-way start brings up what is already running at `from`: clips and sounds with
	// their offset (an event in the past stays in the past)
	for (const { item } of liveItems(seq, from, 'anim')) if (item.t < from) startAnim(run, seq, item);
	for (const { item } of liveItems(seq, from, 'audio'))
		if (item.t < from) startAudio(run, seq, item);
	for (const { item } of liveItems(seq, from, 'video'))
		if (item.t < from) startClipAudio(run, seq, item);
	setTransport(seq.id, { t: from, playing: true, mode });
	tickRun(run, seq, syncedNow());
	return true;
}

/** @param {string} ref @param {{restore?: boolean}} [opts] */
export function stopSequence(ref, opts = {}) {
	const seq = findSequence(get(sequences), ref);
	const run = seq ? runs.get(seq.id) : null;
	if (!run) return false;
	endRun(run, { restore: opts.restore !== false });
	return true;
}

/** Stop every run (leaving Play, a scene load). @param {(run: Run) => boolean} [which] */
export function stopAllSequences(which) {
	for (const run of [...runs.values()]) if (!which || which(run)) endRun(run, { restore: true });
}

/**
 * The Play Sequence node's action, on its trigger stamp (every peer, same stamp).
 * @param {string} ref @param {string} action play | stop | toggle | restart @param {number} at
 */
export function runSequenceAction(ref, action, at) {
	const playing = isSequencePlaying(ref);
	if (action === 'stop' || (action === 'toggle' && playing))
		return stopSequence(ref, { restore: false });
	if (action === 'play' && playing) return false; // already running: play is idempotent
	return playSequence(ref, { at, mode: 'game' });
}

/** @param {string} ref */
export function isSequencePlaying(ref) {
	const seq = findSequence(get(sequences), ref);
	return !!(seq && runs.has(seq.id));
}

/**
 * End a run: sounds stop, the clips this run started stop where they are (a cutscene
 * cut short leaves the door where it got to — `restore` puts PREVIEWED clips back at
 * rest), and the camera goes back to whatever view this peer had before the first shot.
 * @param {Run} run @param {{restore?: boolean, keepCamera?: boolean}} opts
 */
function endRun(run, opts) {
	runs.delete(run.id);
	for (const voice of run.voices) {
		try {
			voice.stop();
		} catch {
			/* already ended */
		}
	}
	run.voices = [];
	if (!run.done) {
		for (const uuid of run.anims) {
			if (run.mode === 'preview' && opts.restore) anim.resetPreview(uuid);
			else anim.stop(uuid, { replicate: false });
		}
		for (const uuid of run.imported) setAnimationState(uuid, { playing: false }, false);
	}
	if (cameraOwner === run.id && !opts.keepCamera) releaseCamera();
	if (program?.id === run.id && !program.scrub) program = null;
	seqTransport.update((map) => {
		const cur = map[run.id];
		return cur ? { ...map, [run.id]: { ...cur, playing: false } } : map;
	});
}

// ---- the tick -----------------------------------------------------------------

/** Called every frame from Scene (beside tickAnimationPreview). */
export function tickSequences() {
	if (!runs.size) return;
	const now = syncedNow();
	const all = get(sequences);
	for (const run of [...runs.values()]) {
		const seq = all[run.id];
		if (!seq) {
			endRun(run, { restore: false }); // deleted under us (a peer, an undo)
			continue;
		}
		tickRun(run, seq, now);
	}
}

/** @param {Run} run @param {any} seq @param {number} now */
function tickRun(run, seq, now) {
	const head = playheadAt(seq, now - run.at, run.from);
	// what the playhead crossed since the last tick — split at a loop wrap into the two
	// real pieces (lastT..end and 0..t), never the empty gap (the animmarker rule)
	if (head.wraps > run.wraps) {
		crossRange(run, seq, run.lastT, seq.duration, now);
		run.wraps = head.wraps;
		run.lastT = -1e-6;
	}
	crossRange(run, seq, run.lastT, head.t, now);
	run.lastT = head.t;
	applyShot(run, seq, head.t);
	showProgram(seq, head.t, run.mode, false);
	setTransport(run.id, { t: head.t, playing: !head.done, mode: run.mode });
	if (head.done) {
		run.done = true;
		if (run.mode === 'game') fireEvent(run, seq, END_EVENT);
		endRun(run, { restore: false });
	}
}

/** @param {Run} run @param {any} seq @param {number} prev @param {number} t @param {number} now */
function crossRange(run, seq, prev, t, now) {
	for (const { item, track } of crossedStarts(seq, prev, t)) {
		if (track.kind === 'anim') startAnim(run, seq, item);
		else if (track.kind === 'audio') startAudio(run, seq, item);
		else if (track.kind === 'video') startClipAudio(run, seq, item);
		else if (track.kind === 'event') {
			if (run.mode === 'game') fireEvent(run, seq, item.name);
			seqFlash.update((map) => ({ ...map, [item.id]: now }));
		}
	}
}

/** The shared moment an item began (flow seconds), across loop wraps. @param {Run} run @param {any} seq @param {any} item */
function itemMoment(run, seq, item) {
	return run.at + (run.wraps * seq.duration + item.t - run.from);
}

/** @param {Run} run @param {any} seq @param {string} name */
function fireEvent(run, seq, name) {
	fired.push({ seq: seq.id, name, at: syncedNow(), mode: run.mode });
	if (fired.length > 50) fired.shift();
	try {
		fireSequenceEvent(seq.id, String(seq.name ?? ''), name);
	} catch (error) {
		console.warn('sequence event:', error);
	}
}

// ---- animation clips ------------------------------------------------------------

/** @param {Run} run @param {any} seq @param {any} item */
function startAnim(run, seq, item) {
	const uuid = item.target;
	if (!uuid) return;
	const clip = String(item.clip ?? '').trim();
	// an IMPORTED clip name goes to the mixer (one field drives both systems, the
	// playanim rule); the mixer has no seek, so a mid-way start begins at its top
	if (clip && clipInfo(uuid).some((c) => c.name === clip)) {
		setAnimationState(uuid, { clip, playing: true, speed: item.speed }, false);
		run.imported.add(uuid);
		return;
	}
	const clipId = clip ? anim.clipIdByName(uuid, clip) : undefined;
	// stamped at the moment the item began, so a peer (or a mid-way start) lands in phase
	anim.play(uuid, clipId ?? null, {
		at: itemMoment(run, seq, item),
		from: item.in ?? 0, // 77: a split's right half continues the clip
		speed: item.speed,
		replicate: false
	});
	run.anims.add(uuid);
}

// ---- audio --------------------------------------------------------------------

/** 77 K1: a video clip's own sound, as an audio item over its source window. @param {Run} run @param {any} seq @param {any} item */
function startClipAudio(run, seq, item) {
	if (item.media === 'image' || !item.src || !(item.gain > 0)) return;
	startAudio(run, seq, { ...item, sound: item.src, caption: undefined }, true);
}

/** @param {Run} run @param {any} seq @param {any} item @param {boolean} [quiet] a clip with no sound is not an error */
function startAudio(run, seq, item, quiet = false) {
	const moment = itemMoment(run, seq, item);
	// 53 (A6/A5): the clip's caption for the rest of its window (a caption with no sound yet is
	// still a subtitle); the player's / 53-scale's Captions switch decides whether it shows
	if (item.caption) showCaption({ text: item.caption, source: 'timeline', seconds: Math.max(1, Math.min(15, item.dur - Math.max(0, syncedNow() - moment))) });
	if (!item.sound) return;
	void Promise.all([import('./soundRuntime'), import('./audioEngine')])
		.then(async ([sr, ae]) => {
			const buffer = await sr.sampleBuffer(item.sound, { timeoutMs: 10000 });
			if (!buffer || runs.get(run.id) !== run) return;
			const now = syncedNow();
			const late = Math.max(0, now - moment);
			if (late >= item.dur) return; // its window already passed while the bytes arrived
			// 77: `in` = where the source starts (a split's right half, a trimmed clip)
			const voice = ae.sampleVoice({ buffer, offset: late + (item.in ?? 0), gain: item.gain, destination: 'sfx' });
			const startMs = sessionNow() + Math.max(0, moment - now) * 1000;
			voice.start(ae.audioTimeFor(startMs));
			// the item's length is the clip window: cut at its end like an editor would
			voice.stop(ae.audioTimeFor(sessionNow() + (moment + item.dur - now) * 1000));
			run.voices.push(voice);
		})
		.catch((error) => {
			if (!quiet) console.warn('sequence audio:', error);
		});
}

// ---- camera shots ---------------------------------------------------------------

/** @param {Run} run @param {any} seq @param {number} t */
function applyShot(run, seq, t) {
	if (run.mode === 'preview' && !get(previewShots)) {
		if (cameraOwner === run.id) releaseCamera();
		return;
	}
	const shot = shotAt(seq, t);
	shotState = shot
		? { run: run.id, item: shot.item, blend: shot.blend }
		: shotState?.run === run.id
			? null
			: shotState;
	if (!shot) {
		if (cameraOwner === run.id) releaseCamera();
		run.shot = '';
		return;
	}
	const uuid = shot.item.camera;
	if (cameraOwner === run.id && run.shot === uuid && get(cameraPreview)?.uuid === uuid) return;
	if (get(specatorMode)) return; // watching a peer: their view wins, silently
	if (!findCameraObject(uuid)) return; // a late joiner's scene may not have it yet
	if (priorCamera === undefined) priorCamera = get(cameraPreview)?.uuid ?? null;
	if (startCameraPreview(uuid)) {
		cameraOwner = run.id;
		run.shot = uuid;
	}
}

/** Give the view back: the camera this peer looked through before, or its own. */
function releaseCamera() {
	const prior = priorCamera;
	cameraOwner = null;
	priorCamera = undefined;
	shotState = null;
	if (prior && findCameraObject(prior)) {
		startCameraPreview(prior);
		const spec = cameraSpec(findCameraObject(prior));
		if (lastPosed?.isPerspectiveCamera && spec.kind !== 'orthographic') {
			lastPosed.fov = spec.fov;
			lastPosed.updateProjectionMatrix();
		}
	} else if (get(cameraPreview)) stopCameraPreview();
	lastPosed = null;
}

/** the shot being shown and how far through it @type {{run: string, item: any, blend: number}|null} */
let shotState = null;
/** the camera the hook last posed (its fov needs putting back on release) @type {any} */
let lastPosed = null;

const posA = new THREE.Vector3();
const posB = new THREE.Vector3();
const quatA = new THREE.Quaternion();
const quatB = new THREE.Quaternion();
const scl = new THREE.Vector3();

/**
 * The pose seam (cameraPreview.setPreviewPoseHook): while a shot with a `to` mark runs,
 * glide position, rotation and fov from the shot camera to the `to` camera.
 * @param {any} camera @param {string} uuid
 */
function poseHook(camera, uuid) {
	const s = shotState;
	if (!s || s.item.camera !== uuid || !s.item.to || cameraOwner !== s.run) return false;
	const a = findCameraObject(s.item.camera);
	const b = findCameraObject(s.item.to);
	if (!a || !b) return false;
	a.updateWorldMatrix(true, false);
	b.updateWorldMatrix(true, false);
	a.matrixWorld.decompose(posA, quatA, scl);
	b.matrixWorld.decompose(posB, quatB, scl);
	camera.position.copy(posA).lerp(posB, s.blend);
	camera.quaternion.copy(quatA).slerp(quatB, s.blend);
	if (camera.isPerspectiveCamera) {
		const fa = cameraSpec(a).fov;
		const fb = cameraSpec(b).kind === 'orthographic' ? fa : cameraSpec(b).fov;
		const fov = fa + (fb - fa) * s.blend;
		if (Math.abs(camera.fov - fov) > 1e-4) {
			camera.fov = fov;
			camera.updateProjectionMatrix();
		}
	}
	lastPosed = camera;
	return true;
}

// ---- editor scrub ---------------------------------------------------------------

/**
 * Park the playhead at t and SHOW that moment (the editor's scrub): the shot at t, and
 * each animation item posed at its offset. Local; no audio, no events.
 * @param {string} id @param {number} t
 */
export function scrubSequence(id, t) {
	const seq = get(sequences)[id];
	if (!seq) return;
	const run = runs.get(id);
	if (run) endRun(run, { restore: false });
	const at = clamp(t, 0, seq.duration);
	setTransport(id, { t: at, playing: false, mode: 'preview' });
	for (const { item, offset } of liveItems(seq, at, 'anim')) {
		const clip = String(item.clip ?? '').trim();
		if (!item.target || (clip && clipInfo(item.target).some((c) => c.name === clip))) continue;
		const clipId = (clip && anim.clipIdByName(item.target, clip)) || undefined;
		anim.scrub(item.target, (item.in ?? 0) + offset * item.speed, clipId);
		scrubbed.add(item.target);
	}
	if (get(previewShots)) {
		const shot = shotAt(seq, at);
		const scrubRun = /** @type {any} */ ({ id: '__scrub', mode: 'preview', shot: scrubShot });
		applyShot(scrubRun, seq, at);
		scrubShot = scrubRun.shot;
		if (!shot && cameraOwner === '__scrub') releaseCamera();
	}
	showProgram(seq, at, 'preview', true);
}

/** the camera the scrub is looking through */
let scrubShot = '';
/** objects a scrub posed — put back at rest when the editor lets go @type {Set<string>} */
const scrubbed = new Set();

/** The editor closed / the author pressed Stop on a parked playhead: undo the look. */
export function releaseScrub() {
	for (const uuid of scrubbed) anim.resetPreview(uuid);
	scrubbed.clear();
	if (cameraOwner === '__scrub') releaseCamera();
	scrubShot = '';
	if (program?.scrub) program = null;
}

// ---- autoplay + lifecycle -------------------------------------------------------

/** @type {(() => void)[]} */
let disposers = [];

/** Install: the camera pose seam, autoplay on entering Play, cleanup on leaving it. Idempotent. */
export function startSequencePlayer() {
	if (disposers.length) return;
	disposers.push(setPreviewPoseHook(poseHook));
	let was = get(isLocked) === true;
	disposers.push(
		isLocked.subscribe((v) => {
			const playing = v === true;
			if (playing === was) return;
			was = playing;
			if (playing) {
				releaseScrub();
				stopAllSequences((run) => run.mode === 'preview');
				const at = syncedNow();
				for (const seq of Object.values(get(sequences)))
					if (seq?.autoplay) playSequence(seq.id, { at, mode: 'game' });
			} else stopAllSequences((run) => run.inPlay);
		})
	);
	// a scene load replaces the sequences: a run whose sequence vanished ends in the tick,
	// one whose sequence was replaced by a same-id load keeps going on the new document
}

/** Test seam. */
export function stopSequencePlayer() {
	stopAllSequences();
	for (const d of disposers) d();
	disposers = [];
}

/** test/debug view */
export function sequencePlayerDebug() {
	return {
		runs: [...runs.values()].map((r) => ({
			id: r.id,
			mode: r.mode,
			at: r.at,
			from: r.from,
			t: r.lastT,
			inPlay: r.inPlay,
			shot: r.shot,
			voices: r.voices.length,
			anims: [...r.anims]
		})),
		cameraOwner,
		priorCamera: priorCamera ?? null,
		preview: get(cameraPreview)?.uuid ?? null,
		blend: shotState?.blend ?? null,
		program,
		cutLoaded: !!cutLoad,
		fired: fired.slice()
	};
}
