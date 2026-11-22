// 103 H7 — THE GIZMO FACES B / C / D (lazy: loaded the first time a style other than A is drawn).
//
// A face is the handles you SEE and HIT; the drag itself is three's TransformControls maths, run for
// the (mode, axis) a hit names (gizmoControls.js), except D's push / pull and corner resize, which a
// face owns (`own`) and writes as absolute state from the press, like every gesture in this app.
//
// HITS ARE ANSWERED IN SCREEN PIXELS, not by raycasting picker meshes: each handle carries a shape
// (a polyline, a point, a flat square or disc) and the score is its distance from the pointer ray in
// CSS pixels at that depth, less its own drawn radius. A finger gets 22 px of slack on every side
// (the 44 px target), a mouse 7 px, so the drawn handles can stay slim at every zoom. A flat area
// (plane square, puck disc) scores half the slack when the ray lands inside it, so a line handle
// drawn over it still wins where it is actually aimed at.
//
// Frames: 'space' handles follow the gizmo's Local / World switch, 'local' ones are always the
// object's own axes (three resizes in local axes only), and D draws its box at the object's real
// size with screen-sized knobs on it.
import * as THREE from 'three';

const TOUCH_SLACK = 22;
const MOUSE_SLACK = 7;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _wa = new THREE.Vector3();
const _wb = new THREE.Vector3();
const _q = new THREE.Vector3();
const _plane = new THREE.Plane();
const _m = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _ident = new THREE.Quaternion();
const AXIS = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };

// --- shared geometry (one per shape, shared by every face) ---
/** @type {Record<string, THREE.BufferGeometry>} */
const GEO = {};
/** @param {string} key @param {() => THREE.BufferGeometry} make */
function geo(key, make) {
	return (GEO[key] ??= make());
}

/** @param {number} opacity */
function mat(opacity = 1) {
	return new THREE.MeshBasicMaterial({
		color: 0xffffff,
		depthTest: false,
		depthWrite: false,
		transparent: true,
		opacity,
		side: THREE.DoubleSide,
		toneMapped: false,
		fog: false
	});
}

/** @param {THREE.BufferGeometry} g @param {number} opacity */
function mesh(g, opacity = 1) {
	const m = new THREE.Mesh(g, mat(opacity));
	m.renderOrder = 1e6;
	m.raycast = () => {}; // the app's own raycasts never see the gizmo
	return m;
}

/**
 * @typedef {{
 *   kind: string, tool: string, mode: string, axis: string, color: string, frame: string,
 *   obj: THREE.Object3D, meshes: THREE.Mesh[], baseOpacity: number[],
 *   hit: any, tap?: boolean, own?: string, shiftMode?: string, shiftAxis?: string,
 *   inAll?: boolean, inTool?: boolean, flip?: string, dir?: THREE.Vector3, normal?: THREE.Vector3,
 *   corner?: THREE.Vector3, face?: {i: number, s: number}, extra?: boolean, hidden?: boolean, arcK?: number
 * }} Handle
 */

/** a polyline hit shape @param {THREE.Vector3[]} pts @param {number} r @param {boolean} [closed] */
const polyHit = (pts, r, closed = false) => ({ type: 'poly', pts, r, closed });

/** an arc in a plane: points from angle a0 to a1 on the circle (u, v) of radius R
 * @param {number} R @param {THREE.Vector3} u @param {THREE.Vector3} v @param {number} a0 @param {number} a1 @param {number} [n] */
function arcPoints(R, u, v, a0, a1, n = 24) {
	const pts = [];
	for (let i = 0; i <= n; i++) {
		const a = a0 + ((a1 - a0) * i) / n;
		pts.push(new THREE.Vector3().addScaledVector(u, Math.cos(a) * R).addScaledVector(v, Math.sin(a) * R));
	}
	return pts;
}

// --- the handle builders (units: three's gizmo units, scaled per frame to a constant screen size) ---

/** an arrow along `dir` from r0 to r1 with a cone tip
 * @param {string} kind @param {string} tool @param {string} axis @param {THREE.Vector3} dir @param {string} color
 * @param {number} r0 @param {number} r1 @param {number} thick @param {string} [frame] @returns {Handle} */
function arrow(kind, tool, axis, dir, color, r0, r1, thick, frame = 'space') {
	const obj = new THREE.Group();
	const shaft = mesh(geo('cyl:' + thick, () => new THREE.CylinderGeometry(thick, thick, 1, 10, 1, true).translate(0, 0.5, 0)));
	shaft.scale.set(1, r1 - r0 - thick * 4, 1);
	shaft.position.y = r0;
	const cone = mesh(geo('cone:' + thick, () => new THREE.ConeGeometry(thick * 3, thick * 8, 16).translate(0, thick * 4, 0)));
	cone.position.y = r1 - thick * 4;
	obj.add(shaft, cone);
	obj.quaternion.setFromUnitVectors(AXIS.Y, dir);
	return {
		kind, tool, mode: 'translate', axis, color, frame, obj, meshes: [shaft, cone], baseOpacity: [1, 1],
		hit: polyHit([new THREE.Vector3(0, r0, 0), new THREE.Vector3(0, r1 + thick * 4, 0)], thick * 3),
		dir: dir.clone()
	};
}

