// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { sceneRevision } from '../../stores/sceneStore';
import { syncedAnimations } from '../../stores/flowStore';
import { sessionNow } from '../sessionClock';
import {
	normalizeSprite,
	normalizeLayer2d,
	clipByName,
	clipFrameAt,
	clipEventsBetween,
	clipDuration,
	frameUv,
	frameSizePx,
	planeSize,
	snapToPixel,
	parallaxOffset
} from './spriteCore.js';

// 64-2d (D4 wave 1): HOW SPRITES AND 2D LAYERS LOOK, on every peer. A LEAF: three, two leaf
// stores, the session clock and the pure core — no history, no peers (spriteActions.js is the
// write side and owns those). Scene.svelte calls `tickSprites2d` once per frame; flowRuntime
// reaches the playback calls through a primed dynamic import, the animationPreview precedent.
//
// EVERYTHING HERE IS DERIVED from the replicated documents (userData.sprite / userData.layer2d
// and the material map), so a load, a joiner's object sync, an undo and a remote edit all
// converge through the same per-frame reconcile:
// · the SAMPLER — nearest (no mipmaps) or linear, clamped, sRGB — is put on the material map;
// · the FRAME is the map's offset/repeat (a uniform: no re-upload, and each object holds its own
//   texture instance because applyMap loads one per material);
// · the PLANE is resized to the frame's pixels / ppu (every peer derives the same size);
// · PLAYBACK is a pure function of a start stamp and the shared flow clock (golden rule 8, the
//   playanim reasoning): a Play Animation node's trigger stamp is the same on every peer, so
//   nothing about playback is ever sent. Flipbook events and a once-clip's end fire LOCALLY on
//   every peer through the Animation Marker / Animation Finished nodes.
//
// PARALLAX + PIXEL SNAP are a DRAW offset, never a pose: the object's `updateMatrixWorld` and
// `updateWorldMatrix` are wrapped so the offset lands in matrixWorld AFTER the authored matrix,
// before the children inherit it. Picking, the gizmo and children all see what is drawn, while
// toJSON / GLTF / the wire read `matrix` — the authored pose — so nothing derived leaks into a
// save (the terrain scatter holder's updateMatrixWorld precedent). The offset only applies while
// the VIEW camera is orthographic and not in XR: perspective editing and VR show the authored
// layout (flat layers in the 3D scene, F1 of the roadmap).

/** @typedef {import('./spriteCore.js').Sprite} Sprite */

/** raw userData.sprite object -> its normalized form (writers REPLACE the block, so identity works) */
/** @type {WeakMap<object, Sprite>} */
const specCache = new WeakMap();

/** @param {any} object @returns {Sprite | null} */
export function spriteSpecOf(object) {
	const raw = object?.userData?.sprite;
	if (!raw || typeof raw !== 'object') return null;
	let spec = specCache.get(raw);
	if (!spec) {
		spec = normalizeSprite(raw);
		specCache.set(raw, spec);
	}
	return spec;
}

/** @param {any} object */
export function isSprite(object) {
	return !!object?.isMesh && !!object?.userData?.sprite;
}

/** @param {any} object */
export function isLayer2d(object) {
	return !!object?.userData?.layer2d && typeof object.userData.layer2d === 'object';
}

// ---- the clock ------------------------------------------------------------------------------

/**
 * The flow runtime's clock, in seconds — `syncedNow` re-stated (that one is module-private in a
 * history-family file): seconds since UTC midnight on the SESSION clock while animations are
 * synced, else this page's own clock. A Play Animation stamp is in these units.
 */
export function spriteClock() {
	return get(syncedAnimations) ? (sessionNow() % 86400000) / 1000 : performance.now() / 1000;
}

/** elapsed seconds between two flow-clock stamps, across midnight @param {number} now @param {number} at */
function since(now, at) {
	let dt = now - at;
	if (dt < -43200) dt += 86400;
	else if (dt > 43200) dt -= 86400;
	return dt;
}

// ---- playback -------------------------------------------------------------------------------

