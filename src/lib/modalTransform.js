// 103 H4 — MOVE / ROTATE / RESIZE NOW: Blender's G / R / S in the viewport, on the ONE gesture engine
// ($lib/modalGrab). Loaded lazily by the three shortcut rows (no key by default; the Blender preset
// binds G / R / Alt+S), so none of this is on the boot path.
//
// The rules, each from the brief:
//  * the selection follows the pointer AT ONCE (no button held); a left click or Enter keeps it,
//    Escape or a right click puts it back — exactly once, through createGesture's commit-or-revert
//  * X / Y / Z toggle a lock each (bindingOf the transform.lock-* rows): one = that axis, two = that
//    plane, none = the view plane (rotate: the view axis; resize: uniform)
//  * Shift = fine (a tenth of the pointer's travel from the moment it is held), Ctrl = snap the way
//    the gizmo does (inverts the snapping switch, in the snapping steps)
//  * a typed number sets the amount (`G X 2 Enter`): metres, degrees, or a factor
//  * ONE undo step (transformSet, the multi-pivot drag's kind) and the wire sends what a gizmo drag
//    sends — `move` per member, live at <= 10/s and once more at the end — so no new message exists
//  * a small line on screen says the mode, the locks and the value; it sits at the TOP so it can never
//    cover the touch bars (row 6)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, selectedObjects, globalCamera, globalRenderer, TControls, lockedObjects, isLocked, isVRMode, pokeScene } from '../stores/sceneStore';
import { peers, showToast, anyModalOpen } from '../stores/appStore';
import { createGesture } from './modalGrab';
import { recordTransformSet } from './history';
import { suspendAnimation, resumeAnimation } from './flowRuntime';
import { withWireBatch } from './wireBatch';
import { snapEnabled, snapSettings } from './snapping';
import { hasOrigin, originWorld } from './objectOrigin';
import { canEditObject } from './objectPermissions';
import { captureAutoKey, playheadOf } from './animationPreview';
import { reseatPivot } from './multiTransform';
import { bindingOf, comboOf } from './shortcuts';
import { pointerAt } from './pointerAt';

/** @typedef {'translate'|'rotate'|'scale'} Mode */

const MODE_WORD = { translate: 'Move', rotate: 'Rotate', scale: 'Resize' };
const NOW_ROW = { translate: 'transform.now-move', rotate: 'transform.now-rotate', scale: 'transform.now-scale' };
const AXES = ['x', 'y', 'z'];
const LIVE_MS = 100;

/** state of the one running gesture (module-level: there is only ever one) */
const st = {
	/** @type {Mode} */ mode: 'translate',
	/** @type {Set<string>} */ locks: new Set(),
	typed: '',
	shift: false,
	ctrl: false,
	/** effective pointer (Shift scales the travel) */ eff: new THREE.Vector2(),
	lastRaw: new THREE.Vector2(),
	origin: new THREE.Vector2(),
	angle: 0,
	lastAngle: 0,
	value: 0,
	lastSend: 0,
	/** @type {THREE.Quaternion} */ basis: new THREE.Quaternion(),
	local: false,
	pivot: new THREE.Vector3(),
	/** @type {HTMLElement|null} */ line: null
};

