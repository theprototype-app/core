// 64-2d (D4 wave 1): THE 2D DOCUMENTS AND THEIR MATHS — sprites, sprite-sheet flipbooks, layers
// with parallax, and the 2D camera follow. A LEAF that imports nothing, so every rule here is
// unit-tested with no scene (tests/unit/spriteCore.test.js).
//
// This is the API roadmap 66 (2D Asset Studio) generates into, so it is kept SMALL and every
// field is documented here. Three documents, each a plain JSON block on an object's userData,
// which is what makes replication, undo, saves, prefabs and GLTF extras work with no new plumbing
// (the userData.camera / userData.physics trick):
//
// userData.sprite — on a Mesh (a plane). The IMAGE is the mesh's own material map (the existing
// `map` message; encoded lossless PNG by spriteActions so pixel art survives), so editing a clip
// never re-sends the pixels. Every field is optional; `normalizeSprite` fills the defaults.
//   ppu      pixels per world unit (16): a 32 px frame is 2 m tall. The plane is sized from it.
//   filter   'nearest' (default, crisp pixel art) | 'linear' (smooth art)
//   snap     pixel snap: the DRAWN position rounds to the 1/ppu grid (the authored one is untouched)
//   sheet    {cols, rows, count, margin, spacing} — a GRID sheet. Frames are numbered row-major
//            from the TOP-LEFT (Aseprite / TexturePacker grid order), `count` trims a short last
//            row, margin/spacing are in pixels (the Tiled tileset convention).
//   clips    [{name, frames | from+to, fps, loop, events, next}] — a FLIPBOOK clip:
//            frames  explicit sheet frame indices ([0,1,2,1]) — wins over from/to
//            from,to an inclusive range (to < from plays backwards)
//            fps     frames per second (12)
//            loop    'loop' | 'once' (holds the last frame, then `next`) | 'pingpong'
//            events  [{frame, name}] — `frame` is the index INSIDE the clip; fires the moment that
//                    frame becomes current (Animation Marker nodes hear it by name)
//            next    a clip to switch to when a 'once' clip ends ('' = hold the last frame)
//   play     the clip that plays on its own ('' = none: the static `frame` shows)
//   frame    the sheet frame shown when no clip plays (0)
//   flipX, flipY  mirror the drawn frame (a character turning round)
// Draw order inside one layer is the object's own Render order (the existing Inspector field).
//
// userData.layer2d — on a Group: a 2D LAYER. Z-ORDER is the layer's z (a 2D scene is viewed down
// -Z, so z is depth — nothing else is needed for the depth test, and three's transparent sort is
// back-to-front by it); Render order breaks ties inside one layer.
//   parallax   how much the layer follows the camera in x: 1 = world (the gameplay layer),
//              0.5 = half speed (far hills), 0 = stuck to the camera (a sky)
//   parallaxY  the same in y (defaults to `parallax`)
//
// Flow node "Camera Follow 2D" (type `follow2d`) — moves a CAMERA OBJECT in x/y after a target,
// with a dead zone, damping, an offset, optional bounds and pixel snap; z is kept (follow2dGoal /
// follow2dStep below). LOCAL per peer, the camerarig rule.

/** @typedef {{frame: number, name: string}} SpriteEvent */
/** @typedef {{name: string, frames: number[]|null, from: number, to: number, fps: number, loop: 'loop'|'once'|'pingpong', events: SpriteEvent[], next: string}} SpriteClip */
/** @typedef {{cols: number, rows: number, count: number, margin: number, spacing: number}} SpriteSheet */
/** @typedef {{ppu: number, filter: 'nearest'|'linear', snap: boolean, sheet: SpriteSheet, clips: SpriteClip[], play: string, frame: number, flipX: boolean, flipY: boolean}} Sprite */

export const SPRITE_FILTERS = Object.freeze(['nearest', 'linear']);
export const SPRITE_LOOPS = Object.freeze(['loop', 'once', 'pingpong']);
/** caps that keep a peer's bytes from asking for something silly */
export const MAX_SHEET_SIDE = 64;
export const MAX_CLIPS = 64;
export const MAX_CLIP_FRAMES = 1024;
export const MAX_EVENTS = 64;
export const MAX_FPS = 120;

