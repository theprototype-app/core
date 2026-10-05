// 36 B12 — THE GAME HUD IN THE HEADSET: the maths, as a LEAF (imports nothing).
//
// vrGamePanel (30b) put a game's MENUS on a board and squeezed everything else — the score,
// the timer, the level — into short LINES on the left wrist and one head-locked strip. The
// layout a template author drew (a score card top-left, a clock top-right, a hint along the
// bottom) never reached the headset. vrHud.js draws it: the playing screen's elements, where
// their author put them, on ONE curved band in front of the eyes. Everything here is pure, so
// the vitest layer covers it against every shipped game's HUD (tests/unit/fixtures).
//
// THE BAND. The 1280x720 authoring stage maps LINEARLY onto a cylinder around the eye: x to
// yaw, y to pitch, one scale `s` (degrees per stage px) for both. A linear map can never make
// two elements overlap that did not overlap on the desktop. `halfWidth` (the HUD size
// setting) sets s; the stage's corners land at ±halfWidth yaw.
//
// READABLE TEXT. At s ~0.047 deg/px an 11 px label is half a degree — legible on a Quest 3
// (25 px per degree), small. So elements that sit together (a CLUSTER) are then SCALED UP
// AS A GROUP ABOUT THE GROUP'S ANCHOR POINT (a top-left score card grows from its top-left
// corner, a top-centre title row from its top edge's middle), each group by the largest factor
// `f <= F_MAX` that keeps it clear of every other group and on the stage (`scaleClusters`).
// Anchored scaling keeps corners in the corners; the overlap guard keeps the author's
// separations; inside a group the author's layout is exact.
//
// ONE DRAW CALL. Elements close together merge into CLUSTERS; each cluster is one curved
// quad strip, every strip lives in ONE BufferGeometry over ONE canvas atlas, and the band
// only covers the clusters (a mostly-empty full-view quad would cost fill rate on a Quest
// for nothing). A cluster with no authored backdrop gets a translucent plate so white text
// still reads against a bright sky.
//
// COMFORT. Head-locked HUDs jitter (every tremor of the head moves them) and swim (they move
// with no lag at all). `followHead` keeps the band inside a dead zone of the head pose and
// eases toward it outside it — small motions leave it still, a turn brings it along. It never
// rolls with the head. Depth: the band sits at a comfortable distance and is pulled IN front
// of anything nearer along its footprint (`pickRadius`), quickly when something comes close,
// slowly when it goes; the geometry is built at radius 1 and scaled, so moving it in depth
// leaves its angular size — and its texel density — unchanged.

/** the HUD's authoring stage (the editor artboard) */
export const STAGE_W = 1280;
export const STAGE_H = 720;
/** a Quest 3's display density at the centre of the lens, px per degree (Meta's figure) */
export const HEADSET_PPD = 25;

/** HUD size setting -> the band's half-width in degrees (the stage corners' yaw) */
export const HUD_SIZES = /** @type {Record<string, number>} */ ({ small: 26, medium: 30, large: 36 });
export const HUD_SIZE_DEFAULT = 'medium';
/** where the HUD goes: a band that follows the head with lag, one fixed in the world, or the wrist card only */
export const HUD_PLACEMENTS = /** @type {const} */ (['head', 'world', 'wrist']);
export const HUD_PLACEMENT_DEFAULT = 'head';

/** the band's resting distance, the nearest it is pulled in to, and the gap it keeps in front of the scene (m) */
export const HUD_BASE_DIST = 1.6;
export const HUD_MIN_DIST = 0.75;
export const HUD_DEPTH_MARGIN = 0.12;
/** the band rests this far below the eyes' horizon (degrees) — eyes rest slightly down */
export const HUD_PITCH = -4;
/** the largest anchored scale-up an element may get */
export const F_MAX = 1.6;
/** the gap (stage px) that merges two elements into one cluster, and a cluster's padding */
export const CLUSTER_GAP = 12;
export const CLUSTER_PAD = 8;

/** kinds with no headset form: you aim with a controller, not the view centre; a plot, a
 * debug pill, a module's own DOM and a full-screen flash have nothing to draw on a band */
export const NO_VR_FORM = new Set(['crosshair', 'minimap', 'debug', 'custom', 'damageflash']);

const DEG = Math.PI / 180;

