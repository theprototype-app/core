// Roadmap 55 A2 — THE BEHAVIOUR OF `window.tpAgent`, with every app dependency handed in. Imports
// NOTHING (the unit layer's entry rule), so each method is tested against fakes; tpAgent.js wires the
// real stores.
//
// The rules this file owns (test flight 2, roadmap 55 § T):
//   · T1 — a VIEWER's edit is REFUSED with a reason, never run: on a cloud build a viewer's create
//     stays on its own page, which reported `created` while nobody else saw it.
//   · one exec = ONE undo step (a history batch around the call), and execs run one at a time, so
//     two pipelined calls can never interleave inside one batch.
//   · T2 — a question the app asks with buttons (an admin offer, a share-or-stash fork) is kept as
//     an OFFER until answered; the toast that showed it may expire, the offer does not.
//   · T10 — tools() is the assistant's own list with FULL JSON schemas, plus the agent-only tools.
//   · the agent's own exec never wakes its own waitForEdit.

import { TP_AGENT_VERSION } from './contract.js';

/** Tools that change nothing in the shared scene, so a viewer may run them. */
export const READ_ONLY_TOOLS = new Set(['list_scene']);

/** Longest waitForEdit (ms). */
export const MAX_WAIT_MS = 10 * 60 * 1000;
/** Default waitForEdit (ms). */
export const DEFAULT_WAIT_MS = 30 * 1000;
/** An offer nobody answered is dropped after this long (ms). */
export const OFFER_TTL_MS = 10 * 60 * 1000;
/** Plain notices kept for status(). */
export const NOTICE_COUNT = 10;

/** The words an agent reads when its edit is refused. @param {string|null} peerId */
export function viewerRefusal(peerId) {
	return (
		'View-only: this agent joined as a viewer, so an edit would stay on this page and nobody else would see it. ' +
		'Ask the host to give ' +
		(peerId ? peerId.toUpperCase() : 'this peer') +
		' edit access (Users ▸ role), or join with an invite link that grants edit.'
	);
}

/**
 * 1.2 (41): the words an agent reads while its host is gone and no person is here.
 * @param {{host: string, until: number, expired: boolean}} away
 */
export function hostAwayRefusal(away) {
	const who = away.host ? away.host.slice(0, 6).toUpperCase() : 'The host';
	return (
		who + ' (the host) left and nobody else is in the session, so this agent is paused: an edit would reach nobody. ' +
		(away.expired
			? 'It waited and they did not come back — leave(), or join again with a new invite.'
			: 'It waits for them until ' + new Date(away.until).toISOString().slice(11, 16) + ' UTC and rejoins when they let it back in; check status().hostAway.')
	);
}

/**
 * 55 owner finding 1: the words an agent reads when the HOST is in another scene. Its edits would land
 * in a room the host left — the two demos nobody saw — so they are refused until it is with them again.
 * @param {string} hostScene @param {boolean} following
 */
export function leftBehindRefusal(hostScene, following) {
	const where = hostScene ? '"' + hostScene + '"' : 'another scene';
	return (
		'The host is now in ' + where + ', and this agent is still in the scene they left, so an edit here would not reach them. ' +
		(following ? 'Following them there now — check status().withHost and try again in a few seconds.' : 'Wait for status().withHost (the host can bring you along with Go to), or ask them which scene to build in.')
	);
}

/**
 * The tool's name, whatever schema shape it arrives in.
 * @param {any} tool @returns {string}
 */
export function toolName(tool) {
	return String(tool?.function?.name ?? tool?.name ?? '');
}

