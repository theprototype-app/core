// 64-extrude (D7): ONE DRAG turns a shape or a text into a solid.
//
// While exactly one extrudable object is selected in Edit — a vector shape with a fill whose mesh
// is still its record, or a block text — an arrow stands on the top-right corner of its front face,
// pointing out of it (local +Z). Press it and drag: the depth follows the pointer along that axis,
// live, and every step is the ordinary edit (`applyGeometry` for a shape, `setTextPathFor` for a
// text) recorded inside ONE history gesture, so peers watch it grow, a release leaves ONE undo step,
// and Escape (or a drag back to where it began) leaves none. Dragging back to zero makes the shape
// flat again (a text goes back to Flat).
//
// The arrow sits on the corner, not the middle, so it never covers the transform gizmo at the
// object's origin. It is a scene-root helper sized in screen pixels; the press is taken through the
// modulePointer seam (Edit only, so no editor session or tool is holding the viewport).
// A LAZY chunk: vectorBoot.js loads it when such an object is first selected.
import * as THREE from 'three';
import { get } from 'svelte/store';
import {
	globalScene,
	globalCamera,
	globalRenderer,
	selectedObjects,
	objectsGroup,
	isVRMode,
	isLocked
} from '../../stores/sceneStore';
import { registerModulePointer } from '../modulePointer';
import { withHistoryGesture } from '../historyGesture';
import { heldByOther } from '../lockHeld';
import { applyGeometry } from '../geometryEdit';
import { setTextPathFor } from '../textPathEdit';
import { normalizeTextPath, isBlockText } from '../textPathCore.js';
import { editingObject } from '../meshEdit';
import { faceEditObject } from '../faceEdit';
import { isVectorObject, vectorEditObject, vectorTool } from './vectorGate.js';

/** the arrow's length on screen, and how near a press must land to take it (px) */
const ARROW_PX = 46;
const GRAB_PX = 11;
/** the deepest a drag goes (the record's own caps are 50 m) */
const MAX_DEPTH = 50;
const COLOR = 0xffb84f;
const COLOR_HOT = 0xffffff;

/** @type {any} */ let target = null;
/** @type {THREE.Group | null} */ let helper = null;
/** @type {null | (() => void)} */ let offPointer = null;
let rafId = 0;
let hot = false;
/**
 * the drag in flight
 * @type {null | {uuid: string, kind: 'vector' | 'text', start: number, depth: number, x0: number, y0: number, ux: number, uy: number, worldPerPx: number, perLocal: number, token: object, pending: number | null}}
 */
let drag = null;

/* ------------------------------------------------------------ eligibility ---- */

/** what kind of extrudable object this is, or null @param {any} o @returns {'vector' | 'text' | null} */
export function extrudeKindOf(o) {
	if (!o?.isMesh) return null;
	if (isVectorObject(o)) {
		const u = o.userData;
		if (u.vertexEdited || u.faceEdited || o.children?.length) return null;
		return u.geometryParams.params?.fillType === 'none' ? null : 'vector';
	}
	if (o.userData?.textPath && isBlockText(normalizeTextPath(o.userData.textPath))) return 'text';
	return null;
}

/** the current depth: 0 = flat @param {any} o @param {'vector' | 'text'} kind */
function depthOf(o, kind) {
	if (kind === 'vector') return o.userData.geometryParams.params?.depth ?? 0;
	const rec = normalizeTextPath(o.userData.textPath);
	return rec.mode === 'extruded' ? rec.depth : 0;
}

/** @type {{id: any, object: any}} */ let seen = { id: null, object: null };

/** the depth of any object (0 = flat, or not extrudable) @param {any} o */
export function depthNow(o) {
	const kind = extrudeKindOf(o);
	return kind ? depthOf(o, kind) : 0;
}

/** the one selected object the arrow is for, or null */
function wanted() {
	if (get(isVRMode) || get(isLocked) === true) return null;
	if (get(vectorEditObject) || get(vectorTool) || get(editingObject) || get(faceEditObject))
		return null;
	const list = get(selectedObjects);
	if (!Array.isArray(list) || list.length !== 1) return null;
	const id = /** @type {any} */ (list[0])?.uuid ?? list[0];
	// resolved once per selection, not per frame (a walk of the whole scene)
	if (id !== seen.id || !seen.object?.parent)
		seen = { id, object: get(objectsGroup)?.getObjectByProperty('uuid', id) ?? null };
	const o = /** @type {any} */ (seen.object);
	if (!o?.uuid || heldByOther(o.uuid)) return null;
	return extrudeKindOf(o) ? o : null;
}

/* -------------------------------------------------------------- geometry ---- */

