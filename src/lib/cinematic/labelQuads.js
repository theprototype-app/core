// 100 C2-1 — TEXT IN THE CINEMATIC VIEW: every troika text draws as a canvas-texture quad while the view is on.
//
// troika paints letters with a GLSL SDF shader; the WebGPU renderer cannot run it and drew each text as a
// pile of plain 1 x 1 squares. The editor's own labels are troika (note pin numbers, ping names, peer
// names, path waypoint numbers, the AI marker) and so are flat 3D text objects, so every editing session
// lost them. While the view is on:
//   - troika's own draw is switched off: `Text.prototype.material` answers one invisible node material
//     (the renderer skips an invisible material), and every text that asks is picked up the same frame;
//   - each text gets a child quad (inherits its transform, billboard parent, visibility) whose texture is
//     a 2D canvas painted from troika's OWN layout (labelLayout.js): same font file, size, colour,
//     outline, anchor, wrapping; the quad copies the text's depth test and render order;
//   - a text whose glyphs troika's material moves one by one (text on a path: three instanced rows per
//     glyph, textPathRuntime) gets one quad per character, moved by the same rows, faded by its alpha;
//   - it follows the text live: a new layout (troika's async sync, which we start ourselves now that
//     troika's onBeforeRender no longer runs), a colour, an outline, the per-letter rows and colours;
//   - on leave everything goes: quads detached, canvases, textures and materials disposed, the material
//     accessor put back. A serializer parks the cover too (a save while the view is on sees plain troika).
// No MSDF pipeline, no troika patch: the canvas is drawn by the browser.
import * as THREE from 'three';
// @ts-ignore - troika-three-text ships no type declarations (threlte's <Text> dependency)
import { Text } from 'troika-three-text';
import { registerParkHook } from '../parkHooks.js';
import { parsePercent, coverBounds, rasterPlan, glyphChars, glyphCells, charRuns, orientBasis, baselineY, bleed } from './labelLayout.js';

/** the bundled default face (troika's resolver data, static/): the subsets a label may need, in fallback order */
const DEFAULT_SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese', 'symbols-2'];

// ---- fonts -------------------------------------------------------------------------------------------

/** font URL -> { family, ready } @type {Map<string, { family: string, ready: boolean, failed: boolean }>} */
const faces = new Map();
let faceSeq = 0;
/** bumped whenever a face finishes loading: texts drawn before it are drawn again */
let fontGeneration = 0;

/** @param {string} url @param {string} [familyHint] */
function faceFor(url, familyHint) {
	let f = faces.get(url);
	if (f) return f;
	f = { family: familyHint ?? 'tp-cinematic-font-' + ++faceSeq, ready: false, failed: false };
	faces.set(url, f);
	const rec = f;
	try {
		const ff = new FontFace(rec.family, `url(${JSON.stringify(url)})`);
		ff.load().then(
			(loaded) => {
				document.fonts.add(loaded);
				rec.ready = true;
				fontGeneration++;
			},
			() => {
				rec.failed = true;
				fontGeneration++;
			}
		);
	} catch {
		rec.failed = true;
	}
	return rec;
}

/** @param {string} rel */
const appUrl = (rel) => new URL(rel, document.baseURI).href;

/**
 * The CSS font stack a text draws with: its own file, else troika's default (the bundled Noto Sans
 * subsets; symbols only when the text has some), then the browser's sans-serif for anything else.
 * @param {any} t @returns {string}
 */
function fontStack(t) {
	if (typeof t.font === 'string' && t.font) return `"${faceFor(t.font).family}", sans-serif`;
	const wantsSymbols = /[ -￿]/.test(String(t.text ?? ''));
	const fams = DEFAULT_SUBSETS.filter((s) => s !== 'symbols-2' || wantsSymbols).map(
		(s) => faceFor(appUrl(`fonts/unicode-font-resolver/font-files/${s}/sans-serif.normal.400.woff`), 'tp-cinematic-noto-' + s).family
	);
	return fams.map((f) => `"${f}"`).join(', ') + ', sans-serif';
}

// ---- the hidden troika draw ---------------------------------------------------------------------------

/**
 * @param {any} W three/webgpu
 */
