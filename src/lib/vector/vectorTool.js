// 64 D1: the DRAW TOOL — drag out a rectangle / ellipse / star / polygon, or place bezier points
// with the pen. Input rides the modulePointer seam (registerModulePointer, Edit mode): while a
// tool is armed every primary press in the viewport is OURS (orbit and select stand down), and
// disarming unregisters, so nothing in Scene.svelte knows this tool exists.
//
// The WORK PLANE is chosen by the first press: the surface under it (its face normal), else the
// ground. The shape's local +Z is that normal and its +X the camera's right laid onto the plane,
// so a shape drawn on a wall reads upright and one drawn on the floor reads like a map. Points
// are 2D in that frame; the finished object is placed at the frame and carries only its record.
//
// Rect / ellipse: press = one corner, release = the other (Shift = square, Alt = from the
// centre). Star / polygon: press = centre, distance = radius. A press that does not travel
// drops the default size centred on it. Pen: click = corner point, click-drag = smooth point
// (the drag pulls its out-handle, the in-handle mirrors), clicking the first point closes the
// path (it fills), Enter / a double click / Finish ends an open one, Backspace removes the last
// point, Esc drops the draft (a second Esc disarms). Each finished shape is ONE create entry.
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera, globalRenderer } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { registerModulePointer } from '../modulePointer';
import { registerKeySessionProbe, comboOf, bindingOf } from '../shortcuts';
import { viewportHasKeys } from '../keyScope';
import { deselectObject } from '../objectActions';
import { drawMode, toggleDrawMode } from '../drawMode';
import { node, moveHandle, centreSubpaths } from './vectorPath.js';
import { cleanVector, vectorDefaults } from './vectorRecord.js';
import { buildVectorGeometry, vectorMaterial } from './vectorMesh.js';
import { addVectorShape } from './vectorActions.js';
import { snapCandidates, snapInPlane, showSnapGuides, clearSnapGuides } from './vectorSnap.js';
import { layerAbove, normalOf } from './vectorArrange.js';
import { isVectorObject } from './vectorGate.js';

// the armed tool lives in the boot gate (Tools ▸ Draw shapes reads it before this chunk loads)
import { vectorTool } from './vectorGate.js';
export { vectorTool };
/** LOCAL: the style the next shape is drawn with */
export const vectorStyle = writable({ fill: '#4f8cff', stroke: '#1d2433', strokeWidth: 0, penWidth: 0.03 });
/** the pen draft as the toolbar reads it */
export const penDraft = writable({ count: 0 });

export const VECTOR_TOOLS = ['rect', 'ellipse', 'star', 'polygon', 'pen'];
/** a press that travels less than this (px) is a click */
const CLICK_PX = 4;
/** how close (px) a press must land to the first pen point to close the path */
const CLOSE_PX = 10;
/** 64-vector-edit row 4: a finger is bigger than a cursor (the 103 touch rules: 44 px targets) */
const TOUCH_CLOSE_PX = 22;
/** a finger that travels less than this (px) tapped */
const TOUCH_SLOP = 10;
/** a finger press in flight: where it would place, and the point it placed once it dragged
 * @type {null | {at: number[], x: number, y: number, placed: number, fresh: boolean}} */
let touchPress = null;
/** shapes sit this far off the surface they were drawn on (no z-fight) */
const SURFACE_LIFT = 0.004;

/** @type {null | (() => void)} */ let offPointer = null;
/** @type {null | {origin: THREE.Vector3, quat: THREE.Quaternion, plane: THREE.Plane, layer?: number}} */ let frame = null;
/** a parametric drag in flight @type {null | {start: number[], x: number, y: number, at: number[]}} */ let drag = null;
/** @type {null | {nodes: import('./vectorPath.js').VNode[], dragging: number, x: number, y: number, lastDown: number}} */ let pen = null;
/** @type {THREE.Mesh | null} */ let preview = null;
/** @type {THREE.Points | null} */ let previewDots = null;

registerKeySessionProbe(() => get(vectorTool) !== null);

