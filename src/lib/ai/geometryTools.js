// Roadmap 85 G1-G7 — SHAPE AND MODEL OBJECTS: the agent / assistant geometry tools.
//
//   set_geometry   change a primitive's params (or its TYPE in place, box → cylinder) through the
//                  Inspector's own `applyGeometry` — the `geometry` message + history kind; a spline
//                  tube takes path / radii through `commitSplineEdit` (the `splineedit` path)
//   create_lathe   a lathe from a profile (params.points on the Lathe spec)
//   create_tube    a tube along a 3D path with per-point radii (57.1's spline record)
//   extrude_shape  an outline + holes → a slab (the Extrude spec)
//   edit_mesh      faceEdit / meshEdit operators on a face or vertex selection, without a session
//   create_mesh    a mesh from vertices / faces / uvs
// Every write is a path a person's edit already takes, so peers, Undo (one step per call — the
// caller's history batch), the viewer gate and the A8 log behave as for the Inspector.
//
// G7: an object whose vertices were hand-edited (`userData.vertexEdited` / `faceEdited`) would lose
// those edits on a rebuild, so G1-G4 refuse it unless the call says `force: true`.
//
// faceEdit / splineTool are loaded on first use: both sit deep in the history import family, and
// this module is part of the assistant's static graph (and of the catalog generator's SSR load).
import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, pokeScene } from '../../stores/sceneStore.js';
import { peers } from '../../stores/appStore.js';
import { applyGeometry, geometryParamsOf } from '$lib/geometryEdit';
import { GEOMETRY_PARAMS, geometrySpec } from '$lib/geometryParams';
import { PROFILE_MAX_POINTS, OUTLINE_MAX_POINTS, OUTLINE_MAX_HOLES } from '$lib/customGeometries';
import { recordObjectPresence } from '$lib/history';
import { moveObjectToGroup } from '$lib/objectActions';
import { toHexColor } from '$lib/materialParamRules.js';
import { setPhysicsFor } from '$lib/physics';
import { paletteColorFor } from '$lib/palette';
import { lockSkip } from './lockNote.js';
import { aiCreatePhysics } from './aiPhysicsDefault.js';
import {
	parseSelect,
	vertexKey,
	facesOf,
	verticesOf,
	applySelect,
	previewOf,
	meshFromData,
	MESH_MAX_VERTICES,
	MESH_MAX_FACES
} from './meshSelectCore.js';

/** the tool names this module answers */
export const GEOMETRY_TOOL_NAMES = ['set_geometry', 'create_lathe', 'create_tube', 'extrude_shape', 'edit_mesh', 'create_mesh'];

/** how many objects one set_geometry call reshapes, and ops one edit_mesh call runs */
const MAX_UPDATES = 100;
const MAX_OPS = 20;
const TUBE_MAX_POINTS = 200;
const TUBE_MAX_RADIUS = 50;

/** types set_geometry may change a primitive INTO (Terrain is made, not converted) */
const TYPE_TARGETS = Object.keys(GEOMETRY_PARAMS).filter((t) => t !== 'Terrain');

/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

/** @param {any} data */
function broadcast(data) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(data);
}

/** G7: has a person (or edit_mesh) changed this object's vertices by hand? @param {any} object */
const handEdited = (object) => !!(object?.userData?.vertexEdited || object?.userData?.faceEdited);

const HAND_EDITED =
	'its vertices were edited by hand (Edit Mesh / sculpt / edit_mesh) and rebuilding from params would throw those edits away — pass force: true to rebuild anyway';

/** a colour an AI may pass: hex or a plain CSS name, else null @param {any} v */
const colorOf = (v) => toHexColor(v) ?? (typeof v === 'string' && /^[a-z]{3,20}$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

/**
 * Check a param patch against a registry spec. Sizes are clamped to the Inspector's minimum and to
 * 1 km (create_objects' cap — the Inspector's slider maximum is a UI range, not a limit), counts to
 * the spec's range (they are what costs triangles), words to the spec's options.
 * @param {string} gtype @param {any} raw an object {key: value}, or create_objects' positional array
 * @returns {{patch: Record<string, any>, errors: string[], warnings: string[]}}
 */
export function cleanParamPatch(gtype, raw) {
	const spec = geometrySpec(gtype);
	/** @type {Record<string, any>} */
	const patch = {};
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];
	if (!spec) return { patch, errors: ['no editable params for ' + gtype], warnings };
	const rows = spec.params;
	let entries = /** @type {[string, any][]} */ ([]);
	if (Array.isArray(raw)) {
		const keys = spec.order.filter((k) => rows.some((p) => p.key === k));
		entries = raw.slice(0, keys.length).map((v, i) => [keys[i], v]);
	} else if (raw && typeof raw === 'object') entries = Object.entries(raw);
	else if (raw !== undefined) errors.push('params: an object like {"width": 3} (keys from list_scene\'s geometry)');
	for (const [key, value] of entries) {
		const row = rows.find((p) => p.key === key);
		if (!row) {
			errors.push('params.' + key + ': not a ' + gtype + ' param — one of ' + rows.map((p) => p.key).join(', '));
			continue;
		}
		if (row.kind === 'bool') {
			if (typeof value !== 'boolean') errors.push('params.' + key + ': true or false');
			else patch[key] = value;
		} else if (row.kind === 'choice') {
			if (!row.options?.includes(value)) errors.push('params.' + key + ': one of ' + (row.options ?? []).join(', '));
			else patch[key] = value;
		} else {
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				errors.push('params.' + key + ': a number');
				continue;
			}
			const lo = row.min ?? -1000;
			const hi = row.kind === 'slider' ? Math.max(row.max ?? 1000, 1000) : (row.max ?? 1000);
			let v = row.kind === 'int' ? Math.round(value) : value;
			v = Math.min(Math.max(v, lo), hi);
			if (v !== value) warnings.push('params.' + key + ' ' + value + ' → ' + r3(v) + ' (range ' + r3(lo) + '..' + r3(hi) + ')');
			patch[key] = v;
		}
	}
	return { patch, errors, warnings };
}