/** a flat square for a two-axis move; `flip` turns it toward the camera
 * @param {string} axis @param {'X'|'Y'|'Z'} normalAxis @param {THREE.Vector3} u @param {THREE.Vector3} v @param {string} color
 * @param {number} at @param {number} half @returns {Handle} */
function planeSquare(axis, normalAxis, u, v, color, at, half) {
	const obj = new THREE.Group();
	const sq = mesh(geo('plane', () => new THREE.PlaneGeometry(1, 1)), 0.45);
	sq.scale.set(half * 2, half * 2, 1);
	const holder = new THREE.Group();
	holder.add(sq);
	// orient the square's XY to (u, v)
	_m.makeBasis(u, v, _v1.crossVectors(u, v));
	holder.quaternion.setFromRotationMatrix(_m);
	holder.position.copy(u).multiplyScalar(at).addScaledVector(v, at);
	obj.add(holder);
	return {
		kind: 'planes', tool: 'translate', mode: 'translate', axis, color, frame: 'space', obj, meshes: [sq], baseOpacity: [0.45],
		hit: { type: 'quad', c: holder.position.clone(), u: u.clone(), v: v.clone(), half },
		normal: AXIS[normalAxis].clone(), flip: 'uv', dir: _v1.copy(u).add(v).clone()
	};
}

/** a ring (or arc) about `axis`, drawn in the plane (u, v)
 * @param {string} kind @param {string} axis @param {THREE.Vector3} normal @param {THREE.Vector3} u @param {THREE.Vector3} v
 * @param {string} color @param {number} R @param {number} tube @param {number} a0 @param {number} a1 @param {string} [frame] @returns {Handle} */
function ring(kind, axis, normal, u, v, color, R, tube, a0, a1, frame = 'space') {
	const obj = new THREE.Group();
	const span = a1 - a0;
	const t = mesh(geo(`torus:${R}:${tube}:${span.toFixed(3)}`, () => new THREE.TorusGeometry(R, tube, 8, Math.max(12, Math.round(64 * (span / (Math.PI * 2)))), span)));
	const holder = new THREE.Group();
	_m.makeBasis(u, v, _v1.crossVectors(u, v));
	holder.quaternion.setFromRotationMatrix(_m);
	t.rotation.z = a0;
	holder.add(t);
	obj.add(holder);
	return {
		kind, tool: 'rotate', mode: 'rotate', axis, color, frame, obj, meshes: [t], baseOpacity: [1],
		hit: polyHit(arcPoints(R, u, v, a0, a1, Math.max(8, Math.round(32 * (span / (Math.PI * 2))))), tube, span >= Math.PI * 2 - 1e-3),
		normal: normal.clone(), flip: span < Math.PI * 2 - 1e-3 ? 'uv' : undefined, dir: u.clone().add(v)
	};
}

/** a cube knob at `at` along `dir` (per-axis resize)
 * @param {string} kind @param {string} tool @param {string} mode @param {string} axis @param {THREE.Vector3} dir
 * @param {string} color @param {number} at @param {number} half @param {string} [frame] @returns {Handle} */
function cube(kind, tool, mode, axis, dir, color, at, half, frame = 'local') {
	const obj = new THREE.Group();
	const c = mesh(geo('box', () => new THREE.BoxGeometry(1, 1, 1)));
	c.scale.setScalar(half * 2);
	c.position.copy(dir).multiplyScalar(at);
	obj.add(c);
	return {
		kind, tool, mode, axis, color, frame, obj, meshes: [c], baseOpacity: [1],
		hit: { type: 'point', p: c.position.clone(), r: half * 1.2 },
		dir: dir.clone()
	};
}

/** a sphere knob
 * @param {string} kind @param {string} tool @param {string} mode @param {string} axis @param {string} color
 * @param {THREE.Vector3} at @param {number} r @param {string} [frame] @returns {Handle} */
function knob(kind, tool, mode, axis, color, at, r, frame = 'space') {
	const obj = new THREE.Group();
	const s = mesh(geo('sphere', () => new THREE.SphereGeometry(1, 20, 14)));
	s.scale.setScalar(r);
	s.position.copy(at);
	obj.add(s);
	return { kind, tool, mode, axis, color, frame, obj, meshes: [s], baseOpacity: [1], hit: { type: 'point', p: at.clone(), r } };
}