/* --------------------------------------------------------------- arming ---- */

/** 64-vector-edit (64-2d's flat view, tools2d.js): presses draw on the plane z = lockedZ (facing +Z), never
 * on the floor behind it; null = the surface under the press, as ever @type {number | null} */
let lockedZ = null;

/** arm a tool (the same one again disarms) @param {string} kind
 * @param {{planeZ?: number}} [opts] planeZ: draw on the XY plane at that z (the 2D view's active layer) */
export function armVectorTool(kind, opts = {}) {
	if (!VECTOR_TOOLS.includes(kind)) return false;
	if (get(vectorTool) === kind) {
		disarmVectorTool();
		return false;
	}
	cancelDraft();
	lockedZ = Number.isFinite(opts.planeZ) ? Number(opts.planeZ) : null;
	if (get(drawMode)) toggleDrawMode();
	deselectObject();
	vectorTool.set(/** @type {any} */ (kind));
	if (!offPointer) offPointer = registerModulePointer({ down: onDown, move: onMove, up: onUp, cancel: onCancel }, { modes: ['edit'] });
	if (typeof window !== 'undefined') window.addEventListener('keydown', onKeydown, true);
	return true;
}

export function disarmVectorTool() {
	cancelDraft();
	offPointer?.();
	offPointer = null;
	if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown, true);
	vectorTool.set(null);
	lockedZ = null;
}

/** drop whatever is half-drawn (the tool stays armed) */
export function cancelDraft() {
	touchPress = null;
	drag = null;
	pen = null;
	frame = null;
	snapCand = null;
	clearSnapGuides();
	penDraft.set({ count: 0 });
	clearPreview();
}

/* ---------------------------------------------------------------- frames ---- */

/** the surface under the ray (point + world normal), else the ground @param {THREE.Raycaster} ray */
function surfaceUnder(ray) {
	const group = get(objectsGroup);
	if (lockedZ !== null) {
		const n = new THREE.Vector3(0, 0, 1);
		// a flat shape ON the plane under the press: draw on it (it stacks one layer up, frameFor)
		for (const h of group ? ray.intersectObject(group, true) : []) {
			if (!h.object?.visible || !(/** @type {any} */ (h.object).isMesh)) continue;
			if (isVectorObject(h.object) && Math.abs(normalOf(h.object).dot(n)) > 1 - 1e-3 && Math.abs(h.point.z - lockedZ) < 0.05)
				return { point: h.point.clone(), normal: n, object: /** @type {any} */ (h.object) };
			break;
		}
		const point = ray.ray.intersectPlane(new THREE.Plane(n, -lockedZ), new THREE.Vector3());
		if (point) return { point, normal: n, object: null };
	}
	if (group) {
		for (const h of ray.intersectObject(group, true)) {
			if (!h.object?.visible || !(/** @type {any} */ (h.object).isMesh)) continue;
			const normal = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
			// face the viewer: a double-sided shape's back face reports the far normal
			if (normal.dot(ray.ray.direction) > 0) normal.negate();
			return { point: h.point.clone(), normal, object: /** @type {any} */ (h.object) };
		}
	}
	const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	const point = new THREE.Vector3();
	if (ray.ray.intersectPlane(ground, point)) return { point, normal: new THREE.Vector3(0, 1, 0), object: null };
	// looking at the sky: a plane facing the camera, 4 m out
	const n = ray.ray.direction.clone().negate();
	return { point: ray.ray.at(4, new THREE.Vector3()), normal: n, object: null };
}