/** the editable shape list_scene shows, for a result @param {any} object */
function shapeOf(object) {
	const gp = object?.userData?.geometryParams;
	if (!gp?.gtype) return undefined;
	/** @type {any} */
	const out = { type: gp.gtype };
	for (const [k, v] of Object.entries(gp.params ?? {})) if (typeof v === 'number') out[k] = r3(v);
	else if (typeof v === 'boolean') out[k] = v;
	return out;
}

// ---- G1 set_geometry -----------------------------------------------------------------------------

/** @param {any} u @returns {Promise<any>} */
async function setGeometryOne(u) {
	const uuid = String(u?.uuid ?? '');
	const object = objectOf(uuid);
	if (!object) return { uuid, error: 'no object with that uuid' };
	const lock = lockSkip(uuid, object);
	if (lock) return { uuid, skipped: lock };
	if (!object.geometry || !object.isMesh) return { uuid, error: 'not a mesh — set_geometry reshapes primitives, lathes, tubes and extrusions' };
	// a spline tube: its record is the shape (57.1), edited through the spline path
	if (object.userData?.spline?.points?.length) return await setSplineShape(uuid, object, u);
	const current = geometryParamsOf(object);
	if (!current) return { uuid, error: 'this mesh has no editable params (an import or a hand-built mesh) — use edit_mesh' };
	if (handEdited(object) && u.force !== true) return { uuid, error: 'not changed: ' + HAND_EDITED, handEdited: true };
	let gtype = current.gtype;
	if (u.type !== undefined) {
		const want = TYPE_TARGETS.find((t) => t.toLowerCase() === String(u.type).toLowerCase());
		if (!want) return { uuid, error: 'type: one of ' + TYPE_TARGETS.join(', ') };
		if (current.gtype === 'Terrain') return { uuid, error: 'type: a terrain stays a terrain (its sculpting lives in the mesh)' };
		gtype = want;
	}
	const { patch, errors, warnings } = cleanParamPatch(gtype, u.params);
	if (errors.length) return { uuid, ok: false, errors };
	if (gtype === current.gtype && !Object.keys(patch).length) return { uuid, ok: false, errors: ['nothing to change: give params or type'] };
	const wasEdited = handEdited(object);
	if (!applyGeometry(uuid, patch, { gtype })) return { uuid, ok: false, errors: ['the ' + gtype + ' could not be built from those params'] };
	if (wasEdited) warnings.push('force: the hand edits were replaced by the rebuilt ' + gtype);
	const after = objectOf(uuid);
	return { uuid, ok: true, geometry: shapeOf(after), ...(gtype !== current.gtype ? { from: current.gtype } : {}), ...(warnings.length ? { warnings } : {}) };
}

/** @param {any} args */
async function setGeometryTool(args) {
	const updates = Array.isArray(args?.updates) ? args.updates.slice(0, MAX_UPDATES) : [];
	if (!updates.length) return { error: 'no updates — pass updates: [{ uuid, params: { width: 3 } }] or [{ uuid, type: "Cylinder" }]' };
	/** @type {any[]} */
	const results = [];
	for (const u of updates) results.push(await setGeometryOne(u));
	const failed = results.filter((r) => r.error || r.errors || r.skipped).length;
	if (failed === results.length) return { error: 'nothing was reshaped: ' + (results[0].error ?? results[0].errors?.[0] ?? results[0].skipped), updated: results };
	return failed ? { updated: results, warning: failed + ' of ' + results.length + ' did not apply — see errors' } : { updated: results };
}

// ---- G3 tubes: the spline record ------------------------------------------------------------------

/**
 * A path + radii → a spline record (scene-local points, re-seated around their centroid) or an error.
 * @param {any} args @returns {{record: any, center: number[]} | {error: string}}
 */
