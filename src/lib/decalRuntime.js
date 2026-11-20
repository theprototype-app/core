// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import {
	normalizeDecal,
	isDecalObject,
	isNewerDecalRecord,
	projectDecal,
	targetRefusal,
	admitStamp,
	expireStamps,
	stampFade,
	stampCap,
	DECAL_MAX_SOURCE_TRIS
} from './decalCore.js';
import { applyDecalProxyLook, decalPlaceholderGeometry } from './decalObject.js';
import { resolveShaderTexture, shaderTextureFor, registerShaderTextureListener, shareShaderTexture } from './shaderTextures.js';
import { registerParkHook } from './parkHooks.js';
import { TControls } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { sessionNow } from './sessionClock.js';

// 102 M3 — DECALS, the runtime. LOCAL per peer and never saved: only the record on the carrier
// (and the carrier's transform) travels; every peer builds the same clipped surface from it and
// from the target's own geometry (golden rule 8, the text object's rule).
//
// Per carrier, ONE visual mesh hangs at the scene root (objectsGroup's parent, the text visual's
// place) sharing the carrier's built geometry, its matrix glued to the carrier's every frame. The
// carrier's own material stays the invisible proxy, so an image never reaches a toJSON.
//
// WHEN IT REBUILDS: the carrier's geometry lives in the carrier's frame (the unit projector box),
// so a target moving rigidly — the carrier is its child — costs nothing. A build runs when the box
// moves against the target (its LOCAL matrix changed and the gizmo let go: "rebuild on transform
// end"), when the target's geometry changes (a geometry uuid or position version), or when the
// record's wrap angle does.
//
// DRAW ORDER: polygonOffset pulls the visual toward the camera and renderOrder puts it after its
// target; the geometry also sits 1 mm off the surface so a click lands on the decal first. The
// material is a PLAIN MeshStandardMaterial (no onBeforeCompile), so the Cinematic view (WebGPU)
// draws it and its "Not shown" chip never lists it. A target with a baked light map lends it to
// the decal: the bake uv is carried through the clip, so the sticker is lit like the wall.

/** the visuals are tagged so serializers and pickers skip them */
const VISUAL_NAME = 'Decal (visual)';
const STAMP_NAME = 'Decal stamp (visual)';
/** metres the surface is pushed toward the projector */
const PUSH_M = 0.001;
/** frames between re-reading a target's geometry signature when nothing else asked */
const TARGET_CHECK_FRAMES = 15;

/**
 * @typedef {{
 *   carrier: any, visual: any, material: any, recRef: any, rec: any,
 *   localKey: string, targetKey: string, angle: number, built: any, frame: number,
 *   refused: string, lightKey: string, imageReady: string
 * }} Entry
 */

/** @type {Map<string, Entry>} */
const entries = new Map();
let visualParent = /** @type {any} */ (null);
let frame = 0;
let newerNoticed = false;
/** refusals already said (one toast per carrier per reason) @type {Set<string>} */
const refusalsSaid = new Set();

// ---- textures ----------------------------------------------------------------------------------

/** hash -> a clamped copy of the shared shader texture (a decal must not repeat at its edges) */
const clamped = new Map();
let placeholderTex = /** @type {any} */ (null);
let texTick = 0;

registerShaderTextureListener(() => {
	texTick++;
});

/** the look of a decal with no image yet: a soft square with a frame, so it is findable */
function placeholderTexture() {
	if (placeholderTex) return placeholderTex;
	const n = 64;
	const data = new Uint8Array(n * n * 4);
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			const i = (y * n + x) * 4;
			const edge = x < 3 || y < 3 || x > n - 4 || y > n - 4;
			// a dashed frame: the corners of a placement, not a solid sticker
			const dash = edge && ((x >> 3) + (y >> 3)) % 2 === 0;
			data[i] = data[i + 1] = data[i + 2] = 255;
			data[i + 3] = dash ? 230 : edge ? 90 : 46;
		}
	placeholderTex = new THREE.DataTexture(data, n, n);
	placeholderTex.colorSpace = THREE.SRGBColorSpace;
	placeholderTex.needsUpdate = true;
	return placeholderTex;
}

/** @param {string} hash @returns {any} the texture, or null while it is on its way */
function decalTexture(hash) {
	if (!hash) return null;
	const hit = clamped.get(hash);
	if (hit) return hit;
	const base = shaderTextureFor(hash);
	if (!base) {
		void resolveShaderTexture(hash);
		return null;
	}
	const t = base.clone();
	t.wrapS = THREE.ClampToEdgeWrapping;
	t.wrapT = THREE.ClampToEdgeWrapping;
	t.needsUpdate = true;
	clamped.set(hash, t);
	return t;
}

