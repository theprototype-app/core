// 36 F11 / S4 — TIDY A NODE GRAPH, AND SAY WHETHER IT IS TIDY. Imports NOTHING (a leaf,
// vitest-covered), so the node editor's Tidy command, the template author script and the
// lint suites all run the same arithmetic.
//
// It works on a GEOMETRY MODEL, never on DOM or graph documents: boxes (a node card's
// top-left + measured size) and wires (which box, which side, and the handle's offset inside
// its box). The caller measures — the editor reads xyflow's measured sizes and handle bounds,
// so a 24-socket group card is exactly as tall as it is drawn — and gets positions back.
//
// THE RULES a tidy graph keeps (`lintGraph`; the user's words, 1.25 feedback):
//   1. no card overlaps another card (nodes, notes, group cards)
//   2. no wire passes through a card it does not start or end at — measured on the SAME
//      bezier xyflow draws (getBezierPath, curvature 0.25), sampled
//   3. frames (backdrop notes) do not overlap each other, and a card is either inside a frame
//      or clear of it
//
// TWO WAYS TO TIDY:
//   · `repairLayout` keeps the author's layout and moves only what breaks a rule, the
//     least distance it can (a card in a wire's way steps out of the wire's band, an
//     overlapping card is pushed down). For a graph that is already readable.
//   · `layeredLayout` rebuilds it: layered left -> right in the direction the wires flow
//     (longest-path layers, cycles broken, barycentric ordering seeded by the old vertical
//     order, each card centred on its neighbours), notes ride above the card they describe,
//     free notes and unwired cards get a column of their own, then `repairLayout` clears
//     whatever a long wire still crosses. Group cards are ordinary blocks here.
//
// Deterministic: a pure function of the model (ids break every tie), so two peers — or the
// author script on two days — get the same answer from the same input.

/** @typedef {'node'|'note'|'group'|'frame'} BoxKind */
/** @typedef {{id: string, x: number, y: number, w: number, h: number, kind?: BoxKind, pinned?: boolean}} Box */
/**
 * A wire. `sx/sy` = the source handle's centre relative to the source box's top-left, `tx/ty`
 * the target handle's; `sp`/`tp` the side the handle sits on (default right -> left).
 * @typedef {{id: string, source: string, target: string, sx: number, sy: number, tx: number, ty: number, sp?: string, tp?: string}} Wire
 */

export const CURVATURE = 0.25;
/** the clearance a tidy graph keeps between cards and between a card and a wire */
export const CLEAR = 12;
export const GAP_X = 110;
export const GAP_Y = 36;

/** @param {number} distance @param {number} c */
function controlOffset(distance, c) {
	return distance >= 0 ? 0.5 * distance : c * 25 * Math.sqrt(-distance);
}

/**
 * The control points xyflow's getBezierPath uses for a wire between two handles.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {string} [sp] @param {string} [tp]
 */
export function bezierControls(x1, y1, x2, y2, sp = 'right', tp = 'left') {
	const ctl = (/** @type {string} */ pos, /** @type {number} */ ax, /** @type {number} */ ay, /** @type {number} */ bx, /** @type {number} */ by) => {
		if (pos === 'left') return [ax - controlOffset(ax - bx, CURVATURE), ay];
		if (pos === 'top') return [ax, ay - controlOffset(ay - by, CURVATURE)];
		if (pos === 'bottom') return [ax, ay + controlOffset(by - ay, CURVATURE)];
		return [ax + controlOffset(bx - ax, CURVATURE), ay];
	};
	const [c1x, c1y] = ctl(sp, x1, y1, x2, y2);
	const [c2x, c2y] = ctl(tp, x2, y2, x1, y1);
	return { c1x, c1y, c2x, c2y };
}

/**
 * Points along the drawn wire (cubic bezier), endpoints included.
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @param {string} [sp] @param {string} [tp] @param {number} [n]
 * @returns {[number, number][]}
 */
export function bezierPoints(x1, y1, x2, y2, sp = 'right', tp = 'left', n = 48) {
	const { c1x, c1y, c2x, c2y } = bezierControls(x1, y1, x2, y2, sp, tp);
	/** @type {[number, number][]} */
	const out = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const u = 1 - t;
		const a = u * u * u;
		const b = 3 * u * u * t;
		const c = 3 * u * t * t;
		const d = t * t * t;
		out.push([a * x1 + b * c1x + c * c2x + d * x2, a * y1 + b * c1y + c * c2y + d * y2]);
	}
	return out;
}

