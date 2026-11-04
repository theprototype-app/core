// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { pathToContours, contoursToShapes, styleShapes, layoutBlock } from './text3dCore.js';
import { QUALITY_SEGMENTS, mergeLetterStyles, textCharCap } from './textPathCore.js';
import { fontFromUrl } from './textFonts.js';

// 64-text TX1 — EXTRUDED text, built LOCALLY on every peer from the record (only the record
// travels and saves): opentype.js reads the font, text3dCore lays the characters out and sorts
// each glyph's flattened loops into outlines + holes, and ONE ExtrudeGeometry holds the whole
// text (group 0 = the caps, the face material; group 1 = the sides). Per-letter size, nudge and
// turn apply in the text's plane before extruding; per-letter COLOUR is a flat-text feature.
//
// A lazy chunk (with opentype.js), reached only from the text runtime.

/** glyph loops in EMS, per font url + glyph + quality @type {Map<string, any[]>} */
const glyphLoops = new Map();
const GLYPH_CACHE_MAX = 4000;

/** built geometries by their inputs (typing back and forth, two identical signs) @type {Map<string, {geometry: any, info: any}>} */
const built = new Map();
const BUILT_MAX = 8;

/** the fields that change the SHAPE (colours / materials do not) @param {any} rec @param {string} url @param {string} profile */
export function shapeKeyOf(rec, url, profile) {
	return JSON.stringify([url, profile, rec.text, rec.size, rec.spacing, rec.lineHeight, rec.maxWidth, rec.align, rec.anchor, rec.depth, rec.bevel, rec.quality, rec.letters]);
}

/** @param {any} font @param {string} url @param {any} glyph @param {number} seg */
function loopsOf(font, url, glyph, seg) {
	const key = url + '|' + glyph.index + '|' + seg;
	let loops = glyphLoops.get(key);
	if (!loops) {
		loops = contoursToShapes(pathToContours(glyph.path?.commands ?? [], seg, { scale: 1 / font.unitsPerEm }));
		if (glyphLoops.size > GLYPH_CACHE_MAX) glyphLoops.clear();
		glyphLoops.set(key, loops);
	}
	return loops;
}

/**
 * Build (or reuse) the extruded geometry for a record. The returned geometry is SHARED with the
 * cache: callers never dispose it themselves (`releaseExtruded` does, when it falls out).
 * @param {any} rec a normalized record (mode 'extruded')
 * @param {string} url the font file (bundled or a Library font's object URL)
 * @param {string} profile 'desktop' | 'low'
 * @returns {Promise<{geometry: any, info: {chars: number, drawn: number, missing: number, truncated: number, triangles: number}}>}
 */