/** @param {any} material @param {any} rec @param {number} fade */
function applyLook(material, rec, fade = 1) {
	const tex = decalTexture(rec.image) ?? placeholderTexture();
	if (material.map !== tex) {
		material.map = tex;
		material.needsUpdate = true;
	}
	material.color.set(rec.tint);
	material.opacity = rec.opacity * fade;
	material.roughness = rec.roughness;
	return !!rec.image && tex !== placeholderTex;
}

function makeMaterial() {
	return new THREE.MeshStandardMaterial({
		color: 0xffffff,
		transparent: true,
		depthWrite: false,
		polygonOffset: true,
		polygonOffsetFactor: -4,
		polygonOffsetUnits: -4,
		metalness: 0,
		roughness: 0.8,
		alphaTest: 0.002
	});
}

// ---- what a target is made of -------------------------------------------------------------------

/**
 * The meshes under a target that a decal wraps, and the facts that refuse it.
 * @param {any} target @returns {{ meshes: any[], facts: any }}
 */
function surfaceOf(target) {
	/** @type {any[]} */
	const meshes = [];
	/** @type {any} */
	const facts = { skinned: false, scattered: false, instanced: false, tris: 0 };
	/** @param {any} node @param {boolean} root */
	const walk = (node, root) => {
		if (!root && (node.visible === false || isDecalObject(node))) return;
		if (node.name === VISUAL_NAME || node.name === STAMP_NAME) return;
		if (node.isSkinnedMesh) facts.skinned = true;
		else if (node.isInstancedMesh) {
			// scatter on a terrain is skipped (the terrain itself takes the decal); a target that IS
			// only instances is refused below
		} else if (node.isMesh && node.geometry?.attributes?.position) {
			meshes.push(node);
			const g = node.geometry;
			facts.tris += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
		}
		for (const child of node.children) walk(child, false);
	};
	walk(target, true);
	if (target?.isInstancedMesh) facts.instanced = true;
	if (target?.userData?.scatterSet) facts.scattered = true;
	return { meshes, facts };
}

/** the target's geometry signature: what a rebuild depends on besides the box @param {any[]} meshes @param {any} target */
function targetKeyOf(meshes, target) {
	target.updateWorldMatrix(true, true);
	const inv = new THREE.Matrix4().copy(target.matrixWorld).invert();
	const m = new THREE.Matrix4();
	let key = '';
	for (const mesh of meshes) {
		const g = mesh.geometry;
		m.multiplyMatrices(inv, mesh.matrixWorld);
		key += g.uuid + ':' + g.attributes.position.version + ':' + (g.index?.version ?? '') + ':' + m.elements.map((v) => v.toFixed(4)).join(',') + '|';
	}
	return key;
}

/** @param {any} carrier */
function localKeyOf(carrier) {
	carrier.updateMatrix();
	return carrier.matrix.elements.map((/** @type {number} */ v) => v.toFixed(5)).join(',');
}

/**
 * The bake a target lends: its light map and the uv attribute it reads, when every mesh agrees.
 * @param {any[]} meshes @returns {{ map: any, ao: any, li: number, ai: number, attr: string } | null}
 */
function bakeOf(meshes) {
	/** @type {any} */
	let found = null;
	for (const mesh of meshes) {
		const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
		const lm = m?.lightMap;
		if (!lm) return null;
		const ch = lm.channel ?? 0;
		const attr = ch === 0 ? 'uv' : 'uv' + ch;
		if (ch === 0 || !mesh.geometry.attributes[attr]) return null;
		if (found && (found.map !== lm || found.attr !== attr)) return null;
		found = { map: lm, ao: m.aoMap && m.aoMap.channel === ch ? m.aoMap : null, li: m.lightMapIntensity ?? 1, ai: m.aoMapIntensity ?? 1, attr };
	}
	return found;
}

/**
 * Build the clipped surface for a box (its world matrix) against a target's meshes.
 * @param {any} boxWorld THREE.Matrix4 @param {any[]} meshes @param {number} angle @param {any} bake
 * @returns {any} a BufferGeometry in box space
 */
