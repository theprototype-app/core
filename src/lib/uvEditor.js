// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry } from './history';
// UV3 painting commits through the EXISTING replicated texture path, so
// persistence (autosave / .tpscene / the object sync) and undo come free.
import { applyMap, materialAt, recordMaterialChange } from './materialsHandler';
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

/** @type {Map<string, {canvas: any, texture: any, uuid: string, slot: number, seededFrom: string|null}>} */
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
		install(material, existing);
		return existing;
	}
	const canvas = existing?.canvas ?? document.createElement('canvas');
	// Match the SOURCE resolution (clamped) rather than always 1024: committing a
	// 1024 re-encode of a 2048 texture would silently halve the user's texture.
	const size = paintSize(live);
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	// a material with no texture starts WHITE, not transparent: painting on a
	// transparent sheet reads as painting on nothing once it is on the model
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	if (url) {
		const image = await decodeImage(url);
		if (image) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
	} else if (live) {
		ctx.drawImage(live, 0, 0, canvas.width, canvas.height);
	}
	const texture = existing?.texture ?? new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.needsUpdate = true;
	const entry = { canvas, texture, uuid, slot, seededFrom: seedKey };
	paintCanvases.set(key, entry);
	install(material, entry);
	return entry;
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

/** the paint canvas size: the source texture's own resolution, clamped, so a
 * commit never silently downscales it @param {any} image @returns {number} */
function paintSize(image) {
	const source = Math.max(image?.width ?? 0, image?.height ?? 0);
	if (!source) return PAINT_CANVAS;
	return Math.min(Math.max(2 ** Math.round(Math.log2(source)), 256), 2048);
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

/** Draw one segment in UV space onto a surface. Canvas y is 1-v (v points up).
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
	ctx.moveTo(from[0] * entry.canvas.width, (1 - from[1]) * entry.canvas.height);
	ctx.lineTo(to[0] * entry.canvas.width, (1 - to[1]) * entry.canvas.height);
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

/** abandon an open stroke without committing (the paint stays on the canvas
 * until the next commit or reseed — it is local only) */
export function cancelPaintStroke() {
	paintStroke = null;
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
