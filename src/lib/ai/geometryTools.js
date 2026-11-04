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
import { parentTarget } from './parentTarget.js';
import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, pokeScene } from '../../stores/sceneStore.js';
import { peers } from '../../stores/appStore.js';
import { applyGeometry, geometryParamsOf } from '$lib/geometryEdit';
import { GEOMETRY_PARAMS, geometrySpec } from '$lib/geometryParams';
import { PROFILE_MAX_POINTS, OUTLINE_MAX_POINTS, OUTLINE_MAX_HOLES } from '$lib/customGeometries';
import { recordObjectPresence, recordTransform } from '$lib/history';
import { moveObjectToGroup } from '$lib/objectActions';
import { toHexColor } from '$lib/materialParamRules.js';
import { setPhysicsFor, physicsShapeChanged } from '$lib/physics';
import { readStoredFaces } from '$lib/meshTopology';
import { paletteColorFor } from '$lib/palette';
import { lockSkip } from './lockNote.js';
import { aiCreatePhysics } from './aiPhysicsDefault.js';
import { shapePose, checkShapes, SHAPES_MAX, SHAPE_ACTIONS } from './shapeBatchCore.js';
import { applyShadowFlags } from './shadowFlags.js';
import { catmullClark, subdivisionSize } from './worldToolsCore.js';
import {
	parseSelect,
	vertexKey,
	facesOf,
	verticesOf,
	applySelect,
	previewOf,
	meshFromData,
	vertexColorsLinear,
	MESH_MAX_VERTICES,
	MESH_MAX_FACES,
	MESH_MAX_MATERIALS
} from './meshSelectCore.js';

/** the tool names this module answers */
export const GEOMETRY_TOOL_NAMES = ['set_geometry', 'create_lathe', 'create_tube', 'extrude_shape', 'edit_mesh', 'create_mesh', 'create_shapes', 'update_mesh', 'duplicate'];

/** how many objects one set_geometry call reshapes, and ops one edit_mesh call runs */
const MAX_UPDATES = 100;
const MAX_OPS = 20;
const TUBE_MAX_POINTS = 200;
const TUBE_MAX_RADIUS = 50;

/** types set_geometry may change a primitive INTO (Terrain is made, not converted) */
/** diorama2: the smallest size (metres) any primitive takes from an agent — create_objects params and set_geometry alike */
export const MIN_SIZE = 0.001;

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

/**
 * mcp-shapes: put a freshly made object (still at the scene root, already announced) into `parentUuid` and give it
 * its LOCAL pose there — create_objects' order: nest first, then place. attach() keeps the world pose, so placing
 * first read every coordinate as world space and the part landed at the inverse of the group's transform.
 * @param {any} object @param {any} args @param {{position?: number[], rotation?: number[], scale?: number[]}} pose
 * @returns {string | null} a warning when parentUuid names no group
 */
function nestLocal(object, args, pose) {
	const target = parentTarget(args.parentUuid);
	if (!target) return null;
	// diorama2: callers check parentTarget BEFORE making anything; a parent gone since then is still said
	if ('error' in target) return target.error;
	moveObjectToGroup(object.uuid, target.parent.uuid, { anyParent: true });
	const before = { pos: object.position.toArray(), rot: [object.rotation.x, object.rotation.y, object.rotation.z], scale: object.scale.toArray() };
	if (pose.position) object.position.fromArray(pose.position);
	if (pose.rotation) object.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
	if (pose.scale) object.scale.fromArray(pose.scale);
	const after = { pos: object.position.toArray(), rot: [object.rotation.x, object.rotation.y, object.rotation.z], scale: object.scale.toArray() };
	pokeScene();
	broadcast({ type: 'move', uuid: object.uuid, pos: after.pos, rot: after.rot, scale: after.scale });
	recordTransform({ uuid: object.uuid, before, after });
	return null;
}

/** G7: has a person (or edit_mesh) changed this object's vertices by hand? @param {any} object */
const handEdited = (object) => !!(object?.userData?.vertexEdited || object?.userData?.faceEdited);

const HAND_EDITED =
	'its vertices were edited by hand (Edit Mesh / sculpt / edit_mesh) and rebuilding from params would throw those edits away — pass force: true to rebuild anyway';