/** @typedef {{left: number, top: number, w: number, h: number}} Rect */
/** @typedef {{id: string, kind: string, rect: Rect, h: 'left' | 'center' | 'right', v: 'top' | 'middle' | 'bottom', backdrop: boolean}} HudItem */

/** the 9-grid anchor as axes (hudDocs.anchorAxes, kept here so the leaf imports nothing) @param {any} anchor */
export function anchorOf(anchor) {
	if (anchor === 'center' || anchor === 'middle') return { v: /** @type {'middle'} */ ('middle'), h: /** @type {'center'} */ ('center') };
	const [v, h] = String(anchor ?? 'top-left').split('-');
	return {
		v: /** @type {'top' | 'middle' | 'bottom'} */ (v === 'bottom' ? 'bottom' : v === 'middle' || v === 'center' ? 'middle' : 'top'),
		h: /** @type {'left' | 'center' | 'right'} */ (h === 'right' ? 'right' : h === 'center' ? 'center' : 'left')
	};
}

/** @param {any} n @param {number} d */
const num = (n, d) => (Number.isFinite(Number(n)) ? Number(n) : d);

/** an element's rect on the stage (hudDocs.rectInFrame's maths) @param {any} el @returns {Rect} */
export function stageRect(el) {
	const { v, h } = anchorOf(el?.anchor);
	const w = num(el?.w, 0);
	const hh = num(el?.h, 0);
	const x = num(el?.x, 0);
	const y = num(el?.y, 0);
	const left = h === 'left' ? x : h === 'right' ? STAGE_W - x - w : STAGE_W / 2 - w / 2 + x;
	const top = v === 'top' ? y : v === 'bottom' ? STAGE_H - y - hh : STAGE_H / 2 - hh / 2 + y;
	return { left, top, w, h: hh };
}

/**
 * The elements the band draws, as items. `renderable(kind)` is the HUD kind registry's test
 * (passed in, so this file stays a leaf).
 * @param {any[]} elements @param {(kind: string) => boolean} [renderable]
 * @returns {HudItem[]}
 */
export function hudItems(elements, renderable = () => true) {
	/** @type {HudItem[]} */
	const out = [];
	for (const el of Array.isArray(elements) ? elements : []) {
		if (!el || typeof el.kind !== 'string' || NO_VR_FORM.has(el.kind) || !renderable(el.kind)) continue;
		const rect = stageRect(el);
		if (!(rect.w > 0 && rect.h > 0)) continue;
		const { h, v } = anchorOf(el.anchor);
		// a panel (or anything with its own background) is a backdrop: the cluster needs no plate
		const backdrop = el.kind === 'panel' || !!(el.style?.bg && el.style.bg !== 'transparent');
		out.push({ id: String(el.id ?? ''), kind: el.kind, rect, h, v, backdrop });
	}
	return out;
}

/**
 * A rect scaled by `f` about its anchor point (left/centre/right x, top/middle/bottom y).
 * @param {Rect} r @param {'left' | 'center' | 'right'} h @param {'top' | 'middle' | 'bottom'} v @param {number} f
 * @returns {Rect}
 */
export function scaleAbout(r, h, v, f) {
	const w = r.w * f;
	const hh = r.h * f;
	const ax = h === 'left' ? r.left : h === 'right' ? r.left + r.w : r.left + r.w / 2;
	const ay = v === 'top' ? r.top : v === 'bottom' ? r.top + r.h : r.top + r.h / 2;
	const left = h === 'left' ? ax : h === 'right' ? ax - w : ax - w / 2;
	const top = v === 'top' ? ay : v === 'bottom' ? ay - hh : ay - hh / 2;
	return { left, top, w, h: hh };
}

/** do two rects overlap by more than `slack` px on both axes? @param {Rect} a @param {Rect} b */
export function overlaps(a, b, slack = 0.5) {
	return a.left + a.w - slack > b.left && b.left + b.w - slack > a.left && a.top + a.h - slack > b.top && b.top + b.h - slack > a.top;
}

/** is a rect on the stage (0.5 px tolerance)? @param {Rect} r */
export function insideStage(r) {
	return r.left >= -0.5 && r.top >= -0.5 && r.left + r.w <= STAGE_W + 0.5 && r.top + r.h <= STAGE_H + 0.5;
}

/**
 * Elements whose padded rects touch merge into one CLUSTER (union-find). Returns each
 * cluster's padded rect and members; deterministic order (top, then left).
 * @param {Rect[]} rects @param {number} [gap] @param {number} [pad]
 * @returns {{rect: Rect, members: number[]}[]}
 */