/** @param {Wire} w @param {Map<string, Box>} byId */
export function wireEnds(w, byId) {
	const s = byId.get(w.source);
	const t = byId.get(w.target);
	if (!s || !t) return null;
	return { x1: s.x + w.sx, y1: s.y + w.sy, x2: t.x + w.tx, y2: t.y + w.ty };
}

/** @param {Wire} w @param {Map<string, Box>} byId */
export function wirePoints(w, byId) {
	const e = wireEnds(w, byId);
	return e ? bezierPoints(e.x1, e.y1, e.x2, e.y2, w.sp, w.tp) : [];
}

/** does segment a-b touch the rectangle (inclusive)? Liang-Barsky clip */
function segmentHitsRect(/** @type {number} */ ax, /** @type {number} */ ay, /** @type {number} */ bx, /** @type {number} */ by, /** @type {number} */ l, /** @type {number} */ t, /** @type {number} */ r, /** @type {number} */ b) {
	let t0 = 0;
	let t1 = 1;
	const dx = bx - ax;
	const dy = by - ay;
	const p = [-dx, dx, -dy, dy];
	const q = [ax - l, r - ax, ay - t, b - ay];
	for (let i = 0; i < 4; i++) {
		if (p[i] === 0) {
			if (q[i] < 0) return false;
		} else {
			const v = q[i] / p[i];
			if (p[i] < 0) {
				if (v > t1) return false;
				if (v > t0) t0 = v;
			} else {
				if (v < t0) return false;
				if (v < t1) t1 = v;
			}
		}
	}
	return true;
}

/** @param {[number, number][]} pts @param {Box} b @param {number} pad */
function polylineHitsBox(pts, b, pad) {
	const l = b.x - pad;
	const t = b.y - pad;
	const r = b.x + b.w + pad;
	const bt = b.y + b.h + pad;
	for (let i = 1; i < pts.length; i++) {
		const [ax, ay] = pts[i - 1];
		const [bx, by] = pts[i];
		if (Math.max(ax, bx) < l || Math.min(ax, bx) > r || Math.max(ay, by) < t || Math.min(ay, by) > bt) continue;
		if (segmentHitsRect(ax, ay, bx, by, l, t, r, bt)) return true;
	}
	return false;
}

/** @param {Box} a @param {Box} b @param {number} [gap] */
export function boxesOverlap(a, b, gap = 0) {
	return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}
/** @param {Box} outer @param {Box} inner */
function contains(outer, inner) {
	return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/**
 * Every rule a box or wire breaks. `pad` widens each card for the wire test (a wire grazing a
 * card's edge reads as crossing it); the cards a wire starts and ends at are exempt.
 * @param {Box[]} boxes @param {Wire[]} wires @param {{pad?: number, gap?: number}} [opts]
 */
export function lintGraph(boxes, wires, opts = {}) {
	const pad = opts.pad ?? 2;
	const gap = opts.gap ?? 0;
	const byId = new Map(boxes.map((b) => [b.id, b]));
	const cards = boxes.filter((b) => b.kind !== 'frame');
	const frames = boxes.filter((b) => b.kind === 'frame');
	/** @type {{a: string, b: string}[]} */
	const overlaps = [];
	for (let i = 0; i < cards.length; i++)
		for (let j = i + 1; j < cards.length; j++) if (boxesOverlap(cards[i], cards[j], gap)) overlaps.push({ a: cards[i].id, b: cards[j].id });
	/** @type {{a: string, b: string}[]} */
	const frameOverlaps = [];
	for (let i = 0; i < frames.length; i++)
		for (let j = i + 1; j < frames.length; j++)
			if (boxesOverlap(frames[i], frames[j]) && !contains(frames[i], frames[j]) && !contains(frames[j], frames[i])) frameOverlaps.push({ a: frames[i].id, b: frames[j].id });
	for (const f of frames) for (const c of cards) if (boxesOverlap(f, c) && !contains(f, c)) frameOverlaps.push({ a: f.id, b: c.id });
	/** @type {{wire: string, box: string}[]} */
	const wireHits = [];
	for (const w of wires) {
		const pts = wirePoints(w, byId);
		if (!pts.length) continue;
		for (const c of cards) {
			if (c.id === w.source || c.id === w.target) continue;
			if (polylineHitsBox(pts, c, pad)) wireHits.push({ wire: w.id, box: c.id });
		}
	}
	return { overlaps, frameOverlaps, wireHits, ok: !overlaps.length && !frameOverlaps.length && !wireHits.length };
}

/** a lint result as one short line, for a toast / a suite / a report */
export function lintSummary(/** @type {ReturnType<typeof lintGraph>} */ r) {
	return `${r.overlaps.length} overlap${r.overlaps.length === 1 ? '' : 's'}, ${r.wireHits.length} wire${r.wireHits.length === 1 ? '' : 's'} through cards, ${r.frameOverlaps.length} frame clash${r.frameOverlaps.length === 1 ? '' : 'es'}`;
}

/** @param {Box[]} boxes */
function cloneBoxes(boxes) {
	return boxes.map((b) => ({ ...b }));
}

/** the y band a wire occupies across [x0, x1] (null when it never enters it) */
function wireBandIn(/** @type {[number, number][]} */ pts, /** @type {number} */ x0, /** @type {number} */ x1) {
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 0; i < pts.length; i++) {
		const [x, y] = pts[i];
		if (x >= x0 && x <= x1) {
			lo = Math.min(lo, y);
			hi = Math.max(hi, y);
		}
		if (i) {
			// a segment that spans the band's edge contributes its crossing point
			const [px, py] = pts[i - 1];
			for (const edge of [x0, x1]) {
				if ((px - edge) * (x - edge) < 0) {
					const yy = py + ((edge - px) / (x - px)) * (y - py);
					lo = Math.min(lo, yy);
					hi = Math.max(hi, yy);
				}
			}
		}
	}
	return lo <= hi ? { lo, hi } : null;
}

