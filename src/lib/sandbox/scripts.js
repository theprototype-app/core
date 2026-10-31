// 69 T1 — SCRIPT NODES IN THE GUEST. scriptRuntime keeps everything it owned (the lint, the loop
// guard, the per-node time budget, the badge); what changed is WHERE the compiled function lives:
// here it is compiled and called inside the sandbox guest (engine.js), and this module is the host
// half that marshals the same arguments the function always got.
//
// `object` is the one argument that was a LIVE THREE.Object3D, and a live object is the way out of
// any sandbox (its parent chain, its material's image, its constructor). The guest gets a VIEW
// instead — uuid, name, type, position, rotation, scale, quaternion, visible, plus `material` and
// `userData` fetched only when the script touches them — with three-alike maths classes, and the
// methods scripts use (lookAt, rotateX/Y/Z, translateX/Y/Z, getWorldPosition). After the call the
// guest diffs the view against what it was handed and the host applies ONLY the changed fields,
// each through an allowlist with type checks. Calls stay synchronous, so a script still sees the
// pose the animations before it in the chain produced, in the same frame.

import { newGuest } from './engine.js';
import { GUEST_MATH } from './guestMath.js';

/** userData keys a script may not write (prototype keys; everything else is the scene author's) */
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** a userData value larger than this (JSON chars) is not handed to the guest */
const USERDATA_VALUE_CAP = 20000;
const ORDERS = new Set(['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY']);

/** @type {import('./engine.js').Guest | null} */
let guest = null;
/** the object a running effect script is looking at @type {any} */
let current = null;
/** the api of the running script (flowRuntime.scriptApi) @type {any} */
let currentApi = null;

const finite = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);

/** @param {any} material */
function materialView(material) {
	if (!material || Array.isArray(material)) return null;
	/** @type {Record<string, any>} */
	const view = {};
	if (material.color?.isColor) view.color = [material.color.r, material.color.g, material.color.b];
	if (material.emissive?.isColor) view.emissive = [material.emissive.r, material.emissive.g, material.emissive.b];
	for (const key of ['opacity', 'emissiveIntensity', 'roughness', 'metalness'])
		if (finite(material[key])) view[key] = material[key];
	for (const key of ['transparent', 'wireframe', 'visible']) if (typeof material[key] === 'boolean') view[key] = material[key];
	return view;
}

/** @param {any} userData */
function userDataView(userData) {
	/** @type {Record<string, any>} */
	const out = {};
	if (!userData || typeof userData !== 'object') return out;
	for (const key of Object.keys(userData)) {
		if (BLOCKED_KEYS.has(key)) continue;
		try {
			const json = JSON.stringify(userData[key]);
			if (json !== undefined && json.length <= USERDATA_VALUE_CAP) out[key] = JSON.parse(json);
		} catch {
			// a cycle / a BigInt: not script data
		}
	}
	return out;
}

const ops = {
	ud: () => (current ? userDataView(current.userData) : null),
	mat: () => (current ? materialView(current.material) : null),
	/** @param {string} name @param {any[]} args */
	api: (name, args) => {
		if (!currentApi) throw new Error('api is not available in this script');
		const fn = currentApi[String(name)];
		if (typeof fn !== 'function') throw new TypeError('api.' + name + ' is not a function');
		return fn(...(Array.isArray(args) ? args : []));
	}
};

/** the scripts guest (null while the engine loads) */
function scriptGuest() {
	if (guest && !guest.disposed) return guest;
	guest = newGuest(ops, [GUEST_MATH, SCRIPT_PRELUDE]);
	sent.clear();
	return guest;
}

/** Is the guest ready (starts the load when it is not)? */
export function scriptSandboxReady() {
	return !!scriptGuest();
}

/**
 * Compile `body` (already linted + loop-guarded) under `key` for one of scriptRuntime's shapes.
 * Returns '' on success, the compile error's text otherwise, or null while the engine loads.
 * @param {string} key @param {string} shape @param {string} body
 */