export function tubeRecordOf(args) {
	const path = args?.path;
	if (!Array.isArray(path) || path.length < 2) return { error: 'path: at least 2 points [x, y, z]' };
	if (path.length > TUBE_MAX_POINTS) return { error: 'path: at most ' + TUBE_MAX_POINTS + ' points (the curve is smooth between them)' };
	for (let i = 0; i < path.length; i++) {
		const p = path[i];
		if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1000))
			return { error: 'path[' + i + ']: [x, y, z] numbers within ±1000' };
	}
	const radius = args.radius === undefined ? 0.05 : Number(args.radius);
	if (!Number.isFinite(radius) || radius <= 0) return { error: 'radius: a positive number (metres)' };
	/** @type {number[]} */
	let radii = path.map(() => radius);
	if (args.radii !== undefined) {
		if (!Array.isArray(args.radii) || args.radii.length !== path.length || !args.radii.every((/** @type {any} */ r) => typeof r === 'number' && r > 0))
			return { error: 'radii: one positive radius per path point (' + path.length + ')' };
		radii = args.radii;
	}
	const center = [0, 1, 2].map((k) => path.reduce((s, p) => s + p[k], 0) / path.length);
	const radial = args.radialSegments === undefined ? 8 : Math.round(Number(args.radialSegments));
	return {
		center,
		record: {
			points: path.map((p, i) => ({ pos: [p[0] - center[0], p[1] - center[1], p[2] - center[2]], radius: Math.min(Math.max(radii[i], 0.002), TUBE_MAX_RADIUS) })),
			color: colorOf(args.color) ?? '#b0b4ba',
			closed: args.closed === true,
			radialSegments: Number.isFinite(radial) ? radial : 8,
			segmentsPerSpan: 12
		}
	};
}

/** set_geometry on a spline tube @param {string} uuid @param {any} object @param {any} u */
async function setSplineShape(uuid, object, u) {
	const st = await import('$lib/splineTool');
	const before = object.userData.spline;
	/** @type {any} */
	const next = { ...before, points: before.points.map((/** @type {any} */ p) => ({ pos: [...p.pos], radius: p.radius })) };
	/** @type {string[]} */
	const errors = [];
	if (u.path !== undefined) {
		// a new path is in SCENE space like create_tube's: re-seat it on the object's own origin
		const made = tubeRecordOf({ path: u.path, radius: before.points[0]?.radius ?? 0.05 });
		if ('error' in made) errors.push(made.error);
		else {
			const o = object.position;
			next.points = u.path.map((/** @type {number[]} */ p, /** @type {number} */ i) => ({ pos: [p[0] - o.x, p[1] - o.y, p[2] - o.z], radius: next.points[i]?.radius ?? next.points[next.points.length - 1]?.radius ?? 0.05 }));
		}
	}
	if (u.radii !== undefined) {
		if (!Array.isArray(u.radii) || u.radii.length !== next.points.length || !u.radii.every((/** @type {any} */ r) => typeof r === 'number' && r > 0))
			errors.push('radii: one positive radius per path point (' + next.points.length + ')');
		else next.points = next.points.map((/** @type {any} */ p, /** @type {number} */ i) => ({ ...p, radius: u.radii[i] }));
	} else if (u.radius !== undefined) {
		if (!(typeof u.radius === 'number' && u.radius > 0)) errors.push('radius: a positive number');
		else next.points = next.points.map((/** @type {any} */ p) => ({ ...p, radius: u.radius }));
	}
	if (u.closed !== undefined) next.closed = u.closed === true;
	if (u.radialSegments !== undefined) next.radialSegments = Number(u.radialSegments);
	if (u.params !== undefined || u.type !== undefined) errors.push('a tube takes path, radius / radii, closed, radialSegments (not params / type)');
	if (errors.length) return { uuid, ok: false, errors };
	if (!st.commitSplineEdit(uuid, before, next)) return { uuid, ok: false, errors: ['the tube could not be rebuilt'] };
	return { uuid, ok: true, tube: { points: next.points.length, closed: !!object.userData.spline?.closed } };
}

/** @param {any} args */
async function createTubeTool(args) {
	const made = tubeRecordOf(args);
	if ('error' in made) return { error: made.error };
	const group = get(objectsGroup);
	if (!group) return { error: 'no scene' };
	const st = await import('$lib/splineTool');
	// created as a 2-point stub and then given its record: the `object` message carries the mesh's whole
	// vertex list as plain numbers, which binarypack cannot send for a long tube; the record is tiny
	const stub = { ...made.record, points: [made.record.points[0], made.record.points[made.record.points.length - 1]] };
	const mesh = st.createSplineMesh(stub, new THREE.Vector3(...made.center));
	if (!mesh) return { error: 'the tube could not be built' };
	mesh.name = String(args.name || 'Tube').slice(0, 120);
	group.add(mesh);
	pokeScene();
	recordObjectPresence('create', mesh);
	broadcast({ type: 'object', element: mesh.toJSON() });
	st.commitSplineEdit(mesh.uuid, stub, made.record);
	const physics = aiCreatePhysics(args, undefined);
	if (physics) setPhysicsFor(mesh.uuid, physics);
	return { created: [{ uuid: mesh.uuid, name: mesh.name, points: made.record.points.length, position: made.center.map(r3) }] };
}

// ---- G2 / G4 parametric shapes: create a base primitive, then give it its params ----------------------

