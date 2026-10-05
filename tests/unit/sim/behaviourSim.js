// 34 R3 (D1) — BEHAVIOURS ON THE HEADLESS LOGIC SIM (kit-core's logicSim.js, proposal B5).
//
// Every fake peer gets the REAL behaviour runtime (src/lib/behaviours/core.js) over the same
// host the app builds: the peer's kit authority, the sim clock, the in-memory wire (every `bhv`
// message goes through the app's validateWireMessage), and the peer's own kit as the handlers'
// `kit`. A behaviour FILE is compiled on every peer separately (source.js, a data: URL instead of
// the app's blob — the same text), exactly as each browser evaluates it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSim } from './logicSim.js';
import { createBehaviourRuntime, BHV } from '../../../src/lib/behaviours/core.js';
import { compileBehaviour, dataUrlImporter } from '../../../src/lib/behaviours/source.js';
import { pickAuthority } from '../../../src/lib/kit/authority.js';

/** a file under static/behaviours @param {string} name */
export function exampleSource(name) {
	return readFileSync(fileURLToPath(new URL('../../../static/behaviours/' + name, import.meta.url)), 'utf8');
}

/**
 * @param {Parameters<typeof createSim>[0] & {objects?: {uuid: string, name: string, pos: number[], tags?: string[]}[]}} [opts]
 */
export function createBehaviourSim(opts = {}) {
	const objects = opts.objects ?? [];
	/** id -> source, so a joiner compiles what everyone runs @type {Map<string, string>} */
	const sources = new Map();
	const glob = (/** @type {string} */ p, /** @type {string} */ s) =>
		new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(s);
	/** @param {any} p @param {any} sim */
	const attach = (p, sim) => {
		const isAuthority = () =>
			pickAuthority({ me: p.id, peers: [...p.connected], host: sim.host, initiator: sim.initiator }) === p.id;
		/** per behaviour id: its kit face + teardown list, kept across source edits (the app keeps
		 * ONE module per behaviour; an edit swaps the definition, unloading is removal) */
		/** @type {Map<string, {face: any, list: (() => void)[]}>} */
		const modules = new Map();
		let lastSize = -1;
		let lastConnectAt = 0;
		p.bhv = createBehaviourRuntime({
			me: () => p.id,
			now: () => sim.now(),
			isAuthority,
			send: (msg) => p.send(msg),
			specs: () => p.kit.specs(),
			peerCount: () => p.connected.size,
			lastPeerChange: () => lastConnectAt,
			tagsOf: (uuid) => objects.find((o) => o.uuid === uuid)?.tags ?? [],
			findObjects: (pattern) =>
				objects
					.filter((o) => glob(pattern, o.name) || (o.tags ?? []).some((t) => glob(pattern, t)))
					.map((o) => ({ uuid: o.uuid, name: o.name, pos: [...o.pos], tags: [...(o.tags ?? [])] })),
			warn: (msg) => (p.warnings ??= []).push(msg),
			// 36 (U10): what `this.emit(name)` asks the app to pulse, recorded per peer
			emit: (id, name, payload) => (p.emits ??= []).push({ id, name, payload, at: sim.now() })
		});
		/** load (or reload, with new source) a behaviour file on THIS peer @param {string} id @param {string} source */
		p.loadBehaviour = async (id, source) => {
			let mod = modules.get(id);
			if (!mod) {
				const list = /** @type {(() => void)[]} */ ([]);
				mod = { list, face: p.kit.api({ onDispose: (/** @type {() => void} */ fn) => list.push(fn), moduleId: 'behaviour:' + id }) };
				modules.set(id, mod);
			}
			const { def, scope } = await compileBehaviour(source, dataUrlImporter);
			const inst = p.bhv.start(id, def, { name: def.name ?? id, kit: mod.face, resetGuard: () => scope.scope.resetGuard?.() });
			scope.bind(inst.ctx.kit);
			p.bhv.loaded(id); // 36 (U10): on.load, every peer
			mod.list.push(() => scope.dispose());
			return inst;
		};
		/** remove a behaviour from this peer (its module unloads: listeners, owned entities) @param {string} id */
		p.unloadBehaviour = (id) => {
			p.bhv.forget(id);
			for (const fn of (modules.get(id)?.list ?? []).reverse()) fn();
			modules.delete(id);
			// what behaviours/app.js does: the authority NOW drops the behaviour's entities
			p.kit.impls.spawner?.disown?.('behaviour:' + id);
		};
		const track = () => {
			if (p.connected.size !== lastSize) {
				lastSize = p.connected.size;
				lastConnectAt = sim.now();
			}
		};
		p.extra = {
			receive: (/** @type {any} */ msg) => {
				track();
				return msg?.type === BHV ? (p.bhv.receive(msg), true) : false;
			},
			tick: () => {
				track();
				p.bhv.tick();
			},
			snapshot: () => p.bhv.snapshot()
		};
	};
	const sim = /** @type {any} */ (createSim({ ...opts, onPeer: attach }));
	/** compile + start a behaviour on every peer @param {string} id @param {string} source */
	sim.load = async (id, source) => {
		sources.set(id, source);
		for (const p of sim.peers.values()) await p.loadBehaviour(id, source);
	};
	/** a joiner arrives and loads what everyone runs (the app: getnodes, then the watcher) @param {string} id */
	sim.joinWithBehaviours = async (id) => {
		const p = sim.join(id);
		for (const [bid, src] of sources) await p.loadBehaviour(bid, src);
		return p;
	};
	/** every peer's view of a behaviour's state */
	sim.states = (/** @type {string} */ id) => [...sim.peers.values()].map((p) => JSON.stringify(p.bhv.live(id)?.state ?? null));
	sim.authorityPeer = () => [...sim.peers.values()].find((p) => pickAuthority({ me: p.id, peers: [...p.connected], host: sim.host, initiator: sim.initiator }) === p.id);
	return sim;
}
