// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
// @ts-ignore - troika-three-text ships no type declarations (threlte's <Text> dependency)
import { Text } from 'troika-three-text';
import {
	CARET_STRIDE,
	normalizeTextPath,
	isBlockText,
	isTextPathObject,
	builtinPolyline,
	makeSampler,
	indexColorRanges,
	decodeGlyphChars,
	mergeLetterStyles,
	layoutOnPath,
	glyphColors,
	glyphQuads,
	isNewerTextRecord
} from './textPathCore.js';
import { applyTextProxyLook, textPlaceholderGeometry } from './textPathObject.js';
import { textPathPolylineOf, textPathSourceKey } from './textPathSources.js';
import { layoutInPlace, blockAlign, anchorParts } from './text3dCore.js';
import { bundledFlatUrl, bundledSolidUrl, fontAssetUrl, fontAssetHere, resolveFontAsset, onFontLanded, shareFontAsset } from './textFonts.js';
import { registerParkHook } from './parkHooks.js';
import { coarsePointer } from './inputDevice.js';
import { isVRMode } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { get } from 'svelte/store';

// 64-text: the ONE text object has two modes on the same record. FLAT (this file's troika
// visual, as below — a block of text, or text on a path) and EXTRUDED: the carrier itself becomes
// the solid letters (text3dBuild, a lazy chunk with opentype.js), so selection, VR rays, shadows
// and Bake → mesh treat it like any mesh. Its geometry is never saved or sent: a park hook swaps
// the placeholder in while a serializer reads the scene, and every peer builds its own.

// 64 D2 — TEXT ON A PATH, the runtime. LOCAL per peer and never saved: only the record on the
// carrier travels; every peer lays the same letters out from it (golden rule 8).
//
// Per carrier, one troika `Text` hangs at the scene root (objectsGroup's parent, the
// flowPaths overlay pattern) with its matrix glued to the carrier's every frame. troika does
// the typesetting on a straight baseline (fonts, kerning, ligatures, fallback scripts, the SDF
// atlas) and paints each character with its own index (`indexColorRanges`), which is how its
// glyphs are mapped back to characters; `layoutOnPath` then turns every glyph into an affine
// transform onto the curve, and the vertex shader applies it from three instanced rows. The
// index colours are replaced by the real ones in the same synchronous `synccomplete` handler
// that delivered them, so no frame ever draws them.
//
// The carrier's geometry becomes the glyph quads (the hit proxy) after each layout.
// Linked text (path.kind 'object') copies its source object's world transform into the
// carrier every frame: deterministic on every peer, no pose ever sent for it.
//
// 65 M3 drives letters through `setLetterOverrides` — a LOCAL layer over the record's styles
// (never replicated, never undone; it is fed from the synced clock).

/** the scene-root visuals are tagged so serializers and pickers skip them */
const VISUAL_NAME = 'Text on a path (visual)';

/** frames between looking a lost link target up again (a deleted path, a late joiner's scene) */
const RELINK_FRAMES = 30;

let baseMaterial = /** @type {any} */ (null);

/** ONE base material for every text: unlit (the letters show their exact colour), path rows in the vertex stage */
function pathMaterial() {
	if (baseMaterial) return baseMaterial;
	const m = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, toneMapped: false });
	// troika derives its text material from this one and calls this hook FIRST, on the
	// unexpanded shader, then renames `position` to its own laid-out glyph vertex — so
	// `transformed` after <begin_vertex> is the glyph on the straight baseline
	m.onBeforeCompile = (/** @type {any} */ shader) => {
		shader.vertexShader = shader.vertexShader
			.replace(
				'#include <common>',
				'#include <common>\nattribute vec4 aTpRow0;\nattribute vec4 aTpRow1;\nattribute vec4 aTpRow2;\nattribute float aTpAlpha;\nvarying float vTpAlpha;'
			)
			.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\nvec4 tpV = vec4(transformed, 1.0);\ntransformed = vec3(dot(aTpRow0, tpV), dot(aTpRow1, tpV), dot(aTpRow2, tpV));\nvTpAlpha = aTpAlpha;'
			);
		shader.fragmentShader = shader.fragmentShader
			.replace('#include <common>', '#include <common>\nvarying float vTpAlpha;')
			.replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vTpAlpha;');
	};
	m.customProgramCacheKey = () => 'tpTextPath1';
	baseMaterial = m;
	return m;
}