const gesture = createGesture({
	snapshot: () => {
		const group = get(objectsGroup);
		/** @type {any[]} */
		const locks = get(lockedObjects) || [];
		/** @type {any} */
		const peer = get(peers);
		const me = peer?.peer?.id ?? peer?.id ?? null;
		const members = get(selectedObjects)
			.map((uuid) => group?.getObjectByProperty('uuid', uuid))
			.filter((o) => o && o.parent && canEditObject(o) && !locks.some((l) => l[1] === o.uuid && l[0] !== me));
		// a child of another member moves with its parent already
		const set = new Set(members);
		const roots = members.filter((o) => {
			for (let p = o.parent; p; p = p.parent) if (set.has(p)) return false;
			return true;
		});
		return roots.map((object) => {
			object.updateMatrixWorld(true);
			return {
				object,
				startWorld: object.matrixWorld.clone(),
				before: { pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() }
			};
		});
	},
	start: (ctx) => {
		const members = ctx.snapshot;
		// the pivot: one object turns about its own origin, a set about its centre
		st.pivot.set(0, 0, 0);
		if (members.length === 1 && hasOrigin(members[0].object)) originWorld(members[0].object, st.pivot);
		else {
			for (const m of members) st.pivot.add(new THREE.Vector3().setFromMatrixPosition(m.startWorld));
			st.pivot.divideScalar(members.length);
		}
		// the gizmo's space decides the lock axes: Local + one object = that object's own axes
		/** @type {any} */
		const controls = get(TControls);
		st.local = controls?.space === 'local' && members.length === 1;
		st.basis.identity();
		if (st.local) members[0].object.getWorldQuaternion(st.basis);
		for (const m of members) {
			suspendAnimation(m.object.uuid);
			void import('./physics').then((p) => p.holdBody(m.object.uuid));
		}
		st.origin.set(ctx.origin.x, ctx.origin.y);
		st.eff.copy(st.origin);
		st.lastRaw.copy(st.origin);
		st.angle = 0;
		st.lastAngle = screenAngle(st.origin);
		st.lastSend = 0;
		showLine();
	},
	apply: (ctx) => {
		const raw = new THREE.Vector2(ctx.origin.x + ctx.dx, ctx.origin.y + ctx.dy);
		if (ctx.event) {
			st.shift = !!ctx.event.shiftKey;
			st.ctrl = !!(ctx.event.ctrlKey || ctx.event.metaKey);
		}
		const step = raw.clone().sub(st.lastRaw).multiplyScalar(st.shift ? 0.1 : 1);
		st.eff.add(step);
		st.lastRaw.copy(raw);
		if (st.mode === 'rotate') {
			const a = screenAngle(st.eff);
			let d = a - st.lastAngle;
			if (d > Math.PI) d -= 2 * Math.PI;
			if (d < -Math.PI) d += 2 * Math.PI;
			st.angle += d;
			st.lastAngle = a;
		}
		applyNow(ctx.snapshot);
	},
	revert: (ctx) => {
		for (const m of ctx.snapshot) {
			m.object.position.fromArray(m.before.pos);
			m.object.rotation.fromArray(m.before.rot);
			m.object.scale.fromArray(m.before.scale);
			m.object.updateMatrixWorld(true);
		}
		sendMoves(ctx.snapshot);
	},
	end: (ctx, kept) => {
		hideLine();
		/** @type {any[]} */
		const set = [];
		for (const m of ctx.snapshot) {
			resumeAnimation(m.object.uuid);
			void import('./physics').then((p) => p.releaseBody(m.object.uuid));
			const after = { pos: m.object.position.toArray(), rot: m.object.rotation.toArray(), scale: m.object.scale.toArray() };
			if (kept && JSON.stringify(after) !== JSON.stringify(m.before)) set.push({ uuid: m.object.uuid, before: m.before, after });
		}
		if (kept) {
			sendMoves(ctx.snapshot);
			if (set.length) recordTransformSet(set);
			for (const entry of set) captureAutoKey(entry.uuid, playheadOf(entry.uuid));
		}
		if (get(selectedObjects).length > 1) reseatPivot();
		pokeScene();
	},
	key: (ctx, e) => onKey(ctx, e),
	rightCancels: true
});

/**
 * Start the gesture (the shortcut rows' action). A second press of a Move / Rotate / Resize now key
 * while one runs switches the mode, handled in `onKey`.
 * @param {Mode} mode @returns {boolean} did it start
 */
export function startModalTransform(mode) {
	if (gesture.active()) return false;
	if (get(isLocked) || get(isVRMode) || get(anyModalOpen)) return false;
	if (!get(globalCamera) || !get(globalRenderer)) return false;
	if (!get(selectedObjects).length) {
		showToast('Select something to ' + MODE_WORD[mode].toLowerCase() + ' first.');
		return false;
	}
	st.mode = mode;
	st.locks = new Set();
	st.typed = '';
	st.shift = false;
	st.ctrl = false;
	// a key has no coordinates: start from where the pointer last was over the viewport (else the
	// viewport's centre — the first move then carries the selection from there)
	const rect = canvasRect();
	const at = pointerAt() ?? [rect.left + rect.width / 2, rect.top + rect.height / 2];
	return gesture.begin(/** @type {any} */ ({ clientX: at[0], clientY: at[1] }), { modal: true });
}

/** for tests and the debug hook */
export function modalTransformState() {
	return { active: gesture.active(), mode: st.mode, locks: [...st.locks].sort(), typed: st.typed, value: st.value, local: st.local };
}