// --- the B set (also the puck's per-axis handles and D's move arrows) ---
/** @param {{extra?: boolean, scale?: number}} [o] @returns {Handle[]} */
function bHandles(o = {}) {
	const k = o.scale ?? 1;
	const X = AXIS.X, Y = AXIS.Y, Z = AXIS.Z;
	/** @type {Handle[]} */
	const hs = [
		arrow('arrows', 'translate', 'X', X, 'x', 0.1 * k, 0.62 * k, 0.012 * k),
		arrow('arrows', 'translate', 'Y', Y, 'y', 0.1 * k, 0.62 * k, 0.012 * k),
		arrow('arrows', 'translate', 'Z', Z, 'z', 0.1 * k, 0.62 * k, 0.012 * k),
		planeSquare('XY', 'Z', X, Y, 'z', 0.17 * k, 0.05 * k),
		planeSquare('YZ', 'X', Y, Z, 'x', 0.17 * k, 0.05 * k),
		planeSquare('XZ', 'Y', X, Z, 'y', 0.17 * k, 0.05 * k),
		ring('rings', 'X', X, Y, Z, 'x', 0.47 * k, 0.008 * k, 0, Math.PI / 2),
		ring('rings', 'Y', Y, Z, X, 'y', 0.47 * k, 0.008 * k, 0, Math.PI / 2),
		ring('rings', 'Z', Z, X, Y, 'z', 0.47 * k, 0.008 * k, 0, Math.PI / 2),
		cube('cubes', 'scale', 'scale', 'X', X, 'x', 0.31 * k, 0.024 * k),
		cube('cubes', 'scale', 'scale', 'Y', Y, 'y', 0.31 * k, 0.024 * k),
		cube('cubes', 'scale', 'scale', 'Z', Z, 'z', 0.31 * k, 0.024 * k)
	];
	const centre = knob('knob', 'scale', 'scale', 'XYZ', 'n', new THREE.Vector3(), 0.042 * k);
	centre.shiftMode = 'translate';
	centre.shiftAxis = 'XYZ';
	hs.push(centre);
	if (o.extra) for (const h of hs) h.extra = true;
	return hs;
}

/** the screen factor three uses for its own gizmo (world units per gizmo unit) @param {any} tc @param {THREE.Vector3} at */
function screenFactor(tc, at) {
	const cam = tc.camera;
	const f = cam.isOrthographicCamera
		? (cam.top - cam.bottom) / cam.zoom
		: at.distanceTo(tc.cameraPosition) * Math.min((1.9 * Math.tan((Math.PI * cam.fov) / 360)) / cam.zoom, 7);
	return (f * tc.size) / 4;
}

/** world units per CSS pixel at a world point @param {any} tc @param {THREE.Vector3} at */
function worldPerPx(tc, at) {
	const cam = tc.camera;
	const el = tc.domElement;
	const h = tc.viewport?.w ? tc.viewport.w : Math.max(1, el?.clientHeight || 600);
	if (cam.isOrthographicCamera) return (cam.top - cam.bottom) / cam.zoom / h;
	_wa.copy(at).sub(tc.cameraPosition);
	cam.getWorldDirection(_wb);
	const d = Math.max(1e-4, _wa.dot(_wb));
	return (2 * d * Math.tan((Math.PI * cam.fov) / 360)) / cam.zoom / h;
}

/** distance (px) from the ray to a handle's shape, less its drawn radius; Infinity = miss */
function scoreHandle(/** @type {Handle} */ h, /** @type {THREE.Ray} */ ray, /** @type {any} */ tc, /** @type {number} */ slack) {
	const mw = h.obj.matrixWorld;
	const scale = _v2.setFromMatrixScale(mw).x || 1;
	const hit = h.hit;
	if (hit.type === 'point') {
		_p.copy(hit.p).applyMatrix4(mw);
		const d = Math.sqrt(ray.distanceSqToPoint(_p));
		const wpp = worldPerPx(tc, _p);
		return Math.max(0, d / wpp - (hit.r * scale) / wpp);
	}
	if (hit.type === 'poly') {
		let best = Infinity;
		const n = hit.pts.length;
		const last = hit.closed ? n : n - 1;
		for (let i = 0; i < last; i++) {
			_p.copy(hit.pts[i]).applyMatrix4(mw);
			_q.copy(hit.pts[(i + 1) % n]).applyMatrix4(mw);
			const onSeg = _v1;
			const d2 = ray.distanceSqToSegment(_p, _q, undefined, onSeg);
			const wpp = worldPerPx(tc, onSeg);
			const s = Math.sqrt(d2) / wpp - (hit.r * scale) / wpp;
			if (s < best) best = s;
		}
		return Math.max(0, best);
	}
	if (hit.type === 'quad' || hit.type === 'disc') {
		const c = _p.copy(hit.c).applyMatrix4(mw);
		const u = _v1.copy(hit.u).transformDirection(mw);
		const v = _v2.copy(hit.v).transformDirection(mw);
		const n = _v3.crossVectors(u, v).normalize();
		if (Math.abs(n.dot(ray.direction)) < 0.15) return Infinity; // edge-on: not aimable
		_plane.setFromNormalAndCoplanarPoint(n, c);
		const at = ray.intersectPlane(_plane, _q);
		if (!at) return Infinity;
		const wpp = worldPerPx(tc, at);
		const rel = at.sub(c);
		if (hit.type === 'disc') {
			const r = rel.length() / scale;
			return r <= hit.R ? slack * 0.5 : ((r - hit.R) * scale) / wpp + slack * 0.5;
		}
		const du = Math.abs(rel.dot(u)) / scale - hit.half;
		const dv = Math.abs(rel.dot(v)) / scale - hit.half;
		const out = Math.max(du, dv, 0);
		return out === 0 ? slack * 0.5 : (out * scale) / wpp + slack * 0.5;
	}
	return Infinity;
}