/** hashes whose missing-font notice was shown (once per font per session) @type {Set<string>} */
const noticed = new Set();

/**
 * The font file a record draws with: a Library font (when its bytes are here), else the bundled
 * one. A Library font still on its way falls back to Noto Sans with ONE notice, and the text is
 * laid out again when the bytes land (onFontLanded).
 * @param {any} rec @param {boolean} solid extruded (needs a concrete file) or flat ('sans' = troika's resolver)
 * @returns {string | null}
 */
function fontUrlFor(rec, solid) {
	if (rec.fontAsset) {
		const url = fontAssetUrl(rec.fontAsset);
		if (url) return url;
		void resolveFontAsset(rec.fontAsset);
		// the bytes are HERE and only being read into an object URL (an exported game's first frame, a
		// reload): no notice and no sans mesh — wait a moment, onFontLanded lays the text out again
		if (fontAssetHere(rec.fontAsset)) return null;
		if (!noticed.has(rec.fontAsset)) {
			noticed.add(rec.fontAsset);
			showToast(`The font “${rec.fontName || 'Font'}” is not on this device yet — showing Noto Sans until it arrives.`);
		}
		return solid ? bundledSolidUrl('sans') : null;
	}
	return solid ? bundledSolidUrl(rec.font) : bundledFlatUrl(rec.font);
}

/**
 * The font file a SOLID build of this record uses, waiting for a Library font that is here (one that is not
 * yet falls back to sans, as the live text does). For a peer baking a text it never built (textPathEdit).
 * @param {any} rec a normalized record @returns {Promise<string>}
 */
export async function solidFontUrl(rec) {
	if (rec.fontAsset) return fontAssetUrl(rec.fontAsset) ?? (await resolveFontAsset(rec.fontAsset)) ?? bundledSolidUrl('sans');
	return bundledSolidUrl(rec.font);
}

/** 'low' on a phone or in a headset (TX6 caps) */
export function textProfile() {
	const forced = typeof window !== 'undefined' ? /** @type {any} */ (window).__tpTextProfile : null;
	if (forced === 'low' || forced === 'desktop') return forced;
	return coarsePointer() || get(isVRMode) ? 'low' : 'desktop';
}

/**
 * @typedef {{carrier: any, text: any, rec: any, recRef: any, troikaKey: string, info: any,
 *   glyphChars: Int32Array | null, target: any, relinkIn: number, sourceKey: any,
 *   overrides: any, dirty: boolean, synced: boolean, glyphs: number, hidden: number, rows: Float32Array | null,
 *   solidKey: string, solidGeo: any, solidMats: any[] | null, solidInfo: any, building: boolean, solidWanted: string, recKey: string}} Entry
 */
/** @type {Map<string, Entry>} */
const entries = new Map();
let visualParent = /** @type {any} */ (null);
let rootRef = /** @type {any} */ (null);

/** the troika-side fields: a change to any of these re-typesets (asynchronously) @param {any} rec */
const troikaKeyOf = (rec) =>
	JSON.stringify([
		rec.text,
		fontUrlFor(rec, false),
		rec.bold,
		rec.italic,
		rec.size,
		rec.spacing,
		rec.lineHeight,
		rec.outline,
		rec.outlineColor,
		isBlockText(rec) ? [rec.maxWidth, rec.align, rec.anchor] : 0
	]);

