// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene, sceneRevision, pokeScene } from '../stores/sceneStore';
import { decodeSplatBlock, encodeSplatBlock, normalizeLayers, baseIsMaterial, base64ToBytes, LAYER_COUNT } from './terrainPaintCore';
import { normalizeScatter, decodeInstances, buildHeightGrid, sampleHeight } from './terrainScatterCore';
import { lodObject, releaseOwner } from './lod';
import { EXPLICIT_MIN_TRIANGLES } from './lodCore';

// 47 T1 + T2 — HOW A PAINTED / SCATTERED TERRAIN LOOKS, on every peer. A LEAF: three, the
// scene store and the two pure cores; no history, no peers (terrainPaint.js is the write
// side and owns those). commandsHandler reaches the appliers below through a dynamic
// import, the faceEdit precedent.
//
// THE DOCUMENT is three userData blocks on the terrain — `terrainSplat` (the RGBA weight
// map, base64), `terrainLayers` (four {color, texture hash, tiling}) and `terrainScatter`
// (per-source instance bytes). Everything here is DERIVED from them, so a load, a joiner's
// object sync, an undo and a remote message all converge on one reconcile.
//
// PAINT = the terrain's OWN material, patched through onBeforeCompile: the diffuse colour
// becomes the weighted blend of the four layers (colour × texture at its tiling), sampled
// by LOCAL xz — never the geometry's uv, which a meshgeo commit drops. A previous
// onBeforeCompile (a shader graph's) runs first and is restored when the paint goes away.
// The material is never cloned, so the Material section keeps editing the real one
// (roughness, metalness, normal map still apply; its colour/map are replaced by the layers).
//
// SCATTER = scene-root InstancedMeshes, NEVER children of the terrain: objectsGroup is the
// replicated, serialized document (editOverlays.js is the story of a child that leaked into
// files). A holder follows its terrain by overriding `updateMatrixWorld`, which the scene
// calls on every render before culling — no per-frame hook, no lag, and a hidden terrain
// hides its scatter. Heights come from the terrain's own grid (terrainScatterCore), so a
// sculpt stroke carries the instances with it.

/** @typedef {{bytes: Uint8Array, res: number, texture: any, key: string}} SplatState */

/** object -> splat runtime state */
/** @type {WeakMap<any, SplatState>} */
const splats = new WeakMap();
/** material -> {onBeforeCompile, customProgramCacheKey} it had before we patched it */
/** @type {WeakMap<any, {obc: any, key: any, uniforms: any, fn: any}>} */
const patched = new WeakMap();
/** object -> {holder, key, gridKey} */
/** @type {Map<any, {holder: any, key: string, layoutKey: string, terrain: any}>} */
const scatters = new Map();

/** a 1×1 white texture: the identity for colour × texture while an image is missing */
let white = /** @type {any} */ (null);
function whiteTexture() {
	if (white) return white;
	white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
	white.needsUpdate = true;
	return white;
}

/** @param {string} uuid */
function objectOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

/** Local XZ bounds of a terrain's geometry (the splat + scatter frame). @param {any} object */
export function terrainBounds(object) {
	const geo = object?.geometry;
	if (!geo?.attributes?.position) return null;
	if (!geo.boundingBox) geo.computeBoundingBox();
	const b = geo.boundingBox;
	const sizeX = b.max.x - b.min.x;
	const sizeZ = b.max.z - b.min.z;
	if (!(sizeX > 0) || !(sizeZ > 0)) return null;
	return { minX: b.min.x, minZ: b.min.z, sizeX, sizeZ };
}

// ---- paint ---------------------------------------------------------------------------