/**
 * @typedef {object} AgentDeps
 * @property {string} [appVersion]
 * @property {() => any[]} getTools the assistant's tool list (getAiTools)
 * @property {(name: string, args: any) => Promise<any>|any} runTool executeAiTool
 * @property {(name: string, args: any) => {name: string}} [resolveName] repairToolCall
 * @property {() => string} systemPrompt
 * @property {(cap: number) => any} summarize summarizeScene
 * @property {() => void} beginBatch
 * @property {(label: string) => void} endBatch
 * @property {() => string|null} peerId
 * @property {() => string|null} role 'admin'|'editor'|'viewer' or null (no roles in this build)
 * @property {() => boolean} [rolesSettled] false while a roles plugin still waits for the host's map (absent = settled)
 * @property {() => string|null} host
 * @property {() => {name: string, where: string, message: string}[]} [behaviourErrors] 1.2: the scene's failing behaviours
 * @property {() => {arrived: number, total: number} | null} [loading] 1.2: a scene still arriving (null = none)
 * @property {() => {host: string, since: number, until: number, expired: boolean} | null} [hostAway] 1.2: the host left
 *   and no person is here: paused (null = a host is here)
 * @property {() => {scene: string, hostScene: string, withHost: boolean, following: boolean} | null} [room] 55 owner
 *   finding 1: our scene, the host's, and whether we stand in the same room (absent/null = not known: allowed)
 * @property {() => boolean} waiting
 * @property {() => {id: string, name: string}[]} openPeers
 * @property {() => boolean} inVR
 * @property {() => {name: string, reason: string}[]} missingTools
 * @property {() => any[]} missingModules
 * @property {(cb: () => void) => () => void} onSceneChange
 * @property {(opts: any) => Promise<string|null>} screenshot
 * @property {() => Promise<void>} leave
 * @property {Record<string, {schema: any, run: (args: any) => Promise<any>|any}>} [extraTools]
 *   agent-only tools (run locally, never batched — they change no shared scene state)
 * @property {() => number} [now]
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(t: any) => void} [clearTimer]
 */

/**
 * The offers registry: actions the app put in front of a person, kept until answered.
 * @param {() => number} now
 */
export function createOffers(now) {
	/** @type {Map<string, {id: string, key: any, text: string, actions: {label: string, action: () => void}[], at: number, onAnswer?: () => void}>} */
	const offers = new Map();
	let seq = 0;
	/** key (a toast's own id, or the toast object) -> offer id */
	const byKey = new Map();
	return {
		/**
		 * Record (or refresh) one offer. Same key = the same question asked again with new words.
		 * @param {any} key @param {string} text @param {{label: string, action: () => void}[]} actions
		 * @param {() => void} [onAnswer] called after a button is pressed (e.g. remove the toast)
		 */
		put(key, text, actions, onAnswer) {
			const known = byKey.get(key);
			const id = known ?? 'o' + ++seq;
			const prev = offers.get(id);
			offers.set(id, { id, key, text: String(text ?? ''), actions: actions.slice(), at: prev?.at ?? now(), onAnswer });
			byKey.set(key, id);
			return id;
		},
		/** the app withdrew the question (a state-mirrored card went away) @param {any} key */
		withdraw(key) {
			const id = byKey.get(key);
			if (id) offers.delete(id);
			byKey.delete(key);
		},
		/** @returns {import('./contract.js').TpAgentOffer[]} */
		list() {
			const t = now();
			for (const [id, o] of offers)
				if (t - o.at > OFFER_TTL_MS) {
					offers.delete(id);
					byKey.delete(o.key);
				}
			return [...offers.values()].map((o) => ({ id: o.id, text: o.text, actions: o.actions.map((a) => a.label), at: o.at }));
		},
		/** @param {string} id @param {string|number} [which] */
		accept(id, which) {
			const o = offers.get(String(id));
			if (!o) return { ok: false, error: 'no pending offer "' + id + '"' };
			/** @type {{label: string, action: () => void} | undefined} */
			let action = o.actions[0];
			if (typeof which === 'number') action = o.actions[which];
			else if (typeof which === 'string' && which)
				action = o.actions.find((a) => a.label.toLowerCase() === which.toLowerCase());
			if (!action)
				return { ok: false, error: 'offer "' + id + '" has no action ' + JSON.stringify(which) + '; actions: ' + o.actions.map((a) => a.label).join(', ') };
			offers.delete(o.id);
			byKey.delete(o.key);
			try {
				action.action();
			} catch (e) {
				return { ok: false, error: 'the action threw: ' + (e instanceof Error ? e.message : String(e)) };
			}
			try {
				o.onAnswer?.();
			} catch {}
			return { ok: true, action: action.label };
		},
		size: () => offers.size
	};
}