/** the token colour for a handle key @param {any} tc @param {string} key */
function colorOf(tc, key) {
	const c = tc.faceColors;
	return key === 'x' ? c.x : key === 'y' ? c.y : key === 'z' ? c.z : c.neutral;
}

// ============================================================================================
// THE FACE
// ============================================================================================

class Face {
	/** @param {string} style @param {Handle[]} handles */
	constructor(style, handles) {
		this.style = style;
		this.handles = handles;
		this.root = new THREE.Group();
		this.root.name = 'TransformControlsFace';
		this.space = new THREE.Group();
		this.local = new THREE.Group();
		/** handles a face seats in world coordinates itself (D's box knobs) */
		this.world = new THREE.Group();
		this.root.add(this.space, this.local, this.world);
		for (const h of handles) (h.frame === 'local' ? this.local : h.frame === 'world' ? this.world : this.space).add(h.obj);
		/** @type {any} */
		this.tc = null;
		this.expanded = false;
		this.root.updateMatrixWorld = (force) => {
			if (this.tc && this.root.visible) this.update(this.tc);
			THREE.Group.prototype.updateMatrixWorld.call(this.root, force);
		};
	}

	/** @param {any} object */
	accepts(object) {
		return !!object;
	}

	/** @param {any} object @param {any} tc */
	attached(object, tc) {
		this.tc = tc;
	}

	/** is this handle on show right now? @param {Handle} h @param {any} tc */
	shown(h, tc) {
		if (tc.hiddenKinds.has(h.kind)) return false;
		if (h.extra) return this.expanded;
		const tool = tc._toolMode ?? tc.mode;
		if (tc.handleSet === 'all') return h.inAll !== false;
		return h.inTool !== false && h.tool === tool;
	}

	/** per frame: seat the frames, turn flat handles toward the camera, paint @param {any} tc */
	update(tc) {
		this.tc = tc;
		const s = screenFactor(tc, tc.worldPosition);
		const spaceQuat = tc.space === 'local' ? tc.worldQuaternion : _ident;
		this.space.position.copy(tc.worldPosition);
		this.space.quaternion.copy(spaceQuat);
		this.space.scale.setScalar(s);
		this.local.position.copy(tc.worldPosition);
		this.local.quaternion.copy(tc.worldQuaternion);
		this.local.scale.setScalar(s);
		const active = tc.dragging ? tc._down?.hit ?? tc._hit : tc._hit;
		for (const h of this.handles) {
			const on = this.shown(h, tc);
			h.obj.visible = on;
			if (!on) continue;
			const q = h.frame === 'local' ? tc.worldQuaternion : spaceQuat;
			// the eye in the handle's frame
			_v1.copy(tc.eye).applyQuaternion(_quat.copy(q).invert());
			if (h.flip === 'uv') {
				// a quarter arc / plane square sits in the quadrant facing the camera
				const sx = _v1.x < 0 ? -1 : 1, sy = _v1.y < 0 ? -1 : 1, sz = _v1.z < 0 ? -1 : 1;
				h.obj.scale.set(h.normal?.x ? 1 : sx, h.normal?.y ? 1 : sy, h.normal?.z ? 1 : sz);
			}
			let fade = 1;
			if (h.kind === 'arrows' && h.dir) {
				const a = Math.abs(h.dir.dot(_v1));
				if (a > 0.99) fade = 0;
				else if (a > 0.95) fade = (0.99 - a) / 0.04;
			} else if (h.kind === 'planes' && h.normal) {
				const a = Math.abs(h.normal.dot(_v1));
				if (a < 0.12) fade = 0;
				else if (a < 0.25) fade = (a - 0.12) / 0.13;
			}
			h.hidden = fade === 0;
			const hot = active?.handle === h;
			const dim = tc.dragging && !hot ? 0.25 : 1;
			const col = hot ? tc.faceColors.hover : colorOf(tc, h.color);
			for (let i = 0; i < h.meshes.length; i++) {
				const m = /** @type {THREE.MeshBasicMaterial} */ (h.meshes[i].material);
				m.color.set(col);
				m.opacity = h.baseOpacity[i] * fade * dim;
			}
		}
	}

	/** the handle under a ray, as {handle, mode, axis, ...} or null @param {THREE.Ray} ray @param {any} tc */
	pick(ray, tc) {
		const slack = tc.pointerKind === 'touch' ? TOUCH_SLACK : MOUSE_SLACK;
		/** @type {Handle|null} */
		let best = null;
		let bestScore = Infinity;
		for (const h of this.handles) {
			if (!h.obj.visible || h.hidden) continue;
			const sc = scoreHandle(h, ray, tc, slack);
			if (sc < bestScore) {
				bestScore = sc;
				best = h;
			}
		}
		if (!best || bestScore > slack) return null;
		return { handle: best, mode: best.mode, axis: best.axis, tap: best.tap, own: best.own, shiftMode: best.shiftMode, shiftAxis: best.shiftAxis, kind: best.kind };
	}

