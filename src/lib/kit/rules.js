// 34 R2 — kit.rules: declarative PLAY RULES any game sets once and every input path obeys —
// grab REACH, a grab VETO, the play BOUNDS and the JUMP height. It generalises 31-towers' reach +
// jump (built for one game, as scene fields) into rules a game sets from code or nodes.
//
// WHAT IS SHARED AND WHAT IS LOCAL
//   reach / jump / bounds   kit DOCUMENT (authority-written): one value for the whole session,
//                           so two peers can never grab by different rules. The app reads them
//                           through resolvePlaySettings, ABOVE the scene's `play` block and its
//                           publishers — so desktop Play, Interact, the VR grip and the VR
//                           teleport all obey with no change of their own.
//   the veto                CODE, registered on every peer by the game (`onGrabRequest(fn)`):
//                           the grab happens on the GRABBING peer, so that peer asks. The game's
//                           code is the same everywhere, so the answer is too.
//   `refused`               a LOCAL event: only the player whose grab was refused hears it.
//
// THE GRAB REQUEST is asked BEFORE the grab (today `ongrab` fires only after it) and may be asked
// every frame while a player aims (the crosshair's "too far" state), so a veto must be cheap and
// free of side effects: `refuse(reason)` is its only output.
//
// A pure piece: it imports only the reach maths (a pure leaf), so the logic sim runs it as is.

import { bodyDistance, normalizeReach } from '../playReach.js';
import spec from './rules.spec.js';

/** @param {any} v @param {number} max @returns {number | null} */
function metres(v, max) {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return null;
	return Math.min(max, n);
}

/** @param {any} v @returns {number[] | null} */
function vec3(v) {
	return Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => Number.isFinite(Number(x))) ? v.slice(0, 3).map(Number) : null;
}

/** a box from two corners, ordered; null unless both are finite triples @param {any} a @param {any} b */
export function normalizeRuleBounds(a, b) {
	const p = vec3(a);
	const q = vec3(b);
	if (!p || !q) return null;
	return { min: p.map((x, i) => Math.min(x, q[i])), max: p.map((x, i) => Math.max(x, q[i])) };
}

/** @param {number[] | {x: number, y: number, z: number}} p */
const asArr = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

/** is `p` inside the box? (true with no box) @param {any} p @param {{min: number[], max: number[]} | null} box */
export function insideBox(p, box) {
	if (!box) return true;
	const a = asArr(p);
	return a.every((x, i) => x >= box.min[i] - 1e-9 && x <= box.max[i] + 1e-9);
}

/** the nearest point inside the box (the point itself with no box) @param {any} p @param {{min: number[], max: number[]} | null} box */
export function clampToBox(p, box) {
	const a = asArr(p);
	if (!box) return [...a];
	return a.map((x, i) => Math.max(box.min[i], Math.min(box.max[i], x)));
}

const initial = () => ({ reach: null, jump: null, bounds: null });