/** @param {Entry} e */
function applyTroika(e) {
	const t = e.text;
	const rec = e.rec;
	// 64-text: a block of text wraps, aligns and sits on its anchor; text on a path is laid out
	// straight from the origin and then carried onto the curve (layoutOnPath)
	if (isBlockText(rec)) {
		const a = anchorParts(rec.anchor);
		t.anchorX = a.x;
		t.anchorY = a.y;
		t.textAlign = blockAlign(rec.align);
		t.whiteSpace = 'normal';
		t.maxWidth = rec.maxWidth > 0 ? rec.maxWidth : Infinity;
	} else {
		t.anchorX = 0;
		t.anchorY = 'top-baseline';
		t.textAlign = 'left';
		t.whiteSpace = 'nowrap';
		t.maxWidth = Infinity;
	}
	t.text = rec.text;
	t.font = fontUrlFor(rec, false);
	t.fontSize = rec.size;
	t.fontWeight = rec.bold ? 'bold' : 'normal';
	t.fontStyle = rec.italic ? 'italic' : 'normal';
	t.letterSpacing = rec.spacing;
	t.lineHeight = rec.lineHeight;
	t.outlineWidth = rec.outline > 0 ? rec.outline * rec.size : 0;
	t.outlineColor = rec.outlineColor;
	t.colorRanges = indexColorRanges(rec.text.length);
	t.sync();
}

/** @param {any} carrier @returns {Entry} */
function makeEntry(carrier) {
	const text = new Text();
	text.name = VISUAL_NAME;
	text.userData.__textPathVisual = true;
	text.material = pathMaterial();
	text.anchorX = 0;
	text.anchorY = 'top-baseline';
	text.textAlign = 'left';
	text.whiteSpace = 'nowrap';
	text.matrixAutoUpdate = false;
	text.frustumCulled = false; // the geometry's bounds are the STRAIGHT layout, not the curve
	text.raycast = () => {}; // the carrier is what a click hits
	/** @type {Entry} */
	const e = {
		carrier,
		text,
		rec: null,
		recRef: null,
		troikaKey: '',
		info: null,
		glyphChars: null,
		target: null,
		relinkIn: 0,
		sourceKey: undefined,
		overrides: null,
		dirty: true,
		synced: false,
		glyphs: 0,
		hidden: 0,
		rows: null,
		solidKey: '',
		solidGeo: null,
		solidMats: null,
		solidInfo: null,
		building: false,
		solidWanted: '',
		recKey: ''
	};
	text.addEventListener('synccomplete', () => {
		const info = text.textRenderInfo;
		if (!info) return;
		e.info = info;
		e.glyphChars = decodeGlyphChars(info.glyphColors);
		e.synced = true;
		layout(e); // in the same task as troika's updateGlyphs: the index colours never draw
	});
	return e;
}

/** @param {Entry} e */
function disposeEntry(e) {
	e.text.removeFromParent();
	e.text.dispose(); // its own geometry; the shared base material stays
	// a carrier that is still a text (deleted, or replaced) gives its solid look back; a BAKED one
	// keeps its geometry + materials — they are the mesh now
	if (e.solidGeo && e.carrier.userData?.textPath && e.carrier.geometry === e.solidGeo) {
		e.carrier.geometry = textPlaceholderGeometry();
		applyTextProxyLook(e.carrier);
	}
	e.solidGeo = null;
	e.solidMats = null;
}

/** the curve in the carrier's frame @param {Entry} e */
function polylineOf(e) {
	if (e.rec.path.kind === 'object' && e.target) {
		const line = textPathPolylineOf(e.target);
		if (line) return line;
	}
	return builtinPolyline(e.rec.path);
}