/**
 * Build the TpAgent object over injected dependencies.
 * @param {AgentDeps} deps
 */
export function createAgentCore(deps) {
	const now = deps.now ?? (() => Date.now());
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
	const extra = deps.extraTools ?? {};
	const offers = createOffers(now);
	/** @type {string[]} */
	const notices = [];
	/** @type {Promise<any>} */
	let queue = Promise.resolve();
	/** > 0 while our own exec runs: its edits must not wake our own waitForEdit */
	let selfEditing = 0;

	/** @param {any} name @param {any} args */
	function resolved(name, args) {
		const raw = String(name ?? '');
		if (extra[raw]) return raw;
		try {
			return deps.resolveName ? deps.resolveName(raw, args ?? {}).name : raw;
		} catch {
			return raw;
		}
	}

	function canEdit() {
		return deps.role() !== 'viewer';
	}

	/** @param {string} name @param {any} args */
	async function run(name, args) {
		const real = resolved(name, args);
		if (extra[real]) {
			try {
				return await extra[real].run(args ?? {});
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e) };
			}
		}
		if (!READ_ONLY_TOOLS.has(real) && !canEdit()) return { error: viewerRefusal(deps.peerId()), refused: true, role: 'viewer' };
		const away = deps.hostAway?.() ?? null;
		if (!READ_ONLY_TOOLS.has(real) && away) return { error: hostAwayRefusal(away), refused: true, hostAway: away };
		const room = deps.room?.() ?? null;
		if (!READ_ONLY_TOOLS.has(real) && room && !room.withHost)
			return { error: leftBehindRefusal(room.hostScene, room.following), refused: true, withHost: false };
		const readOnly = READ_ONLY_TOOLS.has(real);
		if (!readOnly) {
			selfEditing++;
			deps.beginBatch();
		}
		try {
			return await deps.runTool(String(name ?? ''), args ?? {});
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		} finally {
			if (!readOnly) {
				try {
					deps.endBatch('Agent: ' + real);
				} catch {}
				// the scene-change signal can land a beat after the call (a store poke, a debounced
				// subscriber); hold the self-edit window open one more turn of the loop
				setTimer(() => selfEditing--, 0);
			}
		}
	}

	function tools() {
		const list = (deps.getTools() ?? []).filter((t) => !extra[toolName(t)]);
		for (const [name, spec] of Object.entries(extra)) list.push({ type: 'function', function: { name, ...spec.schema } });
		return list;
	}

	/** 1.2: the host-away state, or null @returns {any} */
	function hostAwayNow() {
		try {
			return deps.hostAway?.() ?? null;
		} catch {
			return null;
		}
	}

	/** 1.2: `{loading, objects}` — loading is always present, objects only while it is true */
	function loadingState() {
		let now = null;
		try {
			now = deps.loading?.() ?? null;
		} catch {}
		return now ? { loading: true, objects: { arrived: now.arrived, total: now.total } } : { loading: false };
	}

	/** 1.2: `{behaviourErrors}` when a behaviour is failing, else nothing */
	function behaviourErrors() {
		try {
			const rows = deps.behaviourErrors?.() ?? [];
			return rows.length ? { behaviourErrors: rows.slice(0, 10) } : {};
		} catch {
			return {};
		}
	}

	/** @returns {import('./contract.js').TpAgentStatus & {notices: string[]}} */
	function status() {
		const host = deps.host();
		const peers = deps.openPeers();
		const waiting = deps.waiting();
		const role = /** @type {any} */ (deps.role());
		const room = deps.room?.() ?? null;
		return {
			version: TP_AGENT_VERSION,
			appVersion: deps.appVersion ?? '',
			peerId: deps.peerId(),
			host,
			// in = admitted, the link open, and (with a roles plugin) the host's roles map arrived — until then a
			// joiner's role is only the default, and an Edit invite would read as view-only
			joined: !!host && peers.some((p) => p.id === host) && !waiting && deps.rolesSettled?.() !== false,
			waiting,
			role,
			canEdit: role !== 'viewer',
			peers,
			missingTools: deps.missingTools(),
			missingModules: deps.missingModules(),
			pendingOffers: offers.list().length,
			inVR: deps.inVR(),
			// 55 owner finding 1: where we are and where the host is — an agent left behind says so
			...(room ? { scene: room.scene, hostScene: room.hostScene, withHost: room.withHost, following: room.following } : {}),
			// 1.2 (41): right after a join the snapshot is still arriving — say so until it has landed
			...loadingState(),
			// 1.2 (41): the host left and nobody is here — paused, and until when it waits for them
			...(hostAwayNow() ? { hostAway: hostAwayNow(), withHost: false } : {}),
			// 55 (41's gem test): a behaviour that throws says so here, not only in the runtime's instance list
			...behaviourErrors(),
			notices: notices.slice()
		};
	}

	/** @param {number} [timeoutMs] @returns {Promise<import('./contract.js').TpAgentEditWait>} */
	function waitForEdit(timeoutMs = DEFAULT_WAIT_MS) {
		const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_WAIT_MS));
		return new Promise((resolve) => {
			let done = false;
			/** @type {() => void} */
			let off = () => {};
			const timer = setTimer(() => finish({ changed: false, timedOut: true }), ms);
			/** @param {any} result */
			function finish(result) {
				if (done) return;
				done = true;
				clearTimer(timer);
				try {
					off();
				} catch {}
				resolve(result);
			}
			let primed = false;
			off = deps.onSceneChange(() => {
				// a store subscription calls back once on subscribe — that is not a change
				if (!primed) return;
				if (selfEditing > 0) return;
				finish({ changed: true, at: now() });
			});
			primed = true;
		});
	}

	const agent = {
		version: TP_AGENT_VERSION,
		tools,
		systemPrompt: () => deps.systemPrompt(),
		/** @param {string} name @param {any} [args] */
		exec(name, args) {
			const job = queue.then(() => run(name, args));
			queue = job.catch(() => {});
			return job;
		},
		snapshot: (/** @type {number} */ cap = 1000) => deps.summarize(Math.max(1, Math.min(5000, Number(cap) || 1000))),
		status,
		waitForEdit,
		screenshot: (/** @type {any} */ opts = {}) => {
			if (deps.inVR()) return Promise.resolve(null);
			return deps.screenshot(opts ?? {}).catch(() => null);
		},
		pendingOffers: () => offers.list(),
		accept: (/** @type {string} */ id, /** @type {string|number|undefined} */ which = undefined) => offers.accept(id, which),
		leave: () => deps.leave()
	};

	return {
		agent,
		offers,
		/** a plain toast line, kept for status().notices @param {string} text */
		notice(text) {
			if (!text) return;
			notices.push(String(text).slice(0, 300));
			if (notices.length > NOTICE_COUNT) notices.splice(0, notices.length - NOTICE_COUNT);
		}
	};
}