	/** @param {any} hit @param {any} tc */
	tap(hit, tc) {
		if (hit.kind === 'disc') {
			this.expanded = !this.expanded;
			tc.dispatchEvent({ type: 'change' });
		}
	}

	dispose() {
		this.root.traverse((n) => {
			const m = /** @type {any} */ (n).material;
			if (m) m.dispose();
		});
	}
}

// --- C: the touch puck ---
function puckHandles() {
	const X = AXIS.X, Y = AXIS.Y, Z = AXIS.Z;
	/** @type {Handle[]} */
	const hs = [];
	// the ground disc: slide on the ground (tap = the per-axis handles)
	{
		const obj = new THREE.Group();
		const d = mesh(geo('disc', () => new THREE.CircleGeometry(1, 48)), 0.3);
		d.scale.setScalar(0.3);
		d.rotation.x = -Math.PI / 2;
		const rim = mesh(geo('torus:1:0.012:6.283', () => new THREE.TorusGeometry(1, 0.012, 6, 64)), 0.8);
		rim.scale.setScalar(0.3);
		rim.rotation.x = -Math.PI / 2;
		obj.add(d, rim);
		hs.push({
			kind: 'disc', tool: 'translate', mode: 'translate', axis: 'XZ', color: 'n', frame: 'space', obj, meshes: [d, rim], baseOpacity: [0.3, 0.8],
			hit: { type: 'disc', c: new THREE.Vector3(), u: X.clone(), v: Z.clone(), R: 0.3 }, tap: true, normal: Y.clone()
		});
	}
	const lift = arrow('lift', 'translate', 'Y', Y, 'y', 0.06, 0.6, 0.022);
	hs.push(lift);
	hs.push(ring('ring', 'Y', Y, Z, X, 'y', 0.4, 0.018, 0, Math.PI * 2));
	const k = knob('knob', 'scale', 'scale', 'XYZ', 'n', new THREE.Vector3(0.4 * Math.SQRT1_2, 0, 0.4 * Math.SQRT1_2), 0.055);
	hs.push(k);
	return hs.concat(bHandles({ extra: true, scale: 1.25 }));
}