/** a colour an AI may pass: hex or a plain CSS name, else null @param {any} v */
const colorOf = (v) => toHexColor(v) ?? (typeof v === 'string' && /^[a-z]{3,20}$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

/**
 * Check a param patch against a registry spec. Sizes are clamped to MIN_SIZE (diorama2; the Inspector's minimum before) and to
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
			// diorama2: ONE small minimum for every primitive's sizes (an Octahedron radius clamped to 0.1 while a
			// Sphere took 0.006): a size the Inspector starts above 0 may go down to MIN_SIZE here
			const lo = gtype !== 'Terrain' && row.kind === 'slider' && (row.min ?? 0) > 0 ? MIN_SIZE : (row.min ?? -1000);
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
	const target = parentTarget(args.parentUuid);
	if (target && 'error' in target) return { error: target.error };
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
	// mcp-shapes: in a group the path is in the GROUP's space — the tube sits at the path's centre there
	const warning = nestLocal(mesh, args, { position: made.center, rotation: [0, 0, 0], scale: [1, 1, 1] });
	st.commitSplineEdit(mesh.uuid, stub, made.record);
	const physics = aiCreatePhysics(args, undefined);
	if (physics) setPhysicsFor(mesh.uuid, physics);
	const warnings = [...(warning ? [warning] : []), ...applyShadowFlags(mesh, args)];
	return { created: [{ uuid: mesh.uuid, name: mesh.name, points: made.record.points.length, position: made.center.map(r3), ...(warnings.length ? { warnings } : {}) }] };
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

/** a lathe's params from the agent's args, or the error @param {any} args @returns {{params: Record<string, any>} | {error: string}} */
function latheParamsOf(args) {
	const profile = points2(args?.profile, 'profile', 2, PROFILE_MAX_POINTS);
	if (typeof profile === 'string') return { error: profile };
	if (profile.some((p) => p[0] < 0)) return { error: 'profile: x is the radius from the Y axis, so it cannot be negative' };
	/** @type {Record<string, any>} */
	const params = { points: profile };
	if (args.segments !== undefined) params.segments = Number(args.segments);
	if (args.phiStart !== undefined) params.phiStart = Number(args.phiStart);
	if (args.phiLength !== undefined) params.phiLength = Number(args.phiLength);
	return { params };
}

/** @param {CreateBase} createBase @param {any} args */
function createLatheTool(createBase, args) {
	const made = latheParamsOf(args);
	if ('error' in made) return { error: made.error };
	return createParametric(createBase, 'Lathe', args, made.params);
}

/** an extrusion's params from the agent's args, or the error @param {any} args @returns {{params: Record<string, any>} | {error: string}} */
function extrudeParamsOf(args) {
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
	return { params };
}

/** @param {CreateBase} createBase @param {any} args */
function extrudeShapeTool(createBase, args) {
	const made = extrudeParamsOf(args);
	if ('error' in made) return { error: made.error };
	return createParametric(createBase, 'Extrude', args, made.params);
}

// ---- G6 create_mesh --------------------------------------------------------------------------------

/**
 * mcp-shapes: create_mesh `materials` = the slots faceMaterials index into: [{color, roughness, metalness, opacity,
 * emissive}]. Checked here (an error names the slot) and built as MeshStandardMaterial.
 * @param {any} list @returns {{specs: any[]} | {error: string}}
 */
export function meshMaterialSpecs(list) {
	if (list === undefined) return { specs: [] };
	if (!Array.isArray(list) || !list.length || list.length > MESH_MAX_MATERIALS) return { error: 'materials: a list of 1-' + MESH_MAX_MATERIALS + ' {color, roughness, metalness, …}' };
	/** @type {any[]} */
	const specs = [];
	for (let i = 0; i < list.length; i++) {
		const m = list[i];
		const at = 'materials[' + i + ']';
		if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: at + ': an object like {"color": "#aa6633", "roughness": 0.8}' };
		/** @type {any} */
		const spec = {};
		for (const [key, value] of Object.entries(m)) {
			if (key === 'color' || key === 'emissive') {
				const hex = colorOf(value);
				if (!hex) return { error: at + '.' + key + ': a hex colour like "#ff8800"' };
				spec[key] = hex;
			} else if (key === 'roughness' || key === 'metalness' || key === 'opacity' || key === 'emissiveIntensity') {
				const hi = key === 'emissiveIntensity' ? 100 : 1;
				if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > hi) return { error: at + '.' + key + ': a number from 0 to ' + hi };
				spec[key] = value;
			} else if (key === 'name') spec.name = String(value).slice(0, 60);
			else return { error: at + '.' + key + ': not a material field — color, roughness, metalness, opacity, emissive, emissiveIntensity, name' };
		}
		specs.push(spec);
	}
	return { specs };
}

/** @param {any} spec one meshMaterialSpecs entry @param {string} fallback colour @param {any} args */
function meshMaterial(spec, fallback, args) {
	const m = new THREE.MeshStandardMaterial({ roughness: spec.roughness ?? 0.85, metalness: spec.metalness ?? 0 });
	m.color.set(spec.color ?? fallback);
	if (spec.emissive) m.emissive.set(spec.emissive);
	if (spec.emissiveIntensity !== undefined) m.emissiveIntensity = spec.emissiveIntensity;
	if (spec.opacity !== undefined && spec.opacity < 1) {
		m.opacity = spec.opacity;
		m.transparent = true;
	}
	if (spec.name) m.name = spec.name;
	// mcp-shapes: per-vertex colours multiply the slot's colour; flatShading = one normal per triangle in the shader
	if (Array.isArray(args.colors)) m.vertexColors = true;
	if (args.flatShading === true) m.flatShading = true;
	return m;
}

/**
 * 85b G9: `subdivide: 1-2` smooths the polygon mesh the call gives (Catmull-Clark: corners round off, a cube of six
 * quads comes out a rounded box), checked against the caps BEFORE it runs. The input is checked first as given, so
 * an error names the index the caller sent. @param {any} args @param {number} slots
 * @returns {{args: any, levels: number} | {error: string}}
 */
