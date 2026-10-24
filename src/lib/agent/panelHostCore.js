// Roadmap 67 P1-P6 — THE AGENT PAGE's PANELS: the authority for every panel this agent opened. Imports only
// the pure schema (agentPanelCore.js); panelHost.js wires the real stores, the peer link and the inbox.
//
// What this owns (it holds whatever the model does):
//   · WHO GETS A COPY: the panel's OWNER (a person, never a viewer, never an agent) — by default the person
//     whose message the agent is working on, else the session host; once the owner presses Share, every
//     editor too. A viewer is never sent one (P3).
//   · WHO MAY ACT: an event counts only from the owner, or from an editor of a shared panel; its value is
//     checked against the control (agentPanelCore.checkEvent). Everyone else's bytes are dropped.
//   · ONE STATE: every change bumps the panel's revision and the WHOLE state goes to every copy, so a late
//     or lost message is healed by the next one; an event's new value goes to the OTHER copies (the sender
//     already shows it).
//   · NOTHING ACTS: an accepted event becomes a message in the agent's inbox (wait_for_message / the REPL /
//     tpAgent.nextMessage) — the agent answers with tool calls under its own role (P2, P5).
//   · CAPS: at most PANEL_CAP panels per owner.

import { normalizeSpec, applyPatch, initialValues, mergeValues, checkEvent, controlsOf, PANEL_CAP } from '../agentPanelCore.js';

/** declared tools (P6) an agent may hold */
export const TOOLS_CAP = 32;
const TOOL_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * @typedef {object} PanelHostDeps
 * @property {() => string|null} selfId
 * @property {() => string} [myName] the agent's display name
 * @property {() => string} [machine] the machine the agent runs on (the bridge says)
 * @property {(peerId: string) => string|null} roleOf 'admin'|'editor'|'viewer', or null (no roles: everyone edits)
 * @property {(peerId: string) => boolean} isAgent another agent (55 roster kind)
 * @property {() => string[]} openPeers peer ids with an open connection
 * @property {() => string|null} host the session host
 * @property {() => string|null} [requester] the person whose chat message the agent is working on
 * @property {(peerId: string) => string} [nameOf]
 * @property {(peerId: string, msg: any) => boolean} sendTo one peer, its own connection
 * @property {(evt: any) => void} pushEvent into the agent's inbox
 * @property {() => number} [now]
 * @property {() => string} [makeId]
 */