/** @typedef {(spec: any, extraTypes?: string[]) => any} CreateBase create_objects' own createOne */

/**
 * A 2D point list from the agent, checked (not silently cleaned — a wrong profile should say so).
 * @param {any} list @param {string} field @param {number} min @param {number} max
 * @returns {number[][] | string} points, or the error
 */
function points2(list, field, min, max) {
	if (!Array.isArray(list) || list.length < min) return field + ': at least ' + min + ' points [x, y]';
	if (list.length > max) return field + ': at most ' + max + ' points';
	for (let i = 0; i < list.length; i++) {
		const p = list[i];
		if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1000))
			return field + '[' + i + ']: [x, y] numbers within ±1000';
	}
	return list;
}

/** @param {CreateBase} createBase @param {string} gtype @param {any} args @param {Record<string, any>} params */
function createParametric(createBase, gtype, args, params) {
	const base = createBase({ ...args, kind: 'primitive', primitive: gtype, params: undefined }, [gtype]);
	if (base.error) return { error: base.error };
	if (!applyGeometry(base.uuid, params, { gtype })) return { error: 'the ' + gtype + ' could not be built from those params', created: [base] };
	return { created: [{ ...base, geometry: shapeOf(objectOf(base.uuid)) }] };
}

/** @param {CreateBase} createBase @param {any} args */
function createLatheTool(createBase, args) {
	const profile = points2(args?.profile, 'profile', 2, PROFILE_MAX_POINTS);
	if (typeof profile === 'string') return { error: profile };
	if (profile.some((p) => p[0] < 0)) return { error: 'profile: x is the radius from the Y axis, so it cannot be negative' };
	/** @type {Record<string, any>} */
	const params = { points: profile };
	if (args.segments !== undefined) params.segments = Number(args.segments);
	if (args.phiStart !== undefined) params.phiStart = Number(args.phiStart);
	if (args.phiLength !== undefined) params.phiLength = Number(args.phiLength);
	return createParametric(createBase, 'Lathe', args, params);
}

/** @param {CreateBase} createBase @param {any} args */
function extrudeShapeTool(createBase, args) {
	const outline = points2(args?.points, 'points', 3, OUTLINE_MAX_POINTS);
	if (typeof outline === 'string') return { error: outline };
	/** @type {number[][][]} */
	const holes = [];
	if (args.holes !== undefined) {
		if (!Array.isArray(args.holes) || args.holes.length > OUTLINE_MAX_HOLES) return { error: 'holes: a list of up to ' + OUTLINE_MAX_HOLES + ' outlines' };
		for (let i = 0; i < args.holes.length; i++) {
			const h = points2(args.holes[i], 'holes[' + i + ']', 3, OUTLINE_MAX_POINTS);
			if (typeof h === 'string') return { error: h };
			holes.push(h);
		}
	}
	const depth = args.depth === undefined ? 0.2 : Number(args.depth);
	if (!Number.isFinite(depth) || depth <= 0 || depth > 100) return { error: 'depth: a positive number of metres (≤ 100)' };
	/** @type {Record<string, any>} */
	const params = { points: outline, holes, depth };
	const bevel = args.bevel;
	if (bevel !== undefined && bevel !== false) {
		params.bevel = true;
		if (bevel && typeof bevel === 'object') {
			if (bevel.thickness !== undefined) params.bevelThickness = Number(bevel.thickness);
			if (bevel.size !== undefined) params.bevelSize = Number(bevel.size);
			if (bevel.segments !== undefined) params.bevelSegments = Number(bevel.segments);
		}
	}
	if (args.curveSegments !== undefined) params.curveSegments = Number(args.curveSegments);
	return createParametric(createBase, 'Extrude', args, params);
}

// ---- G6 create_mesh --------------------------------------------------------------------------------

/** @param {any} args */
async function createMeshTool(args) {
	const data = meshFromData(args);
	if ('error' in data) return { error: data.error };
	if (args.color !== undefined && !colorOf(args.color)) return { error: 'color: a hex colour like "#ff8800"' };
	const group = get(objectsGroup);
	if (!group) return { error: 'no scene' };
	const fe = await import('$lib/faceEdit');
	// a one-triangle stub on the `object` message (whose plain-number vertex list binarypack cannot
	// carry for a big mesh), then the real triangles on the meshgeo channel (raw bytes, the face
	// partition beside them) — one presence + one meshgeo entry, one undo step in the call's batch
	const stub = new THREE.BufferGeometry();
	stub.setAttribute('position', new THREE.Float32BufferAttribute(data.positions.slice(0, 9), 3));
	stub.computeVertexNormals();
	const mesh = new THREE.Mesh(stub, new THREE.MeshStandardMaterial({ roughness: 0.85 }));
	mesh.material.color.set(colorOf(args.color) ?? paletteColorFor(mesh.uuid));
	mesh.name = String(args.name || 'Mesh').slice(0, 120);
	if (args.smooth === true) mesh.userData.shading = 'smooth';
	for (const [key, n] of /** @type {const} */ ([['position', 3], ['rotation', 3], ['scale', 3]])) {
		const v = args[key];
		if (v === undefined) continue;
		if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return { error: key + ': [x, y, z] numbers' };
		if (key === 'rotation') mesh.rotation.set(v[0], v[1], v[2]);
		else mesh[key].fromArray(v);
	}
	group.add(mesh);
	pokeScene();
	recordObjectPresence('create', mesh);
	broadcast({ type: 'object', element: mesh.toJSON() });
	if (args.parentUuid) {
		const parent = objectOf(String(args.parentUuid));
		if (parent?.type === 'Group') moveObjectToGroup(mesh.uuid, parent.uuid);
	}
	const before = { positions: data.positions.slice(0, 9), groups: null, uvs: null, faces: null };
	const after = { positions: data.positions, groups: null, uvs: data.uvs, faces: data.partition };
	if (!fe.commitMeshGeoTriple(mesh.uuid, before, after)) return { error: 'the mesh is too large to sync', created: [{ uuid: mesh.uuid, name: mesh.name }] };
	const physics = aiCreatePhysics(args, undefined);
	if (physics) setPhysicsFor(mesh.uuid, physics);
	return { created: [{ uuid: mesh.uuid, name: mesh.name, triangles: data.triangles, faces: data.partition.length }] };
}