function buildGeometry(boxWorld, meshes, angle, bake) {
	const worldToBox = new THREE.Matrix4().copy(boxWorld).invert();
	const sources = meshes.map((mesh) => {
		const g = mesh.geometry;
		return {
			positions: g.attributes.position.array,
			index: g.index ? g.index.array : null,
			normals: g.attributes.normal?.array ?? null,
			uv2: bake ? (g.attributes[bake.attr]?.array ?? null) : null,
			meshToWorld: mesh.matrixWorld.elements
		};
	});
	// 1 mm in box units along +Z (the box's depth axis may be scaled)
	const zLen = new THREE.Vector3().setFromMatrixColumn(boxWorld, 2).length() || 1;
	const out = projectDecal(sources, worldToBox.elements, boxWorld.elements, { angle, push: PUSH_M / zLen });
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.BufferAttribute(out.position, 3));
	geo.setAttribute('normal', new THREE.BufferAttribute(out.normal, 3));
	geo.setAttribute('uv', new THREE.BufferAttribute(out.uv, 2));
	if (bake && out.uv2) geo.setAttribute(bake.attr, new THREE.BufferAttribute(out.uv2, 2));
	geo.computeBoundingSphere();
	geo.computeBoundingBox();
	geo.userData.decalTris = out.tris;
	geo.userData.decalCapped = out.capped;
	return geo;
}

/** @param {any} material @param {any} bake */
function applyBake(material, bake) {
	const map = bake?.map ?? null;
	const ao = bake?.ao ?? null;
	if (material.lightMap !== map || material.aoMap !== ao) {
		material.lightMap = map;
		material.aoMap = ao;
		material.needsUpdate = true;
	}
	if (bake) {
		material.lightMapIntensity = bake.li;
		material.aoMapIntensity = bake.ai;
	}
}

// ---- carriers ----------------------------------------------------------------------------------

/** @param {any} carrier @returns {Entry} */
function makeEntry(carrier) {
	const material = makeMaterial();
	const visual = new THREE.Mesh(carrier.geometry, material);
	visual.name = VISUAL_NAME;
	visual.matrixAutoUpdate = false;
	visual.castShadow = false;
	visual.receiveShadow = true;
	visual.raycast = () => {};
	visual.userData.decalOf = carrier.uuid;
	return { carrier, visual, material, recRef: null, rec: null, localKey: '', targetKey: '', angle: -1, built: null, frame: 0, refused: '', lightKey: '', imageReady: '' };
}

/** @param {Entry} e */
function disposeEntry(e) {
	e.visual.parent?.remove(e.visual);
	e.material.dispose();
	if (e.built) {
		// hand the carrier back its placeholder before the geometry goes
		if (e.carrier.geometry === e.built) e.carrier.geometry = decalPlaceholderGeometry();
		e.built.dispose();
	}
}

/** @param {any} o @param {any} root visible all the way up to the content root */
function shown(o, root) {
	for (let p = o; p && p !== root; p = p.parent) if (!p.visible) return false;
	return true;
}

/** is the gizmo holding this carrier right now (a transform still in progress) @param {any} carrier */
function dragging(carrier) {
	/** @type {any} */
	const tc = get(TControls);
	return !!tc?.dragging && tc.object === carrier;
}

/** @param {Entry} e @param {any} root */
function maybeBuild(e, root) {
	const c = e.carrier;
	const target = c.parent && c.parent !== root ? c.parent : null;
	if (!target) {
		// a decal with nothing under it (dragged out to the top level): it keeps its last surface
		return;
	}
	const localKey = localKeyOf(c);
	const recheck = e.frame++ % TARGET_CHECK_FRAMES === 0;
	if (localKey === e.localKey && e.angle === e.rec.angle && !recheck) return;
	if (dragging(c)) return; // rebuild on transform END; until then the old surface rides along
	const { meshes, facts } = surfaceOf(target);
	if (!meshes.length && !facts.skinned) facts.none = true;
	const refusal = targetRefusal(facts);
	if (refusal) {
		if (e.refused !== refusal) {
			e.refused = refusal;
			const said = c.uuid + refusal;
			if (!refusalsSaid.has(said)) {
				refusalsSaid.add(said);
				showToast(refusal);
			}
		}
		return;
	}
	e.refused = '';
	const targetKey = targetKeyOf(meshes, target);
	const bake = bakeOf(meshes);
	const lightKey = bake ? bake.map.uuid + bake.attr : '';
	if (localKey === e.localKey && targetKey === e.targetKey && e.angle === e.rec.angle && lightKey === e.lightKey) return;
	c.updateWorldMatrix(true, false);
	const geo = buildGeometry(c.matrixWorld, meshes, e.rec.angle, bake);
	const old = e.built;
	e.built = geo;
	c.geometry = geo;
	e.visual.geometry = geo;
	if (old) old.dispose();
	applyBake(e.material, bake);
	e.localKey = localKey;
	e.targetKey = targetKey;
	e.angle = e.rec.angle;
	e.lightKey = lightKey;
	builds++;
}
let builds = 0;