/**
 * Keep the layout, fix what breaks a rule: a card a wire passes through steps out of the
 * wire's band (up or down, whichever is shorter — down once a card has been moved a few
 * times, so two wires cannot bounce it forever); an overlap pushes the lower card down.
 * Pinned boxes never move (the other one does). Frames are left alone.
 * @param {Box[]} boxes @param {Wire[]} wires
 * @param {{clear?: number, maxSteps?: number}} [opts]
 * @returns {{boxes: Box[], moved: string[], steps: number, lint: ReturnType<typeof lintGraph>}}
 */
export function repairLayout(boxes, wires, opts = {}) {
	const clear = opts.clear ?? CLEAR;
	const maxSteps = opts.maxSteps ?? 400;
	const out = cloneBoxes(boxes);
	const byId = new Map(out.map((b) => [b.id, b]));
	/** @type {Map<string, number>} */
	const moves = new Map();
	let steps = 0;
	const movable = (/** @type {Box} */ b) => !!b && !b.pinned && b.kind !== 'frame';
	for (; steps < maxSteps; steps++) {
		const r = lintGraph(out, wires, { pad: 2, gap: 0 });
		if (!r.overlaps.length && !r.wireHits.length) break;
		if (r.overlaps.length) {
			// the pair with the topmost overlap first, so pushes cascade downward in order
			const o = r.overlaps
				.map((p) => ({ a: /** @type {Box} */ (byId.get(p.a)), b: /** @type {Box} */ (byId.get(p.b)) }))
				.sort((p, q) => Math.max(p.a.y, p.b.y) - Math.max(q.a.y, q.b.y) || (p.a.id + p.b.id < q.a.id + q.b.id ? -1 : 1))[0];
			let [upper, lower] = o.a.y < o.b.y || (o.a.y === o.b.y && o.a.id < o.b.id) ? [o.a, o.b] : [o.b, o.a];
			if (!movable(lower)) [upper, lower] = [lower, upper];
			if (!movable(lower)) break;
			// down below `upper` (a card never jumps sideways: columns are how a graph reads)
			const down = upper.y + upper.h + clear - lower.y;
			lower.y += Math.max(1, down);
			moves.set(lower.id, (moves.get(lower.id) ?? 0) + 1);
			continue;
		}
		const hit = r.wireHits
			.map((p) => ({ w: /** @type {Wire} */ (wires.find((x) => x.id === p.wire)), b: /** @type {Box} */ (byId.get(p.box)) }))
			.filter((p) => movable(p.b))
			.sort((p, q) => p.b.y - q.b.y || (p.b.id < q.b.id ? -1 : 1))[0];
		if (!hit) break;
		const band = wireBandIn(wirePoints(hit.w, byId), hit.b.x - clear, hit.b.x + hit.b.w + clear);
		if (!band) break;
		const up = hit.b.y + hit.b.h + clear - band.lo; // move up by this
		const down = band.hi + clear - hit.b.y; // move down by this
		const n = moves.get(hit.b.id) ?? 0;
		if (up < down && n < 3 && hit.b.y - up > -100000) hit.b.y -= Math.max(1, up);
		else hit.b.y += Math.max(1, down);
		moves.set(hit.b.id, n + 1);
	}
	return { boxes: out, moved: [...moves.keys()].sort(), steps, lint: lintGraph(out, wires) };
}