/**
 * T6: the modules the session's OTHER peers run that this page lacks or runs at another version.
 * Pure: the advertised sets, which peers are open now, what is loaded here, and (optionally) the
 * gallery ids an `install_modules` call could fetch.
 * @param {Record<string, {id: string, version: string}[]>} advertised peerId -> modules
 * @param {string[]} openIds
 * @param {{id: string, version: string}[]} loaded
 * @param {string[]|null} [galleryIds] null = the gallery has not been read
 * @returns {import('./contract.js').TpAgentMissingModule[]}
 */
export function missingModulesFrom(advertised, openIds, loaded, galleryIds = null) {
	/** @type {Map<string, import('./contract.js').TpAgentMissingModule>} */
	const out = new Map();
	const have = new Map(loaded.map((m) => [m.id, m.version]));
	for (const peerId of openIds) {
		for (const m of advertised[peerId] ?? []) {
			if (!m?.id || out.has(m.id)) continue;
			const mine = have.get(m.id);
			if (mine === m.version) continue;
			/** @type {import('./contract.js').TpAgentMissingModule} */
			const row = { id: m.id, version: String(m.version ?? '') };
			if (mine) row.have = mine;
			if (galleryIds) row.inGallery = galleryIds.includes(m.id);
			out.set(m.id, row);
		}
	}
	return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}