// ---- G5 edit_mesh ----------------------------------------------------------------------------------

const FACE_OPS = ['extrude', 'inset', 'move', 'bevel', 'subdivide', 'delete', 'flip'];
const VERTEX_OPS = ['weld', 'smooth', 'dissolve', 'bevel', 'delete', 'connect', 'create_face', 'move'];

/**
 * The selection as the op needs it, read off the object's CURRENT geometry (indices are always
 * against the mesh as it is when that op runs).
 * @param {any} fe faceEdit @param {any} object @param {'faces'|'vertices'} mode @param {any} sel parsed
 */
function resolveSelection(fe, object, mode, sel) {
	const { tris, partition } = fe.facePartitionOf(object.geometry);
	if (mode === 'faces') {
		const { picked, outOfRange } = applySelect(facesOf(tris, partition), sel, (f) => f.centroid);
		return { tris, picked, outOfRange, count: partition.length };
	}
	const { picked, outOfRange } = applySelect(verticesOf(tris), sel, (v) => v.position);
	return { tris, picked, outOfRange, count: picked.length };
}

/** the faces made of the carried triangles @param {any} fe @param {any} object @param {number[]} carry */
function carriedSelection(fe, object, carry) {
	const { tris, partition } = fe.facePartitionOf(object.geometry);
	const set = new Set(carry);
	const picked = facesOf(tris, partition).filter((f) => f.tris.length && f.tris.every((/** @type {number} */ t) => set.has(t)));
	return { tris, picked, outOfRange: [] };
}

/** null or {kept} when it ran, else the error
 * @param {any} fe @param {string} uuid @param {any} object @param {'faces'|'vertices'} mode @param {any} op @param {any[]} picked @param {any[]} tris
 * @returns {string | null | {kept: number[] | null}} */
function runOp(fe, uuid, object, mode, op, picked, tris) {
	const name = String(op.op);
	if (mode === 'faces') {
		const triIndices = picked.flatMap((f) => f.tris);
		const r = fe.faceOpOnObject(uuid, name, triIndices, {
			amount: op.distance ?? op.amount,
			width: op.width,
			segments: op.segments,
			profile: op.profile,
			direction: op.direction
		});
		return r.ok ? { kept: r.kept } : r.error;
	}
	const keys = picked.map((v) => v.key);
	switch (name) {
		case 'weld':
		case 'move': {
			const before = fe.trisToPositions(tris);
			const set = new Set(keys);
			let target = null;
			if (name === 'weld') {
				if (keys.length < 2) return 'weld: select at least 2 vertices';
				const c = [0, 0, 0];
				for (const v of picked) for (let k = 0; k < 3; k++) c[k] += v.position[k] / picked.length;
				target = c;
			}
			const off = name === 'move' ? op.offset : null;
			if (name === 'move' && !(Array.isArray(off) && off.length === 3 && off.every((/** @type {any} */ n) => typeof n === 'number' && Number.isFinite(n))))
				return 'move: offset [x, y, z] (object-local metres)';
			const out = tris.map((/** @type {any[]} */ t) =>
				t.map((v) => {
					if (!set.has(vertexKey(v))) return v;
					return target ? new THREE.Vector3(...target) : new THREE.Vector3(v.x + off[0], v.y + off[1], v.z + off[2]);
				})
			);
			const after = fe.trisToPositions(out);
			if (!fe.commitMeshGeoSnapshot(uuid, before, after)) return name + ': the edit is too large to sync';
			return null;
		}
		case 'smooth':
			return fe.smoothVertices(uuid, keys, { factor: op.factor, iterations: op.iterations }) ? null : 'smooth: nothing changed';
		case 'dissolve':
			return fe.dissolveVertices(uuid, keys) ? null : 'dissolve: those vertices cannot be dissolved (each needs faces around it to merge)';
		case 'bevel':
			return fe.bevelVertices(uuid, keys, { width: op.width, profile: op.profile, segments: op.segments })
				? null
				: 'bevel: nothing to bevel (a vertex needs at least three faces around it)';
		case 'delete':
			return fe.deleteVertices(uuid, keys) ? null : 'delete: refused (nothing uses them, or it would delete every face)';
		case 'connect':
			if (keys.length !== 2) return 'connect: select exactly 2 vertices of one face';
			return fe.connectVertices(uuid, keys) ? null : 'connect: the two vertices do not share a face';
		case 'create_face': {
			if (picked.length < 3 || picked.length > 4) return 'create_face: select 3 or 4 vertices';
			const verts = picked.map((v) => ({ x: v.position[0], y: v.position[1], z: v.position[2] }));
			return fe.createFaceFromVerts(uuid, verts) ? null : 'create_face: the face could not be made';
		}
		default:
			return 'unknown vertex op "' + name + '"';
	}
}

