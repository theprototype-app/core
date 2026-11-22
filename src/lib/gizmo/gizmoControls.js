// 103 H7 — THE FACE DRIVER for the app's one transform gizmo. The gizmo itself is three's own
// TransformControls instance in `$TControls` (GizmoControls.svelte makes it), so every rule that hangs
// on it (Scene's undo entry per drag, the move broadcast, snapping, the multi-select pivot, the mesh-edit
// proxies, the PiP hand-over, the cinematic hide) keeps working unchanged: same properties, same events,
// same drag maths. Style A is that gizmo untouched, and costs the boot nothing.
//
// What this adds is a FACE: the handles you see and hit. Styles B / C / D ($lib/gizmo/faces.js, lazy)
// draw their own handles and answer hits analytically in SCREEN pixels (>= 44 px on touch), so the
// visuals can stay slim. A hit names a (mode, axis) pair and the drag then runs through three's own
// pointerMove — the mode is switched for the length of the drag only (all in one = a ring drag rotates
// while the tool is Move), BEFORE `dragging` flips, because the mesh tools read the mode when the drag
// starts. A face may also own a drag outright (D's one-sided resize), raising the same events three would.
//
// LAZY: faces.js imports this, and `installFaceDriver` puts the methods on the one instance the first
// time a face is made (three's pointer listeners call `this.pointerHover` / `this.pointerDown` …
// dynamically, so instance methods take over with no new listener). A boot with style A never loads it.
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { get } from 'svelte/store';
import { gizmoHide } from './gizmoHide.js';

const base = /** @type {any} */ (TransformControls.prototype);

/** targets whose tools restrict the gizmo (one axis set, one mode): they keep three's own face */
function plainTarget(/** @type {any} */ object) {
	const ud = object?.userData;
	return !!object && !ud?.isScatterProxy && !ud?.isSplineProxy && !ud?.isLodLevelProxy;
}