export function subdividedArgs(args, slots = 0) {
	if (args?.subdivide === undefined || args.subdivide === 0) return { args, levels: 0 };
	const levels = args.subdivide;
	if (levels !== 1 && levels !== 2) return { error: 'subdivide: 1 or 2 (each level smooths and makes about four times the faces)' };
	const plain = meshFromData(args, slots);
	if ('error' in plain) return plain;
	const size = subdivisionSize(args, levels);
	if (size.vertices > MESH_MAX_VERTICES || size.faces > MESH_MAX_FACES)
		return { error: 'subdivide: ' + levels + ' level' + (levels > 1 ? 's' : '') + ' would make about ' + size.faces + ' faces and ' + size.vertices + ' vertices; the caps are ' + MESH_MAX_FACES + ' faces and ' + MESH_MAX_VERTICES + ' vertices — send fewer faces or subdivide: 1' };
	const out = catmullClark(args, levels);
	return { args: { ...args, ...out, subdivide: undefined, smooth: args.smooth ?? true }, levels };
}

/**
 * diorama2: a create_mesh / update_mesh call with its `colors` made linear (vertexColorsLinear: sRGB by default, hex
 * allowed, colorSpace "linear" to pass numbers through) and colorSpace consumed. @param {any} args
 * @returns {{args: any} | {error: string}}
 */
function withLinearColors(args) {
	const made = vertexColorsLinear(args?.colors, args?.colorSpace);
	if ('error' in made) return made;
	if (args?.colors === undefined && args?.colorSpace === undefined) return { args };
	const { colorSpace: _c, ...rest } = args;
	return { args: made.colors ? { ...rest, colors: made.colors } : rest };
}

/** 85b G6b: what each data mesh was made from, kept in THIS tab for update_mesh {patch} (a patch edits the authored
 * vertex list, which the triangle soup on the wire no longer holds) @type {Map<string, any>} */
const meshSources = new Map();