export async function buildExtruded(rec, url, profile) {
	const key = shapeKeyOf(rec, url, profile);
	const hit = built.get(key);
	if (hit) {
		// most recently used last
		built.delete(key);
		built.set(key, hit);
		return hit;
	}
	const font = await fontFromUrl(url);
	const all = Array.from(String(rec.text ?? ''));
	const cap = textCharCap('extruded', profile);
	const chars = all.slice(0, cap);
	const truncated = all.length - chars.length;
	const k = 1 / font.unitsPerEm;
	/** @type {Map<string, any>} */
	const glyphs = new Map();
	const glyphOf = (/** @type {string} */ ch) => {
		let g = glyphs.get(ch);
		if (!g) glyphs.set(ch, (g = font.charToGlyph(ch)));
		return g;
	};
	const metrics = {
		advance: (/** @type {string} */ ch) => (glyphOf(ch).advanceWidth ?? 0) * k,
		kern: (/** @type {string} */ a, /** @type {string} */ b) => (font.getKerningValue?.(glyphOf(a), glyphOf(b)) ?? 0) * k,
		ascender: font.ascender * k,
		descender: font.descender * k
	};
	const em = rec.size;
	const place = layoutBlock(chars, metrics, { size: em, spacing: rec.spacing, lineHeight: rec.lineHeight, maxWidth: rec.maxWidth, align: rec.align, anchor: rec.anchor });
	const styles = mergeLetterStyles(chars.length, rec.letters, null);
	const seg = QUALITY_SEGMENTS[/** @type {'low'|'medium'|'high'} */ (rec.quality)] ?? 6;
	/** @type {any[]} */
	const shapes = [];
	let missing = 0;
	let drawn = 0;
	chars.forEach((ch, i) => {
		if (ch === ' ' || ch === '\n' || ch === '\t') return;
		const g = glyphOf(ch);
		if (!g || g.index === 0) {
			missing++;
			return;
		}
		const loops = loopsOf(font, url, g, seg);
		if (!loops.length) return;
		const x = place.x[i];
		const y = place.y[i];
		// ems -> metres at the pen position
		const placed = loops.map((/** @type {any} */ sh) => ({
			outer: sh.outer.map((/** @type {number[]} */ p) => [p[0] * em + x, p[1] * em + y]),
			holes: sh.holes.map((/** @type {number[][]} */ h) => h.map((p) => [p[0] * em + x, p[1] * em + y]))
		}));
		const st = styles[i];
		const out = styleShapes(placed, st, [x + place.advance[i] / 2, y], em);
		for (const sh of out) {
			const shape = new THREE.Shape(sh.outer.map((/** @type {number[]} */ p) => new THREE.Vector2(p[0], p[1])));
			for (const h of sh.holes) shape.holes.push(new THREE.Path(h.map((/** @type {number[]} */ p) => new THREE.Vector2(p[0], p[1]))));
			shapes.push(shape);
		}
		drawn++;
	});
	const bevel = rec.bevel;
	const bevelOn = bevel.size > 0 && bevel.thickness > 0;
	// a bevel cut INTO the letter wider than half its thinnest stroke turns it inside out (a serif's
	// hairline is ~4.5% of the em: measured, 64-text-int). So at most 1.5% of the em goes inward and the
	// rest of the width grows the letter outward; the whole bevel stays under 6% of the em (wider ones
	// close the counters of a, e, g)
	const bevelSize = Math.min(bevel.size, em * 0.06);
	const bevelInset = Math.min(bevelSize, em * 0.015);
	const geometry = shapes.length
		? new THREE.ExtrudeGeometry(shapes, {
				depth: rec.depth,
				steps: 1,
				curveSegments: 1, // the loops are already flattened at the record's quality
				bevelEnabled: bevelOn,
				bevelSize,
				bevelThickness: Math.min(bevel.thickness, rec.depth * 2),
				bevelOffset: bevelOn ? -bevelInset : 0, // the face is inset a little, the sides grow by the rest
				bevelSegments: bevel.segments
			})
		: new THREE.BufferGeometry();
	// centred on its depth, so the anchor sits in the middle of the slab
	if (shapes.length) geometry.translate(0, 0, -rec.depth / 2);
	geometry.computeBoundingBox();
	geometry.computeBoundingSphere();
	const triangles = (geometry.getAttribute('position')?.count ?? 0) / 3;
	const entry = { geometry, info: { chars: all.length, drawn, missing, truncated, triangles } };
	built.set(key, entry);
	while (built.size > BUILT_MAX) {
		const first = built.entries().next().value;
		if (!first) break;
		built.delete(first[0]);
		pendingDispose.add(first[1].geometry);
	}
	return entry;
}

/** geometries evicted from the cache; disposed once nothing shows them @type {Set<any>} */
const pendingDispose = new Set();

/**
 * Dispose evicted geometries no carrier is drawing. The runtime calls this after it swaps.
 * @param {(g: any) => boolean} inUse
 */
export function releaseExtruded(inUse) {
	for (const g of pendingDispose) {
		if (inUse(g)) continue;
		g.dispose?.();
		pendingDispose.delete(g);
	}
}

/** is this geometry one the builder owns (cached or waiting to be disposed)? @param {any} g */
export function ownsGeometry(g) {
	if (pendingDispose.has(g)) return true;
	for (const e of built.values()) if (e.geometry === g) return true;
	return false;
}

/**
 * A baked copy: the cache keeps its own, the baked mesh owns this one. A PLAIN BufferGeometry
 * (attributes, index, groups): an ExtrudeGeometry clone keeps its `parameters`, and toJSON then
 * writes the SHAPES, so every save, peer and undo snapshot would re-extrude it from them —
 * without the depth centring, and slowly.
 * @param {any} g
 */
export function bakeCopy(g) {
	const copy = new THREE.BufferGeometry().copy(g);
	copy.userData = {};
	return copy;
}

/** the two materials of an extruded text (face, side), from the record @param {any} rec @param {any[] | null} reuse */
export function extrudedMaterials(rec, reuse = null) {
	const face = reuse?.[0]?.isMeshStandardMaterial ? reuse[0] : new THREE.MeshStandardMaterial();
	const side = reuse?.[1]?.isMeshStandardMaterial ? reuse[1] : new THREE.MeshStandardMaterial();
	const c = new THREE.Color(rec.color);
	face.color.copy(c);
	face.metalness = rec.metalness;
	face.roughness = rec.roughness;
	face.emissive.copy(c);
	face.emissiveIntensity = rec.emissive;
	side.color.copy(rec.sideColor ? new THREE.Color(rec.sideColor) : c.clone().multiplyScalar(0.6));
	side.metalness = rec.metalness;
	side.roughness = rec.roughness;
	side.emissive.copy(side.color);
	side.emissiveIntensity = rec.emissive * 0.6;
	face.name = 'Text face';
	side.name = 'Text side';
	return [face, side];
}

/** TEST/DEBUG */
export function text3dBuildDebug() {
	return { built: built.size, glyphs: glyphLoops.size, pending: pendingDispose.size };
}