/** the drawing frame for a press @param {THREE.Raycaster} ray */
export function frameFor(ray) {
	const hit = surfaceUnder(ray);
	let { point, normal } = hit;
	let lift = SURFACE_LIFT;
	/** @type {any} */ let onShape = null;
	// 64-vector-edit row 3: a press on the FRONT of a flat shape draws on that shape's own plane, one
	// layer above everything on it (a stable order, never a 4 mm stack of planes that z-fight)
	if (isVectorObject(hit.object) && !(hit.object.userData.geometryParams.params?.depth > 0)) {
		const z = normalOf(hit.object);
		if (z.dot(normal) > 1 - 1e-3) {
			const base = hit.object.getWorldPosition(new THREE.Vector3()).dot(z);
			point = point.clone().addScaledVector(z, base - point.dot(z));
			normal = z;
			lift = 0;
			onShape = hit.object;
		}
	}
	/** @type {any} */
	const camera = get(globalCamera);
	const right = new THREE.Vector3(1, 0, 0);
	if (camera) right.setFromMatrixColumn(camera.matrixWorld, 0);
	// lay the camera's right onto the plane; looking straight down a normal, any right will do
	right.addScaledVector(normal, -right.dot(normal));
	if (right.lengthSq() < 1e-8) right.set(1, 0, 0).addScaledVector(normal, -normal.x);
	right.normalize();
	const up = new THREE.Vector3().crossVectors(normal, right).normalize();
	const basis = new THREE.Matrix4().makeBasis(right, up, normal);
	const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
	const origin = point.clone().addScaledVector(normal, lift);
	return { origin, quat, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), layer: onShape ? layerAbove(onShape, origin) : 0 };
}

/** a ray onto the frame's plane, in frame coordinates @param {THREE.Raycaster} ray @returns {number[] | null} */
function toFrame(ray) {
	if (!frame) return null;
	const p = ray.ray.intersectPlane(frame.plane, new THREE.Vector3());
	if (!p) return null;
	p.sub(frame.origin).applyQuaternion(frame.quat.clone().invert());
	return [p.x, p.y];
}

/** frame point -> screen px @param {number} x @param {number} y */
function screenOf(x, y) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (!camera || !renderer || !frame) return null;
	const rect = renderer.domElement.getBoundingClientRect();
	const v = new THREE.Vector3(x, y, 0).applyQuaternion(frame.quat).add(frame.origin).project(camera);
	return [rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height];
}

/* ------------------------------------------------------------- snapping ---- */

/** @type {import('./vectorSnap.js').Candidates | null} what this draft snaps to (gathered once per frame) */
let snapCand = null;

/** the frame as a world matrix (its z = 0 is the drawing plane) */
function frameMatrix() {
	return frame ? new THREE.Matrix4().compose(frame.origin, frame.quat, new THREE.Vector3(1, 1, 1)) : new THREE.Matrix4();
}

/** 64-vector-edit row 2: snap a frame point (grid / points / edges / guides — the scene's own
 * settings, vectorSnap.js); the pen's own points join the candidates so a path lines up with itself
 * @param {number[]} at @returns {number[]} */
function snapFrame(at) {
	if (!frame) return at;
	const m = frameMatrix();
	snapCand ??= snapCandidates(m);
	const own = pen ? pen.nodes.map((n) => [n.x, n.y]) : [];
	const cand = own.length ? { ...snapCand, points: [...snapCand.points, ...own], guidePoints: [...snapCand.guidePoints, ...own] } : snapCand;
	const r = snapInPlane(m, at, cand);
	showSnapGuides(m, r);
	return r.at;
}

/** a fresh frame: its origin (the press point) snaps too, so a shape starts on the grid
 * @param {THREE.Raycaster} ray */
function startFrame(ray) {
	frame = frameFor(ray);
	snapCand = null;
	const o = snapFrame([0, 0]);
	if (o[0] || o[1]) {
		frame.origin.add(new THREE.Vector3(o[0], o[1], 0).applyQuaternion(frame.quat));
		frame.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quat), frame.origin);
	}
}

/* -------------------------------------------------------------- pointer ---- */

/** @param {any} _hit @param {any} ctx */
function onDown(_hit, ctx) {
	const tool = get(vectorTool);
	if (!tool) return false;
	if (tool === 'pen') return penDown(ctx);
	startFrame(ctx.ray);
	drag = { start: [ctx.clientX, ctx.clientY], x: 0, y: 0, at: [0, 0] };
	return true;
}