/** @param {import('./modalGrab').GestureContext} ctx @param {KeyboardEvent} e */
function onKey(ctx, e) {
	const down = e.type === 'keydown';
	if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
		if (e.key === 'Shift') st.shift = down;
		else st.ctrl = down;
		gesture.refresh();
		return true;
	}
	if (!down) return false;
	if (e.key === 'Enter' || e.key === 'Escape') return false; // the engine's
	const combo = comboOf(e);
	// an axis lock (rebindable; the Blender preset binds X / Y / Z)
	for (const axis of AXES) {
		const bound = bindingOf('transform.lock-' + axis);
		if (bound && combo === bound) {
			if (st.locks.has(axis)) st.locks.delete(axis);
			else st.locks.add(axis);
			gesture.refresh();
			return true;
		}
	}
	// another start-at-once key switches the mode in place (G then R)
	for (const mode of /** @type {Mode[]} */ (['translate', 'rotate', 'scale'])) {
		const bound = bindingOf(NOW_ROW[mode]);
		if (bound && combo === bound) {
			if (mode !== st.mode) switchMode(ctx, mode);
			return true;
		}
	}
	// a typed number
	if (/^[0-9]$/.test(e.key) || e.key === '.' || e.key === ',') {
		const ch = e.key === ',' ? '.' : e.key;
		if (ch === '.' && st.typed.includes('.')) return true;
		st.typed += ch;
		gesture.refresh();
		return true;
	}
	if (e.key === '-') {
		st.typed = st.typed.startsWith('-') ? st.typed.slice(1) : '-' + st.typed;
		gesture.refresh();
		return true;
	}
	if (e.key === 'Backspace') {
		st.typed = st.typed.slice(0, -1);
		gesture.refresh();
		return true;
	}
	// undo / redo / save mid-gesture would act on a half-applied pose: hold them
	if (e.ctrlKey || e.metaKey) return true;
	return false;
}

/** @param {import('./modalGrab').GestureContext} ctx @param {Mode} mode */
function switchMode(ctx, mode) {
	// back to the snapshot, then the new mode measures from where the pointer is NOW
	for (const m of ctx.snapshot) {
		m.object.position.fromArray(m.before.pos);
		m.object.rotation.fromArray(m.before.rot);
		m.object.scale.fromArray(m.before.scale);
		m.object.updateMatrixWorld(true);
	}
	st.mode = mode;
	st.typed = '';
	st.origin.copy(st.eff);
	st.angle = 0;
	st.lastAngle = screenAngle(st.eff);
	gesture.refresh();
}

/* ---------------------------------------------------------------- the maths -- */

function canvasRect() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	return renderer?.domElement?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
}

/** client px -> a world ray @param {THREE.Vector2} p */
function rayAt(p) {
	const rect = canvasRect();
	const ndc = new THREE.Vector2(((p.x - rect.left) / rect.width) * 2 - 1, -((p.y - rect.top) / rect.height) * 2 + 1);
	const ray = new THREE.Raycaster();
	ray.setFromCamera(ndc, /** @type {any} */ (get(globalCamera)));
	return ray.ray;
}

/** where the pivot sits on screen, client px */
function pivotScreen() {
	const rect = canvasRect();
	const v = st.pivot.clone().project(/** @type {any} */ (get(globalCamera)));
	return new THREE.Vector2(rect.left + ((v.x + 1) / 2) * rect.width, rect.top + ((1 - v.y) / 2) * rect.height);
}

/** @param {THREE.Vector2} p */
function screenAngle(p) {
	const c = pivotScreen();
	return Math.atan2(p.y - c.y, p.x - c.x);
}

function viewDir() {
	return /** @type {any} */ (get(globalCamera)).getWorldDirection(new THREE.Vector3());
}

/** a lock's world direction @param {string} axis */
function axisDir(axis) {
	const v = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
	return v.applyQuaternion(st.basis);
}

/** @param {THREE.Vector3} normal @param {THREE.Vector2} p @returns {THREE.Vector3|null} */
function hitPlane(normal, p) {
	const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, st.pivot);
	return rayAt(p).intersectPlane(plane, new THREE.Vector3());
}

