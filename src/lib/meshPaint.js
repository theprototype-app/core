// 102 M6 — PAINT ON MESHES, the painter. A LAZY chunk: the UV editor, the dispatcher and the VR brush import it
// with `import()` on first use. The brush settings live in meshPaintPrefs.js, the arithmetic in meshPaintCore.js.
//
// WHAT IT ADDS TO THE SHIPPED PAINTER (uvEditor.js UV3), which keeps painting exactly as before when nothing new
// is in use (a default brush on the colour map in the UV canvas still goes through `uvpaint`, byte-unchanged):
//   - four CHANNELS, one map each: colour (`map`, the UV editor's own paint canvas — one image, two painters),
//     roughness, metalness, emission (the 72 LK1 map slots, committed through `mapSlot` + the `materialmaps` undo)
//   - BRUSH KINDS: hardness, flow, opacity, eraser, mirror X, an image stamp
//   - MODEL STROKES: a stroke on the model itself. A dab is a sphere in the object's own space, rasterised into
//     the map through every triangle it touches (each triangle's own 3D -> UV map), with seam PADDING into the
//     empty gutter around each island, so a stroke crosses a UV seam the way it crosses the surface
//   - VERTEX COLOURS when the mesh has no usable UVs (none, or overlapping), with the same brush, committed through
//     the meshgeo path (which already carries `colors`)
//   - a NEW MAP on a slot's first stroke (1k / 2k), filled with the material's own value so nothing changes until
//     you paint; a SHARED material asks "all objects" or "this object only" (the second replicates)
//
// THE RASTER IS OURS, NOT THE CANVAS'S. Dabs are written into a per-stroke layer of 64 px TILES in plain JS (pixel
// centres, one owner triangle per pixel, `L += a * (1 - L)`), then composited over the stroke's base pixels by
// putImageData. Two reasons: canvas clip paths anti-alias every shared triangle edge into a faint line (the
// conflation artefact), and plain arithmetic draws the same bytes on every peer. Tiles are read from the canvas
// only when a dab first reaches them, so a stroke costs the area it touches, not the whole map.
//
// THE WIRE: the live stroke is `meshpaint` {id, uuid, slot?, ch?, sp: 'uv'|'obj'|'vtx', c, r, b?, pm?, n?, seg}
// + `meshpaintend` {id, cancel?} — a PREVIEW, replayed with the same numbers (points travel rounded and the sender
// paints the rounded point too). The truth is the commit that follows (`map`, `mapSlot`, `meshgeo`), so a late
// joiner gets the texture, never the path history. Both types are ROOM_SCOPED.
import * as THREE from 'three';
import { carrierRefusal } from './proxyCarrier.js'; // 102-int-2: decals and splats draw nothing of their own
import { get, derived } from 'svelte/store';
import { objectsGroup, pokeScene, globalScene, globalCamera, globalRenderer } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { materialAt, applyMap, recordMaterialChange, setMaterialParam, broadcastMaterial, copyTextureParams } from './materialsHandler';
import { commitPaintedMapSlot } from './materialMaps';
import { mapSlotUrl, mapSlotKnownUrl } from './materialMapTextures.js';
import { isSharedMaterial, materialIdOf, objectsSharing, unlinkMaterial } from './materialSharing';
import { showChoice } from './confirmDialog';
import { resolveHudImage, shareHudImage } from './hudImages';
import {
	openColorSurface,
	dropColorSurface,
	encodePaintCanvas,
	paintPressureFactor,
	uvPaintTick,
	uvBrushColor,
	uvBrushSize,
	uvPenPressure
} from './uvEditor';
import { readTriangles, trisToPositions, trisToGroups, trisToUVs, commitMeshGeoTriple } from './faceEdit';
import { paintChannel, paintValue, paintMapSize, paintTargetInfo, paintShowChannel, BRUSH_STORES } from './meshPaintPrefs';
import {
	channelOf,
	normalizeBrush,
	isDefaultBrush,
	brushWire,
	brushFromWire,
	paintStyle,
	hexToRgb,
	rgbToHex,
	falloff,
	DAB_SPACING,
	dabsAlong,
	triFrame,
	dabOnTri,
	planeToCanvas,
	uvToCanvas,
	padTri,
	texelDensity,
	buildTriGrid,
	trisNear,
	uvOverlap,
	paintTarget,
	vertexDab,
	blendVertexColors,
	mirrorX,
	onMirrorPlane,
	srgbToLinear,
	hashBytes
} from './meshPaintCore.js';
import { quantizePoint } from './meshPaintWire.js';

// 102 M6 (boot rule): the UV editor reads the brush state through this lazy chunk, so the prefs leaf and the
// brush panel stay out of the boot bundle. `newBrush` = a channel other than colour or a brush other than the
// shipped hard round one, which paints through this module instead of uvEditor's own painter.
export const paintUi = derived(
	[paintChannel, paintShowChannel, BRUSH_STORES.hardness, BRUSH_STORES.opacity, BRUSH_STORES.flow, BRUSH_STORES.erase, BRUSH_STORES.stamp],
	([channel, showChannel, hardness, opacity, flow, erase, stamp]) => ({
		channel,
		showChannel: !!showChannel,
		newBrush: channel !== 'color' || hardness !== 1 || opacity !== 1 || flow !== 1 || !!erase || !!stamp
	})
);
/** forget what the panel says a stroke paints (the editor lost its target) */
export function clearTargetInfo() {
	paintTargetInfo.set(null);
}

const TILE = 64;
/** seam padding, texture px past an island's edge */
const PAD = 2;
/** live-stroke broadcast interval (the shipped painter's cadence) */
const SEND_MS = 66;
/** a remote stroke nobody finished is dropped after this */
const STALE_MS = 5000;
/** the stamp mask's resolution */
const STAMP_RES = 64;

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return uuid ? group?.getObjectByProperty?.('uuid', uuid) ?? null : null;
}

/** @param {any} image */
function drawable(image) {
	if (!image || typeof document === 'undefined') return null;
	const w = image.width ?? image.videoWidth;
	const h = image.height ?? image.videoHeight;
	if (!w || !h || image.data !== undefined) return null;
	return image;
}

/** the shipped painter's size rule: the source's own resolution, long side kept in 256..2048 @param {any} image */
function sizeOf(image) {
	const sw = image?.width ?? 0;
	const sh = image?.height ?? 0;
	if (!sw || !sh) return null;
	const longest = Math.max(sw, sh);
	const scale = longest > 2048 ? 2048 / longest : longest < 256 ? Math.min(256 / longest, 8) : 1;
	return { w: Math.min(Math.max(Math.round(sw * scale), 8), 4096), h: Math.min(Math.max(Math.round(sh * scale), 8), 4096) };
}

// ---- the mesh model: the slot's triangles in the object's own space, cached per geometry -------------------------

/** @type {WeakMap<any, Map<number, any>>} geometry -> slot -> model */
const models = new WeakMap();

/**
 * The triangles of one material slot as a flat soup (9 floats each) with their UVs (6 each), a grid to find them,
 * lazily built frames, and the facts that decide map vs vertex colours. Rebuilt when the geometry is swapped
 * (applyMeshGeo makes a new one) or its position / uv attribute changes in place.
 * @param {any} mesh @param {number} slot
 */