/** @param {any} _hit @param {any} ctx */
function onMove(_hit, ctx) {
	const tool = get(vectorTool);
	if (tool === 'pen') return penMove(ctx);
	if (!drag) return;
	const raw = toFrame(ctx.ray);
	if (!raw) return;
	if (Math.hypot(ctx.clientX - drag.start[0], ctx.clientY - drag.start[1]) < CLICK_PX) return;
	const at = snapFrame(raw);
	drag.at = at;
	const shaped = dragShape(/** @type {string} */ (tool), at, { square: !!ctx.shiftKey || shiftHeld, centre: !!ctx.altKey || altHeld });
	showPreview(shaped.params, shaped.cx, shaped.cy);
}

/** @param {any} _hit @param {any} ctx */
function onUp(_hit, ctx) {
	const tool = get(vectorTool);
	clearSnapGuides();
	if (tool === 'pen') {
		if (touchPress) return touchUp(ctx);
		if (pen) pen.dragging = -1;
		return;
	}
	if (!drag || !frame) return;
	const moved = Math.hypot(ctx.clientX - drag.start[0], ctx.clientY - drag.start[1]) >= CLICK_PX;
	const end = toFrame(ctx.ray);
	const at = end && moved ? snapFrame(end) : drag.at;
	const shaped = moved ? dragShape(/** @type {string} */ (tool), at, { square: shiftHeld, centre: altHeld }) : { params: styled(/** @type {string} */ (tool)), cx: 0, cy: 0 };
	place(shaped.params, shaped.cx, shaped.cy);
	drag = null;
	frame = null;
	clearPreview();
}

/** the record (+ centre offset in the frame) a drag to `at` describes
 * @param {string} kind @param {number[]} at @param {{square?: boolean, centre?: boolean}} mods */
export function dragShape(kind, at, mods = {}) {
	const [u, v] = at;
	if (kind === 'star' || kind === 'polygon') {
		return { params: { ...styled(kind), radius: Math.max(0.02, Math.hypot(u, v)) }, cx: 0, cy: 0 };
	}
	let w = Math.abs(u);
	let h = Math.abs(v);
	if (mods.square) w = h = Math.max(w, h);
	const su = u < 0 ? -1 : 1;
	const sv = v < 0 ? -1 : 1;
	if (mods.centre) return { params: { ...styled(kind), width: Math.max(0.02, w * 2), height: Math.max(0.02, h * 2) }, cx: 0, cy: 0 };
	return { params: { ...styled(kind), width: Math.max(0.02, w), height: Math.max(0.02, h) }, cx: (su * w) / 2, cy: (sv * h) / 2 };
}

/** the defaults of a kind in the toolbar's style @param {string} kind */
function styled(kind) {
	const s = get(vectorStyle);
	return { ...vectorDefaults(kind), fill: s.fill, stroke: s.stroke, strokeWidth: kind === 'path' ? s.penWidth : s.strokeWidth };
}

/** create the object at frame point (cx, cy) @param {Record<string, any>} params @param {number} cx @param {number} cy */
function place(params, cx, cy) {
	const group = get(objectsGroup);
	if (!group || !frame) return null;
	group.updateMatrixWorld(true);
	const world = new THREE.Vector3(cx, cy, 0).applyQuaternion(frame.quat).add(frame.origin);
	const position = group.worldToLocal(world.clone());
	const groupQuat = group.getWorldQuaternion(new THREE.Quaternion());
	const quaternion = groupQuat.invert().multiply(frame.quat);
	return addVectorShape(frame.layer ? { ...params, layer: frame.layer } : params, { position, quaternion, select: false });
}

/* ------------------------------------------------------------------ pen ---- */

/** 64-vector-edit row 4: a second finger landed — the camera takes the pinch, and whatever the first
 * finger began goes: the point it placed, the shape it was dragging out, a draft it started */
