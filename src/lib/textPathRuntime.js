// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
// @ts-ignore - troika-three-text ships no type declarations (threlte's <Text> dependency)
import { Text } from 'troika-three-text';
import {
	TEXT_FONTS_PATH,
	CARET_STRIDE,
	fontById,
	normalizeTextPath,
	isTextPathObject,
	builtinPolyline,
	makeSampler,
	indexColorRanges,
	decodeGlyphChars,
	mergeLetterStyles,
	layoutOnPath,
	glyphColors,
	glyphQuads
} from './textPathCore.js';
import { applyTextProxyLook } from './textPathObject.js';
import { textPathPolylineOf, textPathSourceKey } from './textPathSources.js';

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

/** a bundled font's URL ('sans' = troika's resolver, which covers every script) @param {string} id */
function fontUrl(id) {
	const f = fontById(id);
	if (!f.file || typeof document === 'undefined') return null;
	return new URL(TEXT_FONTS_PATH + '/' + f.file, document.baseURI).href;
}

/**
 * @typedef {{carrier: any, text: any, rec: any, recRef: any, troikaKey: string, info: any,
 *   glyphChars: Int32Array | null, target: any, relinkIn: number, sourceKey: any,
 *   overrides: any, dirty: boolean, synced: boolean, glyphs: number, hidden: number, rows: Float32Array | null}} Entry
 */
/** @type {Map<string, Entry>} */
const entries = new Map();
let visualParent = /** @type {any} */ (null);
let rootRef = /** @type {any} */ (null);

/** the troika-side fields: a change to any of these re-typesets (asynchronously) @param {any} rec */
const troikaKeyOf = (rec) =>
	JSON.stringify([rec.text, rec.font, rec.bold, rec.italic, rec.size, rec.spacing, rec.lineHeight, rec.outline, rec.outlineColor]);

/** @param {Entry} e */
function applyTroika(e) {
	const t = e.text;
	const rec = e.rec;
	t.text = rec.text;
	t.font = fontUrl(rec.font);
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
		rows: null
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
	const line = polylineOf(e);
	const sampler = makeSampler(line, rec.side === 'right');
	const orient = rec.orient === 'auto' ? (line.orient ?? 'flat') : rec.orient;
	const charCount = Math.floor((info.caretPositions?.length ?? 0) / CARET_STRIDE);
	const styles = mergeLetterStyles(charCount, rec.letters, e.overrides);
	const glyphChars = e.glyphChars ?? new Int32Array(0);
	const { rows, hidden } = layoutOnPath(
		{ glyphBounds: info.glyphBounds, glyphChars, caretPositions: info.caretPositions, lineHeight: info.lineHeight, fontSize: rec.size },
		styles,
		sampler,
		{ normal: line.normal, orient, align: rec.align, offset: rec.offset, shift: rec.shift }
	);
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
				applyTextProxyLook(o);
			}
			if (o.userData.textPath !== e.recRef) {
				e.recRef = o.userData.textPath;
				e.rec = normalizeTextPath(e.recRef);
				const key = troikaKeyOf(e.rec);
				if (key !== e.troikaKey) {
					e.troikaKey = key;
					applyTroika(e); // relays out on synccomplete
				}
				e.dirty = true;
				applyTextProxyLook(o);
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
				// the glyph's baseline is y = -k·lineHeight; the first line's is 0 (single-line texts here)
				v.set(r[o] * x + r[o + 3], r[o + 4] * x + r[o + 7], r[o + 8] * x + r[o + 11]).applyMatrix4(e.carrier.matrixWorld);
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
			visible: !!e.text.visible && !!e.text.parent,
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