/** the arrow's foot (local): the front face's top-right corner @param {any} o */
function anchorOf(o) {
	const g = o.geometry;
	if (!g) return new THREE.Vector3();
	if (!g.boundingBox) g.computeBoundingBox();
	const b = g.boundingBox;
	if (!b || !Number.isFinite(b.max.x)) return new THREE.Vector3();
	return new THREE.Vector3(b.max.x, b.max.y, Math.max(b.max.z, 0));
}

/** world units per screen pixel at a world point */
function worldPerPixel(/** @type {THREE.Vector3} */ at) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const h = renderer?.domElement?.clientHeight || 600;
	if (!camera) return 0.01;
	if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / h;
	const d = camera.position.distanceTo(at);
	return (2 * d * Math.tan(((camera.fov ?? 50) * Math.PI) / 360)) / h;
}

/** a world point -> client px @param {THREE.Vector3} p */
function screenOf(p) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (!camera || !renderer) return null;
	const rect = renderer.domElement.getBoundingClientRect();
	const v = p.clone().project(camera);
	if (v.z > 1) return null;
	return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
}

/** the arrow in world space: foot, unit direction, tip @param {any} o */
function arrowOf(o) {
	o.updateMatrixWorld();
	const foot = o.localToWorld(anchorOf(o));
	const ahead = o.localToWorld(anchorOf(o).add(new THREE.Vector3(0, 0, 1)));
	const dir = ahead.sub(foot);
	const perLocal = dir.length() || 1;
	dir.divideScalar(perLocal);
	const tip = foot.clone().addScaledVector(dir, ARROW_PX * worldPerPixel(foot));
	return { foot, dir, tip, perLocal };
}

/** a projected arrow shorter than this (px) is looking straight at you: the drag reads screen-up instead */
const MIN_AXIS_PX = 14;

/**
 * How a pointer move maps onto the depth, read at the press: along the arrow as the screen shows it,
 * or — when the arrow points (nearly) at the camera, which is how a shape placed facing you starts —
 * straight up the screen, at the foot's own world-per-pixel. Screen space rather than a ray-to-axis
 * closest point, which has no answer when the ray runs along the axis.
 * @param {THREE.Vector3} foot @param {THREE.Vector3} dir @returns {{ux: number, uy: number, worldPerPx: number}}
 */
export function screenAxis(foot, dir) {
	const wpp = worldPerPixel(foot);
	const len = ARROW_PX * wpp;
	const a = screenOf(foot);
	const b = screenOf(foot.clone().addScaledVector(dir, len));
	const px = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
	if (a && b && px >= MIN_AXIS_PX)
		return { ux: (b[0] - a[0]) / px, uy: (b[1] - a[1]) / px, worldPerPx: len / px };
	return { ux: 0, uy: -1, worldPerPx: wpp };
}

/** distance (px) from a point to a screen segment @param {number[]} p @param {number[]} a @param {number[]} b */
function pxToSegment(p, a, b) {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const l2 = dx * dx + dy * dy;
	const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/* ---------------------------------------------------------------- helper ---- */

function buildHelper() {
	const g = new THREE.Group();
	g.name = 'vector-extrude-handle';
	g.userData.isEditOverlay = true;
	const material = new THREE.MeshBasicMaterial({
		color: COLOR,
		depthTest: false,
		transparent: true,
		opacity: 0.95
	});
	// a unit arrow along +Y (scaled to ARROW_PX at each frame), turned onto the axis
	const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 8), material);
	stem.position.y = 0.36;
	const head = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 12), material);
	head.position.y = 0.86;
	const foot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), material);
	for (const m of [stem, head, foot]) {
		m.renderOrder = 21;
		g.add(m);
	}
	return g;
}

function disposeHelper() {
	if (!helper) return;
	/** @type {any} */ (get(globalScene))?.remove(helper);
	helper.traverse((/** @type {any} */ o) => {
		o.geometry?.dispose?.();
		o.material?.dispose?.();
	});
	helper = null;
}

/** seat the arrow on the target (every frame: the target moves, the camera moves, the depth changes) */
function placeHelper() {
	if (!target) return;
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return;
	if (!helper) {
		helper = buildHelper();
		scene.add(helper);
	}
	const { foot, dir } = arrowOf(target);
	helper.position.copy(foot);
	helper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
	helper.scale.setScalar(ARROW_PX * worldPerPixel(foot));
	const want = hot || drag ? COLOR_HOT : COLOR;
	helper.traverse((/** @type {any} */ o) => {
		if (o.material && o.material.color.getHex() !== want) o.material.color.setHex(want);
	});
}

/* --------------------------------------------------------------- pointer ---- */

/** is the press on the arrow? @param {number} cx @param {number} cy */
function onArrow(cx, cy) {
	if (!target) return false;
	const { foot, tip } = arrowOf(target);
	const a = screenOf(foot);
	const b = screenOf(tip);
	return !!a && !!b && pxToSegment([cx, cy], a, b) <= GRAB_PX;
}