/** the world translation the pointer asks for @returns {THREE.Vector3} */
function translation() {
	const locks = [...st.locks];
	const typed = parseTyped();
	if (typed !== null) {
		const d = new THREE.Vector3();
		for (const a of locks.length && locks.length < 3 ? locks : ['x']) d.addScaledVector(axisDir(a), typed);
		return d;
	}
	const view = viewDir();
	/** @param {THREE.Vector3} n */
	const planeDelta = (n) => {
		const a = hitPlane(n, st.origin);
		const b = hitPlane(n, st.eff);
		return a && b ? b.sub(a) : new THREE.Vector3();
	};
	let d;
	if (locks.length === 1) {
		const a = axisDir(locks[0]);
		// the plane that holds the axis and faces the camera best
		const n = a.clone().cross(view.clone().cross(a));
		d = n.lengthSq() < 1e-8 ? new THREE.Vector3() : a.clone().multiplyScalar(planeDelta(n.normalize()).dot(a));
	} else if (locks.length === 2) {
		const free = AXES.find((x) => !st.locks.has(x)) ?? 'y';
		const n = axisDir(free);
		// an edge-on plane would fling the selection to infinity: use the view plane, flattened
		d = Math.abs(n.dot(view)) < 0.08 ? planeDelta(view.clone().negate()).projectOnPlane(n) : planeDelta(n);
	} else d = planeDelta(view.clone().negate());
	if (snapping()) {
		const stepSize = Number(get(snapSettings)?.translate) || 0;
		if (stepSize > 0) {
			// snap along the lock axes (or the basis axes for a free move)
			const inv = st.basis.clone().invert();
			const localD = d.clone().applyQuaternion(inv);
			localD.set(snap(localD.x, stepSize), snap(localD.y, stepSize), snap(localD.z, stepSize));
			d = localD.applyQuaternion(st.basis);
		}
	}
	return d;
}

/** the rotation axis + angle the pointer asks for @returns {{axis: THREE.Vector3, angle: number}} */
function rotation() {
	const locks = [...st.locks];
	const view = viewDir();
	let axis;
	if (locks.length === 1) axis = axisDir(locks[0]);
	else if (locks.length === 2) axis = axisDir(AXES.find((x) => !st.locks.has(x)) ?? 'y');
	else axis = view.clone();
	let angle;
	const typed = parseTyped();
	if (typed !== null) angle = THREE.MathUtils.degToRad(typed);
	else {
		const facing = axis.dot(view);
		// an axis across the view has no screen circle to follow: sideways travel turns it instead
		angle = Math.abs(facing) < 0.2 ? (st.eff.x - st.origin.x) * 0.01 : st.angle * Math.sign(facing);
	}
	if (snapping()) {
		const stepDeg = Number(get(snapSettings)?.rotateDeg) || 0;
		if (stepDeg > 0) angle = THREE.MathUtils.degToRad(snap(THREE.MathUtils.radToDeg(angle), stepDeg));
	}
	return { axis: axis.normalize(), angle };
}

/** the resize factor the pointer asks for */
function factor() {
	const typed = parseTyped();
	let f;
	if (typed !== null) f = typed;
	else {
		const c = pivotScreen();
		const from = Math.max(10, st.origin.distanceTo(c));
		f = st.eff.distanceTo(c) / from;
	}
	if (snapping()) {
		const stepSize = Number(get(snapSettings)?.scale) || 0;
		if (stepSize > 0) f = Math.max(stepSize, snap(f, stepSize));
	}
	return f;
}

/** @param {number} v @param {number} s */
function snap(v, s) {
	return Math.round(v / s) * s;
}

/** Ctrl inverts the snapping switch — the gizmo snaps when it is on */
function snapping() {
	return !!get(snapEnabled) !== st.ctrl;
}

/** @returns {number|null} */
function parseTyped() {
	if (!st.typed || st.typed === '-' || st.typed === '.' || st.typed === '-.') return null;
	const v = Number(st.typed);
	return Number.isFinite(v) ? v : null;
}

const tmpM = new THREE.Matrix4();
const tmpInv = new THREE.Matrix4();
const tmpW = new THREE.Matrix4();

/** write every member's pose from its snapshot @param {any[]} members */
function applyNow(members) {
	if (st.mode === 'scale') applyScale(members);
	else {
		if (st.mode === 'translate') {
			const d = translation();
			st.value = st.locks.size === 1 ? d.dot(axisDir([...st.locks][0])) : d.length();
			tmpM.makeTranslation(d.x, d.y, d.z);
		} else {
			const { axis, angle } = rotation();
			st.value = THREE.MathUtils.radToDeg(angle);
			const p = st.pivot;
			tmpM.makeTranslation(p.x, p.y, p.z)
				.multiply(new THREE.Matrix4().makeRotationAxis(axis, angle))
				.multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
		}
		for (const m of members) {
			tmpW.multiplyMatrices(tmpM, m.startWorld);
			m.object.parent.updateMatrixWorld(true);
			tmpInv.copy(m.object.parent.matrixWorld).invert();
			tmpW.premultiply(tmpInv);
			tmpW.decompose(m.object.position, m.object.quaternion, m.object.scale);
		}
	}
	updateLine();
	liveSend(members);
	pokeScene();
}