/**
 * uuid -> what plays, when a node or the Inspector chose it. Absent = the document's own `play`
 * clip (autoplay), on the clock's origin so every peer is in phase.
 * `clip` '' = stopped on `frame`.
 * @type {Map<string, {clip: string, at: number, speed: number, frame?: number}>}
 */
const playback = new Map();
/** uuid -> the last step whose events fired, per clip+start, so each frame fires once @type {Map<string, {key: string, step: number}>} */
const eventSteps = new Map();
/** uuid -> first time this peer saw the object (a 'once' autoplay starts there) @type {Map<string, number>} */
const firstSeen = new Map();

/** Where the event hooks go (flowRuntime installs fireAnimMarker / fireAnimFinished). */
/** @type {{marker: (uuid: string, name: string) => void, finished: (uuid: string) => void}} */
let sink = { marker: () => {}, finished: () => {} };
/** @param {{marker?: any, finished?: any}} next */
export function setSpriteEventSink(next) {
	sink = { marker: next?.marker ?? (() => {}), finished: next?.finished ?? (() => {}) };
}

/** Does this object have a flipbook clip of that name? (Play Animation routes on it.) @param {any} object @param {string} name */
export function hasSpriteClip(object, name) {
	const spec = isSprite(object) ? spriteSpecOf(object) : null;
	return !!spec && !!clipByName(spec, name);
}

/** The clip an EMPTY Play Animation clip field means on a sprite: its autoplay clip, else its
 * first ('' = no clips). @param {any} object */
export function defaultSpriteClip(object) {
	const spec = isSprite(object) ? spriteSpecOf(object) : null;
	if (!spec) return '';
	return (spec.play && clipByName(spec, spec.play)?.name) || spec.clips[0]?.name || '';
}

/** The names of an object's flipbook clips (the Play Animation clip field lists them). @param {any} object */
export function spriteClipNames(object) {
	const spec = isSprite(object) ? spriteSpecOf(object) : null;
	return spec ? spec.clips.map((c) => c.name) : [];
}

/**
 * What a sprite shows NOW: the clip, its start, and whether it is running.
 * @param {any} object @param {number} now
 * @returns {{clip: import('./spriteCore.js').SpriteClip | null, at: number, speed: number, frame: number, explicit: boolean}}
 */
function resolvePlayback(object, now) {
	const spec = /** @type {Sprite} */ (spriteSpecOf(object));
	let state = playback.get(object.uuid);
	// a once-clip with a `next` hands over at its end — rolled forward here, deterministically
	// (the next clip starts at the exact moment the first one ended, on every peer)
	for (let hops = 0; state && state.clip && hops < 8; hops++) {
		const clip = clipByName(spec, state.clip);
		if (!clip || clip.loop !== 'once' || !clip.next) break;
		const end = state.at + clipDuration(clip) / state.speed;
		if (since(now, end) < 0) break;
		const next = clipByName(spec, clip.next);
		if (!next) break;
		finishOf(object.uuid, state, clip);
		state = { clip: next.name, at: end, speed: state.speed };
		playback.set(object.uuid, state);
	}
	if (state) {
		const clip = state.clip ? clipByName(spec, state.clip) : null;
		return { clip, at: state.at, speed: state.speed, frame: state.frame ?? spec.frame, explicit: true };
	}
	const auto = spec.play ? clipByName(spec, spec.play) : null;
	if (!auto) return { clip: null, at: 0, speed: 1, frame: spec.frame, explicit: false };
	// a looping autoplay is in phase with the CLOCK (every peer agrees with no stamp at all): it
	// starts on the hour — a start of 0 (midnight) would sit past the half-day wrap `since`
	// applies, and a start that moved every cycle would re-key the event walk and drop the
	// frames between the last tick and the wrap. A once autoplay plays from the moment this peer
	// first saw the sprite.
	if (!firstSeen.has(object.uuid)) firstSeen.set(object.uuid, now);
	const at = auto.loop === 'once' ? /** @type {number} */ (firstSeen.get(object.uuid)) : now - (now % 3600);
	return { clip: auto, at, speed: 1, frame: spec.frame, explicit: false };
}