function meshModel(mesh, slot) {
	const geometry = mesh?.geometry;
	const pos = geometry?.attributes?.position;
	if (!pos) return null;
	const uvAttr = geometry.attributes.uv;
	const stamp = pos.version + ':' + (uvAttr?.version ?? -1) + ':' + pos.count;
	let bySlot = models.get(geometry);
	if (!bySlot) models.set(geometry, (bySlot = new Map()));
	const cached = bySlot.get(slot);
	if (cached && cached.stamp === stamp) return cached;
	const index = geometry.index;
	const count = index ? index.count : pos.count;
	const multi = Array.isArray(mesh.material) && geometry.groups?.length;
	/** @type {number[]} */
	const p = [];
	/** @type {number[]} */
	const u = [];
	for (let i = 0; i + 2 < count; i += 3) {
		if (multi) {
			const g = geometry.groups.find((/** @type {any} */ gr) => i >= gr.start && i < gr.start + gr.count);
			if ((g?.materialIndex ?? 0) !== slot) continue;
		}
		for (let k = 0; k < 3; k++) {
			const j = index ? index.getX(i + k) : i + k;
			p.push(pos.getX(j), pos.getY(j), pos.getZ(j));
			if (uvAttr) u.push(uvAttr.getX(j), uvAttr.getY(j));
		}
	}
	const positions = new Float32Array(p);
	const uvs = uvAttr ? new Float32Array(u) : null;
	geometry.computeBoundingBox?.();
	const box = geometry.boundingBox;
	const diag = box ? box.min.distanceTo(box.max) : 1;
	const model = {
		stamp,
		positions,
		uvs,
		n: positions.length / 9,
		diag: diag > 0 ? diag : 1,
		grid: buildTriGrid(positions, (diag > 0 ? diag : 1) / 48),
		/** @type {(any | null | undefined)[]} */
		frames: [],
		target: paintTarget({ hasUvs: !!uvs, overlap: uvs ? uvOverlap(uvs, 128) : null }),
		/** @type {Map<string, Uint8Array>} canvas size + flip -> which pixels belong to a triangle */
		coverage: new Map()
	};
	bySlot.set(slot, model);
	return model;
}

/** @param {any} model @param {number} t */
function frameOf(model, t) {
	let f = model.frames[t];
	if (f === undefined) {
		const P = model.positions;
		const U = model.uvs;
		const o = t * 9;
		const q = t * 6;
		f = U
			? triFrame([P[o], P[o + 1], P[o + 2]], [P[o + 3], P[o + 4], P[o + 5]], [P[o + 6], P[o + 7], P[o + 8]], [U[q], U[q + 1]], [U[q + 2], U[q + 3]], [U[q + 4], U[q + 5]])
			: null;
		model.frames[t] = f;
	}
	return f;
}

/** Edge function sign test, pixel centre inside a canvas-space triangle (inclusive). @param {number[][]} P
 * @param {number} x @param {number} y */
function insideTri(P, x, y) {
	const [a, b, c] = P;
	const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
	const w0 = (b[0] - x) * (c[1] - y) - (c[0] - x) * (b[1] - y);
	const w1 = (c[0] - x) * (a[1] - y) - (a[0] - x) * (c[1] - y);
	const w2 = (a[0] - x) * (b[1] - y) - (b[0] - x) * (a[1] - y);
	return area > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
}

/** Which pixels of a W x H map some triangle owns — the padding pass may only paint the ones nobody does.
 * @param {any} model @param {number} W @param {number} H @param {boolean} flip */
function coverageOf(model, W, H, flip) {
	const key = W + 'x' + H + (flip ? 'f' : '');
	let cov = model.coverage.get(key);
	if (cov) return cov;
	cov = new Uint8Array(W * H);
	const U = model.uvs;
	if (U)
		for (let t = 0; t < model.n; t++) {
			const q = t * 6;
			const P = [0, 1, 2].map((k) => uvToCanvas([U[q + k * 2], U[q + k * 2 + 1]], W, H, flip));
			const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
			const x1 = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
			const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
			const y1 = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
			for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (insideTri(P, x + 0.5, y + 0.5)) cov[y * W + x] = 1;
		}
	// one size per model is the common case; keep at most two (a 2k cover is 4 MB)
	if (model.coverage.size >= 2) model.coverage.clear();
	model.coverage.set(key, cov);
	return cov;
}

/** Facts for the panel: what a stroke on this object would paint, and why. @param {any} mesh @param {number} slot */
export function targetFor(mesh, slot = 0) {
	const model = meshModel(mesh, slot);
	const info = model ? model.target : null;
	if (get(paintTargetInfo) !== info) paintTargetInfo.set(info);
	return info;
}

// ---- the layer: per-stroke tiles over a canvas --------------------------------------------------------------------

/** @param {any} canvas */
function makeLayer(canvas) {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	return { canvas, ctx, W: canvas.width, H: canvas.height, /** @type {Map<number, any>} */ tiles: new Map(), /** @type {Set<number>} */ dirty: new Set(), dab: 0 };
}

/** @param {any} layer @param {number} tx @param {number} ty */
function tileAt(layer, tx, ty) {
	const key = ty * 65536 + tx;
	let t = layer.tiles.get(key);
	if (!t) {
		const x = tx * TILE;
		const y = ty * TILE;
		const w = Math.min(TILE, layer.W - x);
		const h = Math.min(TILE, layer.H - y);
		const base = layer.ctx.getImageData(x, y, w, h);
		t = { key, x, y, w, h, base: base.data, img: new ImageData(new Uint8ClampedArray(base.data), w, h), L: new Float32Array(w * h), mark: new Uint32Array(w * h) };
		layer.tiles.set(key, t);
	}
	return t;
}

/** Add `a` of the stroke at pixel (x, y), once per dab. @param {any} layer @param {number} x @param {number} y @param {number} a */
function touch(layer, x, y, a) {
	if (!(a > 0) || x < 0 || y < 0 || x >= layer.W || y >= layer.H) return;
	const t = tileAt(layer, (x / TILE) | 0, (y / TILE) | 0);
	const i = (y - t.y) * t.w + (x - t.x);
	if (t.mark[i] === layer.dab) return;
	t.mark[i] = layer.dab;
	const aa = a > 1 ? 1 : a;
	t.L[i] = t.L[i] + aa * (1 - t.L[i]);
	layer.dirty.add(t.key);
}

/** Show the dirty tiles: base blended toward the style by L * opacity. @param {any} layer @param {number[]} rgb 0..255 @param {number} opacity */
function composite(layer, rgb, opacity) {
	for (const key of layer.dirty) {
		const t = layer.tiles.get(key);
		if (!t) continue;
		const out = t.img.data;
		const base = t.base;
		for (let i = 0, n = t.w * t.h; i < n; i++) {
			const k = Math.min(1, t.L[i] * opacity);
			if (k <= 0) continue;
			const o = i * 4;
			out[o] = Math.round(base[o] + (rgb[0] - base[o]) * k);
			out[o + 1] = Math.round(base[o + 1] + (rgb[1] - base[o + 1]) * k);
			out[o + 2] = Math.round(base[o + 2] + (rgb[2] - base[o + 2]) * k);
			out[o + 3] = Math.round(base[o + 3] + (255 - base[o + 3]) * k);
		}
		layer.ctx.putImageData(t.img, t.x, t.y);
	}
	layer.dirty.clear();
}

/** Put the stroke's base pixels back (a cancel). @param {any} layer */
function restoreBase(layer) {
	for (const t of layer.tiles.values()) layer.ctx.putImageData(new ImageData(new Uint8ClampedArray(t.base), t.w, t.h), t.x, t.y);
}

// ---- dabs ---------------------------------------------------------------------------------------------------------

/** @param {Float32Array | null} mask @param {number} sx -1..1 @param {number} sy -1..1 */
function sampleMask(mask, sx, sy) {
	if (!mask) return 1;
	const fx = ((sx + 1) / 2) * (STAMP_RES - 1);
	const fy = ((sy + 1) / 2) * (STAMP_RES - 1);
	if (fx < 0 || fy < 0 || fx > STAMP_RES - 1 || fy > STAMP_RES - 1) return 0;
	const x0 = Math.floor(fx);
	const y0 = Math.floor(fy);
	const x1 = Math.min(x0 + 1, STAMP_RES - 1);
	const y1 = Math.min(y0 + 1, STAMP_RES - 1);
	const tx = fx - x0;
	const ty = fy - y0;
	const a = mask[y0 * STAMP_RES + x0] * (1 - tx) + mask[y0 * STAMP_RES + x1] * tx;
	const b = mask[y1 * STAMP_RES + x0] * (1 - tx) + mask[y1 * STAMP_RES + x1] * tx;
	return a * (1 - ty) + b * ty;
}

