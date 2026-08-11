// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry } from './history';
// UV3 painting commits through the EXISTING replicated texture path, so
// persistence (autosave / .tpscene / the object sync) and undo come free.
import { applyMap, materialAt, recordMaterialChange, copyTextureParams } from './materialsHandler';
// the unwrap REGISTRY: built-in projections, plus whatever a module registers
import { unwrap } from './uvUnwrap';
// UV1: read-only reuse of the mesh snapshot pipeline. faceEdit owns the triangle
// <-> geometry conversion AND the 'meshgeo' history kind (which already accepts a
// {positions, groups, uvs} triple and re-broadcasts uvs on undo), so a UV commit
// needs NO new wire type, NO new history kind, and NOT ONE line changed in
// faceEdit.js — which matters because the mesh-hardening lane is rewriting it in
// parallel.
import {
	readTriangles,
	trisToPositions,
	trisToGroups,
	trisToUVs,
	applyMeshGeo,
	triangleCount,
	// UV5 reads the Edit Mesh pick to scope the UV view — read-only, no writes
	faceEditObject,
	faceEditSelectedTris
} from './faceEdit';

// UV editor core (UV1). The editor is a 2D view of a mesh's `uv` attribute: the
// texture underneath, the UV triangles of ONE material slot on top, and draggable
// vertices. Editing UVs is a GEOMETRY edit as far as the app is concerned — there
// is no standalone uv channel — so a finished drag commits a full geometry
// snapshot through the existing meshgeo path: replicated, undoable, persisted.
//
// Everything here is math + stores; the component owns the canvas and the pointer
// gestures. No top-level DOM access (this module is imported during SSR prerender).

/** hard ceiling on a snapshot message (floats) — mirrors faceEdit's MAX_SNAPSHOT,
 * which is module-private there. ~5k tris. */
const MAX_SNAPSHOT = 45000;

/** quantization for "these two UV corners are the same point" (~1e-5) */
const UV_EPSILON = 1e-5;

/** which material slot the editor is showing @type {import('svelte/store').Writable<number>} */
export const uvActiveSlot = writable(0);
/** the active selection tool: 'select' (pointer) | 'box' | 'lasso'. UV3 adds
 * 'paint'. @type {import('svelte/store').Writable<string>} */
export const uvTool = writable('select');
/** UV3 brush @type {import('svelte/store').Writable<string>} */
export const uvBrushColor = writable('#ff3b30');
/** UV3 brush @type {import('svelte/store').Writable<number>} */
export const uvBrushSize = writable(24);

/**
 * UV5: restrict the editor to the faces picked in Edit Mesh mode.
 *
 * Why this is needed at all: a primitive's faces routinely SHARE UV space. A
 * default BoxGeometry has 24 uv entries but only FOUR distinct coordinates — all
 * six sides map onto the same 0..1 square — so a welded cluster is six corners
 * from six different faces, and dragging one moves the whole cube's mapping.
 * Nothing in UV space can tell those faces apart; the only thing that can is the
 * 3D face selection. 'all' | 'selection'. LOCAL pref.
 * @type {import('svelte/store').Writable<string>}
 */
export const uvFaceFilter = writable(
	typeof localStorage !== 'undefined' ? localStorage.getItem('uvFaceFilter') ?? 'all' : 'all'
);
if (typeof localStorage !== 'undefined')
	uvFaceFilter.subscribe((value) => {
		try {
			localStorage.setItem('uvFaceFilter', value);
		} catch {}
	});

/**
 * The triangles picked in Edit Mesh mode for `uuid`, or null when the filter is
 * off / nothing is picked / the mode is on another object. Triangle indices line
 * up with ours: both walk `readTriangles` order, one triangle per 3 elements.
 * @param {string|undefined|null} uuid @returns {Set<number>|null}
 */
export function selectedFaceTris(uuid) {
	if (!uuid || get(uvFaceFilter) !== 'selection') return null;
	if (get(faceEditObject) !== uuid) return null;
	const picked = get(faceEditSelectedTris);
	return picked?.length ? new Set(picked) : null;
}

/** materials as an array, whatever the object wears (a mesh may carry ONE
 * material or an array of slots) @param {any} object */
export function materialsOf(object) {
	const material = object?.material;
	if (!material) return [];
	return Array.isArray(material) ? material : [material];
}

/**
 * Which object the UV editor should show, given the selection and edit mode.
 * Four reported problems come back to this one question:
 *
 * - `selectedObject` is STICKY (it keeps the last object after a deselect), so
 *   deselecting left the previous object's texture on screen. The SET is what
 *   answers "is anything selected".
 * - Right-click ▸ Edit Mesh enters face-edit WITHOUT making the object the
 *   primary selection, so the editor stayed empty until you clicked the object
 *   first. An active edit session now counts as the target.
 * - An imported .obj/.gltf arrives as a GROUP with no geometry of its own, so
 *   resolve down to a child mesh that actually has UVs.
 * - Multi-select: the editor edits ONE object, so it takes the primary and the
 *   UI says how many are selected.
 *
 * @param {any} primary `$selectedObject` @param {string[]} set `$selectedObjects`
 * @param {string|null} editing an active mesh/face edit uuid, if any
 * @returns {any}
 */
export function uvTargetOf(primary, set, editing) {
	const group = get(objectsGroup);
	// an active edit session wins: you are demonstrably working on that object
	if (editing) {
		const edited = group?.getObjectByProperty('uuid', editing);
		if (edited) return meshWithUvs(edited);
	}
	// nothing selected — do NOT fall back to the sticky primary
	if (!set?.length) return null;
	const candidate =
		primary && primary.uuid && set.includes(primary.uuid)
			? primary
			: group?.getObjectByProperty('uuid', set[0]);
	return candidate ? meshWithUvs(candidate) : null;
}

/** The object itself when it is a mesh, else its first descendant mesh WITH uvs
 * (an imported .obj/.gltf is a Group of meshes), else its first mesh.
 * @param {any} object @returns {any} */
export function meshWithUvs(object) {
	if (!object) return null;
	if (object.geometry?.attributes?.position) return object;
	/** @type {any} */ let firstMesh = null;
	/** @type {any} */ let textured = null;
	object.traverse?.((/** @type {any} */ child) => {
		if (!child.geometry?.attributes?.position) return;
		if (!firstMesh) firstMesh = child;
		if (!textured && child.geometry.attributes.uv) textured = child;
	});
	return textured ?? firstMesh ?? null;
}

