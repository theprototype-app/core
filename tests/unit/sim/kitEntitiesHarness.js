// 34 R2 (kit-entities): a MINIMAL local logic-sim harness for the kit entities proofs — N fake
// peers, a fake clock, an in-memory ordered wire that runs every message through core's
// validateWireMessage (a message the validator refuses is DROPPED, exactly as peerHandler does).
// It stands in until 34-kit-core's B5 sim (tests/unit/sim/logicSim.js) lands; the entities
// runtime only needs a host adapter, so moving onto that sim is a matter of the adapter.
//
// THE AUTHORITY RULE here is the proposal's fallback (§4.4): the session host while it is
// connected, else the smallest connected peer id — kit/authority.js's job in the app.
import { validateWireMessage } from '../../../src/lib/wireValidate.js';
import { createKitEntities } from '../../../src/lib/kit/entities.js';

/**
 * @param {{peers: string[], host?: string, world?: any, players?: Record<string, number[]>}} opts
 */
export function createKitSim(opts) {
	let t = 0;
	const world = opts.world ?? {};
	/** peer id -> [x, y, z] of that peer's player */
	const players = { ...(opts.players ?? {}) };
	/** @type {Map<string, {id: string, kit: ReturnType<typeof createKitEntities>, inbox: {msg: any, from: string}[], connected: boolean}>} */
	const peers = new Map();
	const host = opts.host ?? opts.peers[0];
	const stats = { sent: 0, refused: 0, requests: 0, bytes: 0 };

	function authorityId() {
		const live = [...peers.values()].filter((p) => p.connected).map((p) => p.id);
		if (live.includes(host)) return host;
		return live.sort()[0] ?? null;
	}

	/** @param {string} from @param {any} msg @param {string | null} [to] */
	function deliver(from, msg, to = null) {
		// the wire: structured clone (no shared references), then the validator
		const copy = JSON.parse(JSON.stringify(msg));
		stats.sent++;
		stats.bytes += JSON.stringify(copy).length;
		if (!validateWireMessage(copy)) {
			stats.refused++;
			return;
		}
		for (const p of peers.values()) {
			if (!p.connected || p.id === from) continue;
			if (to && p.id !== to) continue;
			p.inbox.push({ msg: copy, from });
		}
	}

	/** @param {string} id */
	function addPeer(id) {
		const me = {
			id,
			kit: /** @type {any} */ (null),
			inbox: /** @type {any[]} */ ([]),
			connected: true
		};
		me.kit = createKitEntities({
			now: () => t,
			isAuthority: () => me.connected && authorityId() === id,
			authorityId: () => authorityId(),
			send: (msg) => deliver(id, msg),
			request: (piece, op, args) => {
				stats.requests++;
				const auth = authorityId();
				if (auth) deliver(id, { type: 'kitreq', piece, op, args }, auth);
			},
			resolveTarget: (ref) => {
				if (typeof ref !== 'string') return null;
				if (ref.startsWith('player:')) return players[ref.slice(7)] ?? null;
				return null;
			},
			world: () => world
		});
		peers.set(id, me);
		return me;
	}
	for (const id of opts.peers) addPeer(id);

	/** drain every inbox (ordered per sender, like a DataConnection) */
	function flush() {
		for (let guard = 0; guard < 10; guard++) {
			let any = false;
			for (const p of peers.values()) {
				const box = p.inbox.splice(0);
				for (const { msg, from } of box) {
					any = true;
					if (msg.type === 'kitentity') p.kit.receive(msg, from);
					else if (msg.type === 'kitreq') p.kit.handleRequest(msg.piece, msg.op, msg.args, from);
					else if (msg.type === 'getkitentities') {
						const snap = p.kit.snapshot();
						if (snap) deliver(p.id, snap, from);
					}
				}
			}
			if (!any) return;
		}
	}

	return {
		peers,
		players,
		stats,
		host,
		authorityId,
		now: () => t,
		/** @param {string} id */
		kit: (id) => /** @type {any} */ (peers.get(id)).kit,
		/** advance the clock by dt and tick every connected peer (authority first) */
		/** @param {number} dt */
		step(dt) {
			t += dt;
			const order = [...peers.values()]
				.filter((p) => p.connected)
				.sort((a, b) => (a.id === authorityId() ? -1 : b.id === authorityId() ? 1 : 0));
			for (const p of order) {
				flush();
				p.kit.tick(dt);
			}
			flush();
		},
		/** a peer leaves (host-leaves-mid-wave) @param {string} id */
		drop(id) {
			const p = peers.get(id);
			if (p) {
				p.connected = false;
				p.inbox.length = 0;
			}
		},
		/** a late joiner: a fresh peer that asks the authority for the whole set @param {string} id */
		join(id) {
			const p = addPeer(id);
			const auth = authorityId();
			if (auth) deliver(id, { type: 'getkitentities' }, auth);
			flush();
			return p;
		}
	};
}