/** fire the last events + the end of a once-clip that is being handed over @param {string} uuid @param {any} state @param {any} clip */
function finishOf(uuid, state, clip) {
	const key = clip.name + '@' + state.at;
	const seen = eventSteps.get(uuid);
	const from = seen?.key === key ? seen.step : -1;
	const { events, finished } = clipEventsBetween(clip, from, Number.MAX_SAFE_INTEGER);
	for (const e of events) sink.marker(uuid, e.name);
	if (finished) sink.finished(uuid);
	eventSteps.delete(uuid);
}

/**
 * Play / stop / restart / toggle a flipbook clip. LOCAL — called on EVERY peer from the same
 * replicated trigger stamp (`at`), so the sprites agree without a message. `play` keeps a clip
 * that is already running (a held key re-stamping must not restart a walk cycle every pulse);
 * `restart` always starts over; `toggle` stops a running clip and starts a stopped one.
 * @param {any} object @param {string} name @param {{action?: string, at?: number, speed?: number}} [opts]
 * @returns {boolean} handled
 */
export function playSpriteClip(object, name, opts = {}) {
	const spec = isSprite(object) ? spriteSpecOf(object) : null;
	if (!spec) return false;
	const clip = clipByName(spec, name);
	const action = opts.action ?? 'play';
	const at = Number.isFinite(opts.at) ? /** @type {number} */ (opts.at) : spriteClock();
	const speed = Number(opts.speed) > 0 ? Number(opts.speed) : 1;
	const now = spriteClock();
	const current = resolvePlayback(object, now);
	const running = !!current.clip && !clipFrameAt(current.clip, since(now, current.at) * current.speed).done;
	const same = !!clip && current.clip?.name === clip.name;
	if (action === 'stop' || (action === 'toggle' && running && (same || !clip))) {
		// hold the frame that was showing
		const showing = current.clip ? clipFrameAt(current.clip, since(now, current.at) * current.speed).frame : current.frame;
		playback.set(object.uuid, { clip: '', at, speed, frame: showing });
		return true;
	}
	if (!clip) return false;
	if (action === 'play' && same && running) return true;
	playback.set(object.uuid, { clip: clip.name, at, speed });
	return true;
}

/** Forget a node/Inspector choice: back to the document's own autoplay. @param {string} uuid */
export function resetSpritePlayback(uuid) {
	playback.delete(uuid);
	eventSteps.delete(uuid);
	firstSeen.delete(uuid);
}

/** For the Inspector + suites: what is showing. @param {any} object */
export function spriteStatus(object) {
	if (!isSprite(object)) return null;
	const now = spriteClock();
	const p = resolvePlayback(object, now);
	const at = p.clip ? clipFrameAt(p.clip, since(now, p.at) * p.speed) : null;
	return {
		clip: p.clip?.name ?? '',
		playing: !!at && !at.done,
		frame: at ? at.frame : p.frame,
		index: at ? at.index : 0,
		explicit: p.explicit
	};
}

// ---- the per-frame reconcile ------------------------------------------------------------------

/** sprite + layer objects, re-collected when the scene changes (not a traverse per frame) */
/** @type {any[]} */
let sprites = [];
/** @type {any[]} */
let layers = [];
let collectedRev = -1;
/** @type {any} */
let collectedRoot = null;

/** @param {any} root */
function collect(root) {
	const rev = get(sceneRevision);
	if (rev === collectedRev && root === collectedRoot) return;
	collectedRev = rev;
	collectedRoot = root;
	sprites = [];
	layers = [];
	root?.traverse?.((/** @type {any} */ node) => {
		if (isSprite(node)) sprites.push(node);
		if (isLayer2d(node)) layers.push(node);
	});
}

/** @param {any} map @param {Sprite} spec */
function applySampler(map, spec) {
	const nearest = spec.filter === 'nearest';
	const mag = nearest ? THREE.NearestFilter : THREE.LinearFilter;
	const min = nearest ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
	if (map.magFilter === mag && map.minFilter === min && map.generateMipmaps === !nearest && map.wrapS === THREE.ClampToEdgeWrapping && map.wrapT === THREE.ClampToEdgeWrapping) return;
	map.magFilter = mag;
	map.minFilter = min;
	map.generateMipmaps = !nearest;
	map.wrapS = THREE.ClampToEdgeWrapping;
	map.wrapT = THREE.ClampToEdgeWrapping;
	map.needsUpdate = true;
}