/** A dab in texture px (the UV canvas). @param {any} s the stroke @param {number} cx @param {number} cy @param {number} r @param {number} a */
function dabUv(s, cx, cy, r, a) {
	const layer = s.layer;
	const x0 = Math.max(0, Math.floor(cx - r));
	const x1 = Math.min(layer.W - 1, Math.ceil(cx + r));
	const y0 = Math.max(0, Math.floor(cy - r));
	const y1 = Math.min(layer.H - 1, Math.ceil(cy + r));
	for (let y = y0; y <= y1; y++)
		for (let x = x0; x <= x1; x++) {
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d > r) continue;
			const cov = s.mask ? sampleMask(s.mask, dx / r, dy / r) : falloff(d / r, s.brush.hardness);
			touch(layer, x, y, a * cov);
		}
}

/**
 * A dab on the model: a sphere (centre `c`, radius `R`, object space) painted into the map through every triangle
 * it touches. Pass 1 paints pixels a touched triangle OWNS; pass 2 pads each into the uncovered gutter.
 * @param {any} s @param {number[]} c @param {number} R @param {number} a
 */
function dabModel(s, c, R, a) {
	const { layer, model } = s;
	const W = layer.W;
	const H = layer.H;
	const flip = s.flip;
	const tris = trisNear(model.grid, c, R);
	/** @type {{f: any, P: number[][], Pp: number[][], inv: number[], T: number[]}[]} */
	const hits = [];
	for (const t of tris) {
		const f = frameOf(model, t);
		if (!f || !dabOnTri(f, c, R)) continue;
		const T = planeToCanvas(f, W, H, flip);
		const det = T[0] * T[3] - T[2] * T[1];
		if (Math.abs(det) < 1e-18) continue;
		const inv = [T[3] / det, -T[2] / det, -T[1] / det, T[0] / det];
		const P = f.uv.map((/** @type {number[]} */ uv) => uvToCanvas(uv, W, H, flip));
		hits.push({ f, P, Pp: padTri(P, PAD), inv, T });
	}
	if (!hits.length) return;
	const cov = coverageOf(model, W, H, flip);
	const R2 = R * R;
	const hard = s.brush.hardness;
	for (let pass = 0; pass < 2; pass++)
		for (const h of hits) {
			const pts = pass ? h.Pp : h.P;
			const x0 = Math.max(0, Math.floor(Math.min(pts[0][0], pts[1][0], pts[2][0])));
			const x1 = Math.min(W - 1, Math.ceil(Math.max(pts[0][0], pts[1][0], pts[2][0])));
			const y0 = Math.max(0, Math.floor(Math.min(pts[0][1], pts[1][1], pts[2][1])));
			const y1 = Math.min(H - 1, Math.ceil(Math.max(pts[0][1], pts[1][1], pts[2][1])));
			// keep a huge triangle's scan to the dab's own footprint: the sphere seen through this triangle
			const foot = footprint(h, c, R, W, H);
			const fx0 = Math.max(x0, foot[0]);
			const fx1 = Math.min(x1, foot[1]);
			const fy0 = Math.max(y0, foot[2]);
			const fy1 = Math.min(y1, foot[3]);
			const { f, inv, T } = h;
			for (let y = fy0; y <= fy1; y++)
				for (let x = fx0; x <= fx1; x++) {
					const px = x + 0.5;
					const py = y + 0.5;
					if (pass === 0) {
						if (!insideTri(h.P, px, py)) continue;
					} else if (cov[y * W + x] || !insideTri(h.Pp, px, py)) continue;
					// canvas -> plane -> object space
					const ex = px - T[4];
					const ey = py - T[5];
					const qx = inv[0] * ex + inv[1] * ey;
					const qy = inv[2] * ex + inv[3] * ey;
					const wx = f.o[0] + f.e1[0] * qx + f.e2[0] * qy - c[0];
					const wy = f.o[1] + f.e1[1] * qx + f.e2[1] * qy - c[1];
					const wz = f.o[2] + f.e1[2] * qx + f.e2[2] * qy - c[2];
					const d2 = wx * wx + wy * wy + wz * wz;
					if (d2 > R2) continue;
					let k;
					if (s.mask) {
						const st = s.stampFrame;
						k = sampleMask(s.mask, (wx * st.t[0] + wy * st.t[1] + wz * st.t[2]) / R, (wx * st.b[0] + wy * st.b[1] + wz * st.b[2]) / R);
					} else k = falloff(Math.sqrt(d2) / R, hard);
					touch(layer, x, y, a * k);
				}
		}
}

/** The canvas-pixel box the sphere can reach through one triangle's map. @param {any} h @param {number[]} c
 * @param {number} R @param {number} W @param {number} H @returns {number[]} [x0, x1, y0, y1] */
function footprint(h, c, R, W, H) {
	const hit = dabOnTri(h.f, c, R);
	if (!hit) return [1, 0, 1, 0];
	const T = h.T;
	const [qx, qy] = hit.qc;
	const r = hit.r;
	// an axis-aligned box of a transformed circle: centre +- r * (|row|)
	const cx = T[0] * qx + T[2] * qy + T[4];
	const cy = T[1] * qx + T[3] * qy + T[5];
	const ex = r * Math.hypot(T[0], T[2]);
	const ey = r * Math.hypot(T[1], T[3]);
	return [Math.max(0, Math.floor(cx - ex - 1)), Math.min(W - 1, Math.ceil(cx + ex + 1)), Math.max(0, Math.floor(cy - ey - 1)), Math.min(H - 1, Math.ceil(cy + ey + 1))];
}

/** A dab on vertex colours. @param {any} s @param {number[]} c @param {number} R @param {number} a */
function dabVertex(s, c, R, a, mirrored = false) {
	const v = s.vertex;
	// the stroke's normal faces the nearest-vertex fallback (a low-poly mesh); the mirrored half faces the mirror way
	const n = s.n ? (mirrored ? [-s.n[0], s.n[1], s.n[2]] : s.n) : null;
	const touched = vertexDab(v.positions, c, R, s.brush.hardness, a, v.acc, { normals: v.normals, n });
	if (!touched.length) return;
	blendVertexColors(v.base, v.target, v.acc, s.brush.opacity, v.out, touched);
	v.dirty = true;
}

/** One stroke point after another: dabs spaced along the path, mirrored when asked. @param {any} s @param {number[]} p */
function strokePoint(s, p) {
	const dim = s.sp === 'uv' ? 2 : 3;
	const last = s.last;
	if (last && last.length === p.length && last.every((/** @type {number} */ x, /** @type {number} */ i) => x === p[i])) return;
	// the UV canvas measures in texture px, the model in its own units
	const metric = s.sp === 'uv' ? [p[0] * s.layer.W, (s.flip ? 1 - p[1] : p[1]) * s.layer.H, p[2] ?? 1] : [p[0], p[1], p[2], p[3] ?? 1];
	const step = Math.max(DAB_SPACING * 2 * s.r, s.sp === 'uv' ? 0.5 : 1e-6);
	const from = s.lastMetric ?? metric;
	const run = s.lastMetric ? dabsAlong(from, metric, dim, step, s.carry) : { dabs: [metric], carry: 0 };
	s.carry = run.carry;
	s.last = p;
	s.lastMetric = metric;
	for (const d of run.dabs) {
		const w = d[dim];
		const factor = s.pm === 'off' ? 1 : paintPressureFactor(Number.isFinite(w) ? w : 1);
		const r = s.pm === 'opacity' || s.pm === 'off' ? s.r : s.r * factor;
		const a = s.brush.flow * (s.pm === 'opacity' ? factor : 1);
		// one mark per dab: a pixel takes a dab once, and the mirrored half is the SAME dab, so where the two halves
		// meet on the mirror plane they union rather than stack
		if (s.layer) s.layer.dab++;
		if (s.sp === 'uv') dabUv(s, d[0], d[1], r, a);
		else {
			const c = [d[0], d[1], d[2]];
			const mirrored = s.brush.mirror && !onMirrorPlane(c, r) ? mirrorX(c) : null;
			if (s.sp === 'vtx') {
				// vertex dabs stack per call, so the mirrored half (disjoint off the plane) is its own call
				dabVertex(s, c, r, a);
				if (mirrored) dabVertex(s, mirrored, r, a, true);
			} else {
				dabModel(s, c, r, a);
				if (mirrored) dabModel(s, mirrored, r, a);
			}
		}
		s.dabs++;
	}
}