export function clusterRects(rects, gap = CLUSTER_GAP, pad = CLUSTER_PAD) {
	const parent = rects.map((_, i) => i);
	/** @param {number} i @returns {number} */
	const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	const grown = rects.map((r) => ({ left: r.left - gap / 2, top: r.top - gap / 2, w: r.w + gap, h: r.h + gap }));
	for (let i = 0; i < rects.length; i++)
		for (let j = i + 1; j < rects.length; j++) if (overlaps(grown[i], grown[j], 0)) parent[find(i)] = find(j);
	/** @type {Map<number, number[]>} */
	const groups = new Map();
	rects.forEach((_, i) => {
		const root = find(i);
		groups.set(root, [...(groups.get(root) ?? []), i]);
	});
	const out = [...groups.values()].map((members) => {
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const i of members) {
			const r = rects[i];
			x0 = Math.min(x0, r.left);
			y0 = Math.min(y0, r.top);
			x1 = Math.max(x1, r.left + r.w);
			y1 = Math.max(y1, r.top + r.h);
		}
		return { rect: { left: x0 - pad, top: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }, members };
	});
	// a merge can make two clusters' padded rects overlap again: merge until stable
	for (let again = true; again; ) {
		again = false;
		outer: for (let i = 0; i < out.length; i++)
			for (let j = i + 1; j < out.length; j++)
				if (overlaps(out[i].rect, out[j].rect, 0)) {
					const a = out[i].rect;
					const b = out[j].rect;
					const left = Math.min(a.left, b.left);
					const top = Math.min(a.top, b.top);
					out[i] = {
						rect: { left, top, w: Math.max(a.left + a.w, b.left + b.w) - left, h: Math.max(a.top + a.h, b.top + b.h) - top },
						members: [...out[i].members, ...out[j].members].sort((m, n) => m - n)
					};
					out.splice(j, 1);
					again = true;
					break outer;
				}
	}
	return out.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

/** the anchor a CLUSTER scales about: its members' shared anchor, else the third of the stage
 * it sits in @param {Rect} rect @param {HudItem[]} members @returns {{h: HudItem['h'], v: HudItem['v']}} */
export function clusterAnchor(rect, members) {
	const hs = new Set(members.map((m) => m.h));
	const vs = new Set(members.map((m) => m.v));
	const cx = rect.left + rect.w / 2;
	const cy = rect.top + rect.h / 2;
	const h = hs.size === 1 ? members[0].h : cx < STAGE_W / 3 ? 'left' : cx > (2 * STAGE_W) / 3 ? 'right' : 'center';
	const v = vs.size === 1 ? members[0].v : cy < STAGE_H / 3 ? 'top' : cy > (2 * STAGE_H) / 3 ? 'bottom' : 'middle';
	return { h, v };
}

/** a point's offset from an anchor, scaled @param {number} p @param {number} a @param {number} f */
const about = (p, a, f) => a + (p - a) * f;

/**
 * READABLE TEXT, PER CLUSTER: elements that sit together (clusterRects) are scaled up as one
 * group about the group's anchor point — a top-left score card grows from the top-left
 * corner, a top-centre title row from its top edge's middle — each by the largest factor up
 * to fMax that keeps every group clear of every other and on the stage (0.02 steps, the larger
 * factor of an overlapping pair gives way first). Groups unscaled never overlap
 * (clusterRects merges until they do not), so this always terminates. Inside a group the
 * author's layout is kept exactly. Pure; deterministic.
 * @param {HudItem[]} items @param {number} [fMax]
 * @returns {{rects: Rect[], clusters: {rect: Rect, members: number[], f: number, plate: boolean}[]}}
 */