/** @param {any} v @param {number} fallback @param {number} min @param {number} max */
function clampNum(v, fallback, min, max) {
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** @param {any} v @param {number} fallback @param {number} min @param {number} max */
function clampInt(v, fallback, min, max) {
	return Math.round(clampNum(v, fallback, min, max));
}

/** @param {any} v @param {number} [max] */
function cleanName(v, max = 64) {
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** @param {any} raw @returns {SpriteSheet} */
export function normalizeSheet(raw) {
	const cols = clampInt(raw?.cols, 1, 1, MAX_SHEET_SIDE);
	const rows = clampInt(raw?.rows, 1, 1, MAX_SHEET_SIDE);
	const cells = cols * rows;
	return {
		cols,
		rows,
		count: clampInt(raw?.count, cells, 1, cells),
		margin: clampInt(raw?.margin, 0, 0, 4096),
		spacing: clampInt(raw?.spacing, 0, 0, 4096)
	};
}

/** @param {any} raw @param {number} count frames in the sheet @returns {SpriteClip | null} */
export function normalizeClip(raw, count) {
	const name = cleanName(raw?.name);
	if (!name) return null;
	const last = Math.max(0, count - 1);
	const frames = Array.isArray(raw?.frames)
		? raw.frames.slice(0, MAX_CLIP_FRAMES).map((/** @type {any} */ f) => clampInt(f, 0, 0, last))
		: null;
	const loop = SPRITE_LOOPS.includes(raw?.loop) ? raw.loop : 'loop';
	/** @type {SpriteEvent[]} */
	const events = (Array.isArray(raw?.events) ? raw.events : [])
		.slice(0, MAX_EVENTS)
		.map((/** @type {any} */ e) => ({ frame: clampInt(e?.frame, 0, 0, MAX_CLIP_FRAMES - 1), name: cleanName(e?.name) }))
		.filter((/** @type {SpriteEvent} */ e) => e.name);
	return {
		name,
		frames: frames && frames.length ? frames : null,
		from: clampInt(raw?.from, 0, 0, last),
		to: clampInt(raw?.to, last, 0, last),
		fps: clampNum(raw?.fps, 12, 0.1, MAX_FPS),
		loop,
		events,
		next: cleanName(raw?.next)
	};
}

/**
 * THE one boundary every sprite document goes through — an Inspector write, a peer's bytes, a
 * load, an undo. Unknown keys are dropped, numbers are clamped, clip names are unique (the first
 * wins), so the runtime never has to defend itself.
 * @param {any} raw @returns {Sprite}
 */
export function normalizeSprite(raw) {
	const sheet = normalizeSheet(raw?.sheet);
	/** @type {SpriteClip[]} */
	const clips = [];
	const seen = new Set();
	for (const c of Array.isArray(raw?.clips) ? raw.clips.slice(0, MAX_CLIPS) : []) {
		const clip = normalizeClip(c, sheet.count);
		if (!clip || seen.has(clip.name.toLowerCase())) continue;
		seen.add(clip.name.toLowerCase());
		clips.push(clip);
	}
	return {
		ppu: clampNum(raw?.ppu, 16, 0.01, 4096),
		filter: raw?.filter === 'linear' ? 'linear' : 'nearest',
		snap: raw?.snap === true,
		sheet,
		clips,
		play: cleanName(raw?.play),
		frame: clampInt(raw?.frame, 0, 0, sheet.count - 1),
		flipX: raw?.flipX === true,
		flipY: raw?.flipY === true
	};
}

/**
 * The compact form that is STORED: only what differs from the defaults, so a plain sprite is a
 * tiny block and a field added later never rewrites old scenes. normalizeSprite(compactSprite(s))
 * deep-equals normalizeSprite(s).
 * @param {any} raw @returns {Record<string, any>}
 */
export function compactSprite(raw) {
	const s = normalizeSprite(raw);
	const d = normalizeSprite({});
	/** @type {Record<string, any>} */
	const out = {};
	if (s.ppu !== d.ppu) out.ppu = s.ppu;
	if (s.filter !== d.filter) out.filter = s.filter;
	if (s.snap) out.snap = true;
	const cells = s.sheet.cols * s.sheet.rows;
	if (s.sheet.cols !== 1 || s.sheet.rows !== 1 || s.sheet.margin || s.sheet.spacing) {
		/** @type {Record<string, number>} */
		const sheet = { cols: s.sheet.cols, rows: s.sheet.rows };
		if (s.sheet.count !== cells) sheet.count = s.sheet.count;
		if (s.sheet.margin) sheet.margin = s.sheet.margin;
		if (s.sheet.spacing) sheet.spacing = s.sheet.spacing;
		out.sheet = sheet;
	}
	if (s.clips.length)
		out.clips = s.clips.map((c) => {
			/** @type {Record<string, any>} */
			const clip = { name: c.name };
			if (c.frames) clip.frames = c.frames;
			else {
				clip.from = c.from;
				clip.to = c.to;
			}
			clip.fps = c.fps;
			if (c.loop !== 'loop') clip.loop = c.loop;
			if (c.events.length) clip.events = c.events;
			if (c.next) clip.next = c.next;
			return clip;
		});
	if (s.play) out.play = s.play;
	if (s.frame) out.frame = s.frame;
	if (s.flipX) out.flipX = true;
	if (s.flipY) out.flipY = true;
	return out;
}

/** @param {Sprite} sprite @param {string} name @returns {SpriteClip | null} */
export function clipByName(sprite, name) {
	const want = String(name ?? '').trim().toLowerCase();
	if (!want) return null;
	return sprite.clips.find((c) => c.name.toLowerCase() === want) ?? null;
}

/** The sheet frames a clip walks, in order. @param {SpriteClip} clip @returns {number[]} */
export function clipFrames(clip) {
	if (clip.frames) return clip.frames;
	/** @type {number[]} */
	const out = [];
	const step = clip.to >= clip.from ? 1 : -1;
	for (let f = clip.from; ; f += step) {
		out.push(f);
		if (f === clip.to || out.length >= MAX_CLIP_FRAMES) break;
	}
	return out;
}

/** A clip's length in seconds (one pass; a pingpong round trip is 2n-2 frames). @param {SpriteClip} clip */
export function clipDuration(clip) {
	const n = clipFrames(clip).length;
	const steps = clip.loop === 'pingpong' && n > 1 ? 2 * n - 2 : n;
	return steps / clip.fps;
}

/**
 * Which clip INDEX a step lands on. A step is one frame's worth of time: floor(t * fps).
 * @param {SpriteClip} clip @param {number} n frames in the clip @param {number} step
 * @returns {{index: number, done: boolean}}
 */
export function stepIndex(clip, n, step) {
	if (n <= 1) return { index: 0, done: clip.loop === 'once' && step >= 1 };
	const s = Math.max(0, Math.floor(step));
	if (clip.loop === 'once') return s >= n ? { index: n - 1, done: true } : { index: s, done: false };
	if (clip.loop === 'pingpong') {
		const period = 2 * n - 2;
		const k = s % period;
		return { index: k < n ? k : period - k, done: false };
	}
	return { index: s % n, done: false };
}

/**
 * THE FLIPBOOK CLOCK: what a clip shows `elapsed` seconds after it started. Deterministic — two
 * peers given the same start stamp and clock show the same frame, which is the whole netcode
 * (golden rule 8: nothing about playback is ever sent).
 * @param {SpriteClip} clip @param {number} elapsed seconds (negative = not started: frame 0)
 * @returns {{index: number, frame: number, step: number, done: boolean}}
 *   index = position in the clip, frame = the sheet frame, step = whole frames elapsed
 */
export function clipFrameAt(clip, elapsed) {
	const frames = clipFrames(clip);
	const step = Math.max(0, Math.floor(Math.max(0, elapsed) * clip.fps + 1e-9));
	const { index, done } = stepIndex(clip, frames.length, step);
	return { index, frame: frames[index] ?? 0, step, done };
}

/**
 * The events a clip fires while its step moves from `fromStep` (already shown) to `toStep` (shown
 * now) — every frame ENTERED in between, in order, so a dropped render frame never skips a
 * footstep. A 'once' clip stops at its last frame. Pass fromStep = -1 to include the first frame.
 * At most two clip passes are walked: a tab that slept for a minute fires one round, not hundreds.
 * @param {SpriteClip} clip @param {number} fromStep @param {number} toStep
 * @returns {{events: SpriteEvent[], finished: boolean}}
 *   finished = a 'once' clip reached its end inside this window
 */
export function clipEventsBetween(clip, fromStep, toStep) {
	const n = clipFrames(clip).length;
	/** @type {SpriteEvent[]} */
	const events = [];
	let finished = false;
	if (!(toStep > fromStep)) return { events, finished };
	const once = clip.loop === 'once';
	const passLen = clip.loop === 'pingpong' && n > 1 ? 2 * n - 2 : n;
	let start = Math.floor(fromStep) + 1;
	// a 'once' clip has nothing past its last frame, so its window ends there BEFORE the cap
	const end = once ? Math.min(Math.floor(toStep), n - 1) : Math.floor(toStep);
	if (end - start + 1 > 2 * passLen) start = end - 2 * passLen + 1;
	for (let s = start; s <= end; s++) {
		const { index } = stepIndex(clip, n, s);
		for (const e of clip.events) if (e.frame === index) events.push(e);
	}
	if (once && toStep >= n && fromStep < n) finished = true;
	return { events, finished };
}

/**
 * One sheet frame's size in PIXELS (margin/spacing removed). @param {SpriteSheet} sheet
 * @param {number} width image px @param {number} height image px
 */
export function frameSizePx(sheet, width, height) {
	const w = (width - 2 * sheet.margin - (sheet.cols - 1) * sheet.spacing) / sheet.cols;
	const h = (height - 2 * sheet.margin - (sheet.rows - 1) * sheet.spacing) / sheet.rows;
	return { w: Math.max(1, w), h: Math.max(1, h) };
}

/**
 * Texture offset/repeat that show ONE frame, for a texture with three's default flipY (uv v = 0
 * at the image BOTTOM). Frames count row-major from the top-left. A flip mirrors the frame in
 * place (negative repeat, offset moved to the far edge) — the plane itself is never mirrored,
 * so a flipped sprite still faces the camera and keeps its collider.
 * @param {SpriteSheet} sheet @param {number} frame @param {number} width @param {number} height
 * @param {{flipX?: boolean, flipY?: boolean}} [flip]
 * @returns {{offset: [number, number], repeat: [number, number]}}
 */
export function frameUv(sheet, frame, width, height, flip = {}) {
	const W = Math.max(1, width);
	const H = Math.max(1, height);
	const f = Math.min(Math.max(0, Math.floor(frame) || 0), sheet.count - 1);
	const col = f % sheet.cols;
	const row = Math.floor(f / sheet.cols);
	const { w, h } = frameSizePx(sheet, W, H);
	const x0 = sheet.margin + col * (w + sheet.spacing);
	const yTop = sheet.margin + row * (h + sheet.spacing);
	let ox = x0 / W;
	let oy = 1 - (yTop + h) / H;
	let rx = w / W;
	let ry = h / H;
	if (flip.flipX) {
		ox += rx;
		rx = -rx;
	}
	if (flip.flipY) {
		oy += ry;
		ry = -ry;
	}
	return { offset: [ox, oy], repeat: [rx, ry] };
}

/** The plane size in world units for a frame of w×h pixels. @param {number} w @param {number} h @param {number} ppu */
export function planeSize(w, h, ppu) {
	const p = ppu > 0 ? ppu : 16;
	return { width: w / p, height: h / p };
}

/** Round to the pixel grid of `ppu` pixels per unit. @param {number} v @param {number} ppu */
export function snapToPixel(v, ppu) {
	if (!(ppu > 0) || !Number.isFinite(v)) return v;
	return Math.round(v * ppu) / ppu;
}

// ---- layers + parallax --------------------------------------------------------------------

/** @param {any} raw @returns {{parallax: number, parallaxY: number}} */
export function normalizeLayer2d(raw) {
	const parallax = clampNum(raw?.parallax, 1, -4, 4);
	return { parallax, parallaxY: clampNum(raw?.parallaxY, parallax, -4, 4) };
}

/** Stored form: only what differs from 1/same. @param {any} raw @returns {Record<string, number>} */
export function compactLayer2d(raw) {
	const l = normalizeLayer2d(raw);
	/** @type {Record<string, number>} */
	const out = { parallax: l.parallax };
	if (l.parallaxY !== l.parallax) out.parallaxY = l.parallaxY;
	return out;
}

/**
 * How far a layer is DRAWN from where it was authored, for a camera at (x, y). The anchor is the
 * world origin: with the camera there, every layer sits exactly as authored. A factor of 1 moves
 * with the world (offset 0); 0 rides with the camera (offset = the camera's own position).
 * @param {{x: number, y: number}} cam @param {{parallax: number, parallaxY: number}} layer
 * @returns {[number, number]}
 */
export function parallaxOffset(cam, layer) {
	return [cam.x * (1 - layer.parallax), cam.y * (1 - layer.parallaxY)];
}

// ---- 2D camera follow ---------------------------------------------------------------------

export const FOLLOW2D_DEFAULTS = Object.freeze({
	/** dead-zone width/height in world units: the target moves freely inside it */
	deadW: 1,
	deadH: 1,
	/** where the target sits relative to the camera centre */
	ox: 0,
	oy: 0,
	/** seconds of lag (a time constant — the same feel at 30 and 120 fps); 0 = rigid */
	damping: 0.15,
	/** follow on each axis */
	followX: true,
	followY: true,
	/** keep the VIEW inside [minX..maxX] × [minY..maxY]; off when min >= max */
	minX: 0,
	maxX: 0,
	minY: 0,
	maxY: 0,
	/** snap the final position to 1/ppu (0 = off) */
	ppu: 0
});

/** @param {any} raw */
export function normalizeFollow2d(raw) {
	const d = FOLLOW2D_DEFAULTS;
	return {
		deadW: clampNum(raw?.deadW, d.deadW, 0, 1000),
		deadH: clampNum(raw?.deadH, d.deadH, 0, 1000),
		ox: clampNum(raw?.ox, d.ox, -1000, 1000),
		oy: clampNum(raw?.oy, d.oy, -1000, 1000),
		damping: clampNum(raw?.damping, d.damping, 0, 10),
		followX: raw?.followX !== false,
		followY: raw?.followY !== false,
		minX: clampNum(raw?.minX, d.minX, -1e6, 1e6),
		maxX: clampNum(raw?.maxX, d.maxX, -1e6, 1e6),
		minY: clampNum(raw?.minY, d.minY, -1e6, 1e6),
		maxY: clampNum(raw?.maxY, d.maxY, -1e6, 1e6),
		ppu: clampNum(raw?.ppu, d.ppu, 0, 4096)
	};
}

/**
 * Keep a view of half-extents (hw, hh) centred at (x, y) inside the bounds. A bounds box smaller
 * than the view centres the view on it rather than jittering between the edges.
 * @param {number} x @param {number} y @param {{hw: number, hh: number}} half @param {ReturnType<typeof normalizeFollow2d>} o
 */
export function clampView(x, y, half, o) {
	let cx = x;
	let cy = y;
	if (o.maxX > o.minX) cx = o.maxX - o.minX <= 2 * half.hw ? (o.minX + o.maxX) / 2 : Math.min(o.maxX - half.hw, Math.max(o.minX + half.hw, cx));
	if (o.maxY > o.minY) cy = o.maxY - o.minY <= 2 * half.hh ? (o.minY + o.maxY) / 2 : Math.min(o.maxY - half.hh, Math.max(o.minY + half.hh, cy));
	return { x: cx, y: cy };
}

/**
 * Where the camera WANTS to be: the smallest move that brings the target (plus offset) back into
 * the dead zone, then the bounds. Pure — no damping here.
 * @param {{x: number, y: number}} cam @param {{x: number, y: number}} target
 * @param {any} opts normalizeFollow2d input @param {{hw: number, hh: number}} [half] view half-extents (bounds)
 */
export function follow2dGoal(cam, target, opts, half = { hw: 0, hh: 0 }) {
	const o = normalizeFollow2d(opts);
	let x = cam.x;
	let y = cam.y;
	const tx = target.x - o.ox;
	const ty = target.y - o.oy;
	if (o.followX) {
		const dx = tx - x;
		if (dx > o.deadW / 2) x = tx - o.deadW / 2;
		else if (dx < -o.deadW / 2) x = tx + o.deadW / 2;
	}
	if (o.followY) {
		const dy = ty - y;
		if (dy > o.deadH / 2) y = ty - o.deadH / 2;
		else if (dy < -o.deadH / 2) y = ty + o.deadH / 2;
	}
	return clampView(x, y, half, o);
}

/**
 * One damped step toward the goal: alpha = 1 - exp(-dt / damping), frame-rate independent.
 * @param {{x: number, y: number}} cam @param {{x: number, y: number}} goal @param {number} damping @param {number} dt seconds
 */
export function follow2dStep(cam, goal, damping, dt) {
	if (!(damping > 0) || !(dt > 0)) return { x: goal.x, y: goal.y };
	const a = 1 - Math.exp(-Math.min(dt, 1) / damping);
	return { x: cam.x + (goal.x - cam.x) * a, y: cam.y + (goal.y - cam.y) * a };
}