/** @param {any} args */
async function editMeshTool(args) {
	const uuid = String(args?.object ?? args?.uuid ?? '');
	const object = objectOf(uuid);
	if (!object) return { error: 'object: no object with that uuid' };
	if (!object.isMesh || !object.geometry?.attributes?.position) return { error: 'object: not a mesh (a group or a light has no faces) — pick one of its child meshes' };
	const lock = lockSkip(uuid, object);
	if (lock) return { error: lock, skipped: lock };
	const ops = Array.isArray(args.ops) ? args.ops : [];
	if (ops.length > MAX_OPS) return { error: 'ops: at most ' + MAX_OPS + ' per call' };
	const fe = await import('$lib/faceEdit');
	const topSel = args.select === undefined ? null : parseSelect(args.select);
	if (topSel && 'error' in topSel) return { error: topSel.error };
	const modeOf = (/** @type {any} */ s, /** @type {any} */ op) => {
		const m = s?.mode ?? args.select?.mode;
		if (m === 'faces' || m === 'vertices') return m;
		if (op && !FACE_OPS.includes(op.op) && VERTEX_OPS.includes(op.op)) return 'vertices';
		return 'faces';
	};
	// no ops = a preview: what the selection picks (or the whole mesh), so the next call can aim
	if (!ops.length) {
		const { tris, partition } = fe.facePartitionOf(object.geometry);
		const faces = facesOf(tris, partition);
		const vertices = verticesOf(tris);
		if (!topSel) return { object: uuid, ...previewOf(faces, vertices), note: 'nothing changed — pass ops to edit' };
		const pf = applySelect(faces, topSel, (f) => f.centroid).picked;
		const pv = applySelect(vertices, topSel, (v) => v.position).picked;
		return { object: uuid, selected: previewOf(pf, pv), faceCount: faces.length, vertexCount: vertices.length, note: 'nothing changed — pass ops to edit' };
	}
	const trianglesBefore = fe.facePartitionOf(object.geometry).tris.length;
	/** @type {any[]} */
	const done = [];
	/** @type {number[] | null} the triangles the last face op left selected */
	let carry = null;
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (!op || typeof op.op !== 'string') return { error: 'ops[' + i + ']: {op: "extrude", distance: 0.5} …', updated: done.length ? [{ uuid, ok: false, ops: done }] : undefined };
		const sel = op.select !== undefined ? parseSelect(op.select) : topSel;
		if (!sel) return partial(uuid, done, 'ops[' + i + ']: no selection — give select (top level or on the op)');
		if ('error' in sel) return partial(uuid, done, 'ops[' + i + '].' + sel.error);
		const mode = modeOf(op.select ?? null, op);
		const allowed = mode === 'faces' ? FACE_OPS : VERTEX_OPS;
		if (!allowed.includes(op.op)) return partial(uuid, done, 'ops[' + i + ']: "' + op.op + '" is not a ' + mode + ' op — ' + mode + ': ' + allowed.join(', '));
		const live = objectOf(uuid) ?? object;
		// an op with no select of its own goes on with what the last face op left selected (the
		// extruded cap, the inset's inner face), like Edit Mesh; otherwise the select is read again
		const { tris, picked, outOfRange } =
			op.select === undefined && carry && mode === 'faces' ? carriedSelection(fe, live, carry) : resolveSelection(fe, live, mode, sel);
		if (outOfRange.length) return partial(uuid, done, 'ops[' + i + ']: ' + mode + ' ' + outOfRange.slice(0, 5).join(', ') + ' do not exist (preview with ops: [])');
		if (!picked.length) return partial(uuid, done, 'ops[' + i + ']: the selection picks no ' + mode);
		const res = runOp(fe, uuid, live, mode, op, picked, tris);
		if (typeof res === 'string') return partial(uuid, done, 'ops[' + i + '] ' + res);
		carry = res?.kept ?? null;
		done.push({ op: op.op, [mode]: picked.length });
	}
	const after = fe.facePartitionOf(objectOf(uuid).geometry);
	return { updated: [{ uuid, ok: true, ops: done, triangles: after.tris.length, trianglesBefore, faces: after.partition.length }] };
}