function onCancel() {
	clearSnapGuides();
	if (touchPress && pen) {
		if (touchPress.placed >= 0) pen.nodes.splice(touchPress.placed, 1);
		const fresh = touchPress.fresh;
		touchPress = null;
		pen.dragging = -1;
		if (fresh && !pen.nodes.length) cancelDraft();
		else {
			penDraft.set({ count: pen.nodes.length });
			showPenPreview();
		}
		return;
	}
	if (drag) {
		drag = null;
		frame = null;
		clearPreview();
	}
}

/** a finger on the pen: nothing is placed until it lifts (a tap = a corner) or travels (a drag = a smooth
 * point whose handle follows the finger), so a pinch's first finger never leaves a point behind @param {any} ctx */
function touchDown(ctx) {
	const fresh = !pen || !frame;
	if (fresh) {
		pen = { nodes: [], dragging: -1, x: ctx.clientX, y: ctx.clientY, lastDown: pen?.lastDown ?? 0 };
		startFrame(ctx.ray);
	}
	const raw = toFrame(ctx.ray);
	if (!raw) {
		if (fresh) cancelDraft();
		return true;
	}
	touchPress = { at: snapFrame(raw), x: ctx.clientX, y: ctx.clientY, placed: -1, fresh };
	return true;
}

/** @param {any} ctx */
function touchMove(ctx) {
	if (!touchPress || !pen) return;
	if (touchPress.placed < 0) {
		if (Math.hypot(ctx.clientX - touchPress.x, ctx.clientY - touchPress.y) < TOUCH_SLOP) return;
		pen.nodes.push(node(touchPress.at[0], touchPress.at[1]));
		touchPress.placed = pen.nodes.length - 1;
		pen.dragging = touchPress.placed;
		pen.x = touchPress.x;
		pen.y = touchPress.y;
		penDraft.set({ count: pen.nodes.length });
		clearSnapGuides();
	}
	penMove(ctx);
}

/** a finger lifted: a drag already placed its point; a tap closes on the first point, finishes on a
 * double tap of the last, else places a corner @param {any} ctx */
function touchUp(ctx) {
	const press = touchPress;
	touchPress = null;
	if (!press || !pen) return;
	pen.dragging = -1;
	if (press.placed >= 0) return;
	const now = performance.now();
	const near = (/** @type {any} */ n) => {
		const s = n ? screenOf(n.x, n.y) : null;
		return !!s && Math.hypot(s[0] - ctx.clientX, s[1] - ctx.clientY) < TOUCH_CLOSE_PX;
	};
	const first = pen.nodes[0];
	const last = pen.nodes[pen.nodes.length - 1];
	if (first && pen.nodes.length >= 2 && near(first)) {
		finishPen(true);
		return;
	}
	if (last && now - pen.lastDown < 400 && near(last)) {
		finishPen(false);
		return;
	}
	pen.lastDown = now;
	pen.nodes.push(node(press.at[0], press.at[1]));
	penDraft.set({ count: pen.nodes.length });
	showPenPreview();
}

/** @param {any} ctx */
function penDown(ctx) {
	if (ctx.pointerType === 'touch') return touchDown(ctx);
	if (!pen || !frame) {
		pen = { nodes: [], dragging: -1, x: ctx.clientX, y: ctx.clientY, lastDown: 0 };
		startFrame(ctx.ray);
	}
	const raw = toFrame(ctx.ray);
	if (!raw) return true;
	const now = performance.now();
	const last = pen.nodes[pen.nodes.length - 1];
	// a double click: the second press lands on the point the first one made -> finish
	if (last && now - pen.lastDown < 350) {
		const s = screenOf(last.x, last.y);
		if (s && Math.hypot(s[0] - ctx.clientX, s[1] - ctx.clientY) < CLOSE_PX) {
			finishPen(false);
			return true;
		}
	}
	pen.lastDown = now;
	const first = pen.nodes[0];
	if (first && pen.nodes.length >= 2) {
		const s = screenOf(first.x, first.y);
		if (s && Math.hypot(s[0] - ctx.clientX, s[1] - ctx.clientY) < CLOSE_PX) {
			finishPen(true);
			return true;
		}
	}
	const at = snapFrame(raw);
	pen.nodes.push(node(at[0], at[1]));
	pen.dragging = pen.nodes.length - 1;
	pen.x = ctx.clientX;
	pen.y = ctx.clientY;
	penDraft.set({ count: pen.nodes.length });
	showPenPreview();
	return true;
}