/** lay the glyphs on the path and rebuild the hit proxy @param {Entry} e */
function layout(e) {
	e.dirty = false;
	const info = e.info;
	if (!info || !e.rec) return;
	const rec = e.rec;
	if (rec.mode === 'extruded') return; // the carrier is the letters (ensureSolid)
	const charCount = Math.floor((info.caretPositions?.length ?? 0) / CARET_STRIDE);
	const styles = mergeLetterStyles(charCount, rec.letters, e.overrides);
	const glyphChars = e.glyphChars ?? new Int32Array(0);
	let rows;
	let hidden;
	if (isBlockText(rec)) {
		// 64-text: a block keeps troika's own placement; letters only take their styles
		({ rows, hidden } = layoutInPlace({ glyphBounds: info.glyphBounds, glyphChars, caretPositions: info.caretPositions, fontSize: rec.size }, styles, CARET_STRIDE));
	} else {
		const line = polylineOf(e);
		const sampler = makeSampler(line, rec.side === 'right');
		const orient = rec.orient === 'auto' ? (line.orient ?? 'flat') : rec.orient;
		({ rows, hidden } = layoutOnPath(
			{ glyphBounds: info.glyphBounds, glyphChars, caretPositions: info.caretPositions, lineHeight: info.lineHeight, fontSize: rec.size },
			styles,
			sampler,
			{ normal: line.normal, orient, align: rec.align, offset: rec.offset, shift: rec.shift }
		));
	}
	const n = glyphChars.length;
	const r0 = new Float32Array(n * 4);
	const r1 = new Float32Array(n * 4);
	const r2 = new Float32Array(n * 4);
	const alpha = new Float32Array(n);
	let hiddenCount = 0;
	for (let g = 0; g < n; g++) {
		r0.set(rows.subarray(g * 12, g * 12 + 4), g * 4);
		r1.set(rows.subarray(g * 12 + 4, g * 12 + 8), g * 4);
		r2.set(rows.subarray(g * 12 + 8, g * 12 + 12), g * 4);
		alpha[g] = styles[glyphChars[g]]?.opacity ?? 1;
		if (hidden[g]) hiddenCount++;
	}
	const geo = e.text.geometry;
	geo.updateAttributeData('aTpRow0', r0, 4);
	geo.updateAttributeData('aTpRow1', r1, 4);
	geo.updateAttributeData('aTpRow2', r2, 4);
	geo.updateAttributeData('aTpAlpha', alpha, 1);
	geo.updateAttributeData('aTroikaGlyphColor', glyphColors(glyphChars, styles, rec.color), 3);
	e.glyphs = n;
	e.hidden = hiddenCount;
	e.rows = rows;
	// the hit proxy, in the carrier's own frame
	const { positions, index } = glyphQuads(info.glyphBounds, rows, hidden);
	const proxy = new THREE.BufferGeometry();
	proxy.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	proxy.setIndex(new THREE.BufferAttribute(index, 1));
	proxy.computeBoundingBox();
	proxy.computeBoundingSphere();
	const old = e.carrier.geometry;
	e.carrier.geometry = proxy;
	old?.dispose?.();
}

/** @type {Promise<any> | null} */
let buildMod = null;
const builder = () => (buildMod ??= import('./text3dBuild.js'));

/**
 * 64-text TX1: an EXTRUDED text's carrier shows the solid letters.
 * @param {Entry} e @param {boolean=} recChanged the record changed (materials + key refresh) Built asynchronously (the
 * font, then the geometry); the record seen at the end must still be the one asked for, or the
 * result is dropped and the next tick asks again.
 */
function ensureSolid(e, recChanged = false) {
	const rec = e.rec;
	if (recChanged) {
		e.recKey = JSON.stringify(rec);
		const mats = e.solidMats;
		if (mats) builder().then((m) => m.extrudedMaterials(rec, mats));
	}
	const url = fontUrlFor(rec, true);
	if (!url) return;
	const profile = textProfile();
	const wanted = url + '|' + profile + '|' + e.recKey;
	if (wanted === e.solidWanted || e.building) return;
	e.building = true;
	const recRef = e.recRef;
	builder()
		.then(async (m) => {
			const { geometry, info } = await m.buildExtruded(rec, url, profile);
			e.building = false;
			if (e.recRef !== recRef || !entries.has(e.carrier.uuid) || entries.get(e.carrier.uuid) !== e || e.rec.mode !== 'extruded') return;
			e.solidWanted = wanted;
			const c = e.carrier;
			const old = c.geometry;
			c.geometry = geometry;
			if (old && old !== geometry && !m.ownsGeometry(old)) old.dispose?.();
			e.solidGeo = geometry;
			e.solidInfo = info;
			const mats = m.extrudedMaterials(rec, e.solidMats);
			if (c.material !== mats) {
				const prev = c.material;
				c.material = mats;
				if (prev && prev !== e.solidMats && !Array.isArray(prev)) prev.dispose?.();
			}
			e.solidMats = mats;
			c.castShadow = true;
			c.receiveShadow = true;
			m.releaseExtruded((/** @type {any} */ g) => [...entries.values()].some((x) => x.carrier.geometry === g));
		})
		.catch((err) => {
			e.building = false;
			e.solidWanted = wanted; // do not retry a broken font every frame
			console.log('extruded text failed', err);
			showToast('Could not build the solid text: ' + (err?.message ?? 'the font did not load') + '.');
		});
}