const VERT_DECL = 'varying vec2 vTerrainXZ;\n';
const FRAG_DECL = `varying vec2 vTerrainXZ;
uniform sampler2D uSplat;
uniform vec2 uSplatMin;
uniform vec2 uSplatInvSize;
uniform vec3 uLayerColor[4];
uniform vec4 uLayerTiling;
uniform float uBaseIsMaterial;
uniform sampler2D uLayerTex0;
uniform sampler2D uLayerTex1;
uniform sampler2D uLayerTex2;
uniform sampler2D uLayerTex3;
`;
const FRAG_BLEND = `
{
	vec2 splatUv = (vTerrainXZ - uSplatMin) * uSplatInvSize;
	vec4 w = texture2D(uSplat, splatUv);
	w /= max(w.r + w.g + w.b + w.a, 1e-4);
	vec3 c0 = mix(uLayerColor[0] * texture2D(uLayerTex0, splatUv * uLayerTiling.x).rgb, diffuseColor.rgb, uBaseIsMaterial);
	vec3 c1 = uLayerColor[1] * texture2D(uLayerTex1, splatUv * uLayerTiling.y).rgb;
	vec3 c2 = uLayerColor[2] * texture2D(uLayerTex2, splatUv * uLayerTiling.z).rgb;
	vec3 c3 = uLayerColor[3] * texture2D(uLayerTex3, splatUv * uLayerTiling.w).rgb;
	diffuseColor.rgb = c0 * w.r + c1 * w.g + c2 * w.b + c3 * w.a;
}
`;

/** The uniforms one painted terrain's materials share. @param {SplatState} s */
function makeUniforms(s) {
	return {
		uSplat: { value: s.texture },
		uSplatMin: { value: new THREE.Vector2() },
		uSplatInvSize: { value: new THREE.Vector2(1, 1) },
		uLayerColor: { value: [0, 1, 2, 3].map(() => new THREE.Color()) },
		uLayerTiling: { value: new THREE.Vector4(8, 8, 8, 8) },
		uBaseIsMaterial: { value: 1 },
		uLayerTex0: { value: whiteTexture() },
		uLayerTex1: { value: whiteTexture() },
		uLayerTex2: { value: whiteTexture() },
		uLayerTex3: { value: whiteTexture() }
	};
}

/** @param {any} material */
function canPatch(material) {
	return !!material && !material.isShaderMaterial && 'map' in material;
}

/** @param {any} material @param {any} uniforms */
function patchMaterial(material, uniforms) {
	const had = patched.get(material);
	// ours and still installed: re-bind the uniforms the closure reads (a new terrain state)
	if (had && material.onBeforeCompile === had.fn) {
		had.uniforms = uniforms;
		return;
	}
	// someone re-installed theirs over ours (a shader graph recompiling): wrap the NEW one
	const own = (/** @type {string} */ k) => (Object.prototype.hasOwnProperty.call(material, k) ? material[k] : null);
	const prevObc = own('onBeforeCompile');
	const prevKey = own('customProgramCacheKey');
	const record = { obc: prevObc, key: prevKey, uniforms, fn: /** @type {any} */ (null) };
	record.fn = function (/** @type {any} */ shader, /** @type {any} */ renderer) {
		if (prevObc) prevObc.call(this, shader, renderer);
		Object.assign(shader.uniforms, record.uniforms);
		shader.vertexShader = VERT_DECL + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvTerrainXZ = position.xz;');
		shader.fragmentShader = FRAG_DECL + shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAG_BLEND);
	};
	patched.set(material, record);
	material.onBeforeCompile = record.fn;
	material.customProgramCacheKey = function () {
		return (prevKey ? prevKey.call(this) : '') + '|terrain-splat-1';
	};
	material.needsUpdate = true;
}

/** @param {any} material */
function unpatchMaterial(material) {
	const had = patched.get(material);
	if (!had) return;
	patched.delete(material);
	if (had.obc) material.onBeforeCompile = had.obc;
	else delete material.onBeforeCompile;
	if (had.key) material.customProgramCacheKey = had.key;
	else delete material.customProgramCacheKey;
	material.needsUpdate = true;
}

/** @param {any} object */
function materialsOf(object) {
	const m = object?.material;
	return (Array.isArray(m) ? m : [m]).filter(canPatch);
}