// the geometry is the RECORD's, never the save's: a serializer reads the placeholder
let parkGeo = /** @type {any} */ (null);
registerParkHook(() => {
	/** @type {(() => void)[]} */
	const undo = [];
	parkGeo ??= decalPlaceholderGeometry();
	for (const e of entries.values()) {
		const c = e.carrier;
		if (!e.built || c.geometry !== e.built) continue;
		const geo = c.geometry;
		c.geometry = parkGeo;
		undo.push(() => {
			if (c.geometry === parkGeo) c.geometry = geo;
		});
	}
	return undo.length ? () => undo.forEach((u) => u()) : null;
});

/**
 * Serialize ONE carrier as its record (the wire's handshake send): toJSON read with the placeholder
 * in, whatever the park state.
 * @param {any} carrier
 */
export function carrierJSON(carrier) {
	const e = entries.get(carrier.uuid);
	if (!e?.built || carrier.geometry !== e.built) return carrier.toJSON();
	parkGeo ??= decalPlaceholderGeometry();
	carrier.geometry = parkGeo;
	try {
		return carrier.toJSON();
	} finally {
		carrier.geometry = e.built;
	}
}

const inv = new THREE.Matrix4();

/**
 * Per frame (decalTick): one visual per carrier, built from its record and glued to it, plus the
 * stamped marks. Nothing here is sent or saved.
 * @param {any} root objectsGroup @param {number} now ms (performance clock)
 */
export function tickDecals(root, now) {
	visualParent = root?.parent ?? null;
	/** @type {Set<string>} */
	const alive = new Set();
	if (root && visualParent) {
		visualParent.updateWorldMatrix(true, false);
		inv.copy(visualParent.matrixWorld).invert();
		root.traverse((/** @type {any} */ o) => {
			if (!o.isMesh || !isDecalObject(o)) return;
			alive.add(o.uuid);
			let e = entries.get(o.uuid);
			if (e && e.carrier !== o) {
				// a replaced object under the same uuid (an override sync, an undo of a delete)
				disposeEntry(e);
				e = undefined;
			}
			if (!e) {
				e = makeEntry(o);
				entries.set(o.uuid, e);
				applyDecalProxyLook(o);
				o.castShadow = false;
			}
			if (o.userData.decal !== e.recRef) {
				e.recRef = o.userData.decal;
				e.rec = normalizeDecal(e.recRef);
				if (!newerNoticed && isNewerDecalRecord(e.recRef)) {
					newerNoticed = true;
					showToast('A decal in this scene was made with a newer version of theprototype.app — it may look different here. Reload to update.');
				}
				if (e.rec.image) shareShaderTexture(e.rec.image);
				e.imageReady = '';
			}
			// the image lands later than the record on a joiner: re-read the look while it is missing
			if (e.imageReady !== e.rec.image + texTick) {
				const ready = applyLook(e.material, e.rec);
				e.imageReady = ready || !e.rec.image ? e.rec.image + texTick : '';
			} else {
				e.material.color.set(e.rec.tint);
				e.material.opacity = e.rec.opacity;
				e.material.roughness = e.rec.roughness;
			}
			maybeBuild(e, root);
			const v = e.visual;
			if (v.geometry !== o.geometry && o.geometry === e.built) v.geometry = o.geometry;
			if (v.parent !== visualParent) visualParent.add(v);
			v.visible = shown(o, root) && !!e.built;
			v.renderOrder = (o.parent?.renderOrder ?? 0) + 1;
			o.updateWorldMatrix(true, false);
			v.matrix.copy(inv).multiply(o.matrixWorld);
			v.matrixWorldNeedsUpdate = true;
		});
	}
	for (const [uuid, e] of entries)
		if (!alive.has(uuid)) {
			disposeEntry(e);
			entries.delete(uuid);
		}
	tickStamps(root, now);
}

// ---- stamped marks (the flow action) -----------------------------------------------------------

/**
 * @typedef {{
 *   id: string, at: number, life: number, target: string, pose: number[],
 *   image: string, tint: string, opacity: number, cap: number,
 *   visual?: any, material?: any
 * }} LiveStamp pose = the box in the TARGET's frame (column-major 4x4)
 */

/** oldest first @type {LiveStamp[]} */
let stamps = [];
const stampBox = new THREE.Matrix4();
const stampLocal = new THREE.Matrix4();

/** @param {LiveStamp} s */
function dropStamp(s) {
	s.visual?.parent?.remove(s.visual);
	s.visual?.geometry?.dispose();
	s.material?.dispose();
}

/**
 * Take a stamp (from this peer's action, or off the wire). Built at once against its target;
 * the pool keeps the newest `cap`.
 * @param {any} raw @returns {boolean} added
 */