export default {
	spec,
	initial,
	/** @param {any} raw */
	normalize(raw) {
		return {
			reach: normalizeReach(raw?.reach),
			jump: metres(raw?.jump, 5),
			bounds: raw?.bounds ? normalizeRuleBounds(raw.bounds.min, raw.bounds.max) : null
		};
	},
	ops: {
		/** @param {any} s @param {any[]} args */
		setReach(s, [m]) {
			const reach = normalizeReach(m);
			return reach === s.reach ? { result: { ok: true } } : { slice: { ...s, reach } };
		},
		/** @param {any} s @param {any[]} args */
		setJump(s, [m]) {
			const jump = metres(m, 5);
			return jump === s.jump ? { result: { ok: true } } : { slice: { ...s, jump } };
		},
		/** @param {any} s @param {any[]} args */
		setBounds(s, [min, max]) {
			const bounds = min == null && max == null ? null : normalizeRuleBounds(min, max);
			if (!bounds && (min != null || max != null)) return { result: { ok: false, reason: 'bounds need two finite corners' } };
			return JSON.stringify(bounds) === JSON.stringify(s.bounds) ? { result: { ok: true } } : { slice: { ...s, bounds } };
		},
		/** @param {any} s */
		clearRules(s) {
			return s.reach == null && s.jump == null && s.bounds == null ? { result: { ok: true } } : { slice: initial() };
		}
	},
	/** @param {any} ctx */
	make(ctx) {
		/** the vetoes, in registration order (LOCAL: code, not data) @type {Set<(req: any) => void>} */
		const vetoes = (ctx.local.vetoes ??= new Set());
		const s = () => ctx.slice() ?? initial();
		return {
			/** @param {number} m */
			setReach: (m) => ctx.request('setReach', [m]),
			/** @param {number} m */
			setJump: (m) => ctx.request('setJump', [m]),
			/** @param {number[]} min @param {number[]} max */
			setBounds: (min, max) => ctx.request('setBounds', [min, max]),
			clearRules: () => ctx.request('clearRules', []),
			reach: () => s().reach ?? 0,
			jump: () => s().jump ?? 0,
			on: ctx.on,
			extra: {
				/** set several rules in one call: `{reach?, jump?, bounds?: {min, max} | null}`
				 * (`null` clears that rule; an absent key leaves it) @param {any} rules */
				set(rules) {
					/** @type {any[]} */
					const out = [];
					if (rules && 'reach' in rules) out.push(ctx.request('setReach', [rules.reach ?? 0]));
					if (rules && 'jump' in rules) out.push(ctx.request('setJump', [rules.jump ?? 0]));
					if (rules && 'bounds' in rules) out.push(ctx.request('setBounds', rules.bounds ? [rules.bounds.min, rules.bounds.max] : [null, null]));
					return out;
				},
				/** the rules as the input paths read them: `{reach, jump, bounds}`, null = not set */
				current: () => ({ ...s() }),
				/**
				 * Hear every grab REQUEST before it happens and refuse it: `fn(req)` gets
				 * `{uuid, name, point, distance, reach, hand, refuse(reason)}` (`hand` 'left' | 'right'
				 * in VR, 'desktop' otherwise; `distance` from the body). Runs on the grabbing peer,
				 * possibly every frame while aiming — no side effects but `refuse`. Returns off.
				 * @param {(req: any) => void} fn
				 */
				onGrabRequest(fn) {
					vetoes.add(fn);
					return () => vetoes.delete(fn);
				},
				/**
				 * THE question every grab path asks (playInteract, the VR grip): may this player take
				 * hold of it? Reach first (`reach` = the effective one, the kit's else the scene's), then
				 * the vetoes in order; the first refusal wins. `silent` = a per-frame hover check that
				 * must not emit `refused` (the press itself asks without it).
				 * @param {{point: any, eye: any, feetY: number, reach?: number | null, uuid?: string,
				 *   name?: string, hand?: string, silent?: boolean}} req
				 * @returns {{ok: boolean, reason?: string, distance: number}}
				 */
				checkGrab(req) {
					const point = asArr(req.point);
					const eye = asArr(req.eye);
					const distance = bodyDistance({ x: point[0], y: point[1], z: point[2] }, { x: eye[0], y: eye[1], z: eye[2] }, req.feetY);
					const reach = req.reach === undefined ? s().reach : req.reach;
					/** @type {{ok: boolean, reason?: string, distance: number}} */
					let verdict = { ok: true, distance };
					if (reach != null && distance > reach + 1e-6) verdict = { ok: false, reason: 'Too far — get closer', distance };
					else
						for (const fn of [...vetoes]) {
							/** @type {string | null} */
							let said = null;
							try {
								fn({
									uuid: req.uuid ?? null,
									name: req.name ?? '',
									point,
									distance,
									reach: reach ?? null,
									hand: req.hand ?? 'desktop',
									refuse: (/** @type {any} */ reason) => {
										said ??= String(reason || 'Not now');
									}
								});
							} catch (error) {
								console.warn('kit.rules: a grab veto failed', error);
							}
							if (said) {
								verdict = { ok: false, reason: said, distance };
								break;
							}
						}
					if (!verdict.ok && !req.silent) ctx.emitLocal('refused', { uuid: req.uuid ?? null, reason: verdict.reason, distance, hand: req.hand ?? 'desktop' });
					return verdict;
				},
				/** is a point inside the play bounds? (true with none) @param {any} p */
				inside: (p) => insideBox(p, s().bounds),
				/** the nearest point inside the play bounds @param {any} p */
				clamp: (p) => clampToBox(p, s().bounds)
			}
		};
	}
};