/**
 * The slot's texture IMAGE for the editor backdrop when there is no
 * `mapDataUrl`. An imported model's textures are real THREE.Textures that never
 * went through applyMap, so the editor drew an empty square for every OBJ/GLTF
 * import. `texture.image` is an HTMLImageElement / ImageBitmap / canvas, all of
 * which drawImage accepts — but an undecoded <img> has no size and would throw.
 * @param {any} object @param {number} slot @returns {any}
 */
export function textureImageOf(object, slot = 0) {
	const image = materialsOf(object)[slot]?.map?.image;
	if (!image) return null;
	return image.width || image.videoWidth ? image : null;
}

/**
 * Can the editor SHOW this object? Only needs geometry with a uv attribute.
 *
 * Deliberately separate from `uvEditable`: the snapshot cap exists because a
 * GEOMETRY commit has to fit one meshgeo message, which has nothing to do with
 * viewing a UV map or PAINTING (painting writes a texture, never the geometry).
 * Gating the whole editor on the cap meant any real model — a GLB over ~5000
 * triangles — showed no texture at all.
 * @param {any} object @returns {{ok: boolean, reason: string}}
 */
export function uvViewable(object) {
	if (!object?.geometry?.attributes?.position) return { ok: false, reason: 'Select a mesh to edit its UVs.' };
	if (!object.geometry.attributes.uv)
		return { ok: false, reason: 'This mesh has no texture coordinates to edit.' };
	return { ok: true, reason: '' };
}

/**
 * Can its UVs be DRAGGED? Viewable, and small enough that a commit fits one
 * snapshot message (a commit swaps the WHOLE geometry). Painting is unaffected.
 * @param {any} object @returns {{ok: boolean, reason: string}}
 */
export function uvEditable(object) {
	const viewable = uvViewable(object);
	if (!viewable.ok) return viewable;
	if (triangleCount(object) * 9 > MAX_SNAPSHOT)
		return {
			ok: false,
			reason: 'This mesh is too large to move UVs on (an edit could not sync), but you can still paint it.'
		};
	return { ok: true, reason: '' };
}

/** Above this triangle count the UV wireframe and its vertex handles are hidden:
 * a 100k-triangle model would draw 300k line segments and 300k handles every
 * frame. The texture still shows and painting still works. */
export const UV_WIRE_LIMIT = 20000;

/**
 * The UV triangles to draw, as flat screen-agnostic data: one entry per triangle
 * of the requested material slot, each carrying its three [u,v] corners AND the
 * uv-attribute INDICES those corners live at (so a drag can write them back).
 * Reads through `geometry.index` when the mesh is indexed.
 *
 * `geometry.groups` only MEAN a material slot when the object actually wears a
 * material ARRAY — three ignores groups entirely for a single material, and a
 * plain BoxGeometry ships six groups (materialIndex 0..5) so that a cube CAN be
 * six-material. Filtering an ordinary textured box by materialIndex therefore
 * hid ten of its twelve triangles. Same test as `preserveMaterialGroups`.
 * @param {any} object @param {number} slot
 * @param {Set<number>|null} [onlyTris] UV5: keep only these TRIANGLE indices
 *   (the Edit Mesh pick), so faces that share UV space can be edited apart
 * @returns {{corners: number[][], indices: number[], tri: number}[]}
 */
export function uvTriangles(object, slot, onlyTris = null) {
	const geometry = object?.geometry;
	const uv = geometry?.attributes?.uv;
	if (!uv) return [];
	const index = geometry.index;
	const count = index ? index.count : uv.count;
	const perSlot = Array.isArray(object.material) && object.material.length >= 2;
	const slotAt = perSlot ? slotRanges(geometry.groups, count) : () => 0;
	/** @type {{corners: number[][], indices: number[], tri: number}[]} */
	const out = [];
	for (let i = 0; i < count; i += 3) {
		if (slotAt(i) !== slot) continue;
		const tri = i / 3;
		if (onlyTris && !onlyTris.has(tri)) continue;
		const indices = [0, 1, 2].map((o) => (index ? index.getX(i + o) : i + o));
		out.push({ corners: indices.map((j) => [uv.getX(j), uv.getY(j)]), indices, tri });
	}
	return out;
}

/**
 * UV ISLANDS: triangles connected through SHARED UV CORNERS.
 *
 * Union-find over quantised (u,v), the shape of faceEdit's `shellsOfTris` — but keyed
 * in UV space, not position space, and that difference is the whole point. An island
 * is precisely a set of faces that is connected in 3D yet SEPARATE in UV space (a
 * seam), so welding by position would merge every island of a seamed mesh into one.
 * @param {{corners: number[][], indices: number[], tri: number}[]} tris
 * @returns {number[][]} groups of indices INTO `tris`
 */
export function uvIslandsOf(tris) {
	const n = tris.length;
	const parent = [...Array(n).keys()];
	const find = (/** @type {number} */ a) => {
		while (parent[a] !== a) {
			parent[a] = parent[parent[a]];
			a = parent[a];
		}
		return a;
	};
	const union = (/** @type {number} */ a, /** @type {number} */ b) => {
		parent[find(a)] = find(b);
	};
	/** @type {Map<string, number>} first triangle seen at each welded uv corner */
	const byCorner = new Map();
	tris.forEach((tri, ti) => {
		for (const corner of tri.corners) {
			const key = uvKey(corner[0], corner[1]);
			const first = byCorner.get(key);
			if (first === undefined) byCorner.set(key, ti);
			else union(first, ti);
		}
	});
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	for (let ti = 0; ti < n; ti++) {
		const root = find(ti);
		let list = groups.get(root);
		if (!list) groups.set(root, (list = []));
		list.push(ti);
	}
	return [...groups.values()];
}

/** quantised uv key, at the same tolerance `weldedCluster` welds with
 * @param {number} u @param {number} v */
function uvKey(u, v) {
	const q = 1 / UV_EPSILON;
	return Math.round(u * q) + ',' + Math.round(v * q);
}

/**
 * Grow a selection to every uv index in the same ISLAND. "Select linked" — the
 * counterpart of faceEdit's `selectLinkedFaces`, in UV space.
 * @param {any} object @param {number} slot @param {number[]} selected
 * @param {Set<number>|null} [onlyTris] @returns {number[]}
 */
export function expandToIslands(object, slot, selected, onlyTris = null) {
	const tris = uvTriangles(object, slot, onlyTris);
	if (!tris.length || !selected.length) return selected;
	const picked = new Set(selected);
	/** @type {Set<number>} */
	const out = new Set(selected);
	for (const island of uvIslandsOf(tris)) {
		const touches = island.some((ti) => tris[ti].indices.some((i) => picked.has(i)));
		if (!touches) continue;
		for (const ti of island) for (const i of tris[ti].indices) out.add(i);
	}
	return [...out];
}