/** Show what the dabs did since the last call: composite the tiles, upload, redraw the UV view. @param {any} s */
function present(s) {
	if (s.sp === 'vtx') {
		if (s.vertex.dirty) {
			s.vertex.attr.needsUpdate = true;
			s.vertex.dirty = false;
		}
	} else if (s.layer.dirty.size) {
		composite(s.layer, s.rgb, s.brush.opacity);
		s.surface.texture.needsUpdate = true;
		uvPaintTick.update((n) => n + 1);
	}
	pokeScene();
}

// ---- surfaces -------------------------------------------------------------------------------------------------------

/** @type {Map<string, any>} uuid#slot#channel -> a roughness / metalness / emission paint canvas */
const surfaces = new Map();

/** @param {any} material */
function firstMapOf(material) {
	for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) if (material?.[key]) return material[key];
	return null;
}

/**
 * The paint canvas for a roughness / metalness / emission slot, seeded from the slot's image (a shared ORM
 * texture gives its own channel: green for roughness, blue for metalness), or a NEW map at the chosen size,
 * filled so nothing changes until you paint — the material's own value, which is then lifted to 1 (or a black
 * emissive colour to white) in the same undo step as the stroke. Installed as the slot's live texture.
 * @param {any} object @param {number} slot @param {any} ch channelOf(...) @param {boolean} local
 */
function channelSurface(object, slot, ch, local) {
	const material = materialAt(object, slot);
	if (!material || !(ch.map in material)) return null;
	const k = object.uuid + '#' + slot + '#' + ch.key;
	const existing = surfaces.get(k);
	const known = mapSlotKnownUrl(material, ch.map);
	if (existing && (material[ch.map] === existing.texture || (existing.seededFrom && known === existing.seededFrom))) {
		existing.previousMap = material[ch.map] === existing.texture ? existing.previousMap : material[ch.map];
		install(material, existing);
		return existing;
	}
	const source = material[ch.map] ?? null;
	const image = drawable(source?.image);
	const before = source ? mapSlotUrl(material, ch.map, 2048) : null;
	const canvas = existing?.canvas ?? document.createElement('canvas');
	const size = (image && sizeOf(image)) || { w: get(paintMapSize), h: get(paintMapSize) };
	canvas.width = size.w;
	canvas.height = size.h;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	/** @type {{param: string, before: any, after: any} | null} */
	let lift = null;
	const single = !Array.isArray(object.material);
	if (image) {
		ctx.drawImage(image, 0, 0, size.w, size.h);
		if (ch.gray) {
			const data = ctx.getImageData(0, 0, size.w, size.h);
			const px = data.data;
			const at = ch.key === 'roughness' ? 1 : 2; // three reads roughness from G, metalness from B
			for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = px[i + at];
			ctx.putImageData(data, 0, 0);
		}
	} else if (ch.gray) {
		const scalar = typeof material[ch.param] === 'number' ? material[ch.param] : 1;
		// a single material can lift its slider to 1 so the map reads true; a slot of an array cannot (the param
		// message addresses slot 0), so it starts white and multiplies the slider like any map
		const fill = single ? scalar : 1;
		ctx.fillStyle = '#' + Math.round(Math.max(0, Math.min(1, fill)) * 255).toString(16).padStart(2, '0').repeat(3);
		ctx.fillRect(0, 0, size.w, size.h);
		if (single && scalar !== 1) lift = { param: ch.param, before: scalar, after: 1 };
	} else {
		ctx.fillStyle = '#000000';
		ctx.fillRect(0, 0, size.w, size.h);
		if (single && material.emissive?.getHex?.() === 0) lift = { param: 'emissive', before: '#000000', after: '#ffffff' };
	}
	const texture = existing?.texture ?? new THREE.CanvasTexture(canvas);
	texture.image = canvas;
	texture.colorSpace = ch.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
	const inherit = source ?? firstMapOf(material);
	if (inherit) copyTextureParams(inherit, texture);
	texture.needsUpdate = true;
	const entry = { canvas, texture, ch: ch.key, key: ch.map, uuid: object.uuid, slot, flipY: texture.flipY !== false, before, seededFrom: before, previousMap: source, lift, liftShown: false };
	surfaces.set(k, entry);
	install(material, entry);
	if (lift) showLift(material, entry, true);
	void local;
	return entry;
}

/** @param {any} material @param {any} entry */
function install(material, entry) {
	if (material[entry.key] !== entry.texture) {
		material[entry.key] = entry.texture;
		material.needsUpdate = true;
	}
	entry.texture.needsUpdate = true;
	pokeScene();
}

/** Show (or take back) a new map's slider lift locally; the commit records and sends it. @param {any} material
 * @param {any} entry @param {boolean} on */
function showLift(material, entry, on) {
	const lift = entry.lift;
	if (!lift) return;
	const value = on ? lift.after : lift.before;
	if (material[lift.param]?.isColor) material[lift.param].set(value);
	else material[lift.param] = value;
	material.needsUpdate = true;
	entry.liftShown = on;
}

/** The surface a stroke paints, or null. @param {any} object @param {number} slot @param {string} ch @param {boolean} local */
async function surfaceFor(object, slot, ch, local) {
	if (ch === 'color') {
		const entry = await openColorSurface(object.uuid, slot);
		return entry ? Object.assign(entry, { key: 'map', ch: 'color' }) : null;
	}
	return channelSurface(object, slot, channelOf(ch), local);
}

// ---- stamps -------------------------------------------------------------------------------------------------------

/** @type {Map<string, Float32Array>} */
const masks = new Map();

/** The stamp image as a 64 x 64 coverage mask: its alpha where it has any, else darkness (a black shape on white).
 * Null while the bytes are missing (the stroke paints round meanwhile; the commit is the truth). @param {string} hash */
async function stampMask(hash) {
	if (!hash) return null;
	const cached = masks.get(hash);
	if (cached) return cached;
	const url = await resolveHudImage(hash);
	if (!url) return null;
	const image = await new Promise((resolve) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => resolve(null);
		img.src = url;
	});
	if (!image) return null;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = STAMP_RES;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(/** @type {any} */ (image), 0, 0, STAMP_RES, STAMP_RES);
	const px = ctx.getImageData(0, 0, STAMP_RES, STAMP_RES).data;
	let transparent = false;
	for (let i = 3; i < px.length; i += 4) if (px[i] < 250) transparent = true;
	const mask = new Float32Array(STAMP_RES * STAMP_RES);
	for (let i = 0; i < mask.length; i++) {
		const o = i * 4;
		mask[i] = transparent ? px[o + 3] / 255 : 1 - (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
	}
	masks.set(hash, mask);
	return mask;
}