export function scaleClusters(items, fMax = F_MAX) {
	const raw = clusterRects(items.map((it) => it.rect));
	const anchors = raw.map((c) => clusterAnchor(c.rect, c.members.map((i) => items[i])));
	const f = raw.map(() => fMax);
	const step = (/** @type {number} */ v) => Math.max(1, Math.round((v - 0.02) * 100) / 100);
	const at = (/** @type {number} */ i) => scaleAbout(raw[i].rect, anchors[i].h, anchors[i].v, f[i]);
	for (let changed = true; changed; ) {
		changed = false;
		for (let i = 0; i < raw.length; i++)
			if (f[i] > 1 && insideStage(raw[i].rect) && !insideStage(at(i))) {
				f[i] = step(f[i]);
				changed = true;
			}
		for (let i = 0; i < raw.length; i++)
			for (let j = i + 1; j < raw.length; j++) {
				if ((f[i] <= 1 && f[j] <= 1) || !overlaps(at(i), at(j), 0)) continue;
				const hi = Math.max(f[i], f[j]);
				if (f[i] === hi) f[i] = step(f[i]);
				if (f[j] === hi) f[j] = step(f[j]);
				changed = true;
			}
	}
	/** @type {Rect[]} */
	const rects = items.map((it) => ({ ...it.rect }));
	const clusters = raw.map((c, ci) => {
		const r = c.rect;
		const ax = anchors[ci].h === 'left' ? r.left : anchors[ci].h === 'right' ? r.left + r.w : r.left + r.w / 2;
		const ay = anchors[ci].v === 'top' ? r.top : anchors[ci].v === 'bottom' ? r.top + r.h : r.top + r.h / 2;
		for (const m of c.members) {
			const e = items[m].rect;
			rects[m] = { left: about(e.left, ax, f[ci]), top: about(e.top, ay, f[ci]), w: e.w * f[ci], h: e.h * f[ci] };
		}
		// a plate behind the group unless the author's own backdrop already covers most of it
		const area = r.w * r.h;
		const covered = c.members.some((m) => items[m].backdrop && items[m].rect.w * items[m].rect.h >= 0.6 * area);
		return { rect: at(ci), members: c.members, f: f[ci], plate: !covered };
	});
	return { rects, clusters };
}

/** degrees per stage px for a band of half-width `halfWidth` degrees @param {number} halfWidth */
export function degPerPx(halfWidth) {
	return (2 * halfWidth) / STAGE_W;
}

/** a stage point's direction on the band, radians: yaw (+ = right), pitch (+ = up)
 * @param {number} x @param {number} y @param {number} halfWidth @param {number} [pitch0] degrees */
export function stageAngles(x, y, halfWidth, pitch0 = HUD_PITCH) {
	const s = degPerPx(halfWidth) * DEG;
	return { yaw: (x - STAGE_W / 2) * s, pitch: (STAGE_H / 2 - y) * s + pitch0 * DEG };
}

/**
 * Canvas px per stage px so one texel covers no more than one headset pixel at the band's
 * scale (the 33 X1 rule, `texelRatio` >= 1): s deg/px * ppd px/deg, in quarter steps, 1..3.
 * Angular — the band's distance does not enter it (the geometry scales with distance).
 * @param {number} sDegPerPx @param {number} [ppd]
 */
export function texelScale(sDegPerPx, ppd = HEADSET_PPD) {
	return Math.min(3, Math.max(1, Math.ceil(sDegPerPx * ppd * 4 - 1e-9) / 4));
}

/**
 * Shelf-pack `sizes` (canvas px, already scaled) into rows no wider than maxW. Tallest first;
 * returns each box's slot (input order) and the atlas size (heights rounded up to 4).
 * @param {{w: number, h: number}[]} sizes @param {number} maxW @param {number} [gap]
 * @returns {{slots: {x: number, y: number}[], w: number, h: number}}
 */
export function packShelves(sizes, maxW, gap = 4) {
	const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || a - b);
	/** @type {{x: number, y: number}[]} */
	const slots = sizes.map(() => ({ x: 0, y: 0 }));
	let x = 0;
	let y = 0;
	let rowH = 0;
	let w = 0;
	for (const i of order) {
		const s = sizes[i];
		if (x > 0 && x + s.w > maxW) {
			y += rowH + gap;
			x = 0;
			rowH = 0;
		}
		slots[i] = { x, y };
		x += Math.ceil(s.w) + gap;
		rowH = Math.max(rowH, Math.ceil(s.h));
		w = Math.max(w, x - gap);
	}
	const h = y + rowH;
	return { slots, w: Math.max(4, Math.ceil(w / 4) * 4), h: Math.max(4, Math.ceil(h / 4) * 4) };
}

/**
 * The band's geometry at RADIUS 1 around the eye: every quad a strip on the cylinder, columns
 * every `segDeg` degrees of yaw, y = tan(pitch) (straight lines stay straight vertically).
 * `quads` are stage rects (after scaling) with their atlas uv rect (0..1, v up).
 * @param {{rect: Rect, uv: {u0: number, v0: number, u1: number, v1: number}}[]} quads
 * @param {number} halfWidth @param {{segDeg?: number, pitch0?: number}} [opts]
 * @returns {{positions: Float32Array, uvs: Float32Array, indices: Uint32Array}}
 */