// --- D: box handles ---
class BoxFace extends Face {
	/** @param {Face} b the all-in-one face used for targets a box does not fit (mesh elements) */
	constructor(b) {
		const X = AXIS.X, Y = AXIS.Y, Z = AXIS.Z;
		/** @type {Handle[]} */
		const hs = [];
		// the box outline, at the object's real size (seated per frame)
		const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.7, toneMapped: false, fog: false }));
		edges.renderOrder = 1e6;
		edges.raycast = () => {};
		for (const sx of [-1, 1])
			for (const sy of [-1, 1])
				for (const sz of [-1, 1]) {
					const obj = new THREE.Group();
					const c = mesh(geo('box', () => new THREE.BoxGeometry(1, 1, 1)));
					c.scale.setScalar(0.045);
					obj.add(c);
					hs.push({
						kind: 'corners', tool: 'scale', mode: 'scale', axis: 'XYZ', color: 'n', frame: 'world', obj, meshes: [c], baseOpacity: [1],
						hit: { type: 'point', p: new THREE.Vector3(), r: 0.03 }, own: 'corner', corner: new THREE.Vector3(sx, sy, sz)
					});
				}
		const faceDefs = /** @type {const} */ ([
			['X', 0, 1, 'x'], ['X', 0, -1, 'x'], ['Y', 1, 1, 'y'], ['Y', 1, -1, 'y'], ['Z', 2, 1, 'z'], ['Z', 2, -1, 'z']
		]);
		for (const [axis, i, sgn, color] of faceDefs) {
			const obj = new THREE.Group();
			const cone = mesh(geo('dcone', () => new THREE.ConeGeometry(0.035, 0.09, 16).translate(0, 0.045, 0)));
			obj.add(cone);
			hs.push({
				kind: 'faces', tool: 'scale', mode: 'scale', axis, color, frame: 'world', obj, meshes: [cone], baseOpacity: [1],
				hit: { type: 'poly', pts: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.09, 0)], r: 0.035 }, own: 'face', face: { i, s: sgn }
			});
		}
		// the turn arc under the box (rotate about the object's up axis)
		{
			const obj = new THREE.Group();
			const arcMesh = mesh(arcGeo(1));
			obj.add(arcMesh);
			hs.push({
				kind: 'arc', tool: 'rotate', mode: 'rotate', axis: 'Y', color: 'y', frame: 'world', obj, meshes: [arcMesh], baseOpacity: [1],
				hit: polyHit(arcPoints(1, X, Y, 0, Math.PI / 3, 12), 0.014), arcK: 1
			});
		}
		const mover = knob('mover', 'translate', 'translate', 'XYZ', 'n', new THREE.Vector3(), 0.045, 'world');
		hs.push(mover);
		const arrows = bHandles().filter((h) => h.kind === 'arrows');
		for (const a of arrows) a.inAll = false;
		super('D', hs.concat(arrows));
		this.root.add(edges);
		this.edges = edges;
		this.b = b;
		/** local bounds of the target */
		this.box = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
		/** @type {any} */
		this.drag0 = null;
		this._size = new THREE.Vector3();
		this._centre = new THREE.Vector3();
		this.label = /** @type {HTMLElement|null} */ (null);
		this.root.add(b.root);
	}

	/** a box fits whole objects and the selection pivot; mesh elements take the all-in-one face */
	/** @param {any} object */
	usesBox(object) {
		const ud = object?.userData;
		return !!object && !ud?.isVertexProxy && !ud?.isFaceProxy;
	}

	/** @param {any} object @param {any} tc */
	attached(object, tc) {
		this.tc = tc;
		this.b.attached(object, tc);
		if (this.usesBox(object)) this.measure(object);
	}

	/** the target's bounds in its OWN frame (once per attach / drag end, never per frame) @param {any} object */
	measure(object) {
		const box = new THREE.Box3();
		object.updateMatrixWorld(true);
		const inv = _m.copy(object.matrixWorld).invert();
		const rel = new THREE.Matrix4();
		/** @param {any} root */
		const add = (root) => {
			root.traverse((/** @type {any} */ n) => {
				if (!n.isMesh || !n.geometry || n.userData?.isEditorHelper) return;
				if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
				const gb = n.geometry.boundingBox;
				if (!gb || gb.isEmpty()) return;
				rel.multiplyMatrices(inv, n.matrixWorld);
				box.union(new THREE.Box3().copy(gb).applyMatrix4(rel));
			});
		};
		if (object.userData?.isMultiPivot) {
			const members = this.tc?.boxMembers?.() ?? [];
			for (const m of members) add(m);
		} else add(object);
		if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
		this.box.copy(box);
	}

	/** @param {Handle} h @param {any} tc */
	shown(h, tc) {
		const box = this.usesBox(tc.object);
		if (!box) return false;
		return super.shown(h, tc);
	}

	/** @param {any} tc */
	update(tc) {
		this.tc = tc;
		const box = this.usesBox(tc.object);
		this.b.root.visible = !box;
		this.edges.visible = box;
		if (!box) {
			for (const h of this.handles) h.obj.visible = false;
			return;
		}
		super.update(tc);
		const obj = tc.object;
		const size = this.box.getSize(this._size);
		const centre = this.box.getCenter(this._centre);
		// the outline: the object's world matrix times the local box
		const mw = obj.matrixWorld;
		this.edges.matrixAutoUpdate = false;
		this.edges.matrix.compose(centre, _ident, _v3.set(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4)));
		this.edges.matrix.premultiply(mw);
		/** @type {any} */ (this.edges.material).color.set(tc.faceColors.neutral);
		obj.matrixWorld.decompose(_p, _quat, _q);
		const ws = _q.clone();
		for (const h of this.handles) {
			if (!h.obj.visible) continue;
			let at;
			if (h.corner) at = _v3.set(h.corner.x < 0 ? this.box.min.x : this.box.max.x, h.corner.y < 0 ? this.box.min.y : this.box.max.y, h.corner.z < 0 ? this.box.min.z : this.box.max.z).applyMatrix4(mw);
			else if (h.face) {
				const p = centre.clone();
				p.setComponent(h.face.i, h.face.s > 0 ? this.box.max.getComponent(h.face.i) : this.box.min.getComponent(h.face.i));
				at = p.applyMatrix4(mw);
			} else if (h.kind === 'arc') {
				const p = centre.clone();
				p.y = this.box.min.y;
				at = p.applyMatrix4(mw);
			} else if (h.kind === 'mover') at = _v3.copy(centre).applyMatrix4(mw);
			else continue; // the arrows sit in the space frame already
			const s = screenFactor(tc, at);
			h.obj.position.copy(at);
			if (h.face) {
				// the cone stands off the face, pointing out along the object's own axis
				const n = AXIS[/** @type {'X'} */ (h.axis)].clone().multiplyScalar(h.face.s).applyQuaternion(_quat);
				h.obj.position.addScaledVector(n, s * 0.06);
				h.obj.quaternion.setFromUnitVectors(AXIS.Y, n);
				h.obj.scale.setScalar(s);
			} else if (h.kind === 'arc') {
				// a 60-degree arc about the up axis, centred toward the camera, at the box's foot
				const R = Math.max(size.x * ws.x, size.z * ws.z) * 0.5 * 1.35 + s * 0.08;
				// the arc's radius in gizmo units, in quarter steps (one cached ring each), so its tube
				// stays the same few pixels thick at any box size
				const k = Math.min(12, Math.max(0.5, Math.round((R / s) * 4) / 4));
				if (h.arcK !== k) {
					h.arcK = k;
					h.meshes[0].geometry = arcGeo(k);
					h.hit = polyHit(arcPoints(k, AXIS.X, AXIS.Y, 0, Math.PI / 3, 12), 0.014);
				}
				_v1.copy(tc.cameraPosition).sub(at).applyQuaternion(_quat.clone().invert());
				const az = Math.atan2(_v1.z, _v1.x);
				h.obj.quaternion.copy(_quat).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)));
				h.obj.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS.Z, az - Math.PI / 6));
				h.obj.scale.setScalar(s);
			} else {
				h.obj.quaternion.copy(_quat);
				h.obj.scale.setScalar(s);
			}
		}
	}

	/** @param {THREE.Ray} ray @param {any} tc */
	pick(ray, tc) {
		return this.usesBox(tc.object) ? super.pick(ray, tc) : this.b.pick(ray, tc);
	}

	/** D owns the corner and face drags: absolute from the press @param {any} hit @param {THREE.Ray} ray @param {any} tc */
	begin(hit, ray, tc) {
		const h = /** @type {any} */ (hit.handle);
		const obj = tc.object;
		obj.updateMatrixWorld(true);
		const mw = obj.matrixWorld.clone();
		const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), wscale = new THREE.Vector3();
		mw.decompose(pos, quat, wscale);
		const start = { pos: obj.position.clone(), scale: obj.scale.clone(), mw, quat, wscale, worldPos: pos };
		if (h.own === 'face') {
			const i = h.face.i;
			const fixedLocal = this.box.getCenter(new THREE.Vector3());
			fixedLocal.setComponent(i, h.face.s > 0 ? this.box.min.getComponent(i) : this.box.max.getComponent(i));
			const movingLocal = fixedLocal.clone();
			movingLocal.setComponent(i, h.face.s > 0 ? this.box.max.getComponent(i) : this.box.min.getComponent(i));
			const a = AXIS[/** @type {'X'} */ (h.axis)].clone().multiplyScalar(h.face.s).applyQuaternion(quat).normalize();
			const moving = movingLocal.clone().applyMatrix4(mw);
			const t0 = rayAxisParam(ray, moving, a);
			if (t0 === null) return false;
			const extent0 = (this.box.max.getComponent(i) - this.box.min.getComponent(i)) * wscale.getComponent(i);
			this.drag0 = { kind: 'face', i, a, moving, t0, extent0, fixedLocal, start };
		} else {
			const c = h.corner;
			const cornerLocal = new THREE.Vector3(c.x < 0 ? this.box.min.x : this.box.max.x, c.y < 0 ? this.box.min.y : this.box.max.y, c.z < 0 ? this.box.min.z : this.box.max.z);
			const fixedLocal = new THREE.Vector3(c.x < 0 ? this.box.max.x : this.box.min.x, c.y < 0 ? this.box.max.y : this.box.min.y, c.z < 0 ? this.box.max.z : this.box.min.z);
			const corner = cornerLocal.applyMatrix4(mw);
			const fixed = fixedLocal.clone().applyMatrix4(mw);
			this.drag0 = { kind: 'corner', corner, fixed, fixedLocal, start, eye: tc.eye.clone() };
		}
		this.showLabel(tc);
		return true;
	}

	/** @param {THREE.Ray} ray @param {any} tc */
	drag(ray, tc) {
		const d = this.drag0;
		if (!d) return false;
		const obj = tc.object;
		const st = d.start;
		const scale = st.scale.clone();
		if (d.kind === 'face') {
			const t = rayAxisParam(ray, d.moving, d.a);
			if (t === null) return false;
			let extent = Math.max(1e-3, d.extent0 + (t - d.t0));
			if (tc.translationSnap) extent = Math.max(tc.translationSnap, Math.round(extent / tc.translationSnap) * tc.translationSnap);
			const ratio = d.extent0 > 1e-9 ? extent / d.extent0 : 1;
			scale.setComponent(d.i, st.scale.getComponent(d.i) * ratio);
		} else {
			_plane.setFromNormalAndCoplanarPoint(d.eye, d.corner);
			const p = ray.intersectPlane(_plane, new THREE.Vector3());
			if (!p) return false;
			const diag = d.corner.clone().sub(d.fixed);
			const len2 = diag.lengthSq();
			let ratio = len2 > 1e-12 ? Math.max(0.01, p.sub(d.fixed).dot(diag) / len2) : 1;
			if (tc.scaleSnap) ratio = Math.max(tc.scaleSnap, Math.round(ratio / tc.scaleSnap) * tc.scaleSnap);
			scale.copy(st.scale).multiplyScalar(ratio);
		}
		obj.scale.copy(scale);
		// keep the fixed side where it was: its world point before == after
		obj.position.copy(st.pos);
		obj.updateMatrixWorld(true);
		const before = d.fixedLocal.clone().applyMatrix4(st.mw);
		const after = d.fixedLocal.clone().applyMatrix4(obj.matrixWorld);
		const shift = before.sub(after);
		if (obj.parent) {
			const pq = obj.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
			const ps = obj.parent.getWorldScale(new THREE.Vector3());
			shift.applyQuaternion(pq).divide(ps);
		}
		obj.position.add(shift);
		obj.updateMatrixWorld(true);
		this.updateLabel(tc);
		return true;
	}

	/** @param {any} tc */
	end(tc) {
		this.drag0 = null;
		this.hideLabel();
	}

	/** @param {any} tc */
	dragEnded(tc) {
		this.hideLabel();
		if (tc.object && this.usesBox(tc.object)) this.measure(tc.object);
	}

	// --- the size, shown while a drag runs (row 3) ---
	/** @param {any} tc */
	showLabel(tc) {
		if (typeof document === 'undefined') return;
		if (!this.label) {
			const el = document.createElement('div');
			el.className = 'gizmo-size-label';
			el.setAttribute('role', 'status');
			el.style.cssText =
				'position:fixed;z-index:var(--z-toast,60);pointer-events:none;padding:2px 8px;border-radius:6px;font:500 12px/1.6 var(--font-ui-mono,ui-monospace,monospace);background:var(--surface-2,#1b212d);color:var(--text,#e8eaee);border:1px solid var(--border,#2b3344);transform:translate(-50%,-140%);white-space:nowrap';
			this.label = el;
		}
		document.body.appendChild(this.label);
		this.updateLabel(tc);
	}
	/** @param {any} tc */
	updateLabel(tc) {
		const el = this.label;
		if (!el || !tc.object) return;
		const obj = tc.object;
		obj.updateMatrixWorld(true);
		const ws = obj.getWorldScale(new THREE.Vector3());
		const size = this.box.getSize(new THREE.Vector3()).multiply(ws);
		const f = (/** @type {number} */ n) => (Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2));
		el.textContent = `${f(size.x)} × ${f(size.y)} × ${f(size.z)} m`;
		// over the box's top centre on screen
		const top = this.box.getCenter(new THREE.Vector3());
		top.y = this.box.max.y;
		top.applyMatrix4(obj.matrixWorld).project(tc.camera);
		const r = tc.domElement?.getBoundingClientRect?.();
		if (!r) return;
		el.style.left = `${r.left + ((top.x + 1) / 2) * r.width}px`;
		el.style.top = `${r.top + ((1 - top.y) / 2) * r.height}px`;
	}
	hideLabel() {
		this.label?.remove();
	}

	dispose() {
		this.hideLabel();
		this.b.dispose();
		super.dispose();
	}
}