/** back from extruded to flat: the carrier is the invisible hit proxy again @param {Entry} e */
function leaveSolid(e) {
	if (!e.solidGeo) return;
	const c = e.carrier;
	if (c.geometry === e.solidGeo) c.geometry = textPlaceholderGeometry();
	e.solidMats?.forEach((m) => m.dispose?.());
	e.solidMats = null;
	e.solidGeo = null;
	e.solidWanted = '';
	e.solidInfo = null;
	c.castShadow = false;
	c.receiveShadow = false;
	applyTextProxyLook(c);
	e.troikaKey = ''; // re-typeset so the proxy comes back
}

// the geometry is the RECORD's, never the save's: a serializer reads the placeholder
registerParkHook(() => {
	/** @type {(() => void)[]} */
	const undo = [];
	for (const e of entries.values()) {
		const c = e.carrier;
		if (!e.solidGeo || c.geometry !== e.solidGeo || !c.userData?.textPath) continue;
		const geo = c.geometry;
		const mat = c.material;
		const parkedGeo = (c.geometry = parkGeometry());
		const parkedMat = (c.material = parkMaterial());
		undo.push(() => {
			// fix-bake: an autosave export holds the park across its async encode — a carrier BAKED in
			// between (a redo, a peer's bake) has its own mesh now; putting the solid back would hand the
			// baked object the runtime's build (released later) in place of its copy
			if (c.geometry !== parkedGeo || c.material !== parkedMat) return;
			c.geometry = geo;
			c.material = mat;
		});
	}
	return undo.length ? () => undo.forEach((u) => u()) : null;
});
/** @type {any} */
let parkGeo = null;
/** @type {any} */
let parkMat = null;
const parkGeometry = () => (parkGeo ??= textPlaceholderGeometry());
function parkMaterial() {
	if (!parkMat) {
		parkMat = new THREE.MeshBasicMaterial();
		applyTextProxyLook({ material: parkMat });
	}
	return parkMat;
}

// a Library font that landed late: every text using one lays out again
onFontLanded(() => {
	for (const e of entries.values()) {
		if (!e.rec?.fontAsset) continue;
		e.recRef = null; // re-read the record: the troika key and the solid key both see the new URL
	}
});

/** @param {any} o @param {any} root visible all the way up to the content root */
function shown(o, root) {
	for (let p = o; p && p !== root; p = p.parent) if (!p.visible) return false;
	return true;
}

const m4 = new THREE.Matrix4();
const inv = new THREE.Matrix4();

/**
 * linked text: sit the carrier where its path is (local to the carrier's parent). Compared with
 * the carrier's OWN pose every frame, not with the last copy: anything else that writes it (a
 * received move easing in, a gizmo drag) is put back, or the letters would leave their path.
 * @param {Entry} e
 */
function follow(e) {
	const t = e.target;
	const c = e.carrier;
	if (!t || !c.parent) return;
	t.updateWorldMatrix(true, false);
	c.parent.updateWorldMatrix(true, false);
	m4.copy(c.parent.matrixWorld).invert().multiply(t.matrixWorld);
	c.updateMatrix();
	const el = m4.elements;
	const now = c.matrix.elements;
	if (el.every((/** @type {number} */ v, /** @type {number} */ i) => Math.abs(v - now[i]) < 1e-6)) return;
	m4.decompose(c.position, c.quaternion, c.scale);
	c.updateMatrix();
	c.updateMatrixWorld(true);
}