/**
 * Resize: a non-uniform WORLD scale of a rotated object is a shear, which a transform cannot hold —
 * so the scale goes onto each member's own axes (the gizmo's rule) and the positions spread along
 * the lock axes about the pivot. @param {any[]} members
 */
function applyScale(members) {
	const f = factor();
	st.value = f;
	const locks = st.locks.size && st.locks.size < 3 ? st.locks : null;
	const inv = st.basis.clone().invert();
	for (const m of members) {
		const startPos = new THREE.Vector3();
		const startQuat = new THREE.Quaternion();
		const startScale = new THREE.Vector3();
		m.startWorld.decompose(startPos, startQuat, startScale);
		// position: the offset from the pivot, scaled along the locked basis axes
		const off = startPos.clone().sub(st.pivot).applyQuaternion(inv);
		if (!locks) off.multiplyScalar(f);
		else for (const a of locks) off[/** @type {'x'|'y'|'z'} */ (a)] *= f;
		const worldPos = off.applyQuaternion(st.basis).add(st.pivot);
		// scale: each of the member's local axes takes the factor of the basis axis it lies along
		const scale = new THREE.Vector3().fromArray(m.before.scale);
		if (!locks) scale.multiplyScalar(f);
		else {
			for (let i = 0; i < 3; i++) {
				const local = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0).applyQuaternion(startQuat);
				let best = 'x';
				let bestDot = -1;
				for (const a of AXES) {
					const dot = Math.abs(local.dot(axisDir(a)));
					if (dot > bestDot) (bestDot = dot), (best = a);
				}
				if (locks.has(best)) scale.setComponent(i, scale.getComponent(i) * f);
			}
		}
		m.object.parent.updateMatrixWorld(true);
		m.object.position.copy(m.object.parent.worldToLocal(worldPos));
		m.object.rotation.fromArray(m.before.rot);
		m.object.scale.copy(scale);
		m.object.updateMatrixWorld(true);
	}
}

/** @param {any[]} members */
function liveSend(members) {
	const now = Date.now();
	if (now - st.lastSend < LIVE_MS) return;
	st.lastSend = now;
	sendMoves(members);
}

/** the gizmo drag's own message, per member, as one batch @param {any[]} members */
function sendMoves(members) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	withWireBatch(() => {
		for (const m of members)
			peer.send({
				type: 'move',
				uuid: m.object.uuid,
				pos: m.object.position.toArray(),
				rot: m.object.rotation.toArray(),
				scale: m.object.scale.toArray()
			});
	});
}

/* ------------------------------------------------------------ the on-screen line -- */

function showLine() {
	if (typeof document === 'undefined') return;
	if (!st.line) {
		const el = document.createElement('div');
		el.id = 'modal-transform-line';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		el.style.cssText =
			'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:var(--z-hud);pointer-events:none;' +
			'padding:4px 10px;border-radius:6px;font:12px/1.4 var(--font-mono, ui-monospace, monospace);white-space:nowrap;' +
			'background:var(--surface-deep);color:var(--text);border:1px solid var(--border-strong)';
		st.line = el;
	}
	document.body.appendChild(st.line);
	updateLine();
}

function updateLine() {
	if (!st.line) return;
	const locks = st.locks.size && st.locks.size < 3 ? [...st.locks].sort().join('').toUpperCase() : st.mode === 'rotate' ? 'view axis' : st.mode === 'scale' ? 'uniform' : 'view plane';
	const unit = st.mode === 'translate' ? ' m' : st.mode === 'rotate' ? '°' : '×';
	const shown = st.typed ? st.typed + unit + ' (typed)' : st.value.toFixed(st.mode === 'rotate' ? 1 : 3) + unit;
	const extras = [st.local ? 'local' : '', st.shift ? 'fine' : '', snapping() ? 'snap' : ''].filter(Boolean).join(', ');
	st.line.dataset.mode = st.mode;
	st.line.dataset.locks = [...st.locks].sort().join('');
	st.line.textContent =
		MODE_WORD[st.mode] + ' · ' + locks + ' · ' + shown + (extras ? ' · ' + extras : '') + '   Enter / click keeps · Esc / right-click cancels';
}

function hideLine() {
	st.line?.remove();
}