/**
 * The UV bounding box of some uv indices. Nothing computed a SELECTION's bounds
 * before — every transform needs it as the pivot.
 * @param {any} object @param {Iterable<number>} indices
 * @returns {{uMin:number,vMin:number,uMax:number,vMax:number,cu:number,cv:number}|null}
 */
export function uvBounds(object, indices) {
	const uv = object?.geometry?.attributes?.uv;
	if (!uv) return null;
	let uMin = Infinity;
	let vMin = Infinity;
	let uMax = -Infinity;
	let vMax = -Infinity;
	let seen = 0;
	for (const i of indices) {
		if (i < 0 || i >= uv.count) continue;
		const u = uv.getX(i);
		const v = uv.getY(i);
		uMin = Math.min(uMin, u);
		uMax = Math.max(uMax, u);
		vMin = Math.min(vMin, v);
		vMax = Math.max(vMax, v);
		seen++;
	}
	if (!seen) return null;
	return { uMin, vMin, uMax, vMax, cu: (uMin + uMax) / 2, cv: (vMin + vMax) / 2 };
}

/**
 * Rotate / scale / flip uv indices about a pivot (their bounds centre by default).
 * ABSOLUTE writes, unlike `moveUvCluster`'s delta — but the same in-place mutation,
 * so it commits through `beginUvDrag`/`endUvDrag` like any other gesture (that pair
 * diffs whole attribute snapshots, so ANY rewrite between them replicates + undoes).
 * @param {any} object @param {number[]} indices
 * @param {{rotate?: number, scaleU?: number, scaleV?: number, flipU?: boolean, flipV?: boolean, pivot?: {cu: number, cv: number}}} options
 * @returns {boolean}
 */
export function transformUvCluster(object, indices, options = {}) {
	const uv = object?.geometry?.attributes?.uv;
	if (!uv || !indices?.length) return false;
	// the geometry was swapped under us (remote commit / undo) — same guard as
	// moveUvCluster, or we would write into a detached buffer
	if (dragSession && dragSession.uv !== uv) {
		dragSession = null;
		return false;
	}
	const pivot = options.pivot ?? uvBounds(object, indices);
	if (!pivot) return false;
	const rotate = options.rotate ?? 0;
	const cos = Math.cos(rotate);
	const sin = Math.sin(rotate);
	const su = (options.scaleU ?? 1) * (options.flipU ? -1 : 1);
	const sv = (options.scaleV ?? 1) * (options.flipV ? -1 : 1);
	for (const i of indices) {
		const du = (uv.getX(i) - pivot.cu) * su;
		const dv = (uv.getY(i) - pivot.cv) * sv;
		uv.setXY(i, pivot.cu + du * cos - dv * sin, pivot.cv + du * sin + dv * cos);
	}
	uv.needsUpdate = true;
	objectsGroup.update((v) => v);
	return true;
}

/**
 * Fit uv indices into the 0..1 square, preserving aspect (a non-uniform fit would
 * shear the texture across those faces).
 * @param {any} object @param {number[]} indices @param {number} [margin]
 * @returns {boolean}
 */
export function fitUvToSquare(object, indices, margin = 0.02) {
	const bounds = uvBounds(object, indices);
	if (!bounds) return false;
	const width = bounds.uMax - bounds.uMin;
	const height = bounds.vMax - bounds.vMin;
	const span = Math.max(width, height);
	if (!span) return false;
	const scale = (1 - margin * 2) / span;
	const uv = object.geometry.attributes.uv;
	for (const i of indices) {
		const u = margin + (uv.getX(i) - bounds.uMin) * scale;
		const v = margin + (uv.getY(i) - bounds.vMin) * scale;
		uv.setXY(i, u, v);
	}
	uv.needsUpdate = true;
	objectsGroup.update((v) => v);
	return true;
}

/** every uv index the given triangles touch — the scope a drag may weld inside
 * @param {{indices: number[]}[]} tris @returns {Set<number>} */
export function uvIndicesOf(tris) {
	/** @type {Set<number>} */
	const set = new Set();
	for (const tri of tris) for (const i of tri.indices) set.add(i);
	return set;
}

/** element index -> material slot (0 for an ungrouped geometry). Same shape as
 * faceEdit's private slotLookup. @param {any[]} groups @param {number} count */
function slotRanges(groups, count) {
	if (!groups?.length) return () => 0;
	const slots = new Int32Array(count);
	for (const group of groups) {
		const start = Math.max(group.start | 0, 0);
		const end = Math.min(start + (group.count | 0), count);
		for (let i = start; i < end; i++) slots[i] = group.materialIndex || 0;
	}
	return (/** @type {number} */ i) => slots[i] || 0;
}

/** how many material slots the editor should list @param {any} object */
export function slotCount(object) {
	const materials = materialsOf(object);
	return Math.max(materials.length, 1);
}

/**
 * Every uv-attribute index sitting at the SAME uv coordinate as `uvIndex`.
 * Dragging moves the whole welded cluster — that is what every 3D package does,
 * and a non-indexed mesh (OBJ imports, and anything that has been through a mesh
 * op) stores each corner separately, so moving one index alone would tear the
 * mapping apart.
 * @param {any} geometry @param {number} uvIndex
 * @param {Set<number>|null} [scope] UV5: weld only WITHIN these uv indices. On a
 *   cube every side shares the same four UV corners, so an unscoped weld drags
 *   all six faces — scoping to the visible/selected faces is what makes editing
 *   one side possible at all.
 * @returns {number[]}
 */
export function weldedCluster(geometry, uvIndex, scope = null) {
	const uv = geometry?.attributes?.uv;
	if (!uv || uvIndex < 0 || uvIndex >= uv.count) return [];
	const u = uv.getX(uvIndex);
	const v = uv.getY(uvIndex);
	/** @type {number[]} */
	const cluster = [];
	for (let i = 0; i < uv.count; i++) {
		if (scope && !scope.has(i)) continue;
		if (Math.abs(uv.getX(i) - u) <= UV_EPSILON && Math.abs(uv.getY(i) - v) <= UV_EPSILON)
			cluster.push(i);
	}
	return cluster;
}

/**
 * The uv-attribute index nearest to (u, v), or -1 when nothing is within
 * `radius` (both in UV units, so the caller converts its pixel tolerance).
 * Restricted to the given slot's triangles so a hidden slot can't be grabbed.
 * @param {any} object @param {number} slot @param {number} u @param {number} v @param {number} radius
 * @param {Set<number>|null} [onlyTris] UV5 face scope
 */
