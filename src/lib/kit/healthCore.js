// 34 R2 (kit-entities) — kit.health, THE PURE HALF: hit points on a kit entity.
//
// PROMOTED FROM THE `health` MODULE (modules/health, 1281 LOC), keeping what it learned and
// dropping what only existed because a module had no state of its own:
//  - the module derived object hp as `max - (hits - heals)` from two core Counter nodes, because
//    it had nowhere else to keep a number every peer agrees on. A kit entity HAS a replicated
//    record (the `kitentity` wire), so hp is just a field and the authority writes it;
//  - the OVERKILL guard stays (damage to a dead entity is dropped — the module's engine.js:163);
//  - regen stays a pure function of a stamp, never a stored tick (ledger.js:72's rule), folded
//    into the base on every write so a later read cannot double count;
//  - death is an EVENT with the entity as payload (the per-enemy chains in Waves' graph: 21
//    counter + 12 damage + 11 health + 11 healthreset + 10 heal nodes, now one field).
//
// A ZERO-IMPORT LEAF. Times are seconds on whatever clock the caller uses (the kit uses the
// session clock, so two peers agree on a regen read).

/** a fresh health block @param {{max?: number, hp?: number, regen?: number, armor?: number}} [o] */
export function createHealth(o = {}) {
	const max = clampNum(o.max, 1, 1e6, 100);
	return {
		max,
		hp: clampNum(o.hp, 0, max, max),
		/** hp per second, applied lazily from `at` */
		regen: clampNum(o.regen, 0, 1e4, 0),
		/** flat reduction per hit (never below 0) */
		armor: clampNum(o.armor, 0, 1e6, 0),
		/** the time `hp` was last folded (regen counts from here) */
		at: 0,
		dead: false,
		diedAt: -1,
		/** who dealt the last damage (peer id / entity id / any short string) */
		by: '',
		hits: 0
	};
}

/** @param {any} v @param {number} min @param {number} max @param {number} fallback */
function clampNum(v, min, max, fallback) {
	const n = Number(v);
	if (v === undefined || v === null || !Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** current hp at time t (regen included, never above max; a dead entity does not regen)
 * @param {any} h @param {number} t */
export function hpAt(h, t) {
	if (!h) return 0;
	if (h.dead || !h.regen) return h.hp;
	const dt = Math.max(0, t - h.at);
	return Math.min(h.max, h.hp + h.regen * dt);
}

/** fold regen into the base before a write @param {any} h @param {number} t */
function fold(h, t) {
	h.hp = hpAt(h, t);
	h.at = t;
}

/**
 * Apply damage. Returns what happened: `{applied, died}` (applied = hp actually removed). A dead
 * entity takes nothing (the overkill guard); a non-finite or negative amount is refused.
 * @param {any} h @param {number} amount @param {number} t @param {string} [by]
 * @returns {{applied: number, died: boolean}}
 */
export function damage(h, amount, t, by = '') {
	const a = Number(amount);
	if (!h || h.dead || !Number.isFinite(a) || a <= 0) return { applied: 0, died: false };
	fold(h, t);
	const dealt = Math.min(h.hp, Math.max(0, a - h.armor));
	h.hp -= dealt;
	h.hits++;
	h.by = String(by ?? '').slice(0, 64);
	if (h.hp <= 1e-9) {
		h.hp = 0;
		h.dead = true;
		h.diedAt = t;
		return { applied: dealt, died: true };
	}
	return { applied: dealt, died: false };
}

/** heal (never above max, never a dead entity — that is `revive`) @param {any} h @param {number} amount @param {number} t
 * @returns {number} hp restored */
export function heal(h, amount, t) {
	const a = Number(amount);
	if (!h || h.dead || !Number.isFinite(a) || a <= 0) return 0;
	fold(h, t);
	const before = h.hp;
	h.hp = Math.min(h.max, h.hp + a);
	return h.hp - before;
}

/** back to life at `hp` (default full) @param {any} h @param {number} t @param {number} [hp] */
export function revive(h, t, hp) {
	if (!h) return;
	h.dead = false;
	h.diedAt = -1;
	h.hp = clampNum(hp, 1, h.max, h.max);
	h.at = t;
	h.by = '';
}

/** 0..1 of max @param {any} h @param {number} t */
export function fraction(h, t) {
	return h && h.max > 0 ? hpAt(h, t) / h.max : 0;
}