/** resize the plane to the frame (only when it changed) @param {any} object @param {number} w @param {number} h */
function applyPlane(object, w, h) {
	const key = w.toFixed(5) + 'x' + h.toFixed(5);
	const geo = object.geometry;
	if (geo?.userData?.sprite2d === key) return;
	// a PLAIN BufferGeometry: a PlaneGeometry would hand the Inspector editable Plane rows
	// (geometryParamsOf reads geometry.type) that fight this reconcile
	const plane = new THREE.PlaneGeometry(w, h);
	const next = new THREE.BufferGeometry().copy(plane);
	plane.dispose();
	next.userData.sprite2d = key;
	object.geometry = next;
	geo?.dispose?.();
}

/** @param {any} object @param {number} now */
function tickSprite(object, now) {
	const spec = spriteSpecOf(object);
	const material = Array.isArray(object.material) ? object.material[0] : object.material;
	if (!spec || !material) return;
	const map = material.map;
	const image = map?.image;
	const W = image?.width ?? image?.videoWidth ?? 0;
	const H = image?.height ?? image?.videoHeight ?? 0;
	const p = resolvePlayback(object, now);
	let frame = p.frame;
	if (p.clip) {
		const elapsed = since(now, p.at) * p.speed;
		const at = clipFrameAt(p.clip, elapsed);
		frame = at.frame;
		// events: every frame ENTERED since the last tick, keyed by clip + start so a restart fires
		// its first frame again
		const key = p.clip.name + '@' + p.at;
		const seen = eventSteps.get(object.uuid);
		// an AUTOPLAY seen for the first time (a load, a join, the hour turning) starts listening
		// from the frame it is on — its past frames were nobody's events
		const from = seen?.key === key ? seen.step : p.explicit ? -1 : at.step;
		if (!seen || seen.key !== key) eventSteps.set(object.uuid, { key, step: from });
		if (at.step !== from && elapsed >= 0) {
			const { events, finished } = clipEventsBetween(p.clip, from, at.step);
			eventSteps.set(object.uuid, { key, step: at.step });
			for (const e of events) sink.marker(object.uuid, e.name);
			if (finished && !p.clip.next) sink.finished(object.uuid);
		}
	}
	if (!(W > 0 && H > 0)) {
		// no image yet (or still decoding): a square of 1/ppu per pixel would be 0 — keep a 1 m quad
		if (!object.geometry?.userData?.sprite2d) applyPlane(object, 1, 1);
		return;
	}
	applySampler(map, spec);
	const uv = frameUv(spec.sheet, frame, W, H, spec);
	if (map.offset.x !== uv.offset[0] || map.offset.y !== uv.offset[1]) map.offset.set(uv.offset[0], uv.offset[1]);
	if (map.repeat.x !== uv.repeat[0] || map.repeat.y !== uv.repeat[1]) map.repeat.set(uv.repeat[0], uv.repeat[1]);
	const px = frameSizePx(spec.sheet, W, H);
	const size = planeSize(px.w, px.h, spec.ppu);
	applyPlane(object, size.width, size.height);
	// pixel art wants a hard edge, not a blended fringe that sorts badly; smooth art keeps its
	// soft edge and only drops the fully clear pixels
	const alphaTest = spec.filter === 'nearest' ? 0.5 : 0.01;
	if (material.alphaTest !== alphaTest) {
		material.alphaTest = alphaTest;
		material.needsUpdate = true;
	}
}

// ---- draw offsets: parallax + pixel snap ----------------------------------------------------

/** the camera the next frame is drawn through (Scene passes camera.current) @type {any} */
let viewCamera = null;
let inXR = false;
const _camPos = new THREE.Vector3();

/** @returns {{x: number, y: number} | null} the view camera's world xy when parallax applies */
function orthoViewXY() {
	if (inXR || !viewCamera?.isOrthographicCamera) return null;
	viewCamera.updateWorldMatrix(true, false);
	_camPos.setFromMatrixPosition(viewCamera.matrixWorld);
	return { x: _camPos.x, y: _camPos.y };
}

