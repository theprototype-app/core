// 27-A (hardening audit H1 + M7) — WHAT A MESSAGE MUST LOOK LIKE BEFORE IT IS APPLIED.
//
// The dispatcher trusted every payload's SHAPE. `data.hosts.forEach`, `data.forEach` in
// the userdata applier, `lockeditems.filter`, `moveGeometry(data.pos[0], …)` — each one
// throws on a malformed message, and the dispatcher had no try/catch, so ONE bad message
// from ONE peer took down that connection's entire handler. The A1 comment in
// commandsHandler already records an instance of exactly that ("one stray message takes
// the whole connection handler down").
//
// A ZERO-IMPORT LEAF, so the dispatcher can validate before touching any applier, and so
// this is unit-testable with no browser, no peer and no scene.
//
// THE RULE THAT KEEPS IT ADDITIVE: an ABSENT entry means ALLOW. A peer one release ahead
// sends types this table has never heard of, and the correct answer to "I do not know
// this message" is to pass it to a dispatcher that counts it as unknown — never to
// reject it on shape. So this table only ever describes types we DO know, and a new
// message type needs no entry to work.
//
// NaN IS THE OTHER HALF. A non-finite transform is worse than a malformed one: it applies
// cleanly, poisons the object's matrix, and from there every consumer that measures the
// scene (Box3 for bounds, frame-to-fit, the physics body's next step) reads NaN forever
// with nothing pointing back at the message that did it.