/** @param {any} _hit @param {any} ctx */
function onDown(_hit, ctx) {
	const o = wanted();
	if (!o || o !== target || !onArrow(ctx.clientX, ctx.clientY)) return false;
	const kind = /** @type {'vector' | 'text'} */ (extrudeKindOf(o));
	const { foot, dir, perLocal } = arrowOf(o);
	const start = depthOf(o, kind);
	drag = {
		uuid: o.uuid,
		kind,
		start,
		depth: start,
		x0: ctx.clientX,
		y0: ctx.clientY,
		...screenAxis(foot, dir),
		perLocal,
		token: {},
		pending: null
	};
	if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown, true);
	return true;
}

/** @param {any} _hit @param {any} ctx */
function onMove(_hit, ctx) {
	if (!drag) return;
	const along = (ctx.clientX - drag.x0) * drag.ux + (ctx.clientY - drag.y0) * drag.uy;
	// a shape grows from its back face, so its front follows the pointer 1:1; a text is centred on
	// its depth, so the front moves half as far as the depth grows
	const k = drag.kind === 'text' ? 2 : 1;
	let depth = drag.start + (k * along * drag.worldPerPx) / drag.perLocal;
	depth = Math.min(MAX_DEPTH, Math.max(0, Math.round(depth * 1000) / 1000));
	drag.pending = depth;
	if (typeof requestAnimationFrame === 'undefined') flush();
}

/** apply the newest depth (once per frame) */
function flush() {
	if (!drag || drag.pending === null) return;
	const depth = drag.pending;
	drag.pending = null;
	if (depth === drag.depth) return;
	drag.depth = depth;
	setDepth(drag.uuid, drag.kind, depth, drag.token);
}

/**
 * The edit itself, inside the drag's gesture (one undo step for the whole drag).
 * @param {string} uuid @param {'vector' | 'text'} kind @param {number} depth @param {object | null} token
 */
export function setDepth(uuid, kind, depth, token = null) {
	return withHistoryGesture(token, () => {
		if (kind === 'vector') return applyGeometry(uuid, { depth });
		// a text below a millimetre is flat (its record's floor); above it, solid at that depth
		return !!setTextPathFor(uuid, depth < 0.001 ? { mode: 'flat' } : { mode: 'extruded', depth });
	});
}

function onUp() {
	if (!drag) return;
	flush();
	endDrag();
}

function endDrag() {
	drag = null;
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown, true);
}

/** Escape mid-drag: back to the depth it started at, inside the same gesture (no step left) @param {KeyboardEvent} event */
function onKeydown(event) {
	if (event.key !== 'Escape' || !drag) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	const { uuid, kind, start, token } = drag;
	endDrag();
	setDepth(uuid, kind, start, token);
}

/* ------------------------------------------------------------------ loop ---- */

function tick() {
	rafId = 0;
	const o = wanted();
	if (o !== target && !drag) {
		target = o;
		hot = false;
	}
	if (!target) {
		stop();
		return;
	}
	if (drag) flush();
	placeHelper();
	if (typeof requestAnimationFrame !== 'undefined') rafId = requestAnimationFrame(tick);
}

/** hover: light the arrow under the pointer (desktop has no pointermove seam outside a gesture) @param {PointerEvent} e */
function onHover(e) {
	if (drag || !target) return;
	hot = onArrow(e.clientX, e.clientY);
}

/** start watching the selection (vectorBoot calls this when an extrudable object is selected) */
export function watchExtrude() {
	if (!offPointer) {
		offPointer = registerModulePointer(
			{ down: onDown, move: onMove, up: onUp },
			{ modes: ['edit'] }
		);
		if (typeof window !== 'undefined')
			window.addEventListener('pointermove', onHover, { passive: true });
	}
	if (!rafId) tick();
}

function stop() {
	if (rafId && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(rafId);
	rafId = 0;
	if (drag) endDrag();
	target = null;
	hot = false;
	disposeHelper();
	offPointer?.();
	offPointer = null;
	if (typeof window !== 'undefined') window.removeEventListener('pointermove', onHover);
}

/** suites: the arrow's screen segment, the target and the drag @returns {any} */
export function extrudeDebug() {
	if (!target) return { target: null, drag: null };
	const { foot, tip, dir } = arrowOf(target);
	const axis = screenAxis(foot, dir);
	return {
		target: target.uuid,
		// the screen direction a drag reads as "deeper" (unit, px space)
		pull: [axis.ux, axis.uy],
		kind: extrudeKindOf(target),
		depth: depthOf(target, /** @type {any} */ (extrudeKindOf(target))),
		foot: screenOf(foot),
		tip: screenOf(tip),
		drag: drag ? { start: drag.start, depth: drag.depth } : null,
		helper: !!helper
	};
}