/** D's turn arc: 60 degrees of a ring of radius k (gizmo units) @param {number} k */
function arcGeo(k) {
	return geo('darc:' + k, () => new THREE.TorusGeometry(k, 0.014, 6, 24, Math.PI / 3));
}

/** the parameter along the line (p, a) of the point closest to the ray; null when they are parallel */
function rayAxisParam(/** @type {THREE.Ray} */ ray, /** @type {THREE.Vector3} */ p, /** @type {THREE.Vector3} */ a) {
	const w0 = _v1.copy(ray.origin).sub(p);
	const b = ray.direction.dot(a);
	const d = ray.direction.dot(w0);
	const e = a.dot(w0);
	const den = 1 - b * b;
	if (den < 1e-6) return null;
	return (e - b * d) / den;
}

/**
 * @param {string} style 'B' | 'C' | 'D' @param {any} tc
 * @returns {Face}
 */
export function createFace(style, tc) {
	let face;
	if (style === 'C') face = new Face('C', puckHandles());
	else if (style === 'D') {
		const b = new Face('B', bHandles());
		b.tc = tc;
		face = new BoxFace(b);
	}
	else face = new Face('B', bHandles());
	face.tc = tc;
	if (tc.object) face.attached(tc.object, tc);
	return face;
}

/**
 * test seam: where a handle is on screen (client px) — a point ON its shape (70 % along a line, a
 * knob's centre, an area's middle), so a suite drags what a person would aim at.
 * @param {any} tc @param {string} kind @param {string} [axis] @param {number} [along]
 * @returns {{x: number, y: number} | null}
 */
