// 34 R3 (D1) — WHAT A BEHAVIOUR CAN LISTEN TO, and the TYPE of what each handler is handed.
//
// A pure LEAF (the kit specs come in as an argument). A handler name in `on` resolves to:
//
//   start              the behaviour's own first run (once per session, on the authority)
//   grabRequest        the kit.rules VETO — asked on the GRABBING peer before a grab happens,
//                      possibly every frame while aiming: read params, call `refuse(reason)`
//   '<piece>.<event>'  any kit event by its spec name ('round.started', 'health.died')
//   <piece><Event>     the same, camel-cased ('roundStarted', 'spawnerEmptied')
//   an alias           the short names the proposal's examples use (roundStart, died, …)
//
// WHERE A HANDLER RUNS: on the authority only (the kit's single writer), except a LOCAL event
// (grabRequest, and spec events marked `local: true` such as rules.refused / score.newBest),
// which runs on the peer it happened to and may only read state.
//
// TYPED PAYLOADS: an entity in a payload arrives as an EntityRef (`id, kind, pos, hp, max, dead,
// tags, data`, plus `is(pattern)` and `hasTag(tag)`); a grab request's `piece` is a PieceRef
// (`uuid, name, point, hasTag(tag), is(pattern)`). PAYLOAD_TYPES is what the derived node view
// draws as the event node's outputs.

/** short names -> [piece, event] (the proposal §4.3 spelling) */
export const ALIASES = {
	roundStart: ['round', 'started'],
	go: ['round', 'go'],
	won: ['round', 'won'],
	lost: ['round', 'lost'],
	paused: ['round', 'paused'],
	resumed: ['round', 'resumed'],
	menu: ['round', 'menu'],
	levelSelected: ['levels', 'selected'],
	scored: ['score', 'scored'],
	collected: ['pickups', 'collected'],
	allCollected: ['pickups', 'allCollected'],
	spawned: ['spawner', 'spawned'],
	despawned: ['spawner', 'despawned'],
	emptied: ['spawner', 'emptied'],
	damaged: ['health', 'damaged'],
	healed: ['health', 'healed'],
	died: ['health', 'died'],
	revived: ['health', 'revived'],
	stuck: ['mover', 'stuck'],
	grabRefused: ['rules', 'refused']
};

/** payload field types per event key (what the derived view shows as outputs) */
export const PAYLOAD_TYPES = {
	start: {},
	grabRequest: { piece: 'piece', hand: 'string', distance: 'number', reach: 'number', point: 'vector3', refuse: 'action' },
	'spawner.spawned': { entity: 'entity' },
	'spawner.despawned': { entity: 'entity' },
	'spawner.emptied': {},
	'health.damaged': { entity: 'entity', amount: 'number', by: 'string' },
	'health.healed': { entity: 'entity', amount: 'number' },
	'health.died': { entity: 'entity', by: 'string' },
	'health.revived': { entity: 'entity' },
	'mover.stuck': { entity: 'entity' },
	'rules.refused': { uuid: 'string', reason: 'string', distance: 'number', hand: 'string' }
};

/** the special (non-kit) events */
export const SPECIAL_EVENTS = {
	start: { label: 'On behaviour start', local: false },
	grabRequest: { label: 'On grab request', local: true }
};

/**
 * Resolve one `on` key against the kit specs.
 * @param {string} name @param {any[]} specs the kit's specs (kit.specs())
 * @returns {{name: string, key: string, piece: string | null, event: string | null, local: boolean,
 *   label: string, payload: Record<string, string>} | null} null = unknown event
 */
export function resolveEvent(name, specs) {
	const special = /** @type {Record<string, {label: string, local: boolean}>} */ (SPECIAL_EVENTS)[name];
	if (special)
		return { name, key: name, piece: null, event: null, local: special.local, label: special.label, payload: { ...(/** @type {any} */ (PAYLOAD_TYPES)[name] ?? {}) } };
	/** @type {[string, string] | null} */
	let pair = null;
	const alias = /** @type {Record<string, [string, string]>} */ (ALIASES)[name];
	if (alias) pair = alias;
	else if (name.includes('.')) {
		const [piece, event] = name.split('.');
		pair = [piece, event];
	} else {
		for (const spec of specs ?? []) {
			if (!name.startsWith(spec.piece) || name.length <= spec.piece.length) continue;
			const rest = name.slice(spec.piece.length);
			const event = rest.charAt(0).toLowerCase() + rest.slice(1);
			if (spec.calls.some((/** @type {any} */ c) => c.kind === 'event' && c.name === event)) {
				pair = [spec.piece, event];
				break;
			}
		}
	}
	if (!pair) return null;
	const spec = (specs ?? []).find((s) => s.piece === pair[0]);
	const call = spec?.calls.find((/** @type {any} */ c) => c.kind === 'event' && c.name === pair[1]);
	if (!call) return null;
	const key = pair[0] + '.' + pair[1];
	return {
		name,
		key,
		piece: pair[0],
		event: pair[1],
		local: !!call.local,
		label: call.label,
		payload: { ...(/** @type {any} */ (PAYLOAD_TYPES)[key] ?? {}) }
	};
}

/** a glob ('Robot*', '*bot', 'Robot') against a string, case-sensitive @param {string} pattern @param {string} s */
export function globMatch(pattern, s) {
	const p = String(pattern ?? '');
	if (!p.includes('*')) return p === String(s ?? '');
	const re = new RegExp('^' + p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
	return re.test(String(s ?? ''));
}

/** an entity view (kit/entityCore.js entityView) -> an EntityRef @param {any} e */
export function entityRef(e) {
	if (!e || typeof e !== 'object') return e;
	const tags = Array.isArray(e.tags) ? e.tags : [];
	return {
		...e,
		/** kind (or tag) matches a glob @param {string} pattern */
		is: (pattern) => globMatch(pattern, e.kind) || tags.some((/** @type {string} */ t) => globMatch(pattern, t)),
		/** @param {string} tag */
		hasTag: (tag) => tags.includes(tag)
	};
}

/** a grab request (kit.rules' veto argument) -> the handler payload @param {any} req
 * @param {(uuid: string) => string[]} [tagsOf] the piece's tags (the app reads userData tags) */
export function grabPayload(req, tagsOf) {
	const tags = (req?.uuid && tagsOf?.(req.uuid)) || [];
	const name = String(req?.name ?? '');
	return {
		piece: {
			uuid: req?.uuid ?? null,
			name,
			point: req?.point ?? null,
			tags,
			/** @param {string} tag */
			hasTag: (tag) => tags.includes(tag),
			/** the piece's name (or a tag) matches a glob @param {string} pattern */
			is: (pattern) => globMatch(pattern, name) || tags.some((/** @type {string} */ t) => globMatch(pattern, t))
		},
		hand: req?.hand ?? 'desktop',
		distance: Number(req?.distance) || 0,
		reach: req?.reach ?? null,
		point: req?.point ?? null,
		refuse: req?.refuse
	};
}

/** a kit payload -> the handler payload (entities become EntityRefs) @param {any} payload */
export function kitPayload(payload) {
	if (!payload || typeof payload !== 'object') return payload ?? {};
	return payload.entity ? { ...payload, entity: entityRef(payload.entity) } : { ...payload };
}