/** @param {unknown} v */
export function isUuid(v) {
	return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

/** Every element finite, exactly `n` of them. @param {unknown} v @param {number} n */
export function isFiniteArray(v, n) {
	return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** @param {unknown} v */
export function isVec3(v) {
	return isFiniteArray(v, 3);
}

/** A rotation on the wire is an Euler triple or a quaternion. @param {unknown} v */
export function isQuatOrEuler(v) {
	return isFiniteArray(v, 3) || isFiniteArray(v, 4) || isEulerWithOrder(v);
}

/**
 * three's `Euler.toArray()` is `[x, y, z, order]` — the shape the gizmo, the Explorer drop,
 * the Inspector and a dozen other senders put on the wire. The appliers read [0..2] only, so
 * refusing it dropped every one of those moves on the receiving peer (`invalid:move`).
 * @param {unknown} v
 */
export function isEulerWithOrder(v) {
	return Array.isArray(v) && v.length === 4 && isFiniteArray(v.slice(0, 3), 3) && typeof v[3] === 'string' && /^[XYZ]{3}$/.test(v[3]);
}

/** @param {unknown} v */
export function isArray(v) {
	return Array.isArray(v);
}

/** Every element a finite number (any length). @param {unknown} v */
export function isNumberArray(v) {
	return Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Keep a transform APPLICABLE: every non-finite component falls back to the value the
 * object already has, so a partly-broken message moves what it can and poisons nothing.
 * Returns null when there is nothing usable at all, so the caller can skip the write.
 * @param {any} pos @param {any} rot @param {any} scale
 * @param {{pos: number[], rot: number[], scale: number[]}} current
 * @returns {{pos: number[], rot: number[], scale: number[], repaired: boolean} | null}
 */
export function sanitizeTransform(pos, rot, scale, current) {
	if (!Array.isArray(pos) && !Array.isArray(rot) && !Array.isArray(scale)) return null;
	let repaired = false;
	/** @param {any} src @param {number[]} fallback @param {number} n */
	const fix = (src, fallback, n) => {
		/** @type {number[]} */
		const out = [];
		for (let i = 0; i < n; i++) {
			const v = Array.isArray(src) ? src[i] : undefined;
			if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
			else {
				out.push(fallback[i] ?? 0);
				repaired = true;
			}
		}
		return out;
	};
	return {
		pos: fix(pos, current.pos, 3),
		rot: fix(rot, current.rot, 3),
		scale: fix(scale, current.scale, 3),
		repaired
	};
}

/** 34 R2: a finite number @param {unknown} v */
function isNum(v) {
	return typeof v === 'number' && Number.isFinite(v);
}

/** 34 R2: the most rows one `kitentity` message may carry (the kit's entity ceiling, 200, + slack) */
export const KIT_ENTITY_MAX_ROWS = 256;

/**
 * 34 R2: one full kit entity record. Its pose and hp are applied the moment it lands (a NaN
 * would park an enemy at NaN forever, the move rule), and its tags / data are bounded so one
 * message cannot carry a megabyte of junk per entity.
 * @param {any} r
 */
export function isKitEntityRecord(r) {
	if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
	if (
		!isUuid(r.id) ||
		!isVec3(r.pos) ||
		!isNum(r.yaw) ||
		!isNum(r.hp) ||
		!isNum(r.max) ||
		typeof r.dead !== 'boolean'
	)
		return false;
	for (const k of ['kind', 'tpl', 'own'])
		if (r[k] !== undefined && (typeof r[k] !== 'string' || r[k].length > 64)) return false;
	if (r.regen !== undefined && !isNum(r.regen)) return false;
	if (r.born !== undefined && !isNum(r.born)) return false;
	if (r.rm !== undefined && !isNum(r.rm)) return false;
	if (
		r.tags !== undefined &&
		!(
			isArray(r.tags) &&
			r.tags.length <= 16 &&
			r.tags.every((/** @type {any} */ t) => typeof t === 'string' && t.length <= 32)
		)
	)
		return false;
	if (r.data !== undefined) {
		if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) return false;
		if (JSON.stringify(r.data).length > 2048) return false;
	}
	if (r.mv !== undefined && (!r.mv || typeof r.mv !== 'object')) return false;
	return true;
}

/** 34 R2: one compact pose row `[id, x, y, z, yaw, hp, flags]` @param {any} row */
export function isKitEntityRow(row) {
	return isArray(row) && row.length === 7 && isUuid(row[0]) && row.slice(1).every(isNum);
}

/**
 * Per-type shape tests. ABSENT MEANS ALLOW — see the header. Deliberately shallow: this
 * is the difference between "will this throw inside an applier" and "is this message
 * semantically right", and only the first is the dispatcher's business.
 * @type {Record<string, (data: any) => boolean>}
 */
export const VALIDATORS = {
	hosts: (d) => isArray(d.hosts),
	// 37 R15: a chat history reply — a bounded list (each entry is checked again on merge)
	chathistory: (d) => isArray(d.messages) && d.messages.length <= 500,
	userdata: (d) => isArray(d.userdata),
	locked: (d) => isArray(d.lockeditems),
	lock: (d) => isUuid(d.uuid) && (d.uuids === undefined || isArray(d.uuids)),
	unlock: (d) => d.peerId === undefined || typeof d.peerId === 'string',
	clearscene: (d) => typeof d.peerId === 'string',
	delete: (d) => isUuid(d.uuid),
	name: (d) => isUuid(d.uuid) && typeof d.name === 'string',
	move: (d) => isUuid(d.uuid) && isVec3(d.pos) && isQuatOrEuler(d.rot) && isVec3(d.scale),
	throw: (d) => isUuid(d.uuid),
	// 24-A: a knock. The velocities are applied to a body the moment this lands, so the
	// triples are checked here rather than trusted by `applyHit`.
	hit: (d) => isUuid(d.uuid) && isArray(d.linvel) && isArray(d.angvel) && typeof d.speed === 'number',
	// P2: a peer's LOOK presence row. `overrides` and `look` are read as objects the moment
	// this lands, so a malformed row is dropped here rather than breaking the watch chain.
	lookstate: (d) => typeof d.peerId === 'string' && (d.overrides === undefined || typeof d.overrides === 'object'),
	simulate: (d) => typeof d.running === 'boolean' || typeof d.paused === 'boolean',
	loading: (d) => isArray(d.uuids),
	object: (d) => d.element !== undefined,
	group: (d) => d.uuid !== undefined,
	duplicate: (d) => isUuid(d.sourceUuid) && isArray(d.uuids),
	nodes: (d) => isArray(d.nodes) && isArray(d.edges),
	// 36-sim (found proving B2): graphHash() returns a NUMBER (djb2 >>> 0). Requiring a string
	// rejected EVERY nodesync since 27-A, so graph drift between peers was never noticed.
	nodesync: (d) => (typeof d.hash === 'string' || Number.isFinite(d.hash)) && typeof d.count === 'number',
	nodecreate: (d) => !!d.node && typeof d.node === 'object',
	nodedata: (d) => typeof d.id === 'string' && !!d.data && typeof d.data === 'object',
	nodedelete: (d) => isArray(d.ids),
	edgecreate: (d) => !!d.edge && typeof d.edge === 'object',
	edgedelete: (d) => isArray(d.ids),
	// 31: a pulse, and (the clap) WHERE it happened — the point is read as a place the moment it
	// lands, so a non-finite one would plant a star at NaN; absent is every pre-31 trigger
	nodetrigger: (d) =>
		typeof d.id === 'string' &&
		(d.at === undefined || d.at === null || isVec3(d.at)) &&
		// 36 X6: a contact's OTHER body (a uuid, '' = the ground); older peers ignore it
		(d.other === undefined || d.other === null || d.other === '' || isUuid(d.other)),
	nodedefs: (d) => isArray(d.defs),
	verts: (d) => isUuid(d.uuid) && isArray(d.indices),
	meshgeo: (d) => isUuid(d.uuid) && d.positions !== undefined,
	assetstart: (d) => typeof d.hash === 'string' && typeof d.chunks === 'number' && typeof d.size === 'number',
	assetchunk: (d) => typeof d.hash === 'string' && Number.isInteger(d.seq),
	assetfile: (d) => typeof d.hash === 'string',
	manifest: (d) => !!d.manifest && typeof d.manifest === 'object',
	environment: (d) => !!d && typeof d === 'object',
	atscene: (d) => typeof d.peerId === 'string',
	disconnected: (d) => typeof d.peerId === 'string',
	annotations: (d) => isArray(d.annotations),
	joints: (d) => isArray(d.joints),
	triggers: (d) => !!d.triggers && typeof d.triggers === 'object',
	peervars: (d) => typeof d.peerId === 'string',
	playmode: (d) => typeof d.peerId === 'string',
	// 33 P2: a functional pack item was triggered (a door opened). The state is evaluated
	// as a POSE every frame, so a non-finite stamp would put a door at NaN forever.
	behavior: (d) =>
		isUuid(d.uuid) &&
		typeof d.on === 'boolean' &&
		Number.isFinite(d.at) &&
		Number.isFinite(d.from) &&
		Number.isInteger(d.n) &&
		d.n >= 0,
	// 34 R2 (T3): the game kit's ONE document (written by the authority peer only) and a
	// request to it. The slices are read as objects and the stamps compared as numbers the
	// moment a document lands, so a malformed one is dropped here rather than poisoning the
	// latest-wins order; what a slice HOLDS is each piece's own normalize's business.
	kit: (d) =>
		!!d.doc &&
		typeof d.doc === 'object' &&
		Number.isFinite(d.doc.rev) &&
		Number.isFinite(d.doc.at) &&
		isArray(d.doc.rids) &&
		!!d.doc.slices &&
		typeof d.doc.slices === 'object' &&
		!Array.isArray(d.doc.slices) &&
		(d.ev === undefined || isArray(d.ev)),
	kitreq: (d) =>
		typeof d.rid === 'string' &&
		d.rid.length > 0 &&
		d.rid.length <= 128 &&
		typeof d.piece === 'string' &&
		typeof d.op === 'string' &&
		isArray(d.args),
	// 34 R3 (D1): a behaviour's replicated document — written by the authority peer only,
	// latest-wins on (at, rev, by). The state is the behaviour's own JSON (its handlers read it);
	// the stamps are compared and the timers fired by the next authority, so those are checked
	// 36 (U10): the id is the behaviour NODE's id — an editor-made node's is a uuid, a game
	// template's is a short authored name ('rules'), so any short string is accepted
	bhv: (d) =>
		typeof d.id === 'string' &&
		d.id.length > 0 &&
		d.id.length <= 128 &&
		(d.inputs === undefined || (!!d.inputs && typeof d.inputs === 'object' && !Array.isArray(d.inputs))) &&
		Number.isFinite(d.rev) &&
		Number.isFinite(d.at) &&
		typeof d.by === 'string' &&
		!!d.state &&
		typeof d.state === 'object' &&
		!Array.isArray(d.state) &&
		typeof d.started === 'boolean' &&
		Number.isFinite(d.seq) &&
		isArray(d.timers) &&
		d.timers.length <= 64 &&
		d.timers.every(
			(/** @type {any} */ t) => !!t && typeof t.k === 'string' && Number.isFinite(t.at) && typeof t.m === 'string' && isArray(t.a)
		) &&
		(d.fired === undefined || (!!d.fired && typeof d.fired === 'object' && !Array.isArray(d.fired))),
	camera: (d) => typeof d.peerId === 'string' && isVec3(d.position) && isFiniteArray(d.rotation, 3),
	// 34 R2 (kit-entities): the ONE wire type kit entities replicate on — written by the
	// authority peer only (the applier refuses anyone else), applied straight into poses and
	// hit points, so every row is checked here: finite numbers, bounded counts, bounded strings
	kitentity: (d) =>
		Number.isInteger(d.seq) &&
		d.seq >= 0 &&
		isNum(d.at) &&
		(d.snap === undefined || typeof d.snap === 'boolean') &&
		(d.put === undefined ||
			(isArray(d.put) && d.put.length <= KIT_ENTITY_MAX_ROWS && d.put.every(isKitEntityRecord))) &&
		(d.upd === undefined ||
			(isArray(d.upd) && d.upd.length <= KIT_ENTITY_MAX_ROWS && d.upd.every(isKitEntityRow))) &&
		(d.del === undefined ||
			(isArray(d.del) && d.del.length <= KIT_ENTITY_MAX_ROWS && d.del.every(isUuid))),
	// 34 PF (profiler-xr): the live perf stream. The packed columns are read as numbers into a
	// recording on arrival, so a frames batch must be finite numbers in whole frames; a capture
	// is read as an object list. Ops this build does not know pass (a newer peer's addition).
	perflive: (d) => {
		if (typeof d.op !== 'string') return false;
		if (d.op === 'watch') return d.mode === 'light' || d.mode === 'detailed';
		if (d.op === 'frames')
			return (
				Number.isFinite(d.base) &&
				Number.isFinite(d.t0) &&
				isNumberArray(d.f) &&
				d.f.length % 5 === 0 &&
				d.f.length <= 5 * 4096 &&
				(d.c === undefined || (isNumberArray(d.c) && d.c.length === (d.f.length / 5) * 6)) &&
				(d.ev === undefined || isArray(d.ev))
			);
		if (d.op === 'capture') return Number.isFinite(d.base) && Number.isFinite(d.t) && !!d.cap && typeof d.cap === 'object' && isArray(d.cap.objects);
		if (d.op === 'hello') return Number.isFinite(d.base) && !!d.meta && typeof d.meta === 'object';
		return true;
	},
	// 33: only the `lod` parameter is constrained (every other parameter predates this entry
	// and keeps "absent means allow"): a block is an object with a levels ARRAY, or null
	// 36-water: `water` / `bubbles` are a plain object or null (the appliers spread nothing
	// else onto userData)
	objectParameters: (d) => {
		if (d.parameter === 'lod') return isUuid(d.uuid) && (d.lod === null || (!!d.lod && typeof d.lod === 'object' && isArray(d.lod.levels)));
		if (d.parameter === 'water' || d.parameter === 'bubbles' || d.parameter === 'pour') {
			const v = d[d.parameter];
			return isUuid(d.uuid) && (v === null || (!!v && typeof v === 'object' && !isArray(v)));
		}
		return true;
	}
};

/**
 * @param {any} data a message already known to be a non-null object with a `type`
 * @returns {boolean} true when it is safe to hand to the appliers
 */
export function validateWireMessage(data) {
	const check = VALIDATORS[data.type];
	if (!check) return true; // unknown to this table = a newer peer's type = allow
	try {
		return !!check(data);
	} catch {
		// a validator that throws on a hostile shape is itself a rejection
		return false;
	}
}
