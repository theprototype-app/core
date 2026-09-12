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
	return isFiniteArray(v, 3) || isFiniteArray(v, 4);
}

/** @param {unknown} v */
export function isArray(v) {
	return Array.isArray(v);
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

/**
 * Per-type shape tests. ABSENT MEANS ALLOW — see the header. Deliberately shallow: this
 * is the difference between "will this throw inside an applier" and "is this message
 * semantically right", and only the first is the dispatcher's business.
 * @type {Record<string, (data: any) => boolean>}
 */
export const VALIDATORS = {
	hosts: (d) => isArray(d.hosts),
	userdata: (d) => isArray(d.userdata),
	locked: (d) => isArray(d.lockeditems),
	lock: (d) => isUuid(d.uuid) && (d.uuids === undefined || isArray(d.uuids)),
	unlock: (d) => d.peerId === undefined || typeof d.peerId === 'string',
	clearscene: (d) => typeof d.peerId === 'string',
	delete: (d) => isUuid(d.uuid),
	name: (d) => isUuid(d.uuid) && typeof d.name === 'string',
	move: (d) => isUuid(d.uuid) && isVec3(d.pos) && isQuatOrEuler(d.rot) && isVec3(d.scale),
	throw: (d) => isUuid(d.uuid),
	simulate: (d) => typeof d.running === 'boolean' || typeof d.paused === 'boolean',
	loading: (d) => isArray(d.uuids),
	object: (d) => d.element !== undefined,
	group: (d) => d.uuid !== undefined,
	duplicate: (d) => isUuid(d.sourceUuid) && isArray(d.uuids),
	nodes: (d) => isArray(d.nodes) && isArray(d.edges),
	nodesync: (d) => typeof d.hash === 'string' && typeof d.count === 'number',
	nodecreate: (d) => !!d.node && typeof d.node === 'object',
	nodedata: (d) => typeof d.id === 'string' && !!d.data && typeof d.data === 'object',
	nodedelete: (d) => isArray(d.ids),
	edgecreate: (d) => !!d.edge && typeof d.edge === 'object',
	edgedelete: (d) => isArray(d.ids),
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
	camera: (d) => typeof d.peerId === 'string' && isVec3(d.position) && isFiniteArray(d.rotation, 3)
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