export function handlePoint(tc, kind, axis, along = 0.7) {
	const face = tc?._face;
	if (!face) return null;
	tc.getHelper().updateMatrixWorld(true);
	const pool = face.b && !face.usesBox(tc.object) ? face.b.handles : face.handles;
	const h = pool.find((/** @type {Handle} */ x) => x.kind === kind && (!axis || x.axis === axis) && x.obj.visible && !x.hidden);
	if (!h) return null;
	const hit = h.hit;
	let p;
	if (hit.type === 'poly') {
		const i = Math.min(hit.pts.length - 2, Math.floor((hit.pts.length - 1) * along));
		const f = (hit.pts.length - 1) * along - i;
		p = hit.pts[i].clone().lerp(hit.pts[i + 1], Math.min(1, f));
	} else if (hit.type === 'point') p = hit.p.clone();
	else p = hit.c.clone().addScaledVector(hit.u, (hit.R ?? hit.half) * 0.5);
	p.applyMatrix4(h.obj.matrixWorld).project(tc.camera);
	const r = tc.domElement.getBoundingClientRect();
	return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
}

/** test seam: a face's handles as plain data */
export function describeFace(/** @type {any} */ face) {
	return face.handles.map((/** @type {Handle} */ h) => ({ kind: h.kind, mode: h.mode, axis: h.axis, visible: h.obj.visible && !h.hidden }));
}