/** the face-driving methods, called with the gizmo as `this` @type {Record<string, (this: any, ...args: any[]) => any>} */
const driver = {
	/** is a face drawing for the current target? (else three's own gizmo, style A) */
	faceActive() {
		return !!this._face && plainTarget(this.object) && this._face.accepts(this.object);
	},

	/** swap the face (null = three's own). The old one is disposed. @param {any} face */
	setFace(face) {
		if (face === this._face) return;
		if (this._face) {
			/** @type {any} */ (this)._root.remove(this._face.root);
			this._face.dispose();
		}
		this._face = face;
		this.hiddenKinds = new Set(get(gizmoHide)[face?.style] ?? []);
		if (face) /** @type {any} */ (this)._root.add(face.root);
		this._hit = null;
		this.axis = null;
		this.syncFace();
	},

	/** show three's gizmo or the face, whichever is in force for this target */
	syncFace() {
		const on = this.faceActive();
		/** @type {any} */ (this)._gizmo.visible = !on;
		if (this._face) this._face.root.visible = on;
		this.dispatchEvent({ type: 'change' });
	},

	/** @param {any} object */
	attach(object) {
		base.attach.call(this, object);
		this._face?.attached?.(object, this);
		this.syncFace();
		return this;
	},

	detach() {
		base.detach.call(this);
		this._hit = null;
		if (this._face) this._face.root.visible = false;
		return this;
	},

	/** @param {any} pointer */
	pointerHover(pointer) {
		if (!this.faceActive()) return base.pointerHover.call(this, pointer);
		if (this.object === undefined || this.dragging === true) return;
		const ray = this.getRaycaster();
		if (pointer !== null) ray.setFromCamera(pointer, this.camera);
		/** @type {any} */ (this)._root.updateMatrixWorld(true);
		const hit = this._face.pick(ray.ray, this);
		this._hit = hit;
		// the plane three drags on is chosen from (mode, axis): hover alone keeps the tool's mode
		this.axis = hit ? hit.axis : null;
	},

	/** @param {any} pointer */
	pointerDown(pointer) {
		if (!this.faceActive() || this.object === undefined || this.dragging === true) return base.pointerDown.call(this, pointer);
		if (pointer != null && pointer.button !== 0) return;
		const hit = this._hit;
		if (!hit) return;
		this._down = { x: pointer?.x ?? 0, y: pointer?.y ?? 0, t: performance.now(), hit };
		let mode = hit.mode;
		let axis = hit.axis;
		// B's centre knob: resize evenly, or move freely with Shift held
		if (hit.shiftMode && this.shiftKey) {
			mode = hit.shiftMode;
			axis = hit.shiftAxis ?? axis;
		}
		if (mode !== this.mode) {
			this._toolMode = this.mode;
			this.mode = /** @type {any} */ (mode);
		}
		this.axis = axis;
		if (hit.own && this._face.begin) {
			const ray = this.getRaycaster();
			if (pointer !== null) ray.setFromCamera(pointer, this.camera);
			this.object.updateMatrixWorld();
			this._own = this._face.begin(hit, ray.ray, this) ? hit : null;
			if (this._own) {
				this.dragging = true;
				this.dispatchEvent({ type: 'mouseDown', mode: this.mode });
				return;
			}
		}
		base.pointerDown.call(this, pointer);
	},

	/** @param {any} pointer */
	pointerMove(pointer) {
		if (this._own) {
			if (pointer !== null && pointer.button !== -1) return;
			const ray = this.getRaycaster();
			if (pointer !== null) ray.setFromCamera(pointer, this.camera);
			if (this._face.drag(ray.ray, this)) {
				this.dispatchEvent({ type: 'change' });
				this.dispatchEvent({ type: 'objectChange' });
			}
			return;
		}
		base.pointerMove.call(this, pointer);
	},

	/** @param {any} pointer */
	pointerUp(pointer) {
		if (pointer !== null && pointer.button !== 0) return;
		const down = this._down;
		this._down = null;
		// a still, short press on a handle that has a tap meaning (the puck's disc): put back the
		// pixel it may have slid, then let the face answer — the drag records nothing
		const el = this.domElement;
		const px = el ? Math.hypot(((pointer?.x ?? 0) - (down?.x ?? 0)) * el.clientWidth, ((pointer?.y ?? 0) - (down?.y ?? 0)) * el.clientHeight) / 2 : 99;
		const tap = !!down?.hit?.tap && this.dragging && px < 8 && performance.now() - down.t < 450;
		if (tap && !this._own) this.reset();
		if (this._own) {
			this._face.end?.(this);
			this._own = null;
			if (this.dragging) this.dispatchEvent({ type: 'mouseUp', mode: this.mode });
			this.dragging = false;
			this.axis = null;
		} else base.pointerUp.call(this, pointer);
		if (this._toolMode) {
			this.mode = /** @type {any} */ (this._toolMode);
			this._toolMode = null;
		}
		if (tap) this._face?.tap?.(down.hit, this);
		this._face?.dragEnded?.(this);
	},

	dispose() {
		this.setFace(null);
		base.dispose.call(this);
	}
};

/**
 * Make three's gizmo face-capable (once). Fields with their defaults; the methods above as
 * instance methods; the pointer kind and Shift read off each pointer event.
 * @param {any} tc a TransformControls
 */
export function installFaceDriver(tc) {
	if (tc.__faceDriver) return tc;
	tc.__faceDriver = true;
	tc.gizmoStyle ??= 'A';
	tc.handleSet ??= 'tool';
	tc._face = null;
	tc._hit = null;
	tc._toolMode = null;
	tc._own = null;
	tc._down = null;
	tc.pointerKind = 'mouse';
	tc.shiftKey = false;
	tc.faceColors ??= { x: 0xf0625a, y: 0x74c655, z: 0x5b97f5, hover: 0xffd166, neutral: 0xe8e4d8 };
	tc.hiddenKinds ??= new Set();
	for (const [name, fn] of Object.entries(driver)) tc[name] = fn;
	// Settings ▸ Show: the kinds switched off for the face in force
	gizmoHide.subscribe((all) => {
		tc.hiddenKinds = new Set(all[tc._face?.style] ?? []);
		tc.syncFace();
	});
	const getPointer = tc._getPointer;
	tc._getPointer = (/** @type {PointerEvent} */ e) => {
		tc.shiftKey = !!e?.shiftKey;
		if (e?.pointerType) tc.pointerKind = e.pointerType === 'touch' ? 'touch' : 'mouse';
		return getPointer.call(tc, e);
	};
	return tc;
}