/** an edit that stopped part-way: what ran stays (still one undo step), the rest is the error
 * @param {string} uuid @param {any[]} done @param {string} error */
function partial(uuid, done, error) {
	return done.length ? { updated: [{ uuid, ok: false, ops: done, errors: [error] }], warning: 'stopped at: ' + error } : { error };
}

// ---- the router ------------------------------------------------------------------------------------

/**
 * @param {string} name one of GEOMETRY_TOOL_NAMES
 * @param {any} args
 * @param {CreateBase} createBase create_objects' createOne (name, transform, parent, colour, physics)
 * @returns {Promise<any>}
 */
export async function geometryTool(name, args, createBase) {
	switch (name) {
		case 'set_geometry':
			return setGeometryTool(args);
		case 'create_lathe':
			return createLatheTool(createBase, args ?? {});
		case 'create_tube':
			return createTubeTool(args ?? {});
		case 'extrude_shape':
			return extrudeShapeTool(createBase, args ?? {});
		case 'edit_mesh':
			return editMeshTool(args ?? {});
		case 'create_mesh':
			return createMeshTool(args ?? {});
		default:
			return { error: 'unknown geometry tool ' + name };
	}
}

// ---- schemas (the shared registry: the assistant and every agent get these) -------------------------

const V3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const V2 = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
/** where a created shape goes — create_objects' fields */
const PLACE = {
	name: { type: 'string' },
	position: V3,
	rotation: { ...V3, description: 'Euler radians' },
	scale: V3,
	color: { type: 'string', description: 'hex #rrggbb' },
	parentUuid: { type: 'string', description: 'group to nest under (position is then local to it)' },
	physics: { type: 'string', enum: ['static', 'dynamic'], description: 'default static' }
};
const SELECT = {
	type: 'object',
	description:
		'which part of the mesh, in its OWN (local) space; filters AND together. mode "faces" (default) or "vertices". indices = face / vertex numbers from a preview (edit_mesh with ops: []); normal = a direction ([x,y,z] or up/down/+x/-x/+z/-z) within angle degrees (default 30); box = {min, max}; all: true',
	properties: {
		mode: { type: 'string', enum: ['faces', 'vertices'] },
		indices: { type: 'array', items: { type: 'integer' } },
		normal: { description: '[x, y, z] or up | down | +x | -x | +z | -z' },
		angle: { type: 'number', description: 'degrees, default 30' },
		box: { type: 'object', properties: { min: V3, max: V3 } },
		all: { type: 'boolean' }
	}
};