export function compileInGuest(key, shape, body) {
	const g = scriptGuest();
	if (!g) return null;
	return String(g.callEntry('__compile', key, shape, body) ?? '');
}

/** drop every compiled function (scriptRuntime's cache was cleared) */
export function forgetCompiled() {
	sent.clear();
	if (guest && !guest.disposed) guest.callEntry('__forgetAll');
}

const ORDER_LIST = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];

/** the per-call numbers __fx reads (see its comment for the layout) @param {any} object @param {number} time */
function numbersOf(object, time) {
	const p = object.position, r = object.rotation, s = object.scale, q = object.quaternion;
	let wp = p;
	if (object.getWorldPosition && object.parent) {
		const v = p.clone();
		object.getWorldPosition(v);
		wp = v;
	}
	return [p.x, p.y, p.z, r.x, r.y, r.z, Math.max(0, ORDER_LIST.indexOf(r.order)), s.x, s.y, s.z, q.x, q.y, q.z, q.w, object.visible ? 1 : 0, wp.x, wp.y, wp.z, time].join(',');
}

/** what each slot last sent the guest, so an unchanged base / data / name travels as '' */
const sent = new Map();
/** @param {string} slot @param {string} json */
function changedOrEmpty(slot, json) {
	if (sent.get(slot) === json) return '';
	if (sent.size > 8192) sent.clear();
	sent.set(slot, json);
	return json;
}

/** a transform patch `mask,values…` back into applyObjectPatch's shape @param {string} text */
function transformFromText(text) {
	/** @type {Record<string, any>} */
	const p = {};
	if (!text) return p;
	const n = text.split(',').map(Number);
	const mask = n[0];
	let i = 1;
	if (mask & 1) p.p = [n[i++], n[i++], n[i++]];
	if (mask & 2) {
		p.r = [n[i++], n[i++], n[i++], ORDER_LIST[n[i++]]];
	}
	if (mask & 4) p.q = [n[i++], n[i++], n[i++], n[i++]];
	if (mask & 8) p.s = [n[i++], n[i++], n[i++]];
	if (mask & 16) p.v = n[i++] === 1;
	return p;
}

/** @param {any} target @param {any} arr @param {string[]} keys */
function setComponents(target, arr, keys) {
	if (!Array.isArray(arr)) return false;
	let changed = false;
	keys.forEach((k, i) => {
		if (finite(arr[i]) && target[k] !== arr[i]) {
			target[k] = arr[i];
			changed = true;
		}
	});
	return changed;
}

/** apply a guest patch to the real object — allowlisted fields, type-checked values @param {any} object @param {any} p */
export function applyObjectPatch(object, p) {
	if (!p || typeof p !== 'object') return;
	if (Array.isArray(p.p)) setComponents(object.position, p.p, ['x', 'y', 'z']);
	if (Array.isArray(p.r)) {
		const r = p.r;
		const order = ORDERS.has(r[3]) ? r[3] : object.rotation.order;
		object.rotation.set(finite(r[0]) ? r[0] : object.rotation.x, finite(r[1]) ? r[1] : object.rotation.y, finite(r[2]) ? r[2] : object.rotation.z, order);
	} else if (Array.isArray(p.q) && p.q.every(finite)) object.quaternion.set(p.q[0], p.q[1], p.q[2], p.q[3]).normalize();
	if (Array.isArray(p.s)) setComponents(object.scale, p.s, ['x', 'y', 'z']);
	if (typeof p.v === 'boolean') object.visible = p.v;
	if (p.ud && typeof p.ud === 'object' && object.userData) {
		for (const key of Object.keys(p.ud)) if (!BLOCKED_KEYS.has(key)) object.userData[key] = p.ud[key];
	}
	if (Array.isArray(p.udDel) && object.userData) {
		for (const key of p.udDel) if (typeof key === 'string' && !BLOCKED_KEYS.has(key)) delete object.userData[key];
	}
	const m = p.m;
	const material = object.material;
	if (m && typeof m === 'object' && material && !Array.isArray(material)) {
		if (material.color?.isColor) setComponents(material.color, m.color, ['r', 'g', 'b']);
		if (material.emissive?.isColor) setComponents(material.emissive, m.emissive, ['r', 'g', 'b']);
		if (finite(m.opacity)) material.opacity = Math.max(0, Math.min(1, m.opacity));
		for (const key of ['emissiveIntensity', 'roughness', 'metalness']) if (finite(m[key]) && key in material) material[key] = m[key];
		for (const key of ['wireframe', 'visible']) if (typeof m[key] === 'boolean') material[key] = m[key];
		// a render-program change: three must recompile the material
		if (typeof m.transparent === 'boolean' && material.transparent !== m.transparent) {
			material.transparent = m.transparent;
			material.needsUpdate = true;
		}
	}
}