export function applyDecalStamp(raw) {
	if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !Array.isArray(raw.pose) || raw.pose.length !== 16) return false;
	if (!raw.pose.every((/** @type {any} */ v) => Number.isFinite(v))) return false;
	const rec = normalizeDecal({ image: raw.image, tint: raw.tint, opacity: raw.opacity });
	/** @type {LiveStamp} */
	const s = {
		id: raw.id.slice(0, 64),
		at: Number(raw.at) || sessionNow(),
		life: Math.max(0, Math.min(600, Number(raw.life) || 0)),
		target: String(raw.target ?? ''),
		pose: raw.pose.map(Number),
		image: rec.image,
		tint: rec.tint,
		opacity: rec.opacity,
		cap: stampCap(raw.cap)
	};
	const r = admitStamp(stamps, s, s.cap);
	if (!r.added) return false;
	for (const old of r.evicted) dropStamp(/** @type {LiveStamp} */ (old));
	stamps = /** @type {LiveStamp[]} */ (r.list);
	return true;
}

/** the run stopped: every mark goes */
export function clearDecalStamps() {
	for (const s of stamps) dropStamp(s);
	stamps = [];
}

/** @param {any} root @param {number} _now */
function tickStamps(root, _now) {
	if (!stamps.length || !root || !visualParent) return;
	const t = sessionNow();
	const ex = expireStamps(stamps, t);
	for (const s of ex.expired) dropStamp(/** @type {LiveStamp} */ (s));
	stamps = /** @type {LiveStamp[]} */ (ex.list);
	for (const s of stamps) {
		const target = root.getObjectByProperty('uuid', s.target);
		if (!target) {
			if (s.visual) s.visual.visible = false;
			continue;
		}
		target.updateWorldMatrix(true, true);
		stampLocal.fromArray(s.pose);
		stampBox.multiplyMatrices(target.matrixWorld, stampLocal);
		if (!s.visual) {
			const { meshes, facts } = surfaceOf(target);
			if (targetRefusal(facts) || !meshes.length) {
				s.life = 0.001; // gone next frame
				continue;
			}
			const geo = buildGeometry(stampBox, meshes, 80, bakeOf(meshes));
			s.material = makeMaterial();
			applyBake(s.material, bakeOf(meshes));
			s.visual = new THREE.Mesh(geo, s.material);
			s.visual.name = STAMP_NAME;
			s.visual.matrixAutoUpdate = false;
			s.visual.raycast = () => {};
			s.visual.receiveShadow = true;
			if (s.image) shareShaderTexture(s.image);
		}
		if (s.visual.parent !== visualParent) visualParent.add(s.visual);
		applyLook(s.material, /** @type {any} */ (s), stampFade(s, t));
		s.visual.visible = shown(target, root);
		s.visual.renderOrder = (target.renderOrder ?? 0) + 2;
		s.visual.matrix.copy(inv).multiply(stampBox);
		s.visual.matrixWorldNeedsUpdate = true;
	}
}

// ---- seams ---------------------------------------------------------------------------------------

/** debug / e2e: what the runtime holds */
export function decalDebug() {
	return {
		carriers: [...entries.values()].map((e) => ({
			uuid: e.carrier.uuid,
			target: e.carrier.parent?.uuid ?? null,
			tris: e.built?.userData?.decalTris ?? 0,
			capped: !!e.built?.userData?.decalCapped,
			visible: !!e.visual.visible,
			refused: e.refused,
			image: e.rec?.image ?? '',
			mapped: !!e.material.map && e.material.map !== placeholderTex,
			baked: !!e.material.lightMap,
			renderOrder: e.visual.renderOrder,
			polygonOffset: e.material.polygonOffset,
			materialType: e.material.type,
			patched: Object.prototype.hasOwnProperty.call(e.material, 'onBeforeCompile')
		})),
		stamps: stamps.map((s) => ({ id: s.id, target: s.target, built: !!s.visual, tris: s.visual?.geometry?.userData?.decalTris ?? 0, at: s.at, life: s.life })),
		builds,
		sourceCap: DECAL_MAX_SOURCE_TRIS
	};
}

/** the carrier's current built geometry (decalEdit reads it to say "nothing to wrap") @param {string} uuid */
export function decalTrisOf(uuid) {
	return entries.get(uuid)?.built?.userData?.decalTris ?? null;
}

/** force a rebuild on the next tick (an edit that the keys cannot see) @param {string} uuid */
export function invalidateDecal(uuid) {
	const e = entries.get(uuid);
	if (e) e.localKey = '';
}