export function nearestUvIndex(object, slot, u, v, radius, onlyTris = null) {
	let best = -1;
	let bestDist = radius * radius;
	for (const tri of uvTriangles(object, slot, onlyTris))
		tri.corners.forEach((corner, c) => {
			const du = corner[0] - u;
			const dv = corner[1] - v;
			const dist = du * du + dv * dv;
			if (dist <= bestDist) {
				bestDist = dist;
				best = tri.indices[c];
			}
		});
	return best;
}

/**
 * Grow a set of uv indices to the full welded cluster of each member. Selecting
 * or marquee-hitting one corner has to take its co-located twins with it, or a
 * drag tears the mapping at every seam.
 * @param {any} geometry @param {Iterable<number>} indices
 * @param {Set<number>|null} [scope] UV5: weld only within these uv indices
 * @returns {number[]}
 */
export function expandClusters(geometry, indices, scope = null) {
	/** @type {Set<number>} */
	const out = new Set();
	for (const i of indices) {
		if (out.has(i)) continue;
		for (const j of weldedCluster(geometry, i, scope)) out.add(j);
	}
	return [...out];
}

/**
 * Every uv index of `slot` inside an axis-aligned UV-space rect (box select).
 * Corners exactly on the edge count as inside.
 * @param {any} object @param {number} slot
 * @param {{u0: number, v0: number, u1: number, v1: number}} rect
 * @param {Set<number>|null} [onlyTris] UV5 face scope
 * @returns {number[]}
 */
export function uvIndicesInRect(object, slot, rect, onlyTris = null) {
	const uMin = Math.min(rect.u0, rect.u1);
	const uMax = Math.max(rect.u0, rect.u1);
	const vMin = Math.min(rect.v0, rect.v1);
	const vMax = Math.max(rect.v0, rect.v1);
	/** @type {Set<number>} */
	const hit = new Set();
	for (const tri of uvTriangles(object, slot, onlyTris))
		tri.corners.forEach((corner, c) => {
			if (corner[0] >= uMin && corner[0] <= uMax && corner[1] >= vMin && corner[1] <= vMax)
				hit.add(tri.indices[c]);
		});
	return [...hit];
}

/**
 * Every uv index of `slot` inside a freehand polygon (lasso select), by the
 * even-odd ray-crossing rule. `polygon` is [[u,v], ...] and is treated as
 * closed. Fewer than 3 points selects nothing.
 * @param {any} object @param {number} slot @param {number[][]} polygon
 * @param {Set<number>|null} [onlyTris] UV5 face scope
 * @returns {number[]}
 */
export function uvIndicesInPolygon(object, slot, polygon, onlyTris = null) {
	if (!polygon || polygon.length < 3) return [];
	/** @type {Set<number>} */
	const hit = new Set();
	for (const tri of uvTriangles(object, slot, onlyTris))
		tri.corners.forEach((corner, c) => {
			if (pointInPolygon(corner[0], corner[1], polygon)) hit.add(tri.indices[c]);
		});
	return [...hit];
}

/** even-odd point-in-polygon @param {number} u @param {number} v @param {number[][]} poly */
function pointInPolygon(u, v, poly) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [ui, vi] = poly[i];
		const [uj, vj] = poly[j];
		// does the edge straddle the horizontal ray, and is the crossing to the right?
		if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
	}
	return inside;
}

/**
 * Run an unwrap backend over a mesh (or just the faces picked in Edit Mesh) and
 * commit the result.
 *
 * Scoped unwrap only rewrites the picked triangles' UVs and leaves every other face
 * exactly as it was — which is what makes it safe to unwrap one part of a model.
 * @param {string} uuid @param {string} backend @param {any} [options]
 * @param {Set<number>|null} [onlyTris]
 * @returns {boolean}
 */
export function unwrapObject(uuid, backend, options = {}, onlyTris = null) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return false;
	const editable = uvEditable(object);
	if (!editable.ok) {
		showToast(editable.reason);
		return false;
	}
	const triangles = readTriangles(object.geometry);
	// the backend sees only the faces in scope, but indices must map back to the FULL
	// triangle list so the commit can leave the rest untouched
	/** @type {number[]} */
	const targets = [];
	/** @type {any[]} */
	const faces = [];
	triangles.forEach((/** @type {any} */ tri, /** @type {number} */ i) => {
		if (onlyTris && !onlyTris.has(i)) return;
		targets.push(i);
		faces.push({ corners: [tri[0], tri[1], tri[2]], tri: i });
	});
	if (!faces.length) return false;
	const result = unwrap(backend, faces, options);
	if (!result?.uvs?.length) {
		showToast('That unwrap produced nothing');
		return false;
	}
	const before = readUvSnapshot(object);
	before.groups = before.groups ?? null;
	targets.forEach((triIndex, k) => {
		const corners = result.uvs[k];
		if (corners) triangles[triIndex].uv = corners.map((pair) => [pair[0], pair[1]]);
	});
	const positions = trisToPositions(triangles);
	if (positions.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	const after = { positions, groups: trisToGroups(triangles), uvs: trisToUVs(triangles) };
	applyMeshGeo(uuid, after.positions, after.groups, after.uvs);
	broadcastUvGeo(uuid, after);
	recordEntry({ kind: 'meshgeo', uuid, before, after });
	return true;
}

/**
 * UV4: assign TRIANGLES to a material slot.
 *
 * A triangle's slot lives in `geometry.groups`, which `readTriangles` reads onto each
 * triangle as `mi` and `trisToGroups` writes back — every mesh op already carries
 * `mi` through, but nothing ever SET it, so there was no way to say "these faces use
 * material 2". This writes it and commits through the same meshgeo triple every mesh
 * op uses, so replication, undo and persistence come free: positions are unchanged,
 * only the groups differ.
 *
 * The object must already have the slot (see `addMaterialSlot`) — three renders slot
 * N by walking the groups, so pointing a group at a material that does not exist
 * would draw nothing.
 * @param {string} uuid @param {Iterable<number>} tris triangle indices
 * @param {number} slot @returns {boolean}
 */