/** @param {any} ctx */
function penMove(ctx) {
	if (touchPress && touchPress.placed < 0) return touchMove(ctx);
	if (!pen || pen.dragging < 0) return;
	if (Math.hypot(ctx.clientX - pen.x, ctx.clientY - pen.y) < CLICK_PX) return;
	const at = toFrame(ctx.ray);
	if (!at) return;
	const sub = moveHandle({ closed: false, nodes: pen.nodes }, pen.dragging, 'out', at, { mirror: true });
	pen.nodes = sub.nodes;
	showPenPreview();
}

/** add a pen point programmatically (suites, VR) in frame coordinates
 * @param {number} x @param {number} y @param {number[]} [out] the out-handle offset (a smooth point) */
export function penAddPoint(x, y, out) {
	if (!pen || !frame) return false;
	const n = node(x, y);
	if (out && (out[0] || out[1])) Object.assign(n, { ox: out[0], oy: out[1], ix: -out[0], iy: -out[1], smooth: true });
	pen.nodes.push(n);
	penDraft.set({ count: pen.nodes.length });
	showPenPreview();
	return true;
}

/** remove the last pen point */
export function undoPenPoint() {
	if (!pen) return;
	pen.nodes.pop();
	penDraft.set({ count: pen.nodes.length });
	if (!pen.nodes.length) cancelDraft();
	else showPenPreview();
}

/** finish the pen path: closed = it fills @param {boolean} closed */
export function finishPen(closed = false) {
	if (!pen || !frame) return null;
	const nodes = pen.nodes;
	if (nodes.length < 2) {
		if (nodes.length) showToast('A path needs at least two points');
		cancelDraft();
		return null;
	}
	const s = get(vectorStyle);
	const { subpaths, cx, cy } = centreSubpaths([{ closed: closed && nodes.length >= 3, nodes }]);
	const params = {
		...vectorDefaults('path'),
		paths: subpaths,
		fill: s.fill,
		stroke: s.stroke,
		fillType: subpaths[0].closed ? 'solid' : 'none',
		strokeWidth: subpaths[0].closed ? s.strokeWidth || s.penWidth : s.penWidth || 0.03
	};
	const made = place(params, cx, cy);
	cancelDraft();
	return made;
}

/* -------------------------------------------------------------- preview ---- */

function clearPreview() {
	const scene = /** @type {any} */ (get(globalScene));
	for (const o of [preview, previewDots]) {
		if (!o) continue;
		scene?.remove(o);
		o.geometry.dispose();
		/** @type {any} */ (o.material).dispose();
	}
	preview = null;
	previewDots = null;
}

/** @param {Record<string, any>} params @param {number} cx @param {number} cy */
function showPreview(params, cx, cy) {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene || !frame) return;
	if (!preview) {
		const material = vectorMaterial();
		material.transparent = true;
		material.opacity = 0.75;
		preview = new THREE.Mesh(new THREE.BufferGeometry(), material);
		preview.name = 'vector-preview';
		preview.renderOrder = 10;
		scene.add(preview);
	}
	preview.geometry.dispose();
	preview.geometry = buildVectorGeometry(cleanVector(params));
	preview.quaternion.copy(frame.quat);
	preview.position.copy(new THREE.Vector3(cx, cy, 0).applyQuaternion(frame.quat).add(frame.origin));
}

