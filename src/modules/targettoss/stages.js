// 35 TARGET TOSS — the stage table and the pure rules (no scene, no stores).
//
// Five stages of rising difficulty. A stage is CLEARED when every target in it is down: every
// can off its table, every swinging target hit, enough pop-ups hit, the cart hit enough times.
// The clock running out loses the stage (kit.round's own time limit). Stars come from the time
// left: half the clock or more = 3, a quarter = 2, else 1.

/** @typedef {{table: string, rows: number}} CanStack */
/** @typedef {{id: number, name: string, limit: number, intro: string, cans: CanStack[], swing: number, swingSpeed: number, popups: number, popTime: number, cart: number, cartSpeed: number}} Stage */

/** @type {Stage[]} */
export const STAGES = [
	{ id: 1, name: 'Tin cans', limit: 45, intro: 'Knock every can off the table', cans: [{ table: 'Table left', rows: 3 }], swing: 0, swingSpeed: 0, popups: 0, popTime: 0, cart: 0, cartSpeed: 0 },
	{ id: 2, name: 'Two stacks', limit: 50, intro: 'Two pyramids — clear both tables', cans: [{ table: 'Table left', rows: 3 }, { table: 'Table right', rows: 3 }], swing: 0, swingSpeed: 0, popups: 0, popTime: 0, cart: 0, cartSpeed: 0 },
	{ id: 3, name: 'Swingers', limit: 45, intro: 'Hit the three swinging targets', cans: [], swing: 3, swingSpeed: 1.1, popups: 0, popTime: 0, cart: 0, cartSpeed: 0 },
	{ id: 4, name: 'Pop-ups', limit: 45, intro: 'Hit 6 targets before they drop', cans: [], swing: 0, swingSpeed: 0, popups: 6, popTime: 2.2, cart: 0, cartSpeed: 0 },
	{ id: 5, name: 'The cart', limit: 60, intro: 'Hit the moving cart 3 times and clear the big pyramid', cans: [{ table: 'Table right', rows: 4 }], swing: 2, swingSpeed: 1.5, popups: 0, popTime: 0, cart: 3, cartSpeed: 0.7 }
];

/** @param {any} id @returns {Stage | null} */
export const stageById = (id) => STAGES.find((s) => s.id === Number(id)) ?? null;

/** the pop-up targets on the back wall */
export const POPUP_COUNT = 6;
/** the swinging targets */
export const SWING_COUNT = 3;
/** can size (the template is authored to match) */
export const CAN = { r: 0.09, h: 0.24 };
/** the ball shelf slots: x offsets from the shelf centre */
export const BALL_SLOTS = [-0.75, -0.45, -0.15, 0.15, 0.45, 0.75];
/** points */
export const POINTS = { can: 100, swing: 250, popup: 200, cart: 300 };
/** a hit within this many seconds of the last one grows the combo */
export const COMBO_WINDOW = 2.5;
export const COMBO_MAX = 5;

/** the can positions of a pyramid of `rows` on a table top, centred at x/z, top y
 * @param {number} rows @param {number} cx @param {number} top @param {number} cz @returns {number[][]} */
export function pyramid(rows, cx, top, cz) {
	/** @type {number[][]} */ const out = [];
	const gap = CAN.r * 2 + 0.012;
	for (let row = 0; row < rows; row++) {
		const n = rows - row;
		for (let i = 0; i < n; i++) {
			const x = cx + (i - (n - 1) / 2) * gap;
			const y = top + CAN.h / 2 + row * (CAN.h + 0.004) + 0.003;
			out.push([+x.toFixed(4), +y.toFixed(4), cz]);
		}
	}
	return out;
}

/** cans in a stage @param {Stage} stage */
export const canCount = (stage) => stage.cans.reduce((a, c) => a + (c.rows * (c.rows + 1)) / 2, 0);

/** the number of targets a stage has in all @param {Stage} stage */
export const targetCount = (stage) => canCount(stage) + stage.swing + stage.popups + stage.cart;

/** stars from the time left @param {Stage} stage @param {boolean} won @param {number} elapsed */
export function starsFor(stage, won, elapsed) {
	if (!won || !stage) return 0;
	const left = stage.limit - elapsed;
	if (left >= stage.limit * 0.5) return 3;
	if (left >= stage.limit * 0.25) return 2;
	return 1;
}

/** ★★☆ @param {number} n */
export function starsText(n) {
	const k = Math.max(0, Math.min(3, Math.round(Number(n) || 0)));
	return '★'.repeat(k) + '☆'.repeat(3 - k);
}

/** m:ss @param {number} seconds */
export function formatTime(seconds) {
	const s = Math.max(0, Math.ceil(Number(seconds) || 0));
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** a small integer hash (no transcendentals: every peer agrees) @param {number} a @param {number} b */
export function hash2(a, b) {
	let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return h >>> 0;
}

/**
 * Which pop-up targets are UP right now — a pure function of the round number and the round
 * clock, so every peer raises the same two without a message. A slot lasts `popTime`; the
 * first 0.4 s of each slot everything is down (a beat between pops).
 * @param {Stage | null} stage @param {number} round @param {number} elapsed
 * @returns {{slot: number, up: number[]}}
 */
export function popupsUp(stage, round, elapsed) {
	if (!stage || !stage.popups || !(elapsed > 0)) return { slot: -1, up: [] };
	const slot = Math.floor(elapsed / stage.popTime);
	if (elapsed - slot * stage.popTime < 0.4) return { slot, up: [] };
	const a = hash2(round, slot) % POPUP_COUNT;
	let b = hash2(round + 7, slot * 3 + 1) % POPUP_COUNT;
	if (b === a) b = (a + 3) % POPUP_COUNT;
	return { slot, up: [a, b] };
}

/** the swinging target's offset from its rest pose @param {number} index 0.. @param {number} time @param {number} speed
 * @returns {{x: number, y: number, rz: number}} */
export function swingOffset(index, time, speed) {
	const w = 1.6 * (speed || 1);
	const phase = index * 2.1;
	// a smooth pendulum without transcendentals is not needed here: the pose is LOCAL per
	// peer (a module effect), only the hit test reads it — and that runs on one peer
	const a = 0.55 * Math.sin(w * time + phase);
	return { x: 1.3 * Math.sin(a), y: 1.3 * (1 - Math.cos(a)), rz: a };
}

/** the cart's x offset @param {number} time @param {number} speed */
export const cartOffset = (time, speed) => 3.2 * Math.sin((speed || 0.7) * time);