export function assignTrisToSlot(uuid, tris, slot) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return false;
	const slots = materialsOf(object);
	if (slot < 0 || slot >= slots.length) {
		showToast('That object has no material slot ' + slot);
		return false;
	}
	const wanted = new Set(tris);
	if (!wanted.size) return false;
	const before = readUvSnapshot(object);
	// `trisToGroups` returns NULL when every triangle is slot 0 — meaning "no groups
	// needed", which is true for a single material but NOT here: on undo,
	// applyMeshGeo would see no groups and fall back to carrying the CURRENT
	// (post-assign) ones over, so the assignment would not be undone at all. Make
	// the all-slot-0 state explicit instead.
	before.groups = before.groups ?? [{ start: 0, count: before.positions.length / 3, materialIndex: 0 }];
	const triangles = readTriangles(object.geometry);
	let changed = 0;
	triangles.forEach((/** @type {any} */ tri, /** @type {number} */ i) => {
		if (!wanted.has(i) || (tri.mi || 0) === slot) return;
		tri.mi = slot;
		changed++;
	});
	if (!changed) return false;
	const positions = trisToPositions(triangles);
	if (positions.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	const after = { positions, groups: trisToGroups(triangles), uvs: trisToUVs(triangles) };
	applyMeshGeo(uuid, after.positions, after.groups, after.uvs);
	broadcastUvGeo(uuid, after);
	recordEntry({ kind: 'meshgeo', uuid, before, after });
	return true;
}

/** a full {positions, groups, uvs} snapshot of an object's current geometry —
 * the shape the meshgeo wire message and the 'meshgeo' history kind both take
 * @param {any} object */
export function readUvSnapshot(object) {
	const tris = readTriangles(object.geometry);
	return { positions: trisToPositions(tris), groups: trisToGroups(tris), uvs: trisToUVs(tris) };
}

// --- drag session -----------------------------------------------------------
// A gesture is: beginUvDrag (snapshot the BEFORE) -> moveUvCluster xN (write the
// attribute in place for local feedback) -> endUvDrag (commit once). Positions
// never move, so there is no live preview broadcast: peers would pay a full
// snapshot per frame to watch a mapping they cannot see mid-drag. They get the
// result the moment the gesture ends.

/** @type {{uuid: string, before: any, uv: any} | null} */
let dragSession = null;

/**
 * Open a drag gesture on `uuid`. Stashes the BEFORE snapshot and the uv
 * attribute we are about to mutate — if a remote meshgeo or an undo swaps the
 * geometry mid-drag, `moveUvCluster` sees a different attribute object and
 * abandons the gesture rather than writing into a detached buffer.
 * @param {string} uuid @returns {boolean}
 */
export function beginUvDrag(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object || !uvEditable(object).ok) return false;
	dragSession = { uuid, before: readUvSnapshot(object), uv: object.geometry.attributes.uv };
	return true;
}

/** is a drag gesture open? */
export function uvDragging() {
	return !!dragSession;
}

/**
 * Move a welded cluster by (du, dv) in UV space. Writes the attribute in place
 * and pokes objectsGroup so the texture visibly slides on the model while the
 * user drags — THREE trees aren't reactive, the poke is the only signal.
 * @param {any} object @param {number[]} indices @param {number} du @param {number} dv
 */
export function moveUvCluster(object, indices, du, dv) {
	const uv = object?.geometry?.attributes?.uv;
	if (!uv || !indices?.length) return false;
	// the geometry was swapped under us (remote commit / undo) — drop the gesture
	if (dragSession && dragSession.uv !== uv) {
		dragSession = null;
		return false;
	}
	for (const i of indices) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
	uv.needsUpdate = true;
	objectsGroup.update((v) => v);
	return true;
}

/**
 * Close the gesture: swap the geometry to the edited snapshot locally, replicate
 * it, and record ONE undo entry for the whole drag. `applyMeshGeo` normalizes our
 * local geometry to the same index-expanded form peers and the undo replay hold,
 * so undo/redo round-trips exactly.
 * @param {string} uuid @returns {boolean} true when something was committed
 */
export function endUvDrag(uuid) {
	const session = dragSession;
	dragSession = null;
	if (!session || session.uuid !== uuid) return false;
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object) return false;
	const after = readUvSnapshot(object);
	if (!after.uvs || sameFloats(session.before.uvs, after.uvs)) return false;
	if (after.positions.length > MAX_SNAPSHOT) {
		showToast('That edit is too large to sync');
		return false;
	}
	applyMeshGeo(uuid, after.positions, after.groups, after.uvs);
	broadcastUvGeo(uuid, after);
	recordEntry({ kind: 'meshgeo', uuid, before: session.before, after });
	return true;
}

/** abandon an open gesture without committing (Esc / target changed) */
export function cancelUvDrag() {
	dragSession = null;
}

/** @param {number[] | null} a @param {number[] | null} b */
function sameFloats(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return false;
	return true;
}

// --- UV3: texture painting --------------------------------------------------
// A stroke draws onto an OFFSCREEN CANVAS per (uuid, slot) that becomes the
// material's map while painting, so the brush shows up on the model live. Peers
// see the stroke through throttled `uvpaint` segments (the drawMode cadence) and
// converge on the real thing when the stroke COMMITS: the finished canvas is
// encoded once and sent through the existing `objectParameters`/`map` path, so
// it persists, replicates to late joiners and undoes like any other texture.
// Per-stroke, not per-move: the encoded image is ~100-300 KB.

/** how many px the painting canvas is when a material has no texture yet */
const PAINT_CANVAS = 1024;
/** live-stroke broadcast interval (drawMode uses the same cadence) */
const PAINT_THROTTLE = 66;
/** a live stroke nobody finished is dropped after this (a peer vanished mid-drag) */
const STROKE_STALE_MS = 5000;

/** @type {Map<string, {canvas: any, texture: any, uuid: string, slot: number, seededFrom: string|null, flipY: boolean, previousMap: any}>} */
const paintCanvases = new Map();
/** @type {Map<string, {ts: number}>} */
const liveUvStrokes = new Map();
/** @type {{id: string, uuid: string, slot: number, before: string|null, sent: number, points: number[][]} | null} */
let paintStroke = null;
let strokeSeq = 0;

/** @param {string} uuid @param {number} slot */
const paintKey = (uuid, slot) => uuid + '#' + slot;

/**
 * The offscreen canvas for one (uuid, slot), SEEDED from the slot's current
 * texture so a stroke edits the existing image instead of replacing it, and
 * installed as the material's live map.
 *
 * Async on purpose: decoding the seed image is async, and a brush move that
 * lands before the seed finishes paints onto a blank canvas — which then commits
 * over the previous texture and DESTROYS it. (That is exactly what a second
 * stroke did: it wiped the first.) Callers must await this before the first
 * segment. `seededFrom` caches which image the canvas currently represents, so
 * stroke-after-stroke on the same slot needs no reseed at all.
 * @param {string} uuid @param {number} slot @returns {Promise<any>}
 */