/** @param {PanelHostDeps} deps */
export function createPanelHost(deps) {
	const now = deps.now ?? (() => Date.now());
	let seq = 0;
	const makeId = deps.makeId ?? (() => 'p' + now().toString(36) + (++seq).toString(36));
	const lc = (/** @type {any} */ s) => String(s ?? '').toLowerCase();
	const self = () => lc(deps.selfId());

	/** @type {Map<string, {id: string, spec: any, values: Record<string, any>, owner: string, shared: boolean, rev: number, hidden: Set<string>, at: number}>} */
	const panels = new Map();
	/** P6: tool id -> {id, name, description?, spec?} @type {Map<string, any>} */
	const tools = new Map();

	const openIds = () => deps.openPeers().map(lc);
	/** a person who may hold an interactive copy @param {string} id */
	const isPerson = (id) => !!id && id !== self() && !deps.isAgent(id) && deps.roleOf(id) !== 'viewer';
	/** may edit (rolesInfo null = no roles in this build: everyone edits) @param {string} id */
	const canEdit = (id) => deps.roleOf(id) !== 'viewer';

	/** who holds a copy of `p` now @param {any} p */
	function recipients(p) {
		const out = new Set();
		if (openIds().includes(p.owner)) out.add(p.owner);
		if (p.shared) for (const id of openIds()) if (isPerson(id) && !p.hidden.has(id)) out.add(id);
		return [...out];
	}

	/** the full state a copy draws @param {any} p */
	function wireState(p) {
		/** @type {any} */
		const out = { id: p.id, spec: p.spec, values: p.values, owner: p.owner, shared: p.shared, rev: p.rev };
		const name = deps.myName?.();
		if (name) out.agentName = name;
		const machine = deps.machine?.();
		if (machine) out.machine = machine;
		return out;
	}

	/** @param {any} p @param {string} to @param {any} [extra] */
	const sendOpen = (p, to, extra) => deps.sendTo(to, { type: 'agentpanel', op: 'open', panel: { ...wireState(p), ...extra } });
	/** @param {any} p @param {string} [except] */
	function sendState(p, except) {
		for (const to of recipients(p)) {
			if (to === except) continue;
			deps.sendTo(to, { type: 'agentpanel', op: 'patch', panel: p.id, rev: p.rev, spec: p.spec, values: p.values, shared: p.shared });
		}
	}

	/** what the agent reads about a panel @param {any} p */
	const summary = (p) => ({
		panelId: p.id,
		title: p.spec.title,
		toolId: p.spec.toolId,
		owner: p.owner,
		ownerName: deps.nameOf?.(p.owner) || undefined,
		shared: p.shared,
		values: p.values,
		controls: controlsOf(p.spec).map((c) => c.id)
	});

	/** @param {string} owner */
	const countFor = (owner) => [...panels.values()].filter((p) => p.owner === owner).length;

	/** the owner a new panel goes to @param {any} want */
	function resolveOwner(want) {
		if (typeof want === 'string' && want) {
			const id = lc(want);
			if (!openIds().includes(id)) return { error: 'owner ' + want + ' is not in the session (status().peers lists who is)' };
			if (deps.isAgent(id) || id === self()) return { error: 'a panel is for a person, not an agent' };
			if (!canEdit(id)) return { error: 'refused: ' + want + ' is a VIEWER, and viewers never get an interactive panel' };
			return { owner: id };
		}
		const asker = lc(deps.requester?.());
		if (asker && openIds().includes(asker) && isPerson(asker)) return { owner: asker };
		const host = lc(deps.host());
		if (host && openIds().includes(host) && isPerson(host)) return { owner: host };
		const people = openIds().filter(isPerson);
		if (people.length === 1) return { owner: people[0] };
		return { error: 'say whose panel this is: owner = a peer id from status().peers (the person you are working for)' };
	}

	/**
	 * Open a panel. `opts.owner` = a peer id (default: the person you are working for); `opts.values` =
	 * starting values.
	 * @param {any} rawSpec @param {{owner?: string, values?: any}} [opts]
	 * @returns {any}
	 */
	function open(rawSpec, opts = {}) {
		const r = normalizeSpec(rawSpec);
		if (!r.ok) return { error: 'refused: ' + r.error, refused: true };
		const who = resolveOwner(opts.owner);
		if (who.error) return { error: who.error, refused: who.error.startsWith('refused') || undefined };
		const owner = /** @type {string} */ (who.owner);
		if (countFor(owner) >= PANEL_CAP) return { error: 'refused: ' + PANEL_CAP + ' panels are open for this person already — close_panel one first', refused: true };
		const p = { id: makeId(), spec: r.spec, values: mergeValues(r.spec, initialValues(r.spec), opts.values), owner, shared: false, rev: 1, hidden: new Set(), at: now() };
		panels.set(p.id, p);
		sendOpen(p, owner);
		return {
			ok: true,
			...summary(p),
			note: 'The panel is open for ' + (deps.nameOf?.(owner) || owner) + '. Their changes and button presses come to you through wait_for_message (kind "panel"); answer with update_panel and tool calls.'
		};
	}

	/**
	 * Patch a panel (`{title?, values?, controls?}`), then every copy redraws.
	 * @param {string} id @param {any} patch
	 * @returns {any}
	 */
	function update(id, patch) {
		const p = panels.get(String(id ?? ''));
		if (!p) return { error: 'no panel "' + id + '" (list_panels shows yours)' };
		const r = applyPatch(p.spec, p.values, patch);
		if (!r.ok) return { error: 'refused: ' + r.error, refused: true };
		if (!r.changed) return { ok: true, panelId: p.id, unchanged: true };
		p.spec = r.spec;
		p.values = r.values;
		p.rev++;
		sendState(p);
		return { ok: true, panelId: p.id, rev: p.rev, values: p.values };
	}

	/** @param {string} id @returns {any} */
	function close(id) {
		const p = panels.get(String(id ?? ''));
		if (!p) return { error: 'no panel "' + id + '"' };
		for (const to of recipients(p)) deps.sendTo(to, { type: 'agentpanel', op: 'close', panel: p.id });
		panels.delete(p.id);
		return { ok: true, panelId: p.id };
	}

	/** @param {any} p @param {string} event @param {any} extra */
	function emit(p, event, extra = {}) {
		const from = extra.from ?? p.owner;
		deps.pushEvent({
			kind: 'panel',
			event,
			panelId: p.id,
			title: p.spec.title,
			...(p.spec.toolId ? { toolId: p.spec.toolId } : {}),
			...extra,
			from,
			name: deps.nameOf?.(from) || undefined,
			role: deps.roleOf(from) ?? 'editor',
			values: p.values
		});
	}

	/** adopt a saved panel (P4 reopen, P6 request) for `owner` @param {any} spec @param {any} values @param {string} owner */
	function adopt(spec, values, owner) {
		const p = { id: makeId(), spec, values: mergeValues(spec, initialValues(spec), values), owner, shared: false, rev: 1, hidden: new Set(), at: now() };
		panels.set(p.id, p);
		return p;
	}

	/**
	 * A peer's `agentpanel` message. `fromPeer` is the CONNECTION's id.
	 * @param {string} fromPeer @param {any} d
	 */
	function receive(fromPeer, d) {
		if (!d || typeof d !== 'object') return;
		const from = lc(fromPeer);
		if (!from || from === self()) return;
		if (d.op === 'event') {
			const p = panels.get(String(d.panel ?? ''));
			if (!p) return;
			const allowed = canEdit(from) && !deps.isAgent(from) && (from === p.owner || p.shared);
			if (!allowed) return;
			const ev = checkEvent(p.spec, d);
			if (!ev) return;
			if (ev.kind === 'change') {
				if (JSON.stringify(p.values[ev.control]) === JSON.stringify(ev.value)) return;
				p.values = { ...p.values, [ev.control]: ev.value };
				p.rev++;
				for (const to of recipients(p)) if (to !== from) deps.sendTo(to, { type: 'agentpanel', op: 'values', panel: p.id, rev: p.rev, values: { [ev.control]: ev.value } });
				emit(p, 'change', { control: ev.control, label: ev.label, value: ev.value, from });
			} else emit(p, 'press', { control: ev.control, label: ev.label, from });
			return;
		}
		if (d.op === 'share') {
			const p = panels.get(String(d.panel ?? ''));
			if (!p || from !== p.owner) return;
			const shared = d.shared === true;
			if (shared === p.shared) return;
			const before = recipients(p);
			p.shared = shared;
			p.rev++;
			p.hidden.clear();
			const after = recipients(p);
			for (const to of after) if (!before.includes(to)) sendOpen(p, to);
			// the copies that go (unshared) and the ones that stay all hear the new state
			for (const to of before) deps.sendTo(to, { type: 'agentpanel', op: 'patch', panel: p.id, rev: p.rev, spec: p.spec, values: p.values, shared: p.shared });
			emit(p, shared ? 'shared' : 'unshared', { from });
			return;
		}
		if (d.op === 'closed') {
			const p = panels.get(String(d.panel ?? ''));
			if (!p) return;
			if (from === p.owner) {
				const reason = typeof d.reason === 'string' ? d.reason.slice(0, 20) : undefined;
				for (const to of recipients(p)) if (to !== from) deps.sendTo(to, { type: 'agentpanel', op: 'close', panel: p.id });
				panels.delete(p.id);
				emit(p, 'closed', { from, ...(reason ? { reason } : {}), ...(typeof d.error === 'string' ? { error: d.error.slice(0, 200) } : {}) });
			} else p.hidden.add(from);
			return;
		}
		if (d.op === 'reopen') {
			const key = typeof d.key === 'string' ? d.key.slice(0, 64) : '';
			const saved = d.saved && typeof d.saved === 'object' ? d.saved : null;
			if (!key || !saved || !isPerson(from)) {
				if (key) deps.sendTo(from, { type: 'agentpanel', op: 'refused', key, error: 'viewers cannot reopen agent panels' });
				return;
			}
			// the same agent back (a reconnect): it still holds this panel
			const prev = typeof saved.prev === 'string' ? panels.get(saved.prev) : null;
			if (prev && prev.owner === from) {
				sendOpen(prev, from, { replaces: key });
				return;
			}
			const r = normalizeSpec(saved.spec);
			if (!r.ok) {
				deps.sendTo(from, { type: 'agentpanel', op: 'refused', key, error: r.error });
				return;
			}
			if (countFor(from) >= PANEL_CAP) {
				deps.sendTo(from, { type: 'agentpanel', op: 'refused', key, error: PANEL_CAP + ' panels are open for you already' });
				return;
			}
			const p = adopt(r.spec, saved.values, from);
			sendOpen(p, from, { replaces: key });
			emit(p, 'reopened', { from });
			return;
		}
		if (d.op === 'request') {
			const tool = tools.get(String(d.toolId ?? ''));
			if (!tool?.spec || !isPerson(from)) return;
			if (countFor(from) >= PANEL_CAP) return;
			const p = adopt(tool.spec, undefined, from);
			sendOpen(p, from);
			emit(p, 'opened', { from });
		}
	}

	/** what this agent declares (P6) — the panel-carrying ones are what a person can open */
	const toolsWire = () => [...tools.values()].map((t) => ({ id: t.id, name: t.name, panel: !!t.spec }));

	/** a connection opened (a joiner, a reconnect): its copies, and the declared tools @param {string} peerId @param {(msg: any) => void} [send] */
	function peerOpened(peerId, send) {
		const id = lc(peerId);
		const out = send ?? ((/** @type {any} */ msg) => deps.sendTo(id, msg));
		for (const p of panels.values()) {
			const gets = p.owner === id || (p.shared && !p.hidden.has(id) && isPerson(id));
			if (gets) out({ type: 'agentpanel', op: 'open', panel: wireState(p) });
		}
		if (tools.size && !deps.isAgent(id) && canEdit(id)) out({ type: 'agentpanel', op: 'tools', tools: toolsWire() });
	}

	/**
	 * P6: a declared local tool's manifest — `{id, name, description?, panel?}`; `panel` is a panel spec a
	 * person can open from the app. Nothing here runs anything: the tool's command stays on the agent's side.
	 * @param {any} manifest @returns {any}
	 */
	function declareTool(manifest) {
		if (!manifest || typeof manifest !== 'object') return { error: 'a tool manifest is an object {id, name, panel?}' };
		const id = String(manifest.id ?? '');
		if (!TOOL_ID.test(id)) return { error: 'a tool id is 1-64 letters, digits, "_", "-", "." or ":"' };
		const name = String(manifest.name ?? '').replace(/[<>]/g, '').trim().slice(0, 60);
		if (!name) return { error: 'a tool needs a name' };
		if (!tools.has(id) && tools.size >= TOOLS_CAP) return { error: 'at most ' + TOOLS_CAP + ' declared tools' };
		/** @type {any} */
		const row = { id, name };
		if (typeof manifest.description === 'string') row.description = manifest.description.slice(0, 200);
		if (manifest.panel !== undefined && manifest.panel !== null) {
			const r = normalizeSpec({ ...manifest.panel, toolId: manifest.panel.toolId ?? id });
			if (!r.ok) return { error: 'refused: the panel of ' + id + ': ' + r.error, refused: true };
			row.spec = r.spec;
		}
		tools.set(id, row);
		const msg = { type: 'agentpanel', op: 'tools', tools: toolsWire() };
		for (const to of openIds()) if (isPerson(to)) deps.sendTo(to, msg);
		return { ok: true, id, panel: !!row.spec };
	}

	return {
		open,
		update,
		close,
		receive,
		peerOpened,
		declareTool,
		list: () => [...panels.values()].map(summary),
		tools: () => toolsWire(),
		/** for tests */
		get: (/** @type {string} */ id) => panels.get(id) ?? null
	};
}