/**
 * Run a compiled EFFECT (v1 or v2) on `object`.
 * @param {string} key @param {boolean} v2 @param {any} object @param {any} base @param {any} data
 * @param {number} time @param {any} [inputs] @param {any} [api]
 */
export function runEffectInGuest(key, v2, object, base, data, time, inputs, api) {
	const g = scriptGuest();
	if (!g) return undefined;
	current = object && object.position ? object : null;
	currentApi = api ?? null;
	try {
		const uuid = current ? String(current.uuid ?? '') : '';
		const slots = ['m\u0000' + uuid, 'b\u0000' + key + '\u0000' + uuid, 'd\u0000' + key];
		const meta = current ? changedOrEmpty(slots[0], JSON.stringify([String(current.name ?? ''), String(current.type ?? '')])) : '';
		let out;
		try {
			// one packed argument (U+0001 never appears raw in JSON or in a number list): every string
			// handed to the engine is an allocation, and this runs per object per frame
			out = g.callRaw('__fx', [
				key,
				uuid,
				[
					v2 ? '1' : '',
					meta,
					current ? numbersOf(current, time) : String(time),
					changedOrEmpty(slots[1], JSON.stringify(base ?? null)),
					changedOrEmpty(slots[2], JSON.stringify(data ?? null)),
					v2 && inputs != null ? JSON.stringify(inputs) : '',
					api ? '1' : ''
				].join('\u0001')
			]);
		} catch (error) {
			// the guest may not have taken what we sent: send it whole next time
			for (const slot of slots) sent.delete(slot);
			throw error;
		}
		if (!out) return undefined;
		if (out.charCodeAt(0) !== 123) {
			if (current) applyObjectPatch(current, transformFromText(out));
			return undefined;
		}
		const full = g.decode(out);
		if (current) applyObjectPatch(current, { ...transformFromText(full?.t ?? ''), ...(full?.p ?? {}) });
		return full?.r;
	} finally {
		current = null;
		currentApi = null;
	}
}

/** a compiled VALUE script @param {string} key @param {any} inputs @param {number} time @param {any} [api] */
export function runValueInGuest(key, inputs, time, api) {
	const g = scriptGuest();
	if (!g) return undefined;
	currentApi = api ?? null;
	try {
		return g.callEntry('__runValue', key, inputs ?? null, time, !!api);
	} finally {
		currentApi = null;
	}
}

/** a compiled built-in "Player" body @param {string} key @param {any} settings @param {any} input @param {number} time */
export function runPlayerInGuest(key, settings, input, time) {
	const g = scriptGuest();
	if (!g) return undefined;
	return g.callEntry('__runPlayer', key, settings ?? null, input ?? null, time);
}

/** tests / debug: the guest itself (null until loaded) */
export function scriptGuestForTest() {
	return scriptGuest();
}