function showPenPreview() {
	if (!pen || !frame) return;
	const s = get(vectorStyle);
	showPreview({ ...vectorDefaults('path'), paths: [{ closed: false, nodes: pen.nodes }], fillType: 'none', stroke: s.stroke, strokeWidth: s.penWidth || 0.03 }, 0, 0);
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return;
	if (!previewDots) {
		previewDots = new THREE.Points(
			new THREE.BufferGeometry(),
			new THREE.PointsMaterial({ color: 0xffffff, size: 8, sizeAttenuation: false, depthTest: false })
		);
		previewDots.name = 'vector-preview-points';
		previewDots.renderOrder = 11;
		scene.add(previewDots);
	}
	const pos = pen.nodes.flatMap((n) => [n.x, n.y, 0]);
	previewDots.geometry.dispose();
	previewDots.geometry = new THREE.BufferGeometry();
	previewDots.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	previewDots.quaternion.copy(frame.quat);
	previewDots.position.copy(frame.origin);
}

/* ----------------------------------------------------------------- keys ---- */

let shiftHeld = false;
let altHeld = false;

/** capture phase while armed: our keys never reach the shortcut registry (Backspace would
 * delete the selection) @param {KeyboardEvent} event */
function onKeydown(event) {
	shiftHeld = event.shiftKey;
	altHeld = event.altKey;
	if (!get(vectorTool) || !viewportHasKeys(event)) return;
	const target = /** @type {any} */ (event.target);
	if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
	let handled = true;
	if (event.key === 'Escape') {
		if (pen || drag) cancelDraft();
		else disarmVectorTool();
	} else if (pen && comboOf(event) === bindingOf('vector.pen-finish')) finishPen(false);
	else if (pen && comboOf(event) === bindingOf('vector.pen-undo')) undoPenPoint();
	else handled = false;
	if (handled) {
		event.preventDefault();
		event.stopImmediatePropagation();
	}
}
if (typeof window !== 'undefined') {
	const track = (/** @type {KeyboardEvent} */ e) => {
		shiftHeld = e.shiftKey;
		altHeld = e.altKey;
	};
	window.addEventListener('keydown', track, true);
	window.addEventListener('keyup', track, true);
}

/** suites: the tool's state */
export function vectorToolDebug() {
	return {
		tool: get(vectorTool),
		armed: !!offPointer,
		pen: pen ? pen.nodes.map((n) => ({ ...n })) : null,
		// 64-vector-edit: where each pen point is on screen now (suites aim taps at them)
		screen: pen ? pen.nodes.map((n) => screenOf(n.x, n.y)) : null,
		preview: !!preview,
		frame: frame ? { origin: frame.origin.toArray(), quat: frame.quat.toArray() } : null
	};
}

/** 64-vector-edit row 5 (VR): move the draft's frame — the work plane the grip carries; the points ride
 * along (they live in the frame) @param {number[]} origin @param {number[]} quat */
export function setPenFrame(origin, quat) {
	if (!frame) return false;
	frame.origin.fromArray(origin);
	frame.quat.fromArray(quat);
	frame.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(frame.quat), frame.origin);
	snapCand = null;
	if (pen) showPenPreview();
	return true;
}

/** 64-vector-edit row 5 (VR): pull a pen point's out-handle to frame (x, y), the in-handle mirrored —
 * the trigger held and dragged @param {number} index @param {number} x @param {number} y */
export function penHandleTo(index, x, y) {
	if (!pen?.nodes[index]) return false;
	pen.nodes = moveHandle({ closed: false, nodes: pen.nodes }, index, 'out', [x, y], { mirror: true }).nodes;
	showPenPreview();
	return true;
}

/** a frame point snapped the way a press would snap it (VR) @param {number[]} at */
export function penSnap(at) {
	return snapFrame(at);
}

/** suites + VR: start a pen draft on an explicit frame (world origin + quaternion)
 * @param {number[]} origin @param {number[]} quat */
export function beginPenAt(origin, quat) {
	const o = new THREE.Vector3().fromArray(origin);
	const q = new THREE.Quaternion().fromArray(quat);
	const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
	frame = { origin: o, quat: q, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, o) };
	snapCand = null;
	pen = { nodes: [], dragging: -1, x: 0, y: 0, lastDown: 0 };
	penDraft.set({ count: 0 });
}