/** Layer textures resolve asynchronously (shaderTextures: hash -> texture, pull + retry). */
/** @type {any} */
let textures = null;
/** @type {Promise<any> | null} */
let texturesLoading = null;
function loadTextures() {
	if (textures || texturesLoading) return;
	texturesLoading = import('./shaderTextures').then((m) => {
		textures = m;
		m.startShaderTextures();
		m.registerShaderTextureListener(() => scheduleReconcile(true));
		scheduleReconcile(true);
	});
}

/** Refresh one painted terrain's uniforms from its stored layers + bounds. @param {any} object @param {any} uniforms */
function fillUniforms(object, uniforms) {
	const layers = normalizeLayers(object.userData.terrainLayers);
	const b = terrainBounds(object);
	if (b) {
		uniforms.uSplatMin.value.set(b.minX, b.minZ);
		uniforms.uSplatInvSize.value.set(1 / b.sizeX, 1 / b.sizeZ);
	}
	uniforms.uBaseIsMaterial.value = baseIsMaterial(layers[0]) ? 1 : 0;
	for (let i = 0; i < LAYER_COUNT; i++) {
		uniforms.uLayerColor.value[i].set(layers[i].color || '#ffffff');
		uniforms.uLayerTiling.value.setComponent(i, layers[i].tiling);
		const hash = layers[i].texture;
		let tex = null;
		if (hash) {
			if (!textures) loadTextures();
			else {
				tex = textures.shaderTextureFor(hash);
				if (!tex) void textures.resolveShaderTexture(hash);
			}
		}
		uniforms['uLayerTex' + i].value = tex ?? whiteTexture();
	}
}

/** @type {WeakMap<any, any>} object -> its uniforms */
const uniformsOf = new WeakMap();

/** Make an object's look match its `terrainSplat` block (patch / refresh / unpatch). @param {any} object */
function reconcileSplat(object) {
	const block = object.userData?.terrainSplat;
	let s = splats.get(object);
	if (!block) {
		if (s) {
			for (const m of materialsOf(object)) unpatchMaterial(m);
			s.texture.dispose();
			splats.delete(object);
			uniformsOf.delete(object);
		}
		return;
	}
	if (!s || s.key !== block.data) {
		const decoded = decodeSplatBlock(block);
		if (!decoded) return;
		if (s && s.res === decoded.res) {
			s.bytes.set(decoded.bytes);
			s.texture.needsUpdate = true;
			s.key = block.data;
		} else {
			s?.texture.dispose();
			const texture = new THREE.DataTexture(decoded.bytes, decoded.res, decoded.res, THREE.RGBAFormat);
			texture.magFilter = THREE.LinearFilter;
			texture.minFilter = THREE.LinearFilter;
			texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
			texture.needsUpdate = true;
			s = { bytes: decoded.bytes, res: decoded.res, texture, key: block.data };
			splats.set(object, s);
			uniformsOf.delete(object);
		}
	}
	let uniforms = uniformsOf.get(object);
	if (!uniforms) {
		uniforms = makeUniforms(/** @type {SplatState} */ (s));
		uniformsOf.set(object, uniforms);
	}
	fillUniforms(object, uniforms);
	for (const m of materialsOf(object)) patchMaterial(m, uniforms);
}

/**
 * The LIVE bytes of a painted terrain (the brush edits them in place, then calls
 * `splatBytesChanged`). Creates the runtime state from the stored block when needed.
 * @param {any} object @returns {SplatState | null}
 */
export function liveSplat(object) {
	if (!object?.userData?.terrainSplat) return null;
	if (!splats.get(object)) reconcileSplat(object);
	return splats.get(object) ?? null;
}

/** The brush wrote into `liveSplat(object).bytes`: re-upload (no re-encode — that is the
 * commit's job). @param {any} object */
export function splatBytesChanged(object) {
	const s = splats.get(object);
	if (s) s.texture.needsUpdate = true;
}

/**
 * THE ONE WRITE for a splat (local commit, preview, undo, remote): store the block and
 * refresh the look. null removes the paint (the material goes back to itself).
 * @param {string} uuid @param {Uint8Array | null} bytes @param {number} [res]
 */