/** @param {Entry} e @param {any} root */
function resolveTarget(e, root) {
	const id = e.rec.path.kind === 'object' ? e.rec.path.target : null;
	if (!id) {
		e.target = null;
		return;
	}
	// a cached target that left the scene (deleted, re-parented out) is looked up again
	if (e.target && e.target.uuid === id && attached(e.target, root)) return;
	if (e.target && !attached(e.target, root)) {
		e.target = null;
		e.dirty = true;
	}
	if (e.relinkIn-- > 0) return;
	e.relinkIn = RELINK_FRAMES;
	const found = root.getObjectByProperty('uuid', id) ?? null;
	if (found && found !== e.carrier && !found.userData?.textPath) {
		e.target = found;
		e.sourceKey = undefined;
		e.dirty = true;
	}
}

/** @param {any} o @param {any} root */
function attached(o, root) {
	for (let p = o; p; p = p.parent) if (p === root) return true;
	return false;
}

/** TX4: the newer-version notice shows once per tab */
let newerNoticed = false;

/**
 * Per frame (textPathTick): one visual per text object, laid out from its record and glued to
 * its carrier. Nothing here is sent or saved.
 * @param {any} root objectsGroup
 */
export function tickTextPaths(root) {
	rootRef = root;
	visualParent = root?.parent ?? null;
	/** @type {Set<string>} */
	const alive = new Set();
	if (root && visualParent) {
		visualParent.updateWorldMatrix(true, false);
		inv.copy(visualParent.matrixWorld).invert();
		root.traverse((/** @type {any} */ o) => {
			if (!o.isMesh || !isTextPathObject(o)) return;
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
				if (normalizeTextPath(o.userData.textPath).mode !== 'extruded') applyTextProxyLook(o);
			}
			if (o.userData.textPath !== e.recRef) {
				e.recRef = o.userData.textPath;
				e.rec = normalizeTextPath(e.recRef);
				if (!newerNoticed && isNewerTextRecord(e.recRef)) {
					// TX4: drawn with what this build knows; the newer fields stay in the record
					newerNoticed = true;
					showToast('A text in this scene was made with a newer version of theprototype.app — it may look different here. Reload to update.');
				}
				if (e.rec.fontAsset) shareFontAsset(e.rec.fontAsset);
				if (e.rec.mode === 'extruded') ensureSolid(e, true);
				else {
					leaveSolid(e);
					const key = troikaKeyOf(e.rec);
					if (key !== e.troikaKey) {
						e.troikaKey = key;
						applyTroika(e); // relays out on synccomplete
					}
					applyTextProxyLook(o);
				}
				e.dirty = true;
			}
			if (e.rec.mode === 'extruded') {
				e.text.visible = false;
				// the font may land, the device may enter VR (a lower cap): ensureSolid is cheap when nothing changed
				if (!e.building) ensureSolid(e);
				return;
			}
			resolveTarget(e, root);
			if (e.target) {
				const sk = textPathSourceKey(e.target);
				if (sk !== e.sourceKey) {
					e.sourceKey = sk;
					e.dirty = true;
				}
				follow(e);
			}
			if (e.dirty && e.info) layout(e);
			const t = e.text;
			if (t.parent !== visualParent) visualParent.add(t);
			t.visible = shown(o, root);
			o.updateWorldMatrix(true, false);
			t.matrix.copy(inv).multiply(o.matrixWorld);
			t.matrixWorldNeedsUpdate = true;
		});
	}
	for (const [uuid, e] of entries)
		if (!alive.has(uuid)) {
			disposeEntry(e);
			entries.delete(uuid);
		}
}