/** A stamp's orientation on the model: two axes perpendicular to the first hit's normal. @param {number[]} n */
function stampFrameOf(n) {
	const len = Math.hypot(n[0], n[1], n[2]) || 1;
	const nn = [n[0] / len, n[1] / len, n[2] / len];
	const up = Math.abs(nn[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
	const t = [up[1] * nn[2] - up[2] * nn[1], up[2] * nn[0] - up[0] * nn[2], up[0] * nn[1] - up[1] * nn[0]];
	const tl = Math.hypot(t[0], t[1], t[2]) || 1;
	const tt = [t[0] / tl, t[1] / tl, t[2] / tl];
	const b = [nn[1] * tt[2] - nn[2] * tt[1], nn[2] * tt[0] - nn[0] * tt[2], nn[0] * tt[1] - nn[1] * tt[0]];
	return { t: tt, b };
}

// ---- strokes --------------------------------------------------------------------------------------------------------

/**
 * Open a stroke from its SPEC (the fields a `meshpaint` message carries). The same function serves the painter and
 * every peer replaying it, which is what makes the replay draw the same picture.
 * @param {{id: string, uuid: string, slot: number, ch: string, sp: 'uv'|'obj'|'vtx', c: string, r: number, b: any, pm: string, n: number[] | null}} spec
 * @param {boolean} local
 */
async function openStroke(spec, local) {
	const object = objectOf(spec.uuid);
	if (!object) return null;
	// spec.b is the brush in its WIRE form, for the painter and every peer alike
	const brush = brushFromWire(spec.b);
	/** @type {any} */
	const s = { ...spec, brush, local, object, dabs: 0, carry: 0, last: null, lastMetric: null, rgb: hexToRgb(spec.c).map((x) => Math.round(x * 255)) };
	if (spec.sp === 'vtx') {
		const geometry = object.geometry;
		const pos = geometry?.attributes?.position;
		if (!pos) return null;
		let attr = geometry.attributes.color;
		const hadColors = !!attr;
		if (!attr) {
			attr = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3);
			geometry.setAttribute('color', attr);
		}
		const material = object.material;
		const wasVertexColors = !!material?.vertexColors;
		if (material && !Array.isArray(material) && !material.vertexColors) {
			material.vertexColors = true;
			material.needsUpdate = true;
		}
		const lin = hexToRgb(spec.c).map(srgbToLinear);
		s.vertex = {
			positions: pos.array,
			normals: geometry.attributes.normal?.array ?? null,
			attr,
			hadColors,
			wasVertexColors,
			base: new Float32Array(attr.array),
			out: attr.array,
			acc: new Float32Array(pos.count),
			target: lin,
			dirty: false
		};
		return s;
	}
	const surface = await surfaceFor(object, spec.slot, spec.ch, local);
	if (!surface) return null;
	s.surface = surface;
	s.flip = surface.flipY !== false;
	s.layer = makeLayer(surface.canvas);
	if (spec.sp === 'obj') {
		s.model = meshModel(object, spec.slot);
		if (!s.model?.uvs) return null;
	}
	if (brush.stamp) {
		s.mask = await stampMask(brush.stamp);
		if (s.mask && spec.sp !== 'uv') s.stampFrame = stampFrameOf(spec.n ?? [0, 0, 1]);
	}
	return s;
}

/** Free the per-stroke memory (tiles, colour copies). @param {any} s */
function release(s) {
	if (s.layer) {
		s.layer.tiles.clear();
		s.layer.dirty.clear();
	}
	if (s.vertex) {
		s.vertex.base = null;
		s.vertex.acc = null;
	}
}

let seq = 0;
/** @type {any} the local stroke */
let stroke = null;
let lastSend = 0;

/** is a local stroke open (or opening)? */
export function stroking() {
	return !!stroke;
}

/**
 * Should a stroke from the UV canvas leave the shipped painter? Only when something new is in use — a channel
 * other than colour, or a brush other than the shipped hard round one.
 */
export function needsMeshPaint() {
	return get(paintChannel) !== 'color' || !isDefaultBrush(currentBrush());
}

/** the brush as the panel has it */
export function currentBrush() {
	/** @type {Record<string, any>} */
	const raw = {};
	for (const [key, store] of Object.entries(BRUSH_STORES)) raw[key] = get(/** @type {any} */ (store));
	return normalizeBrush(raw);
}

/** the shared material question, asked once per material and session @type {Map<string, string>} */
const sharedAnswers = new Map();

/**
 * A shared material: paint every object wearing it, or give this one its own copy first (sent to peers, who
 * clone it too). False = cancelled. @param {any} object
 */
async function settleSharing(object) {
	if (!isSharedMaterial(object.uuid)) return true;
	const id = materialIdOf(object);
	if (sharedAnswers.get(id) === 'all') return true;
	const others = objectsSharing(id).length - 1;
	const choice = await showChoice({
		title: 'This material is shared',
		message:
			(others === 1 ? '1 other object wears' : others + ' other objects wear') +
			' the same material. Paint all of them, or give this object its own copy first?',
		choices: [
			{ value: 'all', label: 'All objects that share it' },
			{ value: 'this', label: 'This object only' }
		],
		cancelLabel: 'Cancel'
	});
	if (!choice) return false;
	if (choice === 'all') sharedAnswers.set(id, 'all');
	else unlinkForEveryone(object.uuid);
	return true;
}

/** "This object only": clone the material here and on every peer (an older peer ignores the parameter).
 * @param {string} uuid */
export function unlinkForEveryone(uuid) {
	if (!unlinkMaterial(uuid)) return false;
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'materialUnlink', uuid });
	return true;
}

/** the brush radius in the stroke's own units: texture px / 2 on the map, object units on the model
 * @param {any} mesh @param {number} slot @param {string} sp @param {any} hit */
export function strokeRadius(mesh, slot, sp, hit) {
	const size = get(uvBrushSize);
	if (sp === 'uv') return size / 2;
	const model = meshModel(mesh, slot);
	if (!model) return 0;
	if (sp === 'vtx') return (model.diag * size) / 512;
	const dims = mapDims(mesh, slot, get(paintChannel));
	const t = hit && typeof hit.tri === 'number' ? hit.tri : -1;
	let f = t >= 0 ? frameOf(model, t) : null;
	if (!f && hit?.local) {
		for (const tt of trisNear(model.grid, hit.local, model.diag / 48)) {
			f = frameOf(model, tt);
			if (f) break;
		}
	}
	const density = f ? texelDensity(f, dims.w, dims.h) : 0;
	return density > 0 ? size / 2 / density : (model.diag * size) / 512;
}

/** the size of the map a stroke would paint @param {any} mesh @param {number} slot @param {string} ch */
function mapDims(mesh, slot, ch) {
	const material = materialAt(mesh, slot);
	const surface = ch === 'color' ? null : surfaces.get(mesh.uuid + '#' + slot + '#' + ch);
	const image = surface?.canvas ?? drawable(material?.[channelOf(ch).map]?.image);
	if (image) {
		const s = sizeOf(image);
		if (s) return s;
	}
	if (ch === 'color') return { w: 1024, h: 1024 };
	return { w: get(paintMapSize), h: get(paintMapSize) };
}

/**
 * Start a stroke. `sp` 'uv' takes [u, v] (the UV canvas), 'obj' takes the object-space hit {local, normal, tri},
 * and 'obj' becomes 'vtx' by itself on a mesh without usable UVs (said in the panel). Resolves false when nothing
 * can be painted (said with a toast).
 * @param {{uuid: string, slot?: number, sp: 'uv'|'obj', at: number[], w?: number, normal?: number[], tri?: number}} opts
 */