export function bandGeometry(quads, halfWidth, opts = {}) {
	const segDeg = opts.segDeg ?? 4;
	const pitch0 = opts.pitch0 ?? HUD_PITCH;
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const uv = [];
	/** @type {number[]} */
	const idx = [];
	const s = degPerPx(halfWidth);
	for (const q of quads) {
		const cols = Math.max(1, Math.ceil((q.rect.w * s) / segDeg));
		const base = pos.length / 3;
		const top = stageAngles(0, q.rect.top, halfWidth, pitch0).pitch;
		const bottom = stageAngles(0, q.rect.top + q.rect.h, halfWidth, pitch0).pitch;
		for (let c = 0; c <= cols; c++) {
			const t = c / cols;
			const { yaw } = stageAngles(q.rect.left + q.rect.w * t, 0, halfWidth, pitch0);
			const x = Math.sin(yaw);
			const z = -Math.cos(yaw);
			const u = q.uv.u0 + (q.uv.u1 - q.uv.u0) * t;
			pos.push(x, Math.tan(top), z, x, Math.tan(bottom), z);
			uv.push(u, q.uv.v1, u, q.uv.v0);
		}
		for (let c = 0; c < cols; c++) {
			const a = base + c * 2;
			// counter-clockwise seen from the eye (inside the cylinder): top-left, bottom-left, top-right
			idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
		}
	}
	return { positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint32Array(idx) };
}