/**
 * 65 M3: a LOCAL per-letter layer over a text's record — per character index, partial
 * `{dx, dy, rot, size, color, opacity}` (dx/dy/rot ADD, size and opacity MULTIPLY, color
 * replaces; see textPathCore.mergeLetterStyles). Never replicated, never undone, never saved:
 * drive it from the synced clock so every peer shows the same frame. null clears it.
 * Cheap enough per frame (no re-typesetting, one layout pass).
 * @param {string} uuid @param {ArrayLike<any> | null} overrides @returns {boolean} whether the text exists
 */
export function setLetterOverrides(uuid, overrides) {
	const e = entries.get(uuid);
	if (!e) return false;
	e.overrides = overrides ?? null;
	e.dirty = true;
	return true;
}

/** the characters a text holds (what 65 M3 indexes) @param {string} uuid */
export function letterCount(uuid) {
	return entries.get(uuid)?.rec?.text.length ?? 0;
}

/** TEST/DEBUG: every text's layout, from the rows the GPU draws with — per glyph its BASELINE
 * point (its advance centre on the baseline, WORLD space), whether it ran off the path, its scale
 * and its reading direction (world, unit) — plus the colour attribute */
export function textPathDebug() {
	const v = new THREE.Vector3();
	return [...entries.entries()].map(([uuid, e]) => {
		/** @type {number[][]} */
		const baseline = [];
		/** @type {number[][]} */
		const axes = [];
		/** @type {number[]} */
		const scales = [];
		/** @type {boolean[]} */
		const off = [];
		const info = e.info;
		const r = e.rows;
		if (info && r) {
			e.carrier.updateWorldMatrix(true, false);
			const b = info.glyphBounds;
			for (let g = 0; g < e.glyphs; g++) {
				const o = g * 12;
				const x = (b[g * 4] + b[g * 4 + 2]) / 2;
				// on a path the rows place the glyph (its own y is the first line's 0); a BLOCK keeps
				// troika's placement, so its line's y is the caret bottom of the glyph's character
				const c = e.glyphChars?.[g] ?? 0;
				const y = isBlockText(e.rec) ? (info.caretPositions?.[c * CARET_STRIDE + 2] ?? 0) : 0;
				v.set(r[o] * x + r[o + 1] * y + r[o + 3], r[o + 4] * x + r[o + 5] * y + r[o + 7], r[o + 8] * x + r[o + 9] * y + r[o + 11]).applyMatrix4(e.carrier.matrixWorld);
				baseline.push([v.x, v.y, v.z]);
				const sx = Math.hypot(r[o], r[o + 4], r[o + 8]);
				scales.push(sx);
				v.set(r[o], r[o + 4], r[o + 8]).transformDirection(e.carrier.matrixWorld);
				axes.push([v.x, v.y, v.z]);
				off.push(sx === 0);
			}
		}
		const colors = e.text.geometry.getAttribute('aTroikaGlyphColor');
		return {
			uuid,
			text: e.rec?.text ?? '',
			synced: e.synced,
			glyphs: e.glyphs,
			hidden: e.hidden,
			linked: !!e.target,
			visible: e.rec?.mode === 'extruded' ? !!e.solidGeo : !!e.text.visible && !!e.text.parent,
			mode: e.rec?.mode ?? 'flat',
			block: isBlockText(e.rec),
			solid: e.solidInfo ? { ...e.solidInfo, building: e.building } : e.rec?.mode === 'extruded' ? { building: e.building } : null,
			font: e.rec ? (e.rec.fontAsset ? 'asset:' + e.rec.fontAsset : e.rec.font) : null,
			fontUrl: e.rec ? fontUrlFor(e.rec, e.rec.mode === 'extruded') : null,
			proxyTris: (e.carrier.geometry?.index?.count ?? 0) / 3,
			baseline,
			off,
			scales,
			axes,
			colors: colors ? Array.from(colors.array) : [],
			overrides: !!e.overrides
		};
	});
}

/** TEST/DEBUG: the scene the runtime last ran over has this many texts */
export function textPathCount() {
	return rootRef ? entries.size : 0;
}