async function paintSurface(uuid, slot) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const material = materialAt(object, slot);
	if (!material) return null;
	const url = material.userData?.mapDataUrl ?? null;
	// An IMPORTED texture (GLB/OBJ) never went through applyMap, so there is no
	// dataURL to seed from — seed from the live texture's own image instead, or
	// the first stroke commits a blank white sheet OVER the model's texture.
	const live = url ? null : textureImageOf(object, slot);
	const seedKey = url ?? (live ? liveSeedKey(material) : null);
	const key = paintKey(uuid, slot);
	const existing = paintCanvases.get(key);
	// reuse only while it still represents the CURRENT image — an undo, a peer's
	// commit or a dropped image all change it out from under us
	if (existing && existing.seededFrom === seedKey) {
		// remember what we are about to cover, so a cancel can restore it. Must be
		// re-read per install, not kept from the first one: after a commit the
		// material wears applyMap's texture, and a stale previousMap would restore
		// something from two strokes ago.
		existing.previousMap = mapToRestore(material, existing);
		install(material, existing);
		return existing;
	}
	const canvas = existing?.canvas ?? document.createElement('canvas');
	// Match the SOURCE resolution (clamped) rather than always 1024, and keep its
	// ASPECT: a square canvas built from max(w,h) stretched a 2048x1024 albedo to
	// 2048x2048, doubling everything vertically.
	const seedImage = url ? await decodeImage(url) : live;
	const size = paintSize(seedImage);
	canvas.width = size.w;
	canvas.height = size.h;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	// a material with no texture starts WHITE, not transparent: painting on a
	// transparent sheet reads as painting on nothing once it is on the model
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	// the canvas always holds the texture in IMAGE orientation (row 0 = image top);
	// which UV row that corresponds to is `flipY`'s business, handled per stroke
	if (seedImage) ctx.drawImage(seedImage, 0, 0, canvas.width, canvas.height);
	const source = material.map ?? null;
	const texture = existing?.texture ?? new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	// inherit the sampler state of the texture we are about to replace, or an
	// imported map's flipY/wrap/repeat are silently rewritten by the brush
	copyTextureParams(source, texture);
	texture.needsUpdate = true;
	const entry = {
		canvas,
		texture,
		uuid,
		slot,
		seededFrom: seedKey,
		// false for imported (glTF) textures — the stroke mapping depends on it
		flipY: source ? source.flipY !== false : true,
		// so a cancelled stroke can put the model back exactly as it was
		previousMap: mapToRestore(material, existing)
	};
	paintCanvases.set(key, entry);
	install(material, entry);
	return entry;
}

/**
 * What a cancelled stroke should put back: whatever is on the material right now,
 * unless that is already OUR canvas texture (a re-install during the same session),
 * in which case the previously remembered map still stands.
 * @param {any} material @param {any} existing @returns {any}
 */
function mapToRestore(material, existing) {
	const current = material.map ?? null;
	if (current && current === existing?.texture) return existing?.previousMap ?? null;
	return current;
}

/** show the paint canvas on the model @param {any} material @param {any} entry */
function install(material, entry) {
	if (material.map !== entry.texture) {
		material.map = entry.texture;
		material.needsUpdate = true;
	}
	entry.texture.needsUpdate = true;
	objectsGroup.update((v) => v);
}

/** A live texture identifies its seed by uuid+version, so a blank canvas (seed
 * key null) is never mistaken for one seeded from the model's own texture.
 * @param {any} material @returns {string} */
function liveSeedKey(material) {
	return 'tex:' + material.map.uuid + ':' + material.map.version;
}

/**
 * The paint canvas size: the source texture's own resolution, clamped, so a commit
 * never silently downscales it — and its ASPECT, so a 2048x1024 albedo does not
 * come back square with everything doubled vertically.
 * @param {any} image @returns {{w: number, h: number}}
 */
function paintSize(image) {
	const sw = image?.width ?? 0;
	const sh = image?.height ?? 0;
	if (!sw || !sh) return { w: PAINT_CANVAS, h: PAINT_CANVAS };
	const clamp = (/** @type {number} */ n) => Math.min(Math.max(Math.round(n), 8), 4096);
	// scale the LONG side into range and carry the short side with it
	const longest = Math.max(sw, sh);
	const scale = longest > 2048 ? 2048 / longest : longest < 256 ? Math.min(256 / longest, 8) : 1;
	return { w: clamp(sw * scale), h: clamp(sh * scale) };
}

/** @param {string} url @returns {Promise<any>} */
function decodeImage(url) {
	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

/**
 * Where a UV `v` lands on the paint canvas, which always holds the texture in
 * IMAGE orientation (row 0 = image top).
 *
 * `flipY` decides which image row a `v` samples, so it decides where a brush must
 * write. With three's default `flipY = true` the image is flipped at upload, so
 * v = 1 is the image top and canvas y = (1 - v) * h. An IMPORTED glTF texture is
 * `flipY = false` — no flip, so v = 0 is the image top and canvas y = v * h.
 * Painting a GLB with the flipY=true mapping wrote every stroke into the mirrored
 * half of the image. (Verified by the quadrant assertion in uv-texture-params:
 * reasoning alone had this backwards.)
 * @param {any} entry @param {number} v
 */
function canvasY(entry, v) {
	return (entry.flipY === false ? v : 1 - v) * entry.canvas.height;
}

/** Draw one segment in UV space onto a surface.
 * @param {any} entry @param {number[]} from @param {number[]} to
 * @param {string} color @param {number} size */
function strokeSegment(entry, from, to, color, size) {
	const ctx = entry.canvas.getContext('2d');
	if (!ctx) return;
	ctx.strokeStyle = color;
	ctx.lineWidth = size;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	ctx.beginPath();
	ctx.moveTo(from[0] * entry.canvas.width, canvasY(entry, from[1]));
	ctx.lineTo(to[0] * entry.canvas.width, canvasY(entry, to[1]));
	ctx.stroke();
	entry.texture.needsUpdate = true;
	// canvas pixels are not reactive: the UV editor redraws off this tick
	uvPaintTick.update((n) => n + 1);
}

/**
 * Open a paint stroke on one material slot. AWAIT this before the first
 * paintMove — the canvas has to carry the existing texture first, or the stroke
 * commits a blank image over it.
 * @param {string} uuid @param {number} slot @returns {Promise<boolean>}
 */
export async function beginPaintStroke(uuid, slot = 0) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const material = materialAt(object, slot);
	if (!material || !('map' in material)) return false;
	if (!(await paintSurface(uuid, slot))) return false;
	strokeSeq++;
	paintStroke = {
		id: (get(peers)?.peer?.id ?? 'local') + ':' + strokeSeq,
		uuid,
		slot,
		before: material.userData?.mapDataUrl ?? null,
		sent: 0,
		points: []
	};
	return true;
}