/**
 * Rebuild the layout: each connected piece of the graph layered left -> right, the pieces
 * stacked top to bottom, cards with no wires (and notes about nothing nearby) in columns on
 * the left, then repaired.
 * @param {Box[]} boxes @param {Wire[]} wires
 * @param {{gapX?: number, gapY?: number, origin?: {x: number, y: number}, noteReach?: number, sweeps?: number, columnHeight?: number}} [opts]
 */
export function layeredLayout(boxes, wires, opts = {}) {
	const gapX = opts.gapX ?? GAP_X;
	const gapY = opts.gapY ?? GAP_Y;
	const noteReach = opts.noteReach ?? 260;
	const origin = opts.origin ?? topLeft(boxes);
	const byId = new Map(boxes.map((b) => [b.id, b]));
	const get = (/** @type {string} */ id) => /** @type {Box} */ (byId.get(id));
	const cards = boxes.filter((b) => b.kind !== 'frame');
	const isNote = (/** @type {Box} */ b) => b.kind === 'note';
	const live = wires.filter((w) => byId.has(w.source) && byId.has(w.target) && w.source !== w.target && !isNote(get(w.source)) && !isNote(get(w.target)));
	const wired = new Set();
	for (const w of live) wired.add(w.source), wired.add(w.target);

	// --- blocks: a card with the notes that describe it stacked above ---------------------------
	const solid = cards.filter((b) => !isNote(b));
	/** @type {Map<string, Box[]>} */
	const notesOf = new Map();
	/** @type {Box[]} */
	const freeNotes = [];
	for (const n of cards.filter(isNote).sort(byYX)) {
		// prefer the card the note sits ABOVE (how notes are written), else the nearest
		let best = null;
		let bestD = Infinity;
		for (const c of solid) {
			const d = rectDistance(n, c) + (n.y + n.h <= c.y + 4 ? 0 : 40);
			if (d < bestD || (d === bestD && best && c.id < best.id)) (best = c), (bestD = d);
		}
		if (best && bestD <= noteReach) notesOf.set(best.id, [...(notesOf.get(best.id) ?? []), n]);
		else freeNotes.push(n);
	}
	const blockW = (/** @type {string} */ id) => Math.max(get(id).w, ...(notesOf.get(id) ?? []).map((n) => n.w));
	const blockH = (/** @type {string} */ id) => (notesOf.get(id) ?? []).reduce((s, n) => s + n.h + gapY / 2, 0) + get(id).h;

	// --- connected pieces of the wired cards ------------------------------------------------------
	const root = new Map(solid.filter((b) => wired.has(b.id)).map((b) => [b.id, b.id]));
	const find = (/** @type {string} */ x) => {
		while (root.get(x) !== x) x = /** @type {string} */ (root.get(x));
		return x;
	};
	for (const w of live) {
		const ra = find(w.source);
		const rb = find(w.target);
		if (ra !== rb) root.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
	}
	/** @type {Map<string, string[]>} */
	const pieces = new Map();
	for (const id of root.keys()) pieces.set(find(id), [...(pieces.get(find(id)) ?? []), id]);
	const pieceList = [...pieces.values()].sort((p, q) => {
		const py = Math.min(...p.map((id) => get(id).y));
		const qy = Math.min(...q.map((id) => get(id).y));
		return py - qy || q.length - p.length;
	});

	/** @type {Map<string, {x: number, y: number}>} */
	const place = new Map();
	let reversedCount = 0;
	let maxLayers = 0;
	/** lay one piece out at (0, 0); returns its size */
	const layoutPiece = (/** @type {string[]} */ ids) => {
		ids.sort((a, b) => cmpPos(get(a), get(b)));
		const inPiece = new Set(ids);
		/** @type {Map<string, Set<string>>} */
		const succ = new Map(ids.map((id) => [id, new Set()]));
		for (const w of [...live].sort((a, b) => (a.id < b.id ? -1 : 1))) if (inPiece.has(w.source) && inPiece.has(w.target)) /** @type {Set<string>} */ (succ.get(w.source)).add(w.target);
		const state = new Map();
		/** @type {[string, string][]} */
		const reversed = [];
		const visit = (/** @type {string} */ id) => {
			state.set(id, 1);
			for (const t of [...(succ.get(id) ?? [])].sort((a, b) => cmpPos(get(a), get(b)))) {
				const st = state.get(t);
				if (st === 1) reversed.push([id, t]);
				else if (!st) visit(t);
			}
			state.set(id, 2);
		};
		for (const id of ids) if (!state.get(id)) visit(id);
		for (const [x, y] of reversed) {
			/** @type {Set<string>} */ (succ.get(x)).delete(y);
			/** @type {Set<string>} */ (succ.get(y)).add(x);
		}
		reversedCount += reversed.length;
		/** @type {Map<string, string[]>} */
		const pred = new Map(ids.map((id) => [id, []]));
		for (const [x, ts] of succ) for (const t of ts) /** @type {string[]} */ (pred.get(t)).push(x);
		/** @type {Map<string, number>} */
		const layer = new Map();
		const depth = (/** @type {string} */ id) => {
			if (layer.has(id)) return /** @type {number} */ (layer.get(id));
			layer.set(id, 0);
			let l = 0;
			for (const q of /** @type {string[]} */ (pred.get(id))) l = Math.max(l, depth(q) + 1);
			layer.set(id, l);
			return l;
		};
		for (const id of ids) depth(id);
		for (let pass = 0; pass < 2; pass++)
			for (const id of ids) {
				if (/** @type {string[]} */ (pred.get(id)).length) continue;
				const ts = [...(succ.get(id) ?? [])];
				if (ts.length) layer.set(id, Math.max(0, Math.min(...ts.map((t) => /** @type {number} */ (layer.get(t)))) - 1));
			}
		const n = Math.max(...ids.map((id) => /** @type {number} */ (layer.get(id)))) + 1;
		maxLayers = Math.max(maxLayers, n);
		/** @type {string[][]} */
		const layers = Array.from({ length: n }, () => []);
		for (const id of ids) layers[/** @type {number} */ (layer.get(id))].push(id);
		for (const L of layers) L.sort((x, y) => byYX(get(x), get(y)));
		const nbr = (/** @type {string} */ id, /** @type {number} */ dir) => (dir < 0 ? /** @type {string[]} */ (pred.get(id)) : [...(succ.get(id) ?? [])]);
		const pos = new Map();
		layers.forEach((L) => L.forEach((id, i) => pos.set(id, i)));
		const sweeps = opts.sweeps ?? 8;
		for (let s = 0; s < sweeps; s++) {
			const down = s % 2 === 0;
			const order = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
			for (const li of order) {
				const L = layers[li];
				const bary = new Map();
				for (const id of L) {
					const ns = nbr(id, down ? -1 : 1);
					bary.set(id, ns.length ? ns.reduce((acc, q) => acc + pos.get(q), 0) / ns.length : pos.get(id));
				}
				L.sort((x, y) => bary.get(x) - bary.get(y) || pos.get(x) - pos.get(y));
				L.forEach((id, i) => pos.set(id, i));
			}
		}
		// x per layer: the widest block, plus room for the fan of wires leaving it
		/** @type {number[]} */
		const layerX = [];
		let x = 0;
		for (let li = 0; li < n; li++) {
			layerX.push(x);
			const fan = Math.max(0, ...layers[li].map((id) => succ.get(id)?.size ?? 0));
			x += Math.max(0, ...layers[li].map(blockW)) + gapX + Math.min(160, 18 * fan);
		}
		/** @type {Map<string, number>} */
		const top = new Map();
		for (const L of layers) {
			let yy = 0;
			for (const id of L) {
				top.set(id, yy);
				yy += blockH(id) + gapY;
			}
		}
		const centre = (/** @type {string} */ id) => /** @type {number} */ (top.get(id)) + blockH(id) / 2;
		for (let it = 0; it < 12; it++) {
			const down = it % 2 === 0;
			const order = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
			for (const li of order) {
				const L = layers[li];
				const want = L.map((id) => {
					const ns = [...nbr(id, -1), ...nbr(id, 1)];
					return ns.length ? ns.reduce((acc, q) => acc + centre(q), 0) / ns.length - blockH(id) / 2 : /** @type {number} */ (top.get(id));
				});
				const ys = want.slice();
				for (let i = 1; i < L.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + blockH(L[i - 1]) + gapY);
				for (let i = L.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - blockH(L[i]) - gapY);
				for (let i = 1; i < L.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + blockH(L[i - 1]) + gapY);
				L.forEach((id, i) => top.set(id, ys[i]));
			}
		}
		// the piece starts at its own top (centring drifts it), and its blocks are placed
		const minTop = Math.min(...ids.map((id) => /** @type {number} */ (top.get(id))));
		let h = 0;
		for (let li = 0; li < n; li++)
			for (const id of layers[li]) {
				let yy = /** @type {number} */ (top.get(id)) - minTop;
				for (const note of notesOf.get(id) ?? []) {
					place.set(note.id, { x: layerX[li], y: yy });
					yy += note.h + gapY / 2;
				}
				place.set(id, { x: layerX[li], y: yy });
				h = Math.max(h, yy + get(id).h);
			}
		return { ids, w: x - gapX, h };
	};

	// --- every piece (a layered wired piece, a loose card with its notes, a free note) is
	// shelf-packed in reading order: left to right in rows, rows top to bottom, the row width
	// chosen so the whole graph is about as wide as a pane is (2:1) and frames readably ---------
	/** @type {{ids: string[], w: number, h: number, y0: number, x0: number}[]} */
	const items = pieceList.map((ids) => {
		const y0 = Math.min(...ids.map((id) => get(id).y));
		const x0 = Math.min(...ids.map((id) => get(id).x));
		return { ...layoutPiece(ids), y0, x0 };
	});
	const single = (/** @type {string} */ id, /** @type {boolean} */ note) => {
		let yy = 0;
		if (!note)
			for (const nb of notesOf.get(id) ?? []) {
				place.set(nb.id, { x: 0, y: yy });
				yy += nb.h + gapY / 2;
			}
		place.set(id, { x: 0, y: yy });
		const top = note ? get(id) : (notesOf.get(id) ?? [])[0] ?? get(id);
		return { ids: [id], w: note ? get(id).w : blockW(id), h: yy + get(id).h, y0: top.y, x0: top.x };
	};
	for (const nb of freeNotes) items.push(single(nb.id, true));
	for (const b of solid.filter((c) => !wired.has(c.id))) items.push(single(b.id, false));
	items.sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
	const area = items.reduce((acc, it) => acc + (it.w + gapX) * (it.h + gapY), 0);
	const rowW = Math.max(...items.map((it) => it.w), opts.rowWidth ?? Math.sqrt(area * 2.2));
	let rx = 0;
	let ry = 0;
	let rh = 0;
	const shift = (/** @type {string} */ id, /** @type {number} */ dx, /** @type {number} */ dy) => {
		const q = place.get(id);
		if (q) place.set(id, { x: q.x + dx, y: q.y + dy });
	};
	for (const it of items) {
		if (rx > 0 && rx + it.w > rowW) {
			rx = 0;
			ry += rh + gapY * 2;
			rh = 0;
		}
		for (const id of it.ids) {
			shift(id, origin.x + rx, origin.y + ry);
			for (const nb of notesOf.get(id) ?? []) shift(nb.id, origin.x + rx, origin.y + ry);
		}
		rx += it.w + gapX;
		rh = Math.max(rh, it.h);
	}
	const laid = boxes.map((b) => {
		const q = place.get(b.id);
		return q ? { ...b, x: Math.round(q.x), y: Math.round(q.y) } : { ...b };
	});
	const repaired = repairLayout(laid, wires);
	return { ...repaired, layers: maxLayers, reversed: reversedCount };
}

/** @param {Box[]} boxes */
function topLeft(boxes) {
	if (!boxes.length) return { x: 0, y: 0 };
	return { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) };
}
/** @param {Box} a @param {Box} b */
function byYX(a, b) {
	return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** @param {Box} a @param {Box} b */
function cmpPos(a, b) {
	return a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
/** gap between two rectangles (0 when they touch or overlap) @param {Box} a @param {Box} b */
function rectDistance(a, b) {
	const dx = Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w));
	const dy = Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
	return Math.hypot(dx, dy);
}