/** @param {any} args */
async function createMeshTool(args) {
	const lin = withLinearColors(args);
	if ('error' in lin) return { error: lin.error };
	args = lin.args;
	const mats = meshMaterialSpecs(args.materials);
	if ('error' in mats) return { error: mats.error };
	const source = args;
	const sub = subdividedArgs(args, mats.specs.length);
	if ('error' in sub) return { error: sub.error };
	args = sub.args;
	const data = meshFromData(args, mats.specs.length);
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
	if (data.colors) stub.setAttribute('color', new THREE.Float32BufferAttribute(data.colors.slice(0, 9), 3));
	stub.computeVertexNormals();
	const mesh = new THREE.Mesh(stub);
	// diorama2: vertex colours MULTIPLY the material colour, so with colors and no color the material is white (a
	// palette pastel used to tint every vertex colour); a slot with its own color keeps it
	const base = colorOf(args.color) ?? (data.colors ? '#ffffff' : paletteColorFor(mesh.uuid));
	// one slot = a plain material; several = an array, drawn through the geometry groups the meshgeo carries
	const slots = mats.specs.length ? mats.specs.map((spec) => meshMaterial(spec, base, args)) : [meshMaterial({}, base, args)];
	mesh.material = slots.length > 1 ? slots : slots[0];
	mesh.name = String(args.name || 'Mesh').slice(0, 120);
	if (args.smooth === true) mesh.userData.shading = 'smooth';
	const target = parentTarget(args.parentUuid);
	if (target && 'error' in target) return { error: target.error };
	const nested = !!target;
	const pose = shapePose(args, nested);
	if ('error' in pose) return { error: pose.error };
	// at the root the pose rides the `object` message; in a group it is set AFTER nesting (nestLocal)
	if (!nested) {
		if (pose.position) mesh.position.fromArray(pose.position);
		if (pose.rotation) mesh.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
		if (pose.scale) mesh.scale.fromArray(pose.scale);
	}
	group.add(mesh);
	pokeScene();
	recordObjectPresence('create', mesh);
	broadcast({ type: 'object', element: mesh.toJSON() });
	/** @type {string[]} */
	const warnings = [];
	const warning = nestLocal(mesh, args, nested ? pose : {});
	if (warning) warnings.push(warning);
	const before = { positions: data.positions.slice(0, 9), groups: null, uvs: null, faces: null };
	// a single slot draws every triangle: its groups would only mark them all slot 0
	const after = { positions: data.positions, groups: slots.length > 1 ? data.groups : null, uvs: data.uvs, faces: data.partition, ...(data.colors ? { colors: data.colors } : {}) };
	if (!fe.commitMeshGeoTriple(mesh.uuid, before, after)) return { error: 'the mesh is too large to sync', created: [{ uuid: mesh.uuid, name: mesh.name }] };
	const physics = aiCreatePhysics(args, undefined);
	if (physics) setPhysicsFor(mesh.uuid, physics);
	warnings.push(...applyShadowFlags(mesh, args));
	meshSources.set(mesh.uuid, { source: pickMeshSource(source), levels: sub.levels, slots: mats.specs.length });
	return {
		created: [
			{
				uuid: mesh.uuid,
				name: mesh.name,
				triangles: data.triangles,
				...(sub.levels ? { subdivided: sub.levels } : {}),
				faces: data.partition.length,
				...(slots.length > 1 ? { materials: slots.length } : {}),
				...(data.colors ? { vertexColors: true } : {}),
				...(warnings.length ? { warnings } : {})
			}
		]
	};
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

// ---- mcp-shapes: create_shapes, many shapes in one call -------------------------------------------

/**
 * What a create tool would refuse, checked BEFORE anything is made (a batch makes all or nothing up front).
 * @param {string} tool @param {any} args @returns {string | null}
 */
function shapeArgsError(tool, args) {
	const pose = shapePose(args, false);
	if ('error' in pose) return pose.error;
	if (args.color !== undefined && !colorOf(args.color)) return 'color: a hex colour like "#ff8800"';
	/** @type {any} */
	let made;
	const parent = parentTarget(args.parentUuid);
	if (parent && 'error' in parent) return parent.error;
	if (tool === 'create_mesh') {
		const lin = withLinearColors(args);
		if ('error' in lin) return lin.error;
		args = lin.args;
		const mats = meshMaterialSpecs(args.materials);
		const sub = 'error' in mats ? mats : subdividedArgs(args, mats.specs.length);
		made = 'error' in sub ? sub : meshFromData(/** @type {any} */ (sub).args, /** @type {any} */ (mats).specs.length);
	}
	else if (tool === 'create_tube') made = tubeRecordOf(args);
	else if (tool === 'create_lathe') made = latheParamsOf(args);
	else if (tool === 'extrude_shape') made = extrudeParamsOf(args);
	return made && 'error' in made ? made.error : null;
}

/** @param {any} args @param {CreateBase} createBase */
async function createShapesTool(args, createBase) {
	const checked = checkShapes(args?.shapes);
	if ('error' in checked) return { error: checked.error, ...(checked.errors.length > 1 ? { errors: checked.errors } : {}) };
	/** @type {string[]} */
	const errors = [];
	checked.entries.forEach((e, i) => {
		const why = shapeArgsError(e.tool, e.args);
		if (why) errors.push('shapes[' + i + '] (' + e.action + '): ' + why);
	});
	if (errors.length) return { error: 'nothing was made — ' + errors[0], errors };
	/** @type {any[]} */
	const created = [];
	for (let i = 0; i < checked.entries.length; i++) {
		const e = checked.entries[i];
		const r = await geometryTool(e.tool, e.args, createBase);
		const rows = Array.isArray(r?.created) ? r.created : [];
		if (r?.error) created.push({ index: i, action: e.action, error: r.error, ...(rows[0]?.uuid ? { uuid: rows[0].uuid } : {}) });
		else for (const row of rows) created.push({ index: i, action: e.action, ...row });
	}
	const uuids = created.filter((c) => c.uuid && !c.error).map((c) => c.uuid);
	if (!uuids.length) return { error: 'nothing was made: ' + (created[0]?.error ?? 'no shapes'), created };
	const failed = created.filter((c) => c.error).length;
	return { created, uuids, ...(failed ? { warning: failed + ' of ' + created.length + ' shapes failed — see errors' } : {}) };
}

// ---- G6b update_mesh ---------------------------------------------------------------------------------

/** the authored fields of a create_mesh / update_mesh call @param {any} a */
function pickMeshSource(a) {
	/** @type {any} */
	const out = { vertices: a.vertices, faces: a.faces };
	for (const k of ['uvs', 'colors', 'faceMaterials']) if (a[k] !== undefined) out[k] = a[k];
	return out;
}

/** a mesh made from data (G6): not a primitive, not terrain, not an import — a plain BufferGeometry mesh @param {any} o */
function isDataMesh(o) {
	return !!o?.isMesh && !o.userData?.geometryParams && !o.userData?.terrain && !o.userData?.packRef && o.geometry?.type === 'BufferGeometry' && !o.userData?.imported;
}

/**
 * 85b G6b: new data for a mesh create_mesh made, by uuid — mode replace (every vertex and face again) or patch
 * (vertices from `offset` replaced in the authored list; faces kept). Same checks and caps as create_mesh, normals
 * recomputed, the physics shape rebuilt, ONE meshgeo entry (one undo step), replicated.
 * @param {any} args
 */
async function updateMeshTool(args) {
	const lin = withLinearColors(args);
	if ('error' in lin) return { error: lin.error };
	args = lin.args;
	const uuid = String(args.uuid ?? args.object ?? '');
	const object = uuid && objectOf(uuid);
	if (!object) return { error: 'uuid: no object with that uuid' };
	if (!isDataMesh(object)) return { error: 'update_mesh changes meshes made with create_mesh; for a primitive use set_geometry, to model any mesh use edit_mesh' };
	const lock = lockSkip(uuid, object);
	if (lock) return { error: String(lock) };
	const mode = args.mode ?? (args.offset !== undefined ? 'patch' : 'replace');
	const known = meshSources.get(uuid);
	/** @type {any} */
	let next;
	if (mode === 'replace') {
		if (!Array.isArray(args.vertices) || !Array.isArray(args.faces)) return { error: 'replace: give vertices and faces (the whole mesh again)' };
		next = pickMeshSource(args);
	} else if (mode === 'patch') {
		if (!known) return { error: 'patch needs the vertex list this mesh was made from, which this tab no longer has (it was made in another tab, or before a reload): send mode "replace" with every vertex and face' };
		const offset = args.offset ?? 0;
		const verts = known.source.vertices;
		if (!Number.isInteger(offset) || offset < 0 || offset > verts.length) return { error: 'offset: the first vertex to replace, 0-' + verts.length };
		if (!Array.isArray(args.vertices) || !args.vertices.length) return { error: 'patch: vertices from offset on' };
		if (offset + args.vertices.length > verts.length) return { error: 'patch: vertices ' + offset + '-' + (offset + args.vertices.length - 1) + ' run past the mesh\'s ' + verts.length + ' (append with mode "replace")' };
		const v = verts.slice();
		args.vertices.forEach((/** @type {any} */ p, /** @type {number} */ i) => (v[offset + i] = p));
		next = { ...known.source, vertices: v };
		for (const k of ['uvs', 'colors']) {
			if (args[k] === undefined) continue;
			if (!known.source[k]) return { error: k + ': this mesh has no ' + k + ' to patch; send mode "replace"' };
			const list = known.source[k].slice();
			args[k].forEach((/** @type {any} */ p, /** @type {number} */ i) => (list[offset + i] = p));
			next[k] = list;
		}
	} else return { error: 'mode: replace or patch' };
	const slots = Array.isArray(object.material) ? object.material.length : 0;
	if (next.faceMaterials !== undefined && !slots) return { error: 'faceMaterials: this mesh has one material; make it again with materials to have several' };
	const levels = args.subdivide ?? (mode === 'patch' ? known?.levels ?? 0 : 0);
	const sub = subdividedArgs({ ...next, subdivide: levels }, slots);
	if ('error' in sub) return { error: sub.error };
	const data = meshFromData(sub.args, slots);
	if ('error' in data) return { error: data.error };
	const fe = await import('$lib/faceEdit');
	const tris = fe.readTriangles(object.geometry);
	const before = { positions: fe.trisToPositions(tris), groups: fe.trisToGroups(tris), uvs: fe.trisToUVs(tris), faces: readStoredFaces(object.geometry) };
	const after = { positions: data.positions, groups: slots > 1 ? data.groups : null, uvs: data.uvs, faces: data.partition, ...(data.colors ? { colors: data.colors } : {}) };
	if (!fe.commitMeshGeoTriple(uuid, before, after)) return { error: 'the mesh is too large to sync' };
	if (args.smooth !== undefined || sub.levels) object.userData.shading = args.smooth === false ? 'flat' : sub.levels || args.smooth ? 'smooth' : object.userData.shading;
	physicsShapeChanged(uuid);
	meshSources.set(uuid, { source: next, levels: sub.levels, slots });
	return { updated: [{ uuid, ok: true, mode, triangles: data.triangles, ...(sub.levels ? { subdivided: sub.levels } : {}) }] };
}

// ---- diorama2 duplicate -----------------------------------------------------------------------------

/** copies one duplicate call makes */
export const DUPLICATE_MAX = 50;
const AXES = /** @type {const} */ (['x', 'y', 'z']);
const FULL = Math.PI * 2 - 1e-6;

/**
 * Is this parametric primitive its own mirror image across its local `axis` plane (vertex for vertex, up to order)?
 * Then a mirror needs no new triangles and the copy keeps its editable params. Round shapes need an EVEN segment
 * count for the x / z mirror (an odd ring is not symmetric across both planes).
 * @param {any} geometry @param {number} a 0 x, 1 y, 2 z
 */
export function mirrorSymmetric(geometry, a) {
	const p = geometry?.parameters ?? {};
	const even = (/** @type {any} */ n) => Number.isInteger(n) && n % 2 === 0;
	switch (geometry?.type) {
		case 'BoxGeometry':
			return true;
		case 'SphereGeometry':
			if ((p.phiLength ?? Math.PI * 2) < FULL || (p.thetaLength ?? Math.PI) < Math.PI - 1e-6 || (p.thetaStart ?? 0) !== 0 || (p.phiStart ?? 0) !== 0) return false;
			return a === 1 || a === 2 || even(p.widthSegments);
		case 'CylinderGeometry':
		case 'ConeGeometry':
			if ((p.thetaLength ?? Math.PI * 2) < FULL || (p.thetaStart ?? 0) !== 0) return false;
			if (a === 1) return geometry.type === 'CylinderGeometry' && p.radiusTop === p.radiusBottom;
			return a === 0 || even(p.radialSegments);
		case 'CapsuleGeometry':
			return a === 1 || even(p.radialSegments);
		case 'TorusGeometry':
			if ((p.arc ?? Math.PI * 2) < FULL) return false;
			return a !== 0 || even(p.tubularSegments);
		default:
			return false;
	}
}

/**
 * The mirrored triangle soup of a geometry across its local `a` plane: the coordinate negated, each triangle's
 * corners reversed (b and c swap) so it still faces outward, uvs / colours / material slots carried with their
 * corner. Pure (THREE only). @param {any} fe faceEdit (readTriangles + trisTo*) @param {any} geometry @param {number} a
 */
export function mirroredSoup(fe, geometry, a) {
	const tris = fe.readTriangles(geometry);
	const flipped = tris.map((/** @type {any} */ t) => {
		const m = (/** @type {any} */ v) => {
			const c = v.clone();
			c.setComponent(a, -c.getComponent(a));
			return c;
		};
		/** @type {any} */
		const out = [m(t[0]), m(t[2]), m(t[1])];
		if (t.mi !== undefined) out.mi = t.mi;
		if (t.uv) out.uv = [t.uv[0], t.uv[2], t.uv[1]];
		return out;
	});
	/** @type {number[] | null} */
	let colors = null;
	const col = geometry.attributes.color;
	if (col) {
		const index = geometry.index;
		colors = [];
		const n = index ? index.count : geometry.attributes.position.count;
		for (let i = 0; i < n; i += 3)
			for (const o of [0, 2, 1]) {
				const j = index ? index.getX(i + o) : i + o;
				colors.push(col.getX(j), col.getY(j), col.getZ(j));
			}
	}
	return {
		before: { positions: fe.trisToPositions(tris), groups: fe.trisToGroups(tris), uvs: fe.trisToUVs(tris), faces: readStoredFaces(geometry) },
		after: { positions: fe.trisToPositions(flipped), groups: fe.trisToGroups(flipped), uvs: fe.trisToUVs(flipped), faces: readStoredFaces(geometry), ...(colors ? { colors } : {}) }
	};
}

/**
 * A node's local transform conjugated by the mirror across axis `a` (R·T·R): the coordinate negated, the rotation's
 * other two quaternion parts negated, the scale unchanged. Applied to every node of a copied tree, with the
 * remaining R baked into each mesh's triangles, the whole tree is the mirror image of the original with only
 * proper rotations and positive scales. @param {any} node @param {number} a
 */
export function mirrorLocalPose(node, a) {
	node.position.setComponent(a, -node.position.getComponent(a));
	const q = node.quaternion;
	q.set(a === 0 ? q.x : -q.x, a === 1 ? q.y : -q.y, a === 2 ? q.z : -q.z, q.w);
	node.rotation.setFromQuaternion(q);
}

/** a node's pose as history and the `move` message carry it @param {any} o */
const poseOf = (o) => ({ pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() });

/**
 * duplicate {uuid, count?, offset?, mirror?, parentUuid?}: copies of an object (its children, materials, behaviour,
 * physics) through the editor's own Duplicate — no geometry is resent. count copies step by `offset` (the parent's
 * space, metres); mirror "x"|"y"|"z" makes each copy the mirror image across that plane through the PARENT's
 * origin (the group's centre line — a left arm becomes a right arm) with its triangles re-wound so it still faces
 * out. parentUuid nests the copies (they keep their place in the world). One undo step.
 * @param {any} args
 */
async function duplicateTool(args) {
	const uuid = String(args.uuid ?? args.object ?? '');
	const source = uuid && objectOf(uuid);
	if (!source) return { error: 'uuid: no object with that uuid (list_scene lists them)' };
	if (source.isLight || source.isCamera) return { error: 'duplicate copies shapes and models; for a light or a camera, create a new one' };
	const count = args.count ?? 1;
	if (!Number.isInteger(count) || count < 1 || count > DUPLICATE_MAX) return { error: 'count: 1-' + DUPLICATE_MAX + ' copies (for hundreds over a surface, use scatter with source)' };
	const a = args.mirror === undefined ? -1 : AXES.indexOf(String(args.mirror).toLowerCase());
	if (args.mirror !== undefined && a < 0) return { error: 'mirror: "x", "y" or "z" — the axis the mirror flips' };
	let offset = args.offset;
	if (offset !== undefined && !(Array.isArray(offset) && offset.length === 3 && offset.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1000)))
		return { error: 'offset: [x, y, z] metres between copies, in the parent\'s space' };
	if (offset === undefined) {
		// a row to the side by default (the object's own width and a gap); a mirror copy stays on the mirror line
		const size = new THREE.Box3().setFromObject(source, true).getSize(new THREE.Vector3());
		offset = a >= 0 ? [0, 0, 0] : [r3(Math.max(size.x, 0.1) + 0.25), 0, 0];
	}
	const target = parentTarget(args.parentUuid);
	if (target && 'error' in target) return { error: target.error };
	const { duplicateObject } = await import('$lib/objectActions');
	const fe = a >= 0 ? await import('$lib/faceEdit') : null;
	const base = String(args.name || (source.name || source.type) + (a >= 0 ? ' mirror' : ' copy')).slice(0, 110);
	/** @type {any[]} */
	const created = [];
	/** @type {string[]} */
	const warnings = [];
	let flipped = 0;
	let kept = 0;
	for (let i = 1; i <= count; i++) {
		const clone = duplicateObject(source.uuid, { select: false, name: count > 1 ? base + ' ' + i : base, at: source.position.toArray() });
		if (!clone) return created.length ? { created, warning: 'stopped at copy ' + i + ': it could not be made' } : { error: 'the copy could not be made' };
		/** @type {Map<any, any>} */
		const before = new Map();
		clone.traverse((/** @type {any} */ n) => before.set(n, poseOf(n)));
		if (a >= 0 && fe) {
			clone.traverse((/** @type {any} */ n) => mirrorLocalPose(n, a));
			/** @type {any[]} */
			const meshes = [];
			clone.traverse((/** @type {any} */ n) => n.isMesh && n.geometry?.attributes?.position && meshes.push(n));
			for (const m of meshes) {
				if (!m.isSkinnedMesh && !m.isInstancedMesh && !m.userData?.vertexEdited && !m.userData?.faceEdited && mirrorSymmetric(m.geometry, a)) {
					kept++;
					continue;
				}
				// the copy shares its source's geometry (Object3D.clone): give it its own before the swap
				m.geometry = m.geometry.clone();
				const soup = m.isSkinnedMesh || m.isInstancedMesh ? null : mirroredSoup(fe, m.geometry, a);
				if (soup && fe.commitMeshGeoTriple(m.uuid, soup.before, soup.after)) {
					physicsShapeChanged(m.uuid);
					flipped++;
					continue;
				}
				// too big to sync as triangles (or skinned): a negative scale is the same mirror — three re-winds it
				m.scale.setComponent(a, -m.scale.getComponent(a));
				warnings.push((m.name || 'a mesh') + ' is mirrored by a negative scale (too large to rewrite)');
			}
		}
		if (offset.some((/** @type {number} */ v) => v !== 0)) clone.position.add(new THREE.Vector3(offset[0] * i, offset[1] * i, offset[2] * i));
		pokeScene();
		for (const [n, was] of before) {
			const now = poseOf(n);
			if (JSON.stringify(now) === JSON.stringify(was)) continue;
			broadcast({ type: 'move', uuid: n.uuid, pos: now.pos, rot: now.rot, scale: now.scale });
			recordTransform({ uuid: n.uuid, before: was, after: now });
		}
		if (target && target.parent !== clone.parent) moveObjectToGroup(clone.uuid, target.parent.uuid, { anyParent: true });
		created.push({ uuid: clone.uuid, name: clone.name, position: clone.position.toArray().map(r3) });
	}
	return {
		created,
		source: source.uuid,
		...(a >= 0 ? { mirror: AXES[a], rewound: flipped, symmetric: kept } : {}),
		...(warnings.length ? { warnings: [...new Set(warnings)] } : {})
	};
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
		case 'create_shapes':
			return createShapesTool(args ?? {}, createBase);
		case 'update_mesh':
			return updateMeshTool(args ?? {});
		case 'duplicate':
			return duplicateTool(args ?? {});
		default:
			return { error: 'unknown geometry tool ' + name };
	}
}