export async function beginStroke(opts) {
	if (stroke) endStroke();
	const object = objectOf(opts.uuid);
	if (!object?.geometry) return false;
	const carrier = carrierRefusal(object, 'paint');
	if (carrier) {
		showToast(carrier);
		return false;
	}
	const slot = opts.slot ?? 0;
	const ch = get(paintChannel);
	/** @type {'uv'|'obj'|'vtx'} */
	let sp = opts.sp;
	if (sp === 'obj') {
		const info = targetFor(object, slot);
		if (info?.mode === 'vertex') {
			if (ch !== 'color') {
				showToast(channelOf(ch).label + ' needs a UV map, and this mesh ' + (info.reason.includes('no UV') ? 'has none' : 'has overlapping UVs') + '. Paint Colour (as vertex colours), or unwrap it in the UV editor first.');
				return false;
			}
			sp = 'vtx';
		}
	}
	const material = materialAt(object, slot);
	if (!material || (sp !== 'vtx' && !(channelOf(ch).map in material))) {
		showToast('This material has no ' + channelOf(ch).label.toLowerCase() + ' — switch it to Standard in the Inspector to paint it.');
		return false;
	}
	const pending = { opening: true, queue: /** @type {any[]} */ ([]), ending: false, cancelled: false };
	stroke = pending;
	if (!(await settleSharing(object))) {
		stroke = null;
		return false;
	}
	if (pending.cancelled) return false;
	const brush = currentBrush();
	const r = strokeRadius(object, slot, sp, { local: opts.at, tri: opts.tri });
	const spec = {
		id: (get(peers)?.peer?.id ?? 'local') + ':m' + ++seq,
		uuid: opts.uuid,
		slot,
		ch,
		sp,
		c: paintStyle(ch, get(uvBrushColor), get(paintValue), brush.erase),
		r: Math.round(r * 1e5) / 1e5 || 1e-5,
		b: brushWire(brush),
		pm: get(uvPenPressure),
		n: opts.normal ? opts.normal.map((x) => Math.round(x * 1e4) / 1e4) : null
	};
	// the image before the stroke — what undo goes back to (an imported colour map has no data URL, so it is
	// encoded once here instead of undo removing the texture)
	const before = sp === 'vtx' ? null : ch === 'color' ? colourBefore(object, slot) : null;
	if (brush.stamp) shareHudImage(brush.stamp);
	const s = await openStroke(spec, true);
	if (!s || pending.cancelled) {
		if (s) cancelOpened(s);
		if (stroke === pending) stroke = null;
		return false;
	}
	s.before = sp === 'vtx' ? null : ch === 'color' ? before : s.surface.before;
	s.points = [];
	s.sent = 0;
	stroke = s;
	addPoint(s, opts.at, opts.w);
	for (const q of pending.queue) addPoint(s, q.at, q.w);
	present(s);
	if (pending.ending) endStroke();
	return true;
}

/** @param {any} object @param {number} slot */
function colourBefore(object, slot) {
	const material = materialAt(object, slot);
	const url = material?.userData?.mapDataUrl ?? null;
	if (url) return url;
	const image = drawable(material?.map?.image);
	if (!image) return null;
	const size = sizeOf(image);
	if (!size) return null;
	const canvas = document.createElement('canvas');
	canvas.width = size.w;
	canvas.height = size.h;
	canvas.getContext('2d')?.drawImage(image, 0, 0, size.w, size.h);
	return encodePaintCanvas(canvas);
}

/** @param {any} s @param {number[]} at @param {number | undefined} w */
function addPoint(s, at, w) {
	const dim = s.sp === 'uv' ? 2 : 3;
	const raw = [...at.slice(0, dim)];
	if (typeof w === 'number' && Number.isFinite(w) && w < 1 && s.pm !== 'off') raw.push(w);
	const p = quantizePoint(raw, dim);
	s.points.push(p);
	strokePoint(s, p);
}

/**
 * Extend the stroke: UV [u, v] or the object-space point, with the pen's pressure (undefined for a mouse).
 * Points that arrive while the stroke is still opening (the canvas seeds, a shared-material question) queue.
 * @param {number[]} at @param {number} [w]
 */
export function strokeTo(at, w) {
	const s = stroke;
	if (!s) return false;
	if (s.opening) {
		s.queue.push({ at, w });
		return true;
	}
	addPoint(s, at, w);
	present(s);
	const now = performance.now();
	if (now - lastSend >= SEND_MS) {
		lastSend = now;
		flush(s);
	}
	return true;
}

/** send the points peers have not seen (from the last one they have, so their path continues) @param {any} s */
function flush(s) {
	const start = Math.max(s.sent - 1, 0);
	const seg = s.points.slice(start);
	if (!seg.length || (s.sent > 0 && seg.length < 2)) return;
	s.sent = s.points.length;
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const b = s.b && Object.keys(s.b).length ? s.b : undefined;
	peer.send({
		type: 'meshpaint',
		id: s.id,
		uuid: s.uuid,
		...(s.slot ? { slot: s.slot } : {}),
		...(s.ch !== 'color' ? { ch: s.ch } : {}),
		sp: s.sp,
		c: s.c,
		r: s.r,
		...(b ? { b } : {}),
		...(s.pm === 'opacity' || s.pm === 'off' ? { pm: s.pm } : {}),
		...(s.n ? { n: s.n } : {}),
		seg
	});
}

/** Finish the stroke and commit it: one undo step, sent through the paths that already save and sync. */
export function endStroke() {
	const s = stroke;
	if (!s) return false;
	if (s.opening) {
		s.ending = true;
		return false;
	}
	stroke = null;
	flush(s);
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'meshpaintend', id: s.id });
	present(s);
	const ok = s.dabs > 0 ? commit(s) : (cancelOpened(s), false);
	release(s);
	// the stroke as a peer received it (spec + every rounded point), so a suite can REPLAY it and compare pixels
	lastStroke = { id: s.id, uuid: s.uuid, slot: s.slot, sp: s.sp, ch: s.ch, c: s.c, r: s.r, b: s.b, pm: s.pm, n: s.n, dabs: s.dabs, committed: ok, points: s.points.length <= 2048 ? s.points.map((/** @type {number[]} */ p) => [...p]) : null };
	return ok;
}

/** Abandon the stroke: the model goes back exactly as it was. */
export function cancelStroke() {
	const s = stroke;
	stroke = null;
	if (!s) return;
	if (s.opening) {
		s.cancelled = true;
		return;
	}
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'meshpaintend', id: s.id, cancel: 1 });
	cancelOpened(s);
	release(s);
}

/** Put an opened stroke's target back: base pixels, the previous map, the lift, the colours. @param {any} s */
function cancelOpened(s) {
	if (s.vertex) {
		const v = s.vertex;
		if (v.base) v.out.set(v.base);
		v.attr.needsUpdate = true;
		const material = s.object.material;
		if (!v.wasVertexColors && material && !Array.isArray(material)) {
			material.vertexColors = false;
			material.needsUpdate = true;
		}
		if (!v.hadColors) s.object.geometry.deleteAttribute('color');
		pokeScene();
		return;
	}
	if (s.layer) restoreBase(s.layer);
	const material = materialAt(s.object, s.slot);
	const surface = s.surface;
	if (material && surface && material[surface.key] === surface.texture) {
		material[surface.key] = surface.previousMap ?? null;
		material.needsUpdate = true;
	}
	if (material && surface?.liftShown) showLift(material, surface, false);
	if (s.ch === 'color') dropColorSurface(s.uuid, s.slot);
	else surfaces.delete(s.uuid + '#' + s.slot + '#' + s.ch);
	pokeScene();
}

/** @param {any} s */
function commit(s) {
	const label = 'Paint ' + channelOf(s.ch).label.toLowerCase();
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	try {
		if (s.sp === 'vtx') return commitVertex(s);
		const url = encodePaintCanvas(s.surface.canvas);
		if (s.ch === 'color') {
			recordMaterialChange(s.uuid, 'map', null, s.before, url, s.slot);
			applyMap(s.object, url, s.slot);
			broadcastMaterial({ type: 'objectParameters', parameter: 'map', uuid: s.uuid, map: url, ...(s.slot ? { slot: s.slot } : {}) });
			s.surface.seededFrom = url;
			return true;
		}
		const material = materialAt(s.object, s.slot);
		const surface = s.surface;
		if (surface.lift && surface.liftShown && material) {
			// recorded as a real change: put the old value back silently, then set it through the replicated setter
			showLift(material, surface, false);
			setMaterialParam(s.uuid, surface.lift.param, surface.lift.after);
			surface.liftShown = false;
			surface.lift = null;
		}
		const ok = commitPaintedMapSlot(s.uuid, surface.key, s.before, url, s.slot);
		surface.seededFrom = url;
		surface.before = url;
		return ok;
	} finally {
		if (own) endHistoryBatch(label);
	}
}