export function createLabelQuads(W) {
	const hidden = new W.MeshBasicNodeMaterial();
	hidden.visible = false;
	hidden.name = 'cinematic-text-hidden';
	// troika's shadow accessors call these on whatever `material` answers
	/** @type {any} */ (hidden).getDepthMaterial = () => hidden;
	/** @type {any} */ (hidden).getDistanceMaterial = () => hidden;

	/** texts that asked for their material since the last tick (the renderer asks every visible one) @type {Set<any>} */
	const asked = new Set();
	/** @type {Map<any, any>} text -> record */
	const records = new Map();
	const proto = Text.prototype;
	const own = Object.getOwnPropertyDescriptor(proto, 'material');
	let covering = false;
	/** e2e: the quads stand down (a frame with and without them, to count the pixels they draw) */
	let hiddenForTest = false;
	const stats = { made: 0, released: 0, draws: 0, layouts: 0 };

	function cover() {
		if (covering || !own?.get) return;
		covering = true;
		Object.defineProperty(proto, 'material', {
			configurable: true,
			enumerable: own.enumerable,
			get() {
				asked.add(this);
				return hidden;
			},
			set: own.set
		});
	}
	function uncover() {
		if (!covering || !own) return;
		covering = false;
		Object.defineProperty(proto, 'material', own);
	}

	/** troika's real material for a text (its colour / opacity / depth fall back to it) @param {any} t */
	function realMaterial(t) {
		const m = own?.get ? own.get.call(t) : null;
		return Array.isArray(m) ? m[m.length - 1] : m;
	}

	// a save taken while the view is on sees plain troika: the cover is lifted for the serializer
	const unpark = registerParkHook(() => {
		if (!covering) return null;
		uncover();
		/** @type {[any, any][]} */
		const lifted = [];
		for (const r of records.values()) {
			if (r.quad.parent) {
				lifted.push([r.quad, r.quad.parent]);
				r.quad.removeFromParent();
			}
		}
		return () => {
			for (const [q, p] of lifted) p.add(q);
			cover();
		};
	});

	cover();

	/** @param {any} t */
	function track(t) {
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		const material = new W.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
		material.name = 'cinematic-text';
		const geometry = new THREE.BufferGeometry();
		const quad = new THREE.Mesh(geometry, material);
		quad.name = 'cinematic-text-quad';
		quad.userData.localOnly = true;
		quad.userData.cinematicLabel = true;
		quad.raycast = () => {};
		quad.castShadow = false;
		quad.receiveShadow = false;
		t.add(quad);
		const r = { t, quad, canvas, ctx, material, geometry, texture: /** @type {any} */ (null), info: null, drawKey: '', geoKey: '', bounds: /** @type {number[]} */ ([0, 0, 0, 0]), charOf: /** @type {Int32Array | null} */ (null), synced: false };
		records.set(t, r);
		stats.made++;
		return r;
	}

	/** @param {any} r */
	function release(r) {
		r.quad.removeFromParent();
		r.geometry.dispose();
		r.material.dispose();
		r.texture?.dispose();
		r.canvas.width = r.canvas.height = 0;
		records.delete(r.t);
		stats.released++;
	}

	/** a text's look, as one comparable string @param {any} r @param {any} base */
	function styleKey(r, base) {
		const t = r.t;
		const colors = t.geometry?.getAttribute?.('aTroikaGlyphColor');
		return [
			fontGeneration,
			t.color == null ? 'm' + base?.color?.getHexString?.() : String(t.color?.isColor ? t.color.getHexString() : t.color),
			t.outlineWidth, t.outlineColor, t.outlineOpacity, t.outlineBlur, t.outlineOffsetX, t.outlineOffsetY,
			t.strokeWidth, t.strokeColor, t.strokeOpacity, t.fillOpacity,
			t.font, t.fontWeight, t.fontStyle, t.letterSpacing,
			colors && r.info?.glyphColors ? colors.id + ':' + colors.version : '-'
		].join('|');
	}

	/** @param {any} v @param {any} fallback @returns {THREE.Color} */
	const asColor = (v, fallback) => {
		const c = new THREE.Color();
		if (v == null) return fallback?.isColor ? c.copy(fallback) : c.set(0xffffff);
		try {
			return v.isColor ? c.copy(v) : c.set(v);
		} catch {
			return c.set(0xffffff);
		}
	};

	/** paint the canvas from troika's layout @param {any} r @param {any} base */
	function paint(r, base) {
		const t = r.t;
		const info = r.info;
		const fontSize = info.parameters?.fontSize ?? t.fontSize ?? 0.1;
		const outline = Math.max(0, parsePercent(t.outlineWidth, fontSize)) + Math.max(0, parsePercent(t.outlineBlur, fontSize));
		const stroke = Math.max(0, parsePercent(t.strokeWidth, fontSize));
		const bounds = coverBounds(info, fontSize, outline + stroke);
		const plan = rasterPlan(bounds, fontSize);
		r.bounds = bounds;
		if (!plan.w) return false;
		const { ctx, canvas } = r;
		if (canvas.width !== plan.w || canvas.height !== plan.h) {
			canvas.width = plan.w;
			canvas.height = plan.h;
		} else ctx.clearRect(0, 0, plan.w, plan.h);
		const px = plan.px;
		const fill = asColor(t.color, base?.color);
		const glyphColors = info.glyphColors && t.geometry?.getAttribute?.('aTroikaGlyphColor');
		// per-character colours (colorRanges / text on a path): troika keeps them per glyph
		/** @type {Int32Array | null} */
		let colorOfChar = null;
		if (glyphColors && r.charOf) {
			colorOfChar = new Int32Array(Math.floor(info.caretPositions.length / 4)).fill(-1);
			const a = glyphColors.array;
			// troika's shader reads these bytes as LINEAR colour (the standard view shows them so): the same here
			const lin = new THREE.Color();
			for (let g = 0; g < r.charOf.length; g++) {
				const c = r.charOf[g];
				if (c >= 0) colorOfChar[c] = lin.setRGB(a[g * 3] / 255, a[g * 3 + 1] / 255, a[g * 3 + 2] / 255, THREE.LinearSRGBColorSpace).getHex(THREE.SRGBColorSpace);
			}
		}
		const fillHex = fill.getHex(THREE.SRGBColorSpace);
		const runs = charRuns(String(info.parameters?.text ?? t.text ?? ''), info.caretPositions ?? [], colorOfChar ? (i) => (colorOfChar[i] >= 0 ? colorOfChar[i] : fillHex) : undefined);
		const weight = (info.parameters?.fontWeight ?? t.fontWeight) === 'bold' || Number(t.fontWeight) >= 600 ? 'bold' : 'normal';
		const style = (info.parameters?.fontStyle ?? t.fontStyle) === 'italic' ? 'italic ' : '';
		ctx.font = `${style}${weight} ${fontSize * px}px ${fontStack(t)}`;
		ctx.textBaseline = 'alphabetic';
		ctx.textAlign = 'left';
		/** @type {any} */ (ctx).letterSpacing = `${(Number(info.parameters?.letterSpacing ?? t.letterSpacing) || 0) * fontSize * px}px`;
		ctx.lineJoin = 'round';
		const m = ctx.measureText('Hg');
		const ascent = m.fontBoundingBoxAscent ?? fontSize * px * 0.9;
		const descent = m.fontBoundingBoxDescent ?? fontSize * px * 0.25;
		/** @param {number} x @param {number} y local units -> canvas pixels */
		const cx = (x) => (x - bounds[0]) * px;
		const cy = (y) => (bounds[3] - y) * px;
		const outlineColor = asColor(t.outlineColor ?? 0, null);
		const ox = parsePercent(t.outlineOffsetX, fontSize);
		const oy = parsePercent(t.outlineOffsetY, fontSize);
		if (outline > 0) {
			ctx.save();
			ctx.globalAlpha = Math.max(0, Math.min(1, Number(t.outlineOpacity ?? 1)));
			ctx.strokeStyle = ctx.fillStyle = '#' + outlineColor.getHexString(THREE.SRGBColorSpace);
			ctx.lineWidth = 2 * Math.max(0, parsePercent(t.outlineWidth, fontSize)) * px;
			const blur = Math.max(0, parsePercent(t.outlineBlur, fontSize)) * px;
			if (blur > 0) ctx.filter = `blur(${blur / 2}px)`;
			for (const run of runs) {
				const y = cy(baselineY(run.bottom, run.top, ascent, descent, px));
				if (ctx.lineWidth > 0) ctx.strokeText(run.s, cx(run.x + ox), y - oy * px);
				ctx.fillText(run.s, cx(run.x + ox), y - oy * px);
			}
			ctx.restore();
		}
		const fillOpacity = Math.max(0, Math.min(1, Number(t.fillOpacity ?? 1)));
		for (const run of runs) {
			const y = cy(baselineY(run.bottom, run.top, ascent, descent, px));
			const col = colorOfChar ? '#' + run.color.toString(16).padStart(6, '0') : '#' + fill.getHexString(THREE.SRGBColorSpace);
			if (fillOpacity > 0) {
				ctx.globalAlpha = fillOpacity;
				ctx.fillStyle = col;
				ctx.fillText(run.s, cx(run.x), y);
			}
			if (stroke > 0) {
				ctx.globalAlpha = Math.max(0, Math.min(1, Number(t.strokeOpacity ?? 1)));
				ctx.strokeStyle = '#' + asColor(t.strokeColor ?? 0x808080, null).getHexString(THREE.SRGBColorSpace);
				ctx.lineWidth = stroke * px;
				ctx.strokeText(run.s, cx(run.x), y);
			}
		}
		ctx.globalAlpha = 1;
		// the texels: transparent ones take the outermost ink's colour (no dark fringe when filtered)
		const img = ctx.getImageData(0, 0, plan.w, plan.h);
		const edge = outline > 0 ? outlineColor : fill;
		const edgeHex = edge.getHex(THREE.SRGBColorSpace);
		bleed(img.data, [(edgeHex >> 16) & 255, (edgeHex >> 8) & 255, edgeHex & 255]);
		const tex = r.texture;
		if (tex && tex.image.width === plan.w && tex.image.height === plan.h) {
			tex.image.data.set(new Uint8Array(img.data.buffer));
			tex.needsUpdate = true;
		} else {
			tex?.dispose();
			const next = new THREE.DataTexture(new Uint8Array(img.data.buffer.slice(0)), plan.w, plan.h, THREE.RGBAFormat, THREE.UnsignedByteType);
			next.colorSpace = THREE.SRGBColorSpace;
			next.generateMipmaps = true;
			next.minFilter = THREE.LinearMipmapLinearFilter;
			next.magFilter = THREE.LinearFilter;
			next.anisotropy = 4;
			next.needsUpdate = true;
			r.texture = next;
			r.material.map = next;
			r.material.needsUpdate = true;
		}
		stats.draws++;
		return true;
	}

	/** the quad(s) for the current layout @param {any} r */
	function shape(r) {
		const t = r.t;
		const info = r.info;
		const [x0, y0, x1, y1] = r.bounds;
		const geo = t.geometry;
		const rows = [geo?.getAttribute?.('aTpRow0'), geo?.getAttribute?.('aTpRow1'), geo?.getAttribute?.('aTpRow2')];
		const alpha = geo?.getAttribute?.('aTpAlpha');
		const w = x1 - x0;
		const h = y1 - y0;
		/** @param {number} x @param {number} y */
		const uv = (x, y) => [(x - x0) / w, (y1 - y) / h];
		/** @type {number[]} */
		const pos = [];
		/** @type {number[]} */
		const uvs = [];
		/** @type {number[]} */
		const col = [];
		/** @type {number[]} */
		const index = [];
		const perGlyph = rows.every((a) => a && a.count >= 1) && r.charOf && r.charOf.length;
		if (perGlyph && r.charOf) {
			// text on a path: one cell per character, carried by its glyph's rows (the path material's own maths)
			const fontSize = info.parameters?.fontSize ?? t.fontSize ?? 0.1;
			const pad = Math.max(0, parsePercent(t.outlineWidth, fontSize)) + 0.15 * fontSize;
			const cells = glyphCells(info.glyphBounds, info.caretPositions, r.charOf, pad);
			const [a, b, c] = rows.map((x) => x.array);
			const n = Math.min(r.charOf.length, rows[0].count, rows[1].count, rows[2].count);
			for (let g = 0; g < n; g++) {
				const cx0 = cells[g * 4];
				const cy0 = cells[g * 4 + 1];
				const cx1 = cells[g * 4 + 2];
				const cy1 = cells[g * 4 + 3];
				if (!(cx1 > cx0) || !(cy1 > cy0)) continue;
				const k = pos.length / 3;
				const al = alpha ? alpha.array[g] : 1;
				for (const [x, y] of [[cx0, cy0], [cx1, cy0], [cx1, cy1], [cx0, cy1]]) {
					pos.push(a[g * 4] * x + a[g * 4 + 1] * y + a[g * 4 + 3], b[g * 4] * x + b[g * 4 + 1] * y + b[g * 4 + 3], c[g * 4] * x + c[g * 4 + 1] * y + c[g * 4 + 3]);
					uvs.push(...uv(x, y));
					col.push(1, 1, 1, al);
				}
				index.push(k, k + 1, k + 2, k, k + 2, k + 3);
			}
		} else {
			const basis = orientBasis(t.orientation);
			for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
				if (basis) pos.push(basis[0] * x + basis[3] * y, basis[1] * x + basis[4] * y, basis[2] * x + basis[5] * y);
				else pos.push(x, y, 0);
				uvs.push(...uv(x, y));
				col.push(1, 1, 1, 1);
			}
			index.push(0, 1, 2, 0, 2, 3);
		}
		const g = r.geometry;
		g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
		g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
		g.setIndex(index);
		g.computeBoundingBox();
		g.computeBoundingSphere();
		r.material.vertexColors = !!perGlyph;
		stats.layouts++;
	}

	/** @param {any} r */
	function geoKeyOf(r) {
		const geo = r.t.geometry;
		const parts = [r.info ? 'i' : '-', r.t.orientation ?? '', r.bounds.join(',')];
		for (const name of ['aTpRow0', 'aTpRow1', 'aTpRow2', 'aTpAlpha']) {
			const a = geo?.getAttribute?.(name);
			parts.push(a ? a.id + ':' + a.version : '-');
		}
		return parts.join('|');
	}

	/** keep one text's quad in step with it @param {any} r */
	function update(r) {
		const t = r.t;
		// troika's onBeforeRender started its sync; it no longer runs, so we do
		if (t._needsSync) t.sync();
		const info = t.textRenderInfo;
		if (!info) {
			r.quad.visible = false;
			return;
		}
		const base = realMaterial(t);
		if (info !== r.info) {
			r.info = info;
			r.charOf = info.glyphBounds && info.caretPositions ? glyphChars(info.glyphBounds, info.caretPositions) : null;
			r.drawKey = '';
		}
		const key = styleKey(r, base);
		if (key !== r.drawKey) {
			r.drawKey = key;
			if (!paint(r, base)) {
				r.quad.visible = false;
				return;
			}
		}
		const gk = geoKeyOf(r);
		if (gk !== r.geoKey) {
			r.geoKey = gk;
			shape(r);
		}
		const m = r.material;
		m.depthTest = base?.depthTest !== false;
		m.opacity = base?.opacity ?? 1;
		m.toneMapped = base?.toneMapped !== false;
		m.side = base?.side ?? THREE.DoubleSide;
		r.quad.renderOrder = t.renderOrder;
		r.quad.visible = !hiddenForTest;
	}

	return {
		/** one frame: new texts picked up, every quad in step, gone texts released */
		tick() {
			for (const t of asked) if (!records.has(t) && t.isTroikaText) track(t);
			asked.clear();
			for (const r of [...records.values()]) {
				// a text that left the scene (a label unmounted, a pin deleted) takes its quad with it
				if (!r.t.parent) {
					release(r);
					continue;
				}
				try {
					update(r);
				} catch (e) {
					r.quad.visible = false;
				}
			}
		},
		/** texts reached by a scene walk (one hidden from the renderer by a parent is still covered when it shows) @param {any} scene */
		scan(scene) {
			/** @type {Set<any>} */
			const seen = new Set();
			scene.traverse((/** @type {any} */ o) => {
				if (!o.isTroikaText) return;
				seen.add(o);
				if (!records.has(o)) track(o);
			});
			for (const r of [...records.values()]) if (!seen.has(r.t)) release(r);
		},
		get count() {
			return records.size;
		},
		stats() {
			let texels = 0;
			for (const r of records.values()) texels += r.texture ? r.texture.image.width * r.texture.image.height : 0;
			return { quads: records.size, texels, ...stats, covering };
		},
		/** e2e: what one text's quad shows @param {any} t */
		recordOf(t) {
			const r = records.get(t);
			return r ? { visible: r.quad.visible, w: r.canvas.width, h: r.canvas.height, bounds: [...r.bounds], vertices: r.geometry.getAttribute('position')?.count ?? 0 } : null;
		},
		/** e2e @param {boolean} on */
		hideForTest(on) {
			hiddenForTest = !!on;
		},
		/** the view is leaving: every quad, canvas, texture and material goes, troika draws itself again */
		undo() {
			for (const r of [...records.values()]) release(r);
			asked.clear();
			uncover();
			unpark();
			hidden.dispose();
		}
	};
}