/** is a stroke open? */
export function painting() {
	return !!paintStroke;
}

let lastPaintSend = 0;

/**
 * Extend the open stroke to (u, v): draws locally and streams the unsent tail to
 * peers on a throttle. @param {number} u @param {number} v
 * @param {string} color @param {number} size
 */
export function paintMove(u, v, color, size) {
	if (!paintStroke) return false;
	const entry = paintCanvases.get(paintKey(paintStroke.uuid, paintStroke.slot));
	if (!entry) return false;
	const previous = paintStroke.points[paintStroke.points.length - 1];
	paintStroke.points.push([u, v]);
	if (previous) strokeSegment(entry, previous, [u, v], color, size);
	objectsGroup.update((value) => value);
	const now = performance.now();
	if (now - lastPaintSend < PAINT_THROTTLE) return true;
	lastPaintSend = now;
	flushStroke(color, size);
	return true;
}

/** send the points peers have not seen yet (small plain arrays — no raw-bytes
 * need, unlike a geometry snapshot) @param {string} color @param {number} size */
function flushStroke(color, size) {
	if (!paintStroke) return;
	// include the last SENT point so the receiver's line continues unbroken
	const start = Math.max(paintStroke.sent - 1, 0);
	const seg = paintStroke.points.slice(start);
	if (seg.length < 2) return;
	paintStroke.sent = paintStroke.points.length;
	/** @type {any} */
	const peer = get(peers);
	peer?.send({
		type: 'uvpaint',
		id: paintStroke.id,
		uuid: paintStroke.uuid,
		...(paintStroke.slot ? { slot: paintStroke.slot } : {}),
		seg,
		color,
		size
	});
}

/**
 * Close the stroke: flush the tail, then COMMIT the canvas as the slot's texture
 * through the existing replicated map path — one undo entry for the stroke.
 * @param {string} color @param {number} size @returns {boolean} committed
 */
export function endPaintStroke(color, size) {
	const stroke = paintStroke;
	if (!stroke) return false;
	flushStroke(color, size);
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'uvpaintend', id: stroke.id });
	paintStroke = null;
	if (stroke.points.length < 1) return false;
	const entry = paintCanvases.get(paintKey(stroke.uuid, stroke.slot));
	const object = get(objectsGroup)?.getObjectByProperty('uuid', stroke.uuid);
	if (!entry || !object) return false;
	const dataURL = canvasToDataUrl(entry.canvas);
	recordMaterialChange(stroke.uuid, 'map', null, stroke.before, dataURL, stroke.slot);
	applyMap(object, dataURL, stroke.slot);
	peer?.send({
		type: 'objectParameters',
		parameter: 'map',
		uuid: stroke.uuid,
		map: dataURL,
		...(stroke.slot ? { slot: stroke.slot } : {})
	});
	// KEEP the canvas: its pixels already ARE the committed image, so the next
	// stroke reuses it with no decode and no reseed race. Marking what it now
	// represents is what lets paintSurface trust it (and re-seed when an undo or
	// a peer's commit changes the texture underneath).
	entry.seededFrom = dataURL;
	return true;
}

/**
 * Abandon an open stroke without committing, and put the model back: installing
 * the paint canvas REPLACED `material.map`, so bailing out used to leave the
 * CanvasTexture (with the brush marks, and previously with rewritten sampler
 * state) on the material with nothing ever committed.
 */
export function cancelPaintStroke() {
	const stroke = paintStroke;
	paintStroke = null;
	if (!stroke) return;
	const entry = paintCanvases.get(paintKey(stroke.uuid, stroke.slot));
	const object = get(objectsGroup)?.getObjectByProperty('uuid', stroke.uuid);
	const material = materialAt(object, stroke.slot);
	if (!entry || !material) return;
	if (material.map === entry.texture) {
		material.map = entry.previousMap ?? null;
		material.needsUpdate = true;
		objectsGroup.update((v) => v);
	}
	// the canvas now disagrees with the material — drop it so the next stroke
	// re-seeds from whatever is actually on the model
	paintCanvases.delete(paintKey(stroke.uuid, stroke.slot));
}

/** webp when the browser can encode it, else jpeg — the downscaleImage rule
 * @param {any} canvas */
function canvasToDataUrl(canvas) {
	const webp = canvas.toDataURL('image/webp', 0.85);
	return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.9);
}

/**
 * Receive side: draw a peer's live stroke segments. The committed `map` message
 * that follows overwrites this, so a dropped segment self-heals.
 * @param {any} data
 */
export async function applyUvPaint(data) {
	const slot = data?.slot ?? 0;
	const entry = await paintSurface(data?.uuid, slot);
	if (!entry) return;
	const seg = data.seg ?? [];
	for (let i = 1; i < seg.length; i++)
		strokeSegment(entry, seg[i - 1], seg[i], data.color ?? '#000000', data.size ?? 16);
	liveUvStrokes.set(data.id, { ts: Date.now() });
	objectsGroup.update((v) => v);
}

/** Receive side: a peer finished a stroke. @param {any} data */
export function applyUvPaintEnd(data) {
	liveUvStrokes.delete(data?.id);
}

/** how many live remote strokes we are tracking (test hook) */
export function liveStrokeCount() {
	return liveUvStrokes.size;
}

/**
 * The live paint canvas for one slot, for the UV editor to draw as its backdrop.
 *
 * Without this the UV view showed a stroke only on RELEASE: the backdrop is
 * decoded from `userData.mapDataUrl`, which only changes when the stroke commits,
 * while the 3D model (and a peer) sees the CanvasTexture updating per dab. The
 * canvas is only trustworthy while it represents the current image — mid-stroke
 * (it is the truth) or right after a commit (`seededFrom` matches). After an undo
 * or someone else's commit it is stale, so the caller falls back to the decoded
 * image until the next stroke re-seeds it.
 * @param {string|undefined|null} uuid @param {number} slot @returns {any}
 */