export function applyTerrainSplat(uuid, bytes, res = 0) {
	const object = objectOf(uuid);
	if (!object) return false;
	if (bytes) {
		const block = encodeSplatBlock(bytes, res);
		object.userData.terrainSplat = block;
		const s = splats.get(object);
		if (s && s.res === res) {
			if (s.bytes !== bytes) s.bytes.set(bytes);
			s.texture.needsUpdate = true;
			s.key = block.data;
		}
	} else delete object.userData.terrainSplat;
	reconcileSplat(object);
	pokeScene();
	return true;
}

/** @param {string} uuid @param {any} layers null = back to the defaults */
export function applyTerrainLayers(uuid, layers) {
	const object = objectOf(uuid);
	if (!object) return false;
	if (layers) object.userData.terrainLayers = normalizeLayers(layers);
	else delete object.userData.terrainLayers;
	reconcileSplat(object);
	pokeScene();
	return true;
}

// ---- scatter ---------------------------------------------------------------------------

/** shared primitive geometries, origin at the BASE so an instance stands on the ground */
/** @type {Map<string, any>} */
const primGeo = new Map();
/** @type {Map<string, any>} */
const primMat = new Map();
const PRIM_COLOR = /** @type {Record<string, number>} */ ({ Cone: 0x3f6e32, Sphere: 0x4f7d3a, Capsule: 0x6f8f4a });

/** @param {string} type */
function primitiveParts(type) {
	let geo = primGeo.get(type);
	if (!geo) {
		if (type === 'Box') geo = new THREE.BoxGeometry(1, 1, 1);
		else if (type === 'Sphere') geo = new THREE.SphereGeometry(0.5, 12, 8);
		else if (type === 'Cone') geo = new THREE.ConeGeometry(0.5, 1, 10);
		else if (type === 'Cylinder') geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
		else if (type === 'Capsule') geo = new THREE.CapsuleGeometry(0.3, 0.4, 4, 10);
		else geo = new THREE.DodecahedronGeometry(0.5);
		geo.computeBoundingBox();
		geo.translate(0, -geo.boundingBox.min.y, 0);
		primGeo.set(type, geo);
	}
	let mat = primMat.get(type);
	if (!mat) {
		mat = new THREE.MeshStandardMaterial({ color: PRIM_COLOR[type] ?? 0x8a8a84, roughness: 0.9 });
		primMat.set(type, mat);
	}
	return [{ geometry: geo, material: mat }];
}

/** hash -> parts (null while loading / missing) */
/** @type {Map<string, {parts: {geometry: any, material: any}[] | null, state: 'loading'|'ready'|'missing'}>} */
const models = new Map();
/** @type {(() => void) | null} */
let explorerWatch = null;

/** A Library model as instanceable parts: every mesh, its transform relative to the model
 * root baked into a geometry clone. Async; a missing hash is pulled from the mesh and the
 * reconcile re-runs when the bytes land (golden rule 9). @param {string} hash */
function libraryParts(hash) {
	const entry = models.get(hash);
	if (entry?.state === 'ready') return entry.parts;
	if (entry?.state === 'loading') return null;
	models.set(hash, { parts: null, state: 'loading' });
	void (async () => {
		const explorer = await import('./explorer');
		const item = explorer.itemByHash(hash);
		if (!item) {
			models.set(hash, { parts: null, state: 'missing' });
			const share = await import('./assetShare');
			share.requestAsset(hash);
			if (!explorerWatch)
				explorerWatch = explorer.explorerItems.subscribe(() => {
					let retry = false;
					for (const [h, e] of models) if (e.state === 'missing' && explorer.itemByHash(h)) (models.delete(h), (retry = true));
					if (retry) scheduleReconcile(true);
				});
			return;
		}
		try {
			const blob = await explorer.itemBlob(item.id);
			if (!blob) throw new Error('no bytes');
			const ext = String(item.name ?? '').split('.').pop()?.toLowerCase() ?? 'glb';
			const root = await explorer.parseObjectFile(await blob.arrayBuffer(), ext);
			root.updateMatrixWorld(true);
			const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
			/** @type {{geometry: any, material: any}[]} */
			const parts = [];
			root.traverse((/** @type {any} */ m) => {
				if (!m.isMesh || !m.geometry?.attributes?.position || m.isSkinnedMesh) return;
				const geometry = m.geometry.clone();
				geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
				parts.push({ geometry, material: Array.isArray(m.material) ? m.material[0] : m.material });
			});
			models.set(hash, { parts, state: 'ready' });
		} catch (error) {
			console.log('scatter: model ' + hash + ' failed to load', error);
			models.set(hash, { parts: [], state: 'ready' });
		}
		scheduleReconcile(true);
	})();
	return null;
}