/** wrap an angle to (-PI, PI] @param {number} a */
export function wrapAngle(a) {
	return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * @typedef {{x: number, y: number, z: number, yaw: number, pitch: number, ready: boolean}} FollowState
 * @typedef {{x: number, y: number, z: number, yaw: number, pitch: number}} HeadPose
 */

/** a fresh follow state @returns {FollowState} */
export function followState() {
	return { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ready: false };
}

/** move `cur` toward `target` only past a dead zone, easing with time constant tau (s)
 * @param {number} cur @param {number} target @param {number} dead @param {number} k */
function deadEase(cur, target, dead, k) {
	const d = target - cur;
	const ad = Math.abs(d);
	if (ad <= dead) return cur;
	return cur + Math.sign(d) * (ad - dead) * k;
}

/**
 * HEAD-LOCKED WITH LAG: the band follows the head, but only past a dead zone (a tremor leaves
 * it still — no jitter), easing toward the head outside it (a turn brings it along, smoothly),
 * and never rolling with the head. Mutates and returns `state` (allocation-free per frame).
 * @param {FollowState} state @param {HeadPose} head @param {number} dt seconds
 * @param {{posTau?: number, rotTau?: number, deadDeg?: number, posDead?: number}} [opts]
 */
export function followHead(state, head, dt, opts = {}) {
	if (!state.ready) {
		Object.assign(state, { x: head.x, y: head.y, z: head.z, yaw: head.yaw, pitch: head.pitch, ready: true });
		return state;
	}
	const kr = 1 - Math.exp(-Math.max(0, dt) / (opts.rotTau ?? 0.18));
	const kp = 1 - Math.exp(-Math.max(0, dt) / (opts.posTau ?? 0.12));
	const dead = (opts.deadDeg ?? 1.5) * DEG;
	const posDead = opts.posDead ?? 0.015;
	// yaw through the wrap: ease the DIFFERENCE, then re-wrap
	const dy = wrapAngle(head.yaw - state.yaw);
	state.yaw = wrapAngle(state.yaw + (deadEase(0, dy, dead, kr) - 0));
	state.pitch = deadEase(state.pitch, head.pitch, dead, kr);
	state.x = deadEase(state.x, head.x, posDead, kp);
	state.y = deadEase(state.y, head.y, posDead, kp);
	state.z = deadEase(state.z, head.z, posDead, kp);
	return state;
}

/**
 * FIXED IN THE WORLD: the band stays where it was placed (in front of you, level) until you
 * have turned past `turnDeg` or walked `walk` m away; then it re-places itself in front of you
 * (eased, the vrGamePanel lazy-follow rule — all the way back, not to the edge of the zone).
 * `state.ready` false = place now. Mutates and returns `state`.
 * @param {FollowState & {moving?: boolean}} state @param {HeadPose} head @param {number} dt
 * @param {{turnDeg?: number, walk?: number, tau?: number}} [opts]
 */
export function anchorWorld(state, head, dt, opts = {}) {
	const turn = (opts.turnDeg ?? 50) * DEG;
	const walk = opts.walk ?? 1.2;
	if (!state.ready) {
		Object.assign(state, { x: head.x, y: head.y, z: head.z, yaw: head.yaw, pitch: 0, ready: true, moving: false });
		return state;
	}
	const dy = wrapAngle(head.yaw - state.yaw);
	const away = Math.hypot(head.x - state.x, head.z - state.z);
	if (!state.moving && (Math.abs(dy) > turn || away > walk)) state.moving = true;
	if (state.moving) {
		const k = 1 - Math.exp(-Math.max(0, dt) / (opts.tau ?? 0.3));
		state.yaw = wrapAngle(state.yaw + dy * k);
		state.x += (head.x - state.x) * k;
		state.y += (head.y - state.y) * k;
		state.z += (head.z - state.z) * k;
		if (Math.abs(wrapAngle(head.yaw - state.yaw)) < 2 * DEG && Math.hypot(head.x - state.x, head.z - state.z) < 0.05) state.moving = false;
	} else state.y += (head.y - state.y) * (1 - Math.exp(-Math.max(0, dt) / 0.5)); // stand up / sit down: follow height gently
	return state;
}

/**
 * How far the band sits: its resting distance, or just in front of the nearest thing along its
 * footprint so it never hangs BEHIND a surface it is drawn over (two depth cues fighting).
 * @param {number[]} distances hits along the band's rays (m; non-finite = no hit)
 * @param {{base?: number, min?: number, margin?: number}} [opts]
 */
export function pickRadius(distances, opts = {}) {
	const base = opts.base ?? HUD_BASE_DIST;
	const min = opts.min ?? HUD_MIN_DIST;
	const margin = opts.margin ?? HUD_DEPTH_MARGIN;
	let near = Infinity;
	for (const d of distances) if (Number.isFinite(d) && d > 0) near = Math.min(near, d);
	return Math.max(min, Math.min(base, near - margin));
}

/** ease the band's distance: IN quickly (something came close), OUT slowly (no pumping)
 * @param {number} cur @param {number} target @param {number} dt */
export function easeRadius(cur, target, dt) {
	if (!Number.isFinite(cur)) return target;
	const tau = target < cur ? 0.08 : 0.6;
	return cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

/**
 * 36 U8 -> the headset: which of the game's declared INPUT ACTIONS a headset player can
 * actually press, and on what. Truthful only — an action with no VR equivalent (a keyboard
 * key button, crouch) is left out rather than shown with a key nobody is holding.
 * @param {{id: string, label: string, pointer?: string, keys?: string[]}[]} actions touchSpec's actions
 * @param {{jump?: string | null, trigger?: string, grip?: string, menu?: string | null}} controls
 *   the control names (null = not available here: no jump in this game, no pause menu)
 * @returns {{control: string, label: string}[]}
 */
export function vrActionHints(actions, controls) {
	/** @type {{control: string, label: string}[]} */
	const out = [];
	const add = (/** @type {string | null | undefined} */ control, /** @type {string} */ label) => {
		if (!control || !label || out.some((h) => h.control === control)) return;
		out.push({ control, label });
	};
	for (const a of Array.isArray(actions) ? actions : []) {
		if (!a || typeof a.id !== 'string') continue;
		if (a.id === 'jump') add(controls.jump, a.label || 'Jump');
		else if (a.id === 'grab') add(controls.grip ?? 'Grip', a.label || 'Grab');
		else if (a.pointer === 'press' || a.pointer === 'tap') add(controls.trigger ?? 'Trigger', a.label || 'Use');
	}
	add(controls.menu, 'Menu');
	return out.slice(0, 5);
}

/** placement / size values as stored (a stray value reads as the default) @param {any} v */
export function coercePlacement(v) {
	return HUD_PLACEMENTS.includes(/** @type {any} */ (v)) ? /** @type {'head' | 'world' | 'wrist'} */ (v) : HUD_PLACEMENT_DEFAULT;
}
/** @param {any} v */
export function coerceSize(v) {
	return typeof v === 'string' && HUD_SIZES[v] ? v : HUD_SIZE_DEFAULT;
}