/** Vertex colours ride the meshgeo commit (it carries `colors` since mcp-shapes), corner by corner. @param {any} s */
function commitVertex(s) {
	const object = s.object;
	const geometry = object.geometry;
	const v = s.vertex;
	const tris = readTriangles(geometry);
	const expand = (/** @type {Float32Array} */ src) => {
		const index = geometry.index;
		const count = index ? index.count : geometry.attributes.position.count;
		const out = new Array(count * 3);
		for (let i = 0; i < count; i++) {
			const j = index ? index.getX(i) : i;
			out[i * 3] = src[j * 3];
			out[i * 3 + 1] = src[j * 3 + 1];
			out[i * 3 + 2] = src[j * 3 + 2];
		}
		return out;
	};
	const positions = trisToPositions(tris);
	const groups = trisToGroups(tris);
	const uvs = trisToUVs(tris);
	const before = { positions, groups, uvs, colors: expand(v.base) };
	const after = { positions, groups, uvs, colors: expand(v.out) };
	const material = object.material;
	if (!v.wasVertexColors && material && !Array.isArray(material)) {
		material.vertexColors = false; // so the setter records false -> true
		setMaterialParam(object.uuid, 'vertexColors', true);
	}
	return commitMeshGeoTriple(object.uuid, before, after);
}

// ---- the receive side ---------------------------------------------------------------------------------------------

/** @type {Map<string, {ready: Promise<any>, ts: number}>} */
const remote = new Map();

/** A peer's live stroke. @param {any} data a `meshpaint` message wireValidate passed */
export async function applyMeshPaint(data) {
	let entry = remote.get(data.id);
	if (!entry) {
		const spec = { id: data.id, uuid: data.uuid, slot: data.slot ?? 0, ch: data.ch ?? 'color', sp: data.sp, c: data.c, r: data.r, b: brushWire(brushFromWire(data.b)), pm: data.pm ?? 'size', n: data.n ?? null };
		entry = { ready: openStroke(spec, false), ts: Date.now() };
		remote.set(data.id, entry);
	}
	entry.ts = Date.now();
	const s = await entry.ready;
	if (!s) return;
	for (const p of data.seg) strokePoint(s, p);
	present(s);
}

/** A peer finished (or cancelled) a stroke. The commit that follows replaces the preview. @param {any} data */
export async function applyMeshPaintEnd(data) {
	const entry = remote.get(data?.id);
	if (!entry) return;
	remote.delete(data.id);
	const s = await entry.ready;
	if (!s) return;
	if (data.cancel) cancelOpened(s);
	else present(s);
	release(s);
}

/** @returns {number} live remote strokes (test hook) */
export function remoteStrokeCount() {
	return remote.size;
}

if (typeof window !== 'undefined')
	setInterval(() => {
		const now = Date.now();
		for (const [id, entry] of remote) if (now - entry.ts > STALE_MS) void applyMeshPaintEnd({ id, cancel: 0 });
	}, STALE_MS);

// ---- colour pick ----------------------------------------------------------------------------------------------------

/**
 * Take the brush value from the model under the cursor: the colour (or the grey of the channel) at the hit's UV,
 * or the vertex colour when the mesh paints vertex colours. @param {any} mesh @param {number} slot @param {any} hit a raycast hit
 */