export function paintPreviewCanvas(uuid, slot = 0) {
	if (!uuid) return null;
	const entry = paintCanvases.get(paintKey(uuid, slot));
	if (!entry) return null;
	if (paintStroke && paintStroke.uuid === uuid && paintStroke.slot === slot) return entry.canvas;
	const material = materialAt(get(objectsGroup)?.getObjectByProperty('uuid', uuid), slot);
	const url = material?.userData?.mapDataUrl ?? null;
	return entry.seededFrom === url ? entry.canvas : null;
}

/** a monotonic counter bumped on every dab, local or remote — the UV editor
 * redraws off this, because canvas pixels are not reactive state */
export const uvPaintTick = writable(0);

// ---- texture tools ---------------------------------------------------------

/** the slot's texture size + a rough VRAM figure (RGBA plus ~33% for the mip chain)
 * @param {any} object @param {number} slot
 * @returns {{w: number, h: number, bytes: number}|null} */
export function textureInfo(object, slot = 0) {
	const image = textureImageOf(object, slot);
	if (!image) return null;
	const w = image.width ?? 0;
	const h = image.height ?? 0;
	if (!w || !h) return null;
	return { w, h, bytes: Math.round(w * h * 4 * 1.33) };
}

/**
 * Resize a slot's texture and commit it like any other texture change: replicated,
 * one undo entry, persisted (user decision). `longest` caps the LONG side and the
 * short side follows, so a non-square texture keeps its aspect.
 * @param {string} uuid @param {number} slot @param {number} longest
 * @returns {Promise<boolean>}
 */
export async function resizeSlotTexture(uuid, slot, longest) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const material = materialAt(object, slot);
	const source = textureImageOf(object, slot);
	if (!material || !source) {
		showToast('That slot has no texture to resize');
		return false;
	}
	const scale = longest / Math.max(source.width, source.height);
	const w = Math.max(Math.round(source.width * scale), 1);
	const h = Math.max(Math.round(source.height * scale), 1);
	if (w === source.width && h === source.height) return false;
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) return false;
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(source, 0, 0, w, h);
	const before = material.userData?.mapDataUrl ?? null;
	const dataURL = canvasToDataUrl(canvas);
	// a stale paint canvas would still hold the OLD resolution
	paintCanvases.delete(paintKey(uuid, slot));
	recordMaterialChange(uuid, 'map', null, before, dataURL, slot);
	applyMap(object, dataURL, slot);
	/** @type {any} */
	const peer = get(peers);
	peer?.send({
		type: 'objectParameters',
		parameter: 'map',
		uuid,
		map: dataURL,
		...(slot ? { slot } : {})
	});
	showToast('Texture resized to ' + w + 'x' + h);
	return true;
}

/**
 * A LOCAL-ONLY UV test grid.
 *
 * Driven through `scene.overrideMaterial`, following the viewMode wireframe precedent
 * exactly — a per-material map swap would LEAK: the object sync and autosave both
 * serialize `material.map`, so a peer joining (or an autosave taken) while the
 * checker was on would bake the checker into the scene, and `userData.mapDataUrl`
 * would still claim the real texture. Scene-wide is the honest trade for never
 * corrupting anyone's asset.
 * @type {import('svelte/store').Writable<boolean>}
 */
export const uvCheckerOn = writable(false);

/** @type {any} */ let checkerMaterial = null;

/** the checker texture: RepeatWrapping matters — CanvasTexture defaults to
 * ClampToEdge, so a UV outside 0..1 would smear instead of tiling (the same default
 * that made painting a GLB break its tiling) */
function checkerTexture(size = 512, cells = 8) {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	const step = size / cells;
	for (let y = 0; y < cells; y++)
		for (let x = 0; x < cells; x++) {
			const dark = (x + y) % 2 === 0;
			ctx.fillStyle = dark ? '#3d4653' : '#d7dde6';
			ctx.fillRect(x * step, y * step, step, step);
		}
	// a thin border per cell reads the stretch direction at a glance
	ctx.strokeStyle = 'rgba(255,120,26,0.9)';
	ctx.lineWidth = Math.max(size / 256, 1);
	for (let i = 0; i <= cells; i++) {
		ctx.beginPath();
		ctx.moveTo(i * step, 0);
		ctx.lineTo(i * step, size);
		ctx.moveTo(0, i * step);
		ctx.lineTo(size, i * step);
		ctx.stroke();
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	return texture;
}

/**
 * Apply / clear the checker override. The caller passes the scene so this module
 * stays free of scene-store plumbing.
 * @param {any} scene @param {boolean} on
 */
export function applyUvChecker(scene, on) {
	if (!scene) return;
	if (on) {
		if (!checkerMaterial) {
			const map = checkerTexture();
			checkerMaterial = new THREE.MeshBasicMaterial({ map });
		}
		scene.overrideMaterial = checkerMaterial;
	} else if (scene.overrideMaterial === checkerMaterial) {
		scene.overrideMaterial = null;
	}
}

/**
 * Does the slot's texture sample v = 0 from the image's TOP row? True for an
 * imported glTF texture (`flipY = false`).
 *
 * The editor draws the UV square with v UP (v = 1 at the top), so a flipY=true
 * texture's image can be blitted as-is, while a flipY=false one has to be drawn
 * vertically FLIPPED for the backdrop to agree with where the model samples.
 * @param {any} object @param {number} slot @returns {boolean}
 */
export function slotFlipsV(object, slot = 0) {
	return materialsOf(object)[slot]?.map?.flipY === false;
}

// A peer that vanished mid-stroke never sends its `uvpaintend`, so sweep stale
// entries (drawMode's pattern). Stroke-keyed, so no handleDisconnected hook.
if (typeof window !== 'undefined')
	setInterval(() => {
		const now = Date.now();
		for (const [id, stroke] of liveUvStrokes)
			if (now - stroke.ts > STROKE_STALE_MS) liveUvStrokes.delete(id);
	}, STROKE_STALE_MS);

/**
 * The meshgeo wire message, byte-identical to faceEdit's private
 * broadcastMeshGeo (raw Float32 BYTES — binarypack recurses per element and
 * silently blows the call stack on a big plain array, and broadcast() swallows
 * the throw). `groups`/`uvs` are omitted when absent so an older peer just sees
 * today's message.
 * @param {string} uuid @param {{positions: number[], groups: any[] | null, uvs: number[] | null}} snapshot
 */
function broadcastUvGeo(uuid, snapshot) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	peer.send({
		type: 'meshgeo',
		uuid: uuid,
		positions: new Float32Array(snapshot.positions).buffer,
		...(snapshot.groups?.length ? { groups: snapshot.groups } : {}),
		...(snapshot.uvs?.length ? { uvs: new Float32Array(snapshot.uvs).buffer } : {})
	});
}