// ---- schemas (the shared registry: the assistant and every agent get these) -------------------------

const V3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const V2 = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
/** where a created shape goes — create_objects' fields */
/** diorama2: a vertex colour: [r, g, b] or a hex string */
const VCOLOR = { anyOf: [{ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }, { type: 'string', description: '#rrggbb' }] };
const COLOR_SPACE = { type: 'string', enum: ['srgb', 'linear'], description: 'how [r, g, b] colors numbers are meant: "srgb" (default — like a colour picker, as material colours are) or "linear"; hex is always sRGB' };

const PLACE = {
	name: { type: 'string' },
	position: V3,
	rotation: { ...V3, description: 'Euler radians' },
	scale: V3,
	color: { type: 'string', description: 'hex #rrggbb' },
	parentUuid: {
		type: 'string',
		description: 'uuid of a group (or any object, not a light or camera) to nest under — position / rotation / scale AND the shape\'s own points are then LOCAL to it (no position = its origin), so the part moves and turns with it. A uuid that is not in the scene is an error and nothing is made'
	},
	physics: { type: 'string', enum: ['static', 'dynamic'], description: 'default static' },
	castShadow: { type: 'boolean', description: 'cast a shadow (on by default)' },
	receiveShadow: { type: 'boolean', description: 'shadows fall on it (on by default)' }
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
								params: { type: 'object', description: 'param name → value; sizes from 0.001 m to 1 km (the same for every primitive), segment counts to their range' },
								path: { type: 'array', items: V3, description: 'tubes: a new path in the space the tube lives in (the scene, or its group)' },
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
				'A tube swept along a smooth 3D path — rail, pipe, cable, handrail, tentacle. path = [[x, y, z], …] in SCENE space, or in the group\'s own space with parentUuid (the object is placed at the path\'s centre); radius for all points or radii per point (tapers). Editable with set_geometry (path, radii, closed). Returns the uuid.',
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
					parentUuid: { type: 'string', description: "uuid of a group to nest under — path points are then LOCAL to that group, so the tube moves and turns with it" },
					physics: { type: 'string', enum: ['static', 'dynamic'] },
					castShadow: PLACE.castShadow,
					receiveShadow: PLACE.receiveShadow
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
				' faces; normals are computed (smooth: true for smooth shading, flatShading: true for hard facets). Colour it as you make it: materials [{color, roughness, metalness, …}] (up to ' +
				MESH_MAX_MATERIALS +
				' slots) with faceMaterials [slot per face, same order as faces] for parts in different colours; or colors (one per vertex: [r, g, b] 0-1 meant as sRGB, the way a colour picker or a hex code means them, or a "#rrggbb" string; colorSpace: "linear" takes the numbers as linear) for a painted gradient — they multiply the material colour, which is white when you give colors and no color. Material slots last through edit_mesh; vertex colours last only while an edit keeps the vertex count. subdivide: 1 or 2 smooths it (Catmull-Clark: a box of six quads becomes a rounded pebble, a few quads become a soft organic shape; each level about four times the faces, checked against the caps). Edit it afterwards with edit_mesh, or send new vertices with update_mesh. Returns the uuid.',
			parameters: {
				type: 'object',
				properties: {
					vertices: { type: 'array', items: V3, maxItems: MESH_MAX_VERTICES },
					faces: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, maxItems: MESH_MAX_FACES },
					uvs: { type: 'array', items: V2 },
					smooth: { type: 'boolean' },
					flatShading: { type: 'boolean', description: 'true = one flat normal per triangle (low-poly look)' },
					colors: { type: 'array', items: VCOLOR, maxItems: MESH_MAX_VERTICES, description: 'one colour per vertex, in the order of vertices: [r, g, b] (0-1, sRGB unless colorSpace is "linear") or "#rrggbb"' },
					colorSpace: COLOR_SPACE,
					materials: {
						type: 'array',
						minItems: 1,
						maxItems: MESH_MAX_MATERIALS,
						description: 'material slots faceMaterials points into',
						items: {
							type: 'object',
							properties: {
								color: { type: 'string', description: 'hex like "#aa6633"' },
								roughness: { type: 'number', minimum: 0, maximum: 1 },
								metalness: { type: 'number', minimum: 0, maximum: 1 },
								opacity: { type: 'number', minimum: 0, maximum: 1 },
								emissive: { type: 'string', description: 'hex glow colour' },
								emissiveIntensity: { type: 'number', minimum: 0, maximum: 100 },
								name: { type: 'string' }
							}
						}
					},
					faceMaterials: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: MESH_MAX_FACES, description: 'the materials slot of each face (0 = the first), one per face' },
					subdivide: { type: 'integer', minimum: 0, maximum: 2, description: 'smooth the mesh 1 or 2 levels (Catmull-Clark); smooth shading follows unless smooth: false' },
					...PLACE
				},
				required: ['vertices', 'faces']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'duplicate',
			description:
				'Copy an object you built (its children, materials, behaviour and physics come along; nothing is resent): count copies stepping by offset [x, y, z] metres in its parent\'s space (default: a row to the side), or mirror "x"|"y"|"z" = the mirror image across that plane through the PARENT\'s centre (in a group: its centre line — a left arm or ear becomes the right one; at the scene root: the world\'s), its triangles re-wound so normals stay right (Box and even-segment round shapes keep their params). parentUuid nests the copies (they keep their place in the world). One undo step; everyone sees it. For tens to hundreds of copies spread over a terrain or mesh, use scatter with source: <uuid>.',
			parameters: {
				type: 'object',
				properties: {
					uuid: { type: 'string', description: 'the object to copy' },
					count: { type: 'integer', minimum: 1, maximum: DUPLICATE_MAX, description: 'copies (default 1)' },
					offset: { ...V3, description: '[x, y, z] metres between copies in the parent\'s space; with mirror it moves the mirror image (default [0, 0, 0])' },
					mirror: { type: 'string', enum: ['x', 'y', 'z'], description: 'the axis the mirror flips: x makes a left part the right one' },
					parentUuid: { type: 'string', description: 'a group (or any object) to put the copies in' },
					name: { type: 'string', description: 'the copies\' name (numbered when several)' }
				},
				required: ['uuid']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'update_mesh',
			description:
				'New data for a mesh create_mesh made, by uuid, as ONE undo step: mode "replace" sends every vertex and face again (the same fields and caps as create_mesh, subdivide included); mode "patch" replaces vertices from offset on (vertices[0] lands on index offset) and keeps the faces — for moving part of a mesh made in this tab (after a reload, send "replace"). uvs/colors patch the same way. Primitives use set_geometry; to model any mesh use edit_mesh.',
			parameters: {
				type: 'object',
				properties: {
					uuid: { type: 'string' },
					mode: { type: 'string', enum: ['replace', 'patch'] },
					offset: { type: 'integer', minimum: 0, description: 'patch: the first vertex index the new vertices replace' },
					vertices: { type: 'array', items: V3, maxItems: MESH_MAX_VERTICES },
					faces: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, maxItems: MESH_MAX_FACES },
					uvs: { type: 'array', items: V2 },
					colors: { type: 'array', items: VCOLOR, maxItems: MESH_MAX_VERTICES, description: 'as create_mesh: [r, g, b] (sRGB unless colorSpace is "linear") or "#rrggbb" per vertex' },
					colorSpace: COLOR_SPACE,
					faceMaterials: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: MESH_MAX_FACES },
					smooth: { type: 'boolean' },
					subdivide: { type: 'integer', minimum: 0, maximum: 2 }
				},
				required: ['uuid', 'vertices']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_shapes',
			description:
				'Make up to ' +
				SHAPES_MAX +
				' shapes in ONE call and ONE undo step: shapes = [{action: "mesh", mesh: {…create_mesh\'s fields…}}, {action: "lathe", lathe: {…}}, …] with action one of ' +
				Object.keys(SHAPE_ACTIONS).join(', ') +
				' (the same fields as create_mesh / create_lathe / extrude_shape / create_tube, parentUuid included). Every entry is checked first and nothing is made if one is wrong (the error names its index, shapes[3]); the uuids come back in the order given.',
			parameters: {
				type: 'object',
				properties: {
					shapes: {
						type: 'array',
						minItems: 1,
						maxItems: SHAPES_MAX,
						items: {
							type: 'object',
							properties: {
								action: { type: 'string', enum: Object.keys(SHAPE_ACTIONS) },
								...Object.fromEntries(Object.entries(SHAPE_ACTIONS).map(([a, tool]) => [a, { type: 'object', description: tool + '\'s fields' }]))
							},
							required: ['action']
						}
					}
				},
				required: ['shapes']
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
	'vertices/faces, subdivide: 1-2 to smooth it; update_mesh sends it new vertices); create_shapes makes many in one call. With parentUuid every coordinate is the',
	'group\'s own (local) space. edit_mesh models a mesh: extrude/inset/bevel/subdivide faces picked by normal',
	'("up"), box or index; weld/smooth/dissolve vertices. Preview a selection with ops: [].',
	'duplicate copies an object (count + offset for a row, mirror: "x" for the other side of a group).'
].join('\n');