export const GEOMETRY_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_geometry',
			description:
				'Reshape existing objects in place (they keep uuid, transform, material and flows): change a primitive\'s params (the keys list_scene shows under geometry, e.g. {width, height, depth} for a Box, {radiusTop, radiusBottom, height, radialSegments} for a Cylinder, {segments, phiLength} for a Lathe, {depth, bevel} for an extrusion), or its TYPE (box → Cylinder) with params on top of the new type\'s defaults. A tube (create_tube) takes path, radius / radii, closed. An object whose vertices were hand-edited refuses unless force: true (the rebuild replaces those edits). Up to ' +
				MAX_UPDATES +
				' objects per call, one undo step.',
			parameters: {
				type: 'object',
				properties: {
					updates: {
						type: 'array',
						maxItems: MAX_UPDATES,
						items: {
							type: 'object',
							properties: {
								uuid: { type: 'string' },
								type: { type: 'string', enum: TYPE_TARGETS, description: 'change the primitive type in place' },
								params: { type: 'object', description: 'param name → value; sizes clamped to 1 km, segment counts to their range' },
								path: { type: 'array', items: V3, description: 'tubes: a new path in scene space' },
								radius: { type: 'number', description: 'tubes: one radius for every point' },
								radii: { type: 'array', items: { type: 'number' }, description: 'tubes: one radius per point' },
								closed: { type: 'boolean', description: 'tubes: join the ends' },
								radialSegments: { type: 'integer', description: 'tubes: 3-32' },
								force: { type: 'boolean', description: 'rebuild even though the vertices were hand-edited' }
							},
							required: ['uuid']
						}
					}
				},
				required: ['updates']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_lathe',
			description:
				'A lathed (turned) object — vase, bowl, bottle, column, lamp shade: revolve a 2D profile around the Y axis. profile = [[radius, height], …] from bottom to top (radius ≥ 0; start and end at radius 0 to close the bottom / top). Editable afterwards with set_geometry (segments, phiLength). Returns the uuid.',
			parameters: {
				type: 'object',
				properties: {
					profile: { type: 'array', items: V2, minItems: 2, maxItems: PROFILE_MAX_POINTS, description: '[[radius, height], …] in metres' },
					segments: { type: 'integer', description: 'around the axis, 3-128 (default 12; 32+ looks round)' },
					phiStart: { type: 'number', description: 'radians' },
					phiLength: { type: 'number', description: 'radians, default 2π (a full turn)' },
					...PLACE
				},
				required: ['profile']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_tube',
			description:
				'A tube swept along a smooth 3D path — rail, pipe, cable, handrail, tentacle. path = [[x, y, z], …] in SCENE space (the object is placed at the path\'s centre); radius for all points or radii per point (tapers). Editable with set_geometry (path, radii, closed). Returns the uuid.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'array', items: V3, minItems: 2, maxItems: TUBE_MAX_POINTS },
					radius: { type: 'number', description: 'metres, default 0.05' },
					radii: { type: 'array', items: { type: 'number' }, description: 'one radius per path point' },
					closed: { type: 'boolean', description: 'a loop (3+ points)' },
					radialSegments: { type: 'integer', description: '3-32, default 8' },
					name: { type: 'string' },
					color: { type: 'string', description: 'hex #rrggbb' },
					physics: { type: 'string', enum: ['static', 'dynamic'] }
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'extrude_shape',
			description:
				'A solid from a 2D outline — sign, letter, logo, floor plan, gear, cookie: points = [[x, y], …] (x right, y up), extruded along +Z by depth and centred on it, so it stands upright facing +Z (rotate [-1.5708, 0, 0] to lay it flat). holes = outlines cut through it (a window, the inside of an O). bevel rounds the edges. Editable with set_geometry (depth, bevel …). Returns the uuid.',
			parameters: {
				type: 'object',
				properties: {
					points: { type: 'array', items: V2, minItems: 3, maxItems: OUTLINE_MAX_POINTS },
					holes: { type: 'array', items: { type: 'array', items: V2 }, maxItems: OUTLINE_MAX_HOLES },
					depth: { type: 'number', description: 'metres, default 0.2' },
					bevel: {
						description: 'true, or {thickness, size, segments}',
						anyOf: [{ type: 'boolean' }, { type: 'object', properties: { thickness: { type: 'number' }, size: { type: 'number' }, segments: { type: 'integer' } } }]
					},
					curveSegments: { type: 'integer', description: '1-32' },
					...PLACE
				},
				required: ['points']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'edit_mesh',
			description:
				'Model an existing mesh like Edit Mesh does: run ops on a selection of its faces or vertices. Face ops: extrude {distance}, inset {amount 0-1}, move {distance} along the normal, bevel {width, segments, profile}, subdivide, delete, flip. Vertex ops: weld (to their centre), move {offset [x,y,z]}, smooth {factor, iterations}, dissolve, bevel {width}, delete, connect (2 vertices), create_face (3-4 vertices). An op without its own select goes on with what the previous face op left selected (after extrude / inset / move / flip: the cap, the inset\'s inner face), like Edit Mesh; otherwise the select is read again on the mesh as it is at that op (indices too). Call with ops: [] first to preview faces / vertices (index, normal, centre). Afterwards the object counts as hand-edited (set_geometry then needs force). One undo step per call.',
			parameters: {
				type: 'object',
				properties: {
					object: { type: 'string', description: 'the mesh uuid' },
					select: SELECT,
					ops: {
						type: 'array',
						maxItems: MAX_OPS,
						items: {
							type: 'object',
							properties: {
								op: { type: 'string', enum: [...new Set([...FACE_OPS, ...VERTEX_OPS])] },
								select: SELECT,
								distance: { type: 'number' },
								amount: { type: 'number' },
								width: { type: 'number' },
								segments: { type: 'integer' },
								profile: { type: 'number', description: '-1..1' },
								direction: { type: 'string', enum: ['out', 'in'] },
								offset: V3,
								factor: { type: 'number' },
								iterations: { type: 'integer' }
							},
							required: ['op']
						}
					}
				},
				required: ['object']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_mesh',
			description:
				'A mesh from raw data: vertices [[x, y, z], …] and faces [[i, j, k] or [i, j, k, l] …] (indices into vertices, counter-clockwise seen from outside; polygons of up to 32 corners are fanned, so keep them convex), optional uvs (one [u, v] per vertex). Up to ' +
				MESH_MAX_VERTICES +
				' vertices and ' +
				MESH_MAX_FACES +
				' faces; normals are computed (smooth: true for smooth shading). Edit it afterwards with edit_mesh. Returns the uuid.',
			parameters: {
				type: 'object',
				properties: {
					vertices: { type: 'array', items: V3, maxItems: MESH_MAX_VERTICES },
					faces: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, maxItems: MESH_MAX_FACES },
					uvs: { type: 'array', items: V2 },
					smooth: { type: 'boolean' },
					...PLACE
				},
				required: ['vertices', 'faces']
			}
		}
	}
];

/** a short block for the assistant's system prompt */
export const GEOMETRY_PROMPT = [
	'',
	'Shapes: set_geometry reshapes an existing object in place (params like width/height/radius, or',
	'its type) — never delete and recreate. create_lathe (profile → vase, bowl, column), create_tube',
	'(path → rail, pipe), extrude_shape (outline → sign, letter, floor plan), create_mesh (raw',
	'vertices/faces). edit_mesh models a mesh: extrude/inset/bevel/subdivide faces picked by normal',
	'("up"), box or index; weld/smooth/dissolve vertices. Preview a selection with ops: [].'
].join('\n');