// ---- guest side ------------------------------------------------------------------------------
const SCRIPT_PRELUDE = String.raw`
(function () {
	'use strict';
	const B = __bridge;
	const { Vector3, Quaternion, Euler, Color, matOf, fin } = __guestMath;
	const SIG = {
		v1: ['object', 'base', 'data', 'time', 'params'],
		effect: ['object', 'base', 'data', 'time', 'params', 'inputs', 'dist', 'lerp', 'clamp', 'api'],
		value: ['inputs', 'time', 'dist', 'lerp', 'clamp', 'api'],
		player: ['settings', 'input', 'time', 'dist', 'lerp', 'clamp']
	};
	// scriptIO's SCRIPT_HELPERS, verbatim in behaviour
	const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	const pointOf = (p) => {
		if (Array.isArray(p)) return [finite(p[0]), finite(p[1]), finite(p[2])];
		if (p && Array.isArray(p.position)) return pointOf(p.position);
		if (p && typeof p === 'object' && 'x' in p) return [finite(p.x), finite(p.y), finite(p.z)];
		return [0, 0, 0];
	};
	const dist = (a, b) => {
		const p = pointOf(a), q = pointOf(b);
		return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
	};
	const lerp = (a, b, t) => a + (b - a) * t;
	const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
	const api = Object.freeze({
		object: (ref) => B.call('api', 'object', [ref && typeof ref === 'object' ? { uuid: ref.uuid } : ref]),
		raycast: (from, dir, max) => B.call('api', 'raycast', max === undefined ? [from, dir] : [from, dir, max]),
		keys: () => B.call('api', 'keys', []),
		spawn: (command) => B.call('api', 'spawn', [command])
	});

	const fns = new Map();
	const def = (name, fn) => Object.defineProperty(globalThis, name, { value: (json) => B.encode(fn(...B.decode(json))) });
	def('__compile', (key, shape, body) => {
		try {
			fns.set(key, new Function(...SIG[shape], body));
			return '';
		} catch (error) {
			return String(error);
		}
	});
	def('__forgetAll', () => {
		fns.clear();
		baseCache.clear();
		dataCache.clear();
		views.clear();
		return true;
	});

	const Z = new Vector3(0, 0, 1), X = new Vector3(1, 0, 0), Y = new Vector3(0, 1, 0);
	const ORD = ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY'];
	const same = (x, y) => x === y || (x !== x && y !== y);
	// the methods every view shares (one prototype, so a call builds no closures)
	const VIEW = {
		isObject3D: true,
		rotateOnAxis(axis, angle) {
			const q = new Quaternion().setFromEuler(this.rotation).multiply(new Quaternion().setFromAxisAngle(axis, angle));
			this.quaternion.copy(q);
			this.rotation.setFromQuaternion(q);
			return this;
		},
		rotateX(a) { return this.rotateOnAxis(X, a); },
		rotateY(a) { return this.rotateOnAxis(Y, a); },
		rotateZ(a) { return this.rotateOnAxis(Z, a); },
		translateOnAxis(axis, d) {
			const v = axis.clone().applyQuaternion(new Quaternion().setFromEuler(this.rotation));
			this.position.addScaledVector(v, d);
			return this;
		},
		translateX(d) { return this.translateOnAxis(X, d); },
		translateY(d) { return this.translateOnAxis(Y, d); },
		translateZ(d) { return this.translateOnAxis(Z, d); },
		lookAt(x, y, z) {
			const t = x && typeof x === 'object' ? new Vector3(x.x, x.y, x.z) : new Vector3(x, y, z);
			const zAxis = t.sub(this.position);
			if (zAxis.lengthSq() === 0) zAxis.z = 1;
			zAxis.normalize();
			let xAxis = new Vector3().crossVectors(this.up, zAxis);
			if (xAxis.lengthSq() === 0) {
				zAxis.x += Math.abs(this.up.z) === 1 ? 0.0001 : 0;
				zAxis.z += Math.abs(this.up.z) === 1 ? 0 : 0.0001;
				zAxis.normalize();
				xAxis = new Vector3().crossVectors(this.up, zAxis);
			}
			xAxis.normalize();
			const yAxis = new Vector3().crossVectors(zAxis, xAxis);
			const q = new Quaternion().setFromRotationMatrix([xAxis.x, yAxis.x, zAxis.x, xAxis.y, yAxis.y, zAxis.y, xAxis.z, yAxis.z, zAxis.z]);
			this.quaternion.copy(q);
			this.rotation.setFromQuaternion(q);
			return this;
		},
		getWorldPosition(target) {
			const v = target || new Vector3();
			const n = this.__n;
			return v.set(+n[15] + this.position.x - +n[0], +n[16] + this.position.y - +n[1], +n[17] + this.position.z - +n[2]);
		},
		getWorldQuaternion(target) { return (target || new Quaternion()).setFromEuler(this.rotation); },
		updateMatrix() {},
		updateMatrixWorld() {},
		updateWorldMatrix() {},
		get userData() {
			if (this.__ud === null) {
				this.__ud = B.call('ud') || {};
				this.__udJson = {};
				for (const k of Object.keys(this.__ud)) this.__udJson[k] = JSON.stringify(this.__ud[k]);
			}
			return this.__ud;
		},
		get material() {
			if (this.__mat === null) {
				const m = B.call('mat');
				if (!m) return (this.__mat = undefined);
				this.__matJson = JSON.stringify(m);
				const mat = { ...m };
				if (m.color) mat.color = new Color().setRGB(m.color[0], m.color[1], m.color[2]);
				if (m.emissive) mat.emissive = new Color().setRGB(m.emissive[0], m.emissive[1], m.emissive[2]);
				this.__mat = mat;
			}
			return this.__mat;
		}
	};
	const hidden = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: false });
	const fixed = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true });
	// ONE view per object, kept across frames the way the live object was (a script that keeps a
	// reference, or sets its own field on it, sees it next frame); position/rotation/scale/quaternion
	// are not replaceable, as on three's Object3D, so updating them in place is safe
	const views = new Map();
	function viewFor(uuid) {
		let v = views.get(uuid);
		if (v) return v;
		if (views.size > 4096) views.clear();
		v = Object.create(VIEW);
		fixed(v, 'uuid', uuid);
		fixed(v, 'position', new Vector3());
		fixed(v, 'rotation', new Euler());
		fixed(v, 'scale', new Vector3(1, 1, 1));
		fixed(v, 'quaternion', new Quaternion());
		fixed(v, 'up', new Vector3(0, 1, 0));
		v.name = '';
		v.type = '';
		v.visible = true;
		for (const k of ['__n', '__ud', '__udJson', '__mat', '__matJson']) hidden(v, k, null);
		views.set(uuid, v);
		return v;
	}
	/** the changed transform as "mask,values…" (1 position, 2 rotation, 4 quaternion, 8 scale, 16 visible) */
	function transformPatch(v) {
		const n = v.__n;
		const p = v.position, r = v.rotation, s = v.scale, q = v.quaternion;
		let mask = 0;
		const out = [];
		if (!same(p.x, +n[0]) || !same(p.y, +n[1]) || !same(p.z, +n[2])) { mask |= 1; out.push(p.x, p.y, p.z); }
		const order = ORD.indexOf(r.order);
		if (!same(r.x, +n[3]) || !same(r.y, +n[4]) || !same(r.z, +n[5]) || order !== +n[6]) { mask |= 2; out.push(r.x, r.y, r.z, order); }
		else if (!same(q.x, +n[10]) || !same(q.y, +n[11]) || !same(q.z, +n[12]) || !same(q.w, +n[13])) { mask |= 4; out.push(q.x, q.y, q.z, q.w); }
		if (!same(s.x, +n[7]) || !same(s.y, +n[8]) || !same(s.z, +n[9])) { mask |= 8; out.push(s.x, s.y, s.z); }
		if (!!v.visible !== (n[14] === '1')) { mask |= 16; out.push(v.visible ? 1 : 0); }
		return mask ? mask + ',' + out.join(',') : '';
	}
	/** userData / material changes, only when the script touched them */
	function extraPatch(v, p) {
		const ud = v.__ud;
		if (ud) {
			const changed = {};
			let any = false;
			for (const k of Object.keys(ud)) {
				const j = JSON.stringify(ud[k]);
				if (j !== v.__udJson[k]) { changed[k] = ud[k]; any = true; }
			}
			if (any) p.ud = changed;
			const gone = Object.keys(v.__udJson).filter((k) => !(k in ud));
			if (gone.length) p.udDel = gone;
		}
		const mat = v.__mat;
		if (mat) {
			const now = {};
			for (const k of Object.keys(mat)) {
				const x = mat[k];
				now[k] = x && x.isColor ? [x.r, x.g, x.b] : x;
			}
			if (JSON.stringify(now) !== v.__matJson) p.m = now;
		}
		return p;
	}

	const fnOf = (key) => {
		const fn = fns.get(key);
		if (!fn) throw new Error('Script could not be compiled');
		return fn;
	};
	// base / data arrive as JSON only when they changed since the last call for this slot ('' = same)
	const baseCache = new Map(), dataCache = new Map();
	const cached = (map, slot, json) => {
		if (json === '') return map.get(slot);
		const v = JSON.parse(json);
		if (map.size > 4096) map.clear();
		map.set(slot, v);
		return v;
	};
	/**
	 * one effect call: key, uuid ('' = no object), then v2 meta nums base data inputs api joined by
	 * U+0001. nums = position(3) rotation(3) order rotation-order-index(1) scale(3)
	 * quaternion(4) visible(1) world-position(3) time(1); meta = JSON [name, type] or '' (same).
	 * Returns '' (nothing changed), a transform patch, or '{…}' JSON {v: {t, p, r}} when there is a
	 * result or a userData / material change.
	 */
	Object.defineProperty(globalThis, '__fx', {
		value: (key, uuid, packed) => {
			const [v2, meta, nums, baseJ, dataJ, inputsJ, withApi] = packed.split('\u0001');
			const fn = fnOf(key);
			let object = null;
			let n = null;
			if (uuid) {
				object = viewFor(uuid);
				n = nums.split(',');
				if (meta) {
					const m = JSON.parse(meta);
					object.name = m[0];
					object.type = m[1];
				}
				object.__n = n;
				object.__ud = null;
				object.__mat = null;
				object.position.set(+n[0], +n[1], +n[2]);
				object.rotation.set(+n[3], +n[4], +n[5], ORD[+n[6]] || 'XYZ');
				object.scale.set(+n[7], +n[8], +n[9]);
				object.quaternion.set(+n[10], +n[11], +n[12], +n[13]);
				object.visible = n[14] === '1';
			} else n = nums.split(',');
			const time = +n[n.length - 1];
			const base = cached(baseCache, key + '\u0000' + uuid, baseJ);
			const shared = cached(dataCache, key, dataJ);
			// a fresh top level per call, as resolveInputs built one per frame
			const data = shared && typeof shared === 'object' && !Array.isArray(shared) ? Object.assign({}, shared) : shared;
			const result = v2
				? fn(object, base, data, time, data, inputsJ ? JSON.parse(inputsJ) : undefined, dist, lerp, clamp, withApi ? api : undefined)
				: fn(object, base, data, time, data);
			const t = object ? transformPatch(object) : '';
			const extra = object ? extraPatch(object, {}) : {};
			if (result === undefined && !extra.ud && !extra.udDel && !extra.m) return t;
			return JSON.stringify({ v: { t, p: extra, r: result } });
		}
	});
	def('__runValue', (key, inputs, time, withApi) => fnOf(key)(inputs, time, dist, lerp, clamp, withApi ? api : undefined));
	def('__runPlayer', (key, settings, input, time) => fnOf(key)(settings, input, time, dist, lerp, clamp));
})();
`;