/** the draw offset of one object, added to its matrixWorld translation @param {any} object */
function drawAdjust(object) {
	const m = object.matrixWorld.elements;
	if (isLayer2d(object)) {
		const cam = orthoViewXY();
		if (cam) {
			const [dx, dy] = parallaxOffset(cam, normalizeLayer2d(object.userData.layer2d));
			m[12] += dx;
			m[13] += dy;
		}
	}
	const spec = isSprite(object) ? spriteSpecOf(object) : null;
	if (spec?.snap) {
		m[12] = snapToPixel(m[12], spec.ppu);
		m[13] = snapToPixel(m[13], spec.ppu);
	}
}

const WRAPPED = Symbol('sprite2dDraw');

/**
 * Wrap an object's two world-matrix methods so the draw offset is applied after its own matrix
 * and BEFORE its children read it. Idempotent; an object that stops being a sprite/layer keeps
 * the wrapper, which then adds nothing.
 * @param {any} object
 */
function wrapDraw(object) {
	if (object[WRAPPED]) return;
	object[WRAPPED] = true;
	/** @this {any} @param {boolean} [force] */
	object.updateMatrixWorld = function (force) {
		if (this.matrixAutoUpdate) this.updateMatrix();
		if (this.matrixWorldNeedsUpdate || force) {
			if (this.matrixWorldAutoUpdate === true) {
				if (this.parent === null) this.matrixWorld.copy(this.matrix);
				else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
				drawAdjust(this);
			}
			this.matrixWorldNeedsUpdate = false;
			force = true;
		}
		const children = this.children;
		for (let i = 0, l = children.length; i < l; i++) {
			const child = children[i];
			child.updateMatrixWorld(force);
		}
	};
	/** @this {any} @param {boolean} updateParents @param {boolean} updateChildren */
	object.updateWorldMatrix = function (updateParents, updateChildren) {
		const parent = this.parent;
		if (updateParents === true && parent !== null) parent.updateWorldMatrix(true, false);
		if (this.matrixAutoUpdate) this.updateMatrix();
		if (this.matrixWorldAutoUpdate === true) {
			if (this.parent === null) this.matrixWorld.copy(this.matrix);
			else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
			drawAdjust(this);
		}
		if (updateChildren === true) {
			const children = this.children;
			for (let i = 0, l = children.length; i < l; i++) children[i].updateWorldMatrix(false, true);
		}
	};
}

/**
 * THE per-frame entry (one Scene useTask line). Reconciles every sprite from its document and
 * records the view camera the parallax offsets are taken from.
 * @param {any} root objectsGroup @param {any} camera the camera this frame renders through
 * @param {any} [renderer]
 */
export function tickSprites2d(root, camera, renderer) {
	if (!root) return;
	viewCamera = camera ?? null;
	inXR = !!renderer?.xr?.isPresenting;
	collect(root);
	if (!sprites.length && !layers.length) return;
	const now = spriteClock();
	for (const object of sprites) {
		try {
			tickSprite(object, now);
		} catch (error) {
			console.warn('sprite tick failed', error);
		}
		if (spriteSpecOf(object)?.snap) wrapDraw(object);
	}
	for (const layer of layers) wrapDraw(layer);
	// forget objects that are gone (the uuid maps are tiny, a sweep on change is enough)
	if (playback.size || firstSeen.size) {
		const live = new Set(sprites.map((s) => s.uuid));
		for (const uuid of [...playback.keys()]) if (!live.has(uuid)) playback.delete(uuid);
		for (const uuid of [...firstSeen.keys()]) if (!live.has(uuid)) firstSeen.delete(uuid);
		for (const uuid of [...eventSteps.keys()]) if (!live.has(uuid)) eventSteps.delete(uuid);
	}
}

/** For suites: the live counts and the parallax camera. */
export function sprite2dDebug() {
	return {
		sprites: sprites.length,
		layers: layers.length,
		ortho: !!viewCamera?.isOrthographicCamera,
		xr: inXR,
		playing: [...playback.entries()].map(([uuid, p]) => ({ uuid, ...p }))
	};
}