export function pickAt(mesh, slot, hit) {
	const ch = channelOf(get(paintChannel));
	const info = targetFor(mesh, slot);
	if (info?.mode === 'vertex' || !hit?.uv) {
		const color = mesh.geometry?.attributes?.color;
		if (!color || !hit?.face) return false;
		const i = hit.face.a;
		const lin = [color.getX(i), color.getY(i), color.getZ(i)];
		const srgb = lin.map((c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
		uvBrushColor.set(rgbToHex(srgb));
		return true;
	}
	const material = materialAt(mesh, slot);
	const surface = ch.key === 'color' ? null : surfaces.get(mesh.uuid + '#' + slot + '#' + ch.key);
	const image = surface && material?.[ch.map] === surface.texture ? surface.canvas : drawable(material?.[ch.map]?.image);
	if (!image) return false;
	const flip = material[ch.map]?.flipY !== false;
	const w = image.width;
	const h = image.height;
	const x = Math.min(w - 1, Math.max(0, Math.floor(hit.uv.x * w)));
	const y = Math.min(h - 1, Math.max(0, Math.floor((flip ? 1 - hit.uv.y : hit.uv.y) * h)));
	const probe = document.createElement('canvas');
	probe.width = probe.height = 1;
	const ctx = probe.getContext('2d', { willReadFrequently: true });
	if (!ctx) return false;
	ctx.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
	const px = ctx.getImageData(0, 0, 1, 1).data;
	if (ch.gray) paintValue.set(Math.round((px[ch.key === 'roughness' ? 1 : 2] / 255) * 100) / 100);
	else uvBrushColor.set(rgbToHex([px[0] / 255, px[1] / 255, px[2] / 255]));
	return true;
}

// ---- the channel alone, on the model (LOCAL view) -------------------------------------------------------------------

/** @type {any} */
let channelProxy = null;

/**
 * Show one channel by itself on the model: a scene-root proxy sharing the mesh's geometry, drawn over it unlit.
 * Outside objectsGroup, so no save, sync or undo ever sees it (the colliderHelpers pattern). Null hides it.
 * @param {any} mesh @param {number} slot @param {string} ch
 */
export function showChannelView(mesh, slot, ch) {
	hideChannelView();
	const scene = get(globalScene);
	/** @type {any} */
	const s = scene;
	if (!s || !mesh?.geometry) return false;
	const key = channelOf(ch);
	const material = materialAt(mesh, slot);
	const texture = material?.[key.map] ?? null;
	const view = new THREE.MeshBasicMaterial({ map: texture, color: texture ? 0xffffff : 0x808080, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, toneMapped: false });
	if (key.gray && texture) {
		// three reads roughness from G and metalness from B: show that channel as grey, whatever the image holds
		const sw = key.key === 'roughness' ? 'g' : 'b';
		view.onBeforeCompile = (shader) => {
			shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#ifdef USE_MAP\n\tdiffuseColor.rgb *= vec3(texture2D(map, vMapUv).' + sw + ');\n#endif');
		};
		view.customProgramCacheKey = () => 'paint-view-' + sw;
	}
	channelProxy = new THREE.Mesh(mesh.geometry, view);
	channelProxy.name = 'paint-channel-view';
	channelProxy.frustumCulled = false;
	channelProxy.matrixAutoUpdate = false;
	channelProxy.renderOrder = 5;
	channelProxy.userData.target = mesh;
	channelProxy.onBeforeRender = () => {
		channelProxy.matrixWorld.copy(mesh.matrixWorld);
		const now = materialAt(mesh, slot)?.[key.map] ?? null;
		if (view.map !== now) {
			view.map = now;
			view.needsUpdate = true;
		}
	};
	s.add(channelProxy);
	pokeScene();
	return true;
}

export function hideChannelView() {
	if (!channelProxy) return;
	channelProxy.parent?.remove(channelProxy);
	channelProxy.material.dispose();
	channelProxy = null;
	pokeScene();
}

// ---- the viewport brush (desktop) -----------------------------------------------------------------------------------

/** @type {any} */
let ring = null;

/** the brush ring on the surface @param {any} point world @param {any} normal world @param {number} radius world */
export function showRing(point, normal, radius) {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return;
	if (!ring) {
		ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
		ring.name = 'paint-cursor';
		ring.renderOrder = 997;
	}
	if (ring.parent !== scene) scene.add(ring);
	ring.visible = true;
	ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
	ring.position.copy(point).addScaledVector(normal, radius * 0.02);
	ring.scale.setScalar(Math.max(radius, 1e-4));
	pokeScene();
}

export function hideRing() {
	if (ring?.visible) {
		ring.visible = false;
		pokeScene();
	}
}

/** where the ring is, for the suites */
export function ringDebug() {
	return ring ? { visible: !!ring.visible, radius: ring.scale.x, pos: ring.position.toArray() } : null;
}

/**
 * The object-space facts of a raycast hit: the point, the normal (object space) and the slot's triangle index.
 * @param {any} mesh @param {any} hit
 */
export function localHit(mesh, hit) {
	const local = mesh.worldToLocal(hit.point.clone());
	const n = hit.face?.normal ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
	return { local: [local.x, local.y, local.z], normal: [n.x, n.y, n.z] };
}

/** The material slot a hit landed on: its face's slot on a multi-material mesh, else 0 (a model stroke paints the
 * material under the brush, whichever slot the UV editor shows). @param {any} mesh @param {any} hit @param {number} fallback */
export function slotOfHit(mesh, hit, fallback) {
	if (!Array.isArray(mesh.material)) return 0;
	const i = hit?.face?.materialIndex;
	return Number.isInteger(i) ? i : fallback;
}

/** a hit's world normal @param {any} hit */
export function worldNormal(hit) {
	return hit.face?.normal ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
}

/** the ring's world radius for a stroke that would start here @param {any} mesh @param {number} slot @param {any} hit */
export function ringRadius(mesh, slot, hit) {
	const info = targetFor(mesh, slot);
	const sp = info?.mode === 'vertex' ? 'vtx' : 'obj';
	const r = strokeRadius(mesh, slot, sp, { local: localHit(mesh, hit).local });
	const scale = new THREE.Vector3();
	mesh.getWorldScale(scale);
	return r * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
}

/**
 * Paint on the model in the viewport while the UV editor's Paint tool is armed. Window CAPTURE listeners, so a
 * stroke is claimed before the viewport's own select and orbit (the weight brush's recipe). Alt+click picks the
 * value under the cursor; [ and ] size the brush. Returns the detach.
 * @param {{target: () => any, slot: () => number}} opts
 */
export function attachViewportPainting(opts) {
	const ray = new THREE.Raycaster();
	let active = false;
	/** @param {any} e */
	const hitAt = (e) => {
		const cam = /** @type {any} */ (get(globalCamera));
		const canvas = /** @type {any} */ (get(globalRenderer))?.domElement;
		const mesh = opts.target();
		if (!cam || !canvas || !mesh?.geometry) return null;
		const r = canvas.getBoundingClientRect();
		ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cam);
		const hit = ray.intersectObject(mesh, false)[0];
		return hit ? { mesh, hit, canvas } : null;
	};
	/** @param {any} e */
	const pressure = (e) => {
		if (get(uvPenPressure) === 'off' || e?.pointerType !== 'pen') return undefined;
		const p = Number(e.pressure);
		return Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : undefined;
	};
	/** @param {PointerEvent} e */
	const down = (e) => {
		if (e.button !== 0) return;
		const canvas = /** @type {any} */ (get(globalRenderer))?.domElement;
		if (!canvas || e.target !== canvas) return;
		const found = hitAt(e);
		if (!found) return;
		e.stopPropagation();
		e.stopImmediatePropagation();
		e.preventDefault();
		if (e.altKey) {
			pickAt(found.mesh, slotOfHit(found.mesh, found.hit, opts.slot()), found.hit);
			return;
		}
		active = true;
		const h = localHit(found.mesh, found.hit);
		void beginStroke({ uuid: found.mesh.uuid, slot: slotOfHit(found.mesh, found.hit, opts.slot()), sp: 'obj', at: h.local, w: pressure(e), normal: h.normal }).then((ok) => {
			if (!ok) active = false;
		});
	};
	/** @param {PointerEvent} e */
	const move = (e) => {
		if (active) {
			e.stopPropagation();
			let samples = [];
			try {
				samples = /** @type {any} */ (e).getCoalescedEvents?.() ?? [];
			} catch {
				samples = [];
			}
			for (const sample of samples.length ? samples : [e]) {
				const found = hitAt(sample);
				if (found) strokeTo(localHit(found.mesh, found.hit).local, pressure(sample));
			}
		}
		const found = hitAt(e);
		if (found) showRing(found.hit.point, worldNormal(found.hit), ringRadius(found.mesh, slotOfHit(found.mesh, found.hit, opts.slot()), found.hit));
		else hideRing();
	};
	/** @param {PointerEvent} e */
	const up = (e) => {
		if (!active) return;
		e.stopPropagation();
		active = false;
		endStroke();
	};
	/** @param {KeyboardEvent} e */
	const key = (e) => {
		const el = /** @type {any} */ (document.activeElement);
		if (el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes(el.type)))) return;
		if (e.key === '[' || e.key === ']') {
			uvBrushSize.update((n) => Math.max(1, Math.min(128, Math.round(e.key === ']' ? n * 1.25 + 1 : n / 1.25))));
			e.preventDefault();
		} else if (e.key === 'Escape' && stroke) {
			cancelStroke();
			active = false;
		}
	};
	window.addEventListener('pointerdown', down, true);
	window.addEventListener('pointermove', move, true);
	window.addEventListener('pointerup', up, true);
	window.addEventListener('keydown', key, true);
	return () => {
		window.removeEventListener('pointerdown', down, true);
		window.removeEventListener('pointermove', move, true);
		window.removeEventListener('pointerup', up, true);
		window.removeEventListener('keydown', key, true);
		if (active) endStroke();
		active = false;
		hideRing();
	};
}

/**
 * What the UV canvas shows behind the wire for a roughness / metalness / emission channel: the live paint canvas
 * while it is installed, else the slot's image, else null (no map yet — the first stroke makes one).
 * @param {any} mesh @param {number} slot @param {string} ch
 */
export function channelBackdrop(mesh, slot, ch) {
	if (!mesh || ch === 'color') return null;
	const key = channelOf(ch);
	const material = materialAt(mesh, slot);
	const surface = surfaces.get(mesh.uuid + '#' + slot + '#' + key.key);
	if (surface && material?.[key.map] === surface.texture) return surface.canvas;
	return drawable(material?.[key.map]?.image);
}

// ---- the suites' view -----------------------------------------------------------------------------------------------

/** @type {any} */
let lastStroke = null;

/** A hash of the pixels a slot's channel READS, so a suite can say "both peers (or a reload, or a re-import) show the
 * same thing": all four bytes for colour and emission, only green for roughness and only blue for metalness (a glTF
 * round trip merges the two into one image), rows in three's flipY = true order whatever the texture says (the
 * glTF loader turns flipY off and the exporter flips the image to match). @param {string} uuid @param {number} slot
 * @param {string} ch */
export function mapHash(uuid, slot = 0, ch = 'color') {
	const object = objectOf(uuid);
	const material = materialAt(object, slot);
	const key = channelOf(ch);
	const texture = material?.[key.map];
	const image = drawable(texture?.image);
	if (!image) return null;
	const w = image.width;
	const h = image.height;
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(image, 0, 0);
	const px = ctx.getImageData(0, 0, w, h).data;
	const flip = texture.flipY === false;
	const at = key.key === 'roughness' ? 1 : key.key === 'metalness' ? 2 : -1;
	const out = new Uint8Array(at < 0 ? px.length : w * h);
	for (let y = 0; y < h; y++) {
		const sy = flip ? h - 1 - y : y;
		for (let x = 0; x < w; x++) {
			const i = (sy * w + x) * 4;
			if (at < 0) out.set(px.subarray(i, i + 4), (y * w + x) * 4);
			else out[y * w + x] = px[i + at];
		}
	}
	return { hash: hashBytes(out), w, h };
}

export function meshPaintDebug() {
	return {
		stroking: !!stroke,
		remote: remote.size,
		surfaces: surfaces.size,
		last: lastStroke,
		target: get(paintTargetInfo),
		channel: get(paintChannel),
		brush: currentBrush(),
		ring: ringDebug(),
		view: !!channelProxy
	};
}