/** @param {any} source */
function partsOf(source) {
	return source.kind === 'primitive' ? primitiveParts(source.type) : libraryParts(source.hash);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** The world-visible test the render traversal applies: every ancestor visible. @param {any} o */
function chainVisible(o) {
	for (let n = o; n; n = n.parent) if (!n.visible) return false;
	return true;
}

/** @param {any} terrain */
function makeHolder(terrain) {
	const holder = new THREE.Object3D();
	holder.name = 'terrain-scatter';
	holder.matrixAutoUpdate = false;
	holder.userData.terrainScatterOf = terrain.uuid;
	// follow the terrain: called by scene.updateMatrixWorld before every render's culling
	holder.updateMatrixWorld = (/** @type {boolean} */ force) => {
		if (terrain.parent) {
			terrain.updateWorldMatrix(true, false);
			holder.matrixWorld.copy(terrain.matrixWorld);
			holder.visible = chainVisible(terrain);
		} else holder.visible = false;
		for (const child of holder.children) child.updateMatrixWorld(force);
	};
	return holder;
}

/** @param {any} holder */
function clearHolder(holder) {
	releaseOwner(holder); // 47-int: the cells' LOD entries (lod.js holds them until their owner lets go)
	for (const child of [...holder.children]) {
		holder.remove(child);
		child.dispose?.();
	}
}

/** Make an object's scatter holder match its `terrainScatter` block. @param {any} object */
function reconcileScatter(object) {
	const block = object.userData?.terrainScatter;
	let entry = scatters.get(object);
	const sets = block ? normalizeScatter(block, base64ToBytes)?.sets ?? [] : [];
	if (!sets.length) {
		if (entry) {
			clearHolder(entry.holder);
			entry.holder.parent?.remove(entry.holder);
			scatters.delete(object);
		}
		return;
	}
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return;
	if (!entry) {
		entry = { holder: makeHolder(object), key: '', layoutKey: '', terrain: object };
		scatters.set(object, entry);
	}
	if (entry.holder.parent !== scene) scene.add(entry.holder);
	const pos = object.geometry?.attributes?.position;
	const layoutKey = (pos ? pos.version + ':' + pos.count + ':' + (pos.array?.length ?? 0) : '') + ':' + uuidTag(pos);
	const key = JSON.stringify(sets.map((s) => [s.id, s.data, s.align, sourceReady(s.source)]));
	if (entry.key === key && entry.layoutKey === layoutKey) return;
	entry.key = key;
	entry.layoutKey = layoutKey;
	layoutScatter(object, entry.holder, sets);
}

/** attribute identity (a meshgeo swap replaces it with a fresh one at version 0) */
/** @type {WeakMap<any, number>} */
const attrIds = new WeakMap();
let attrSeq = 0;
/** @param {any} attr */
function uuidTag(attr) {
	if (!attr) return 0;
	let id = attrIds.get(attr);
	if (!id) attrIds.set(attr, (id = ++attrSeq));
	return id;
}

/** @param {any} source */
function sourceReady(source) {
	return source.kind === 'primitive' || models.get(source.hash)?.state === 'ready';
}

/** @param {any} object @param {any} holder @param {any[]} sets */
function layoutScatter(object, holder, sets) {
	clearHolder(holder);
	const b = terrainBounds(object);
	const pos = object.geometry?.attributes?.position;
	const grid = pos ? buildHeightGrid(pos.array) : null;
	if (!b) return;
	for (const set of sets) {
		const parts = partsOf(set.source);
		if (!parts || !parts.length) continue;
		const list = decodeInstances(/** @type {Uint8Array} */ (base64ToBytes(set.data)), b);
		const matrices = instanceMatrices(list, set.align, grid);
		for (const part of parts) {
			// 47-int (46 LOD): a dense model takes levels. One centre for instances spread over a
			// whole terrain means nothing, so a LOD'd part is split into cells — each cell picks
			// its level by its NEAREST instance (lod.js) and is culled on its own. A light part
			// (a primitive, a low-poly rock) stays ONE draw call per set, as the lane built it.
			const lodded = trianglesOfGeo(part.geometry) >= EXPLICIT_MIN_TRIANGLES;
			for (const ids of lodded ? cellsOf(list, b) : [list.map((_, k) => k)]) {
				const mesh = new THREE.InstancedMesh(part.geometry, part.material, ids.length);
				mesh.name = 'terrain-scatter:' + set.id;
				mesh.castShadow = true;
				mesh.receiveShadow = true;
				mesh.userData.scatterSet = set.id;
				ids.forEach((id, k) => mesh.setMatrixAt(k, matrices[id]));
				mesh.instanceMatrix.needsUpdate = true;
				mesh.computeBoundingSphere();
				holder.add(mesh);
				if (lodded) lodObject(mesh, {}, holder);
			}
		}
	}
}

/** Terrain-LOCAL instance matrices — the drawn pose, and (48 B1) the collider pose.
 * @param {{x: number, z: number, yaw: number, scale: number}[]} list @param {boolean} align
 * @param {ReturnType<typeof buildHeightGrid>} grid @returns {any[]} */
function instanceMatrices(list, align, grid) {
	return list.map((inst) => {
		const h = grid ? sampleHeight(grid, inst.x, inst.z) : { y: 0, nx: 0, ny: 1, nz: 0 };
		_qy.setFromAxisAngle(UP, inst.yaw);
		if (align) _q.setFromUnitVectors(UP, _n.set(h.nx, h.ny, h.nz)).multiply(_qy);
		else _q.copy(_qy);
		return new THREE.Matrix4().compose(_p.set(inst.x, h.y, inst.z), _q, _s.setScalar(inst.scale));
	});
}

/**
 * 48 B1: what a simulation needs to give a terrain's scatter its colliders — every set that
 * asks for one (`collider` box / sphere / hull), with the parts it draws and its instances'
 * TERRAIN-LOCAL matrices, computed exactly as the render does (same heights, same tilt), so
 * a ball rests on the rock it sees. A set whose Library model is still loading is left out
 * (it is not drawn either); `pending` says so, and the physics side rebuilds when it lands.
 * @param {any} object a terrain @returns {{sets: {id: string, collider: string, parts: {geometry: any}[], matrices: any[]}[], pending: boolean}}
 */
export function scatterPhysicsSets(object) {
	const out = { sets: /** @type {any[]} */ ([]), pending: false };
	const block = object?.userData?.terrainScatter;
	const b = block ? terrainBounds(object) : null;
	if (!b) return out;
	const wanted = (normalizeScatter(block, base64ToBytes)?.sets ?? []).filter((s) => s.collider);
	if (!wanted.length) return out;
	const pos = object.geometry?.attributes?.position;
	const grid = pos ? buildHeightGrid(pos.array) : null;
	for (const set of wanted) {
		const parts = partsOf(set.source);
		if (!parts) {
			out.pending = true;
			continue;
		}
		if (!parts.length) continue;
		const list = decodeInstances(/** @type {Uint8Array} */ (base64ToBytes(set.data)), b);
		out.sets.push({ id: set.id, collider: /** @type {string} */ (set.collider), parts, matrices: instanceMatrices(list, set.align, grid) });
	}
	return out;
}

/** @param {any} g */
function trianglesOfGeo(g) {
	return Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
}

/** the side of a LOD cell: at least SCATTER_CELL_MIN m, at most SCATTER_CELLS per terrain side */
const SCATTER_CELL_MIN = 24;
const SCATTER_CELLS = 4;

/** Instance indices grouped by cell over the terrain (empty cells dropped).
 * @param {{x: number, z: number}[]} list @param {{minX: number, minZ: number, sizeX: number, sizeZ: number}} b */
function cellsOf(list, b) {
	const side = Math.max(SCATTER_CELL_MIN, Math.max(b.sizeX, b.sizeZ) / SCATTER_CELLS);
	/** @type {Map<string, number[]>} */
	const cells = new Map();
	list.forEach((inst, k) => {
		const key = Math.floor((inst.x - b.minX) / side) + ',' + Math.floor((inst.z - b.minZ) / side);
		const ids = cells.get(key);
		if (ids) ids.push(k);
		else cells.set(key, [k]);
	});
	return [...cells.values()];
}

/** @param {string} uuid @param {any} block null = no scatter */
export function applyTerrainScatter(uuid, block) {
	const object = objectOf(uuid);
	if (!object) return false;
	const sets = block ? normalizeScatter(block, base64ToBytes)?.sets ?? [] : [];
	if (sets.length) object.userData.terrainScatter = { v: 1, sets };
	else delete object.userData.terrainScatter;
	reconcileScatter(object);
	pokeScene();
	return true;
}

// ---- remote applier (commandsHandler objectParameters, dynamic import) ----------------

/** @param {any} data an `objectParameters` message with parameter terrainSplat / terrainLayers / terrainScatter */
export async function applyRemoteTerrainParam(data) {
	if (data.parameter === 'terrainSplat') {
		if (data.bytes == null) return applyTerrainSplat(data.uuid, null);
		const { wireSplatBytes } = await import('./terrainPaintCore');
		const bytes = wireSplatBytes(data.bytes, Number(data.res));
		if (bytes) applyTerrainSplat(data.uuid, bytes, Number(data.res));
	} else if (data.parameter === 'terrainLayers') applyTerrainLayers(data.uuid, data.terrainLayers ?? null);
	else if (data.parameter === 'terrainScatter') applyTerrainScatter(data.uuid, data.terrainScatter ?? null);
	return true;
}

// ---- the reconcile ----------------------------------------------------------------------

/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;
let started = false;

/** @param {boolean} [force] re-layout every scatter (a model just loaded) */
function scheduleReconcile(force = false) {
	if (force) for (const e of scatters.values()) e.key = '';
	if (timer) return;
	timer = setTimeout(() => {
		timer = null;
		reconcileAll();
	}, 30);
}

/** Walk the document once: every terrain carrying a block gets its look; holders whose
 * terrain left the scene are dropped. Exported for the suite. */
export function reconcileAll() {
	const group = /** @type {any} */ (get(objectsGroup));
	const live = new Set();
	group?.traverse((/** @type {any} */ o) => {
		const ud = o.userData;
		if (!ud) return;
		if (ud.terrainSplat || splats.get(o)) reconcileSplat(o);
		if (ud.terrainScatter || scatters.has(o)) {
			reconcileScatter(o);
			live.add(o);
		}
	});
	for (const [object, entry] of [...scatters]) {
		if (live.has(object)) continue;
		clearHolder(entry.holder);
		entry.holder.parent?.remove(entry.holder);
		scatters.delete(object);
	}
}

/** Boot (App.svelte, one line). Idempotent. */
export function startTerrainSurface() {
	if (started || typeof window === 'undefined') return;
	started = true;
	sceneRevision.subscribe(() => scheduleReconcile());
}

/** Debug / suite / perf note: what is drawn. */
export function terrainSurfaceStats() {
	let instances = 0;
	let meshes = 0;
	let tris = 0;
	for (const { holder } of scatters.values())
		for (const m of holder.children) {
			meshes++;
			instances += m.count;
			const g = m.geometry;
			tris += ((g.index ? g.index.count : g.attributes.position.count) / 3) * m.count;
		}
	let painted = 0;
	/** @type {any} */ (get(objectsGroup))?.traverse((/** @type {any} */ o) => {
		if (splats.get(o)) painted++;
	});
	return { painted, scatterTerrains: scatters.size, instancedMeshes: meshes, instances, tris: Math.round(tris) };
}
