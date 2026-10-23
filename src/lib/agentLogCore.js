// 55 A8 — the agent action log, PURE half (imports nothing; the unit layer runs it).
//
// One log line per agent tool call: "Claude · created 12 objects (Rock, Log +10)", "set 11
// objects static", "added 2 nodes (spin) to Sign". The line is a SUMMARY the agent's page
// writes from the call it just made; the edits themselves travel on the replicated ops as
// always, so a line never carries content — only what to say and which objects it touched
// (click → select). An entry is `{id, peer, name, tool, text, uuids, at, ok, undone?}`.

/** how many entries a peer keeps (and a late joiner is sent) */
export const AGENT_LOG_CAP = 200;
/** what the handshake sends a late joiner */
export const AGENT_LOG_HANDSHAKE = 50;
/** a line's text cap — it is the agent's own words about its call, shown as text only */
export const TEXT_MAX = 160;

/** tools that only read: no line */
const READ_ONLY = new Set(['list_scene', 'status', 'screenshot', 'wait_for_edit', 'tools', 'snapshot']);

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = one + 's') => n + ' ' + (n === 1 ? one : many);

/** "Rock, Log +10" — at most two distinct names, then a count @param {string[]} names */
export function nameList(names) {
	const clean = [...new Set(names.map((n) => String(n ?? '').replace(/_/g, ' ').trim()).filter(Boolean))];
	if (!clean.length) return '';
	const head = clean.slice(0, 2).join(', ');
	return clean.length > 2 ? head + ' +' + (clean.length - 2) : head;
}

/** @param {any} v */
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Every uuid a call touched, from its args and its result (shallow, the shapes tools.js and
 * flowTools.js answer with). Order kept, duplicates dropped.
 * @param {string} tool @param {any} args @param {any} result @returns {string[]}
 */
export function touchedUuids(tool, args, result) {
	/** @type {string[]} */
	const out = [];
	const add = (/** @type {any} */ u) => {
		if (typeof u === 'string' && u && u !== 'scene' && !out.includes(u)) out.push(u);
	};
	for (const r of arr(result?.created)) add(r?.uuid);
	for (const r of arr(result?.updated)) add(r?.uuid);
	add(result?.groupUuid);
	for (const u of arr(result?.members)) add(u);
	for (const u of arr(args?.updates)) add(u?.uuid);
	if (tool === 'delete_objects') return out; // deleted things cannot be selected
	for (const u of arr(args?.uuids)) add(u);
	for (const j of arr(args?.joints)) {
		add(j?.a);
		add(j?.b);
	}
	if ((tool === 'create_flow_nodes' || tool === 'update_flow_nodes') && typeof result?.graph === 'string') add(result.graph);
	if ((tool === 'create_behaviour' || tool === 'edit_behaviour') && typeof args?.target === 'string') add(args.target);
	return out;
}

/**
 * The line for one tool call, or null for a call worth no line (a read, or an unknown tool
 * that changed nothing). `nameOf(uuid)` names an object in this scene (empty when gone).
 * @param {string} tool @param {any} args @param {any} result
 * @param {(uuid: string) => string} [nameOf]
 * @returns {string | null}
 */
export function summarizeToolCall(tool, args, result, nameOf = () => '') {
	if (READ_ONLY.has(tool)) return null;
	const failed = !result || typeof result !== 'object' || (result.error && !result.created && !result.updated);
	if (failed) return 'tried ' + tool.replace(/_/g, ' ') + ' — ' + String(result?.error ?? 'it failed').slice(0, 80);
	switch (tool) {
		case 'create_objects': {
			const made = arr(result.created).filter((r) => r && !r.error);
			const names = nameList(made.map((r) => r.name));
			return 'created ' + count(made.length, 'object') + (names ? ' (' + names + ')' : '');
		}
		case 'update_objects': {
			const done = arr(result.updated).filter((r) => r && r.ok);
			const names = nameList(done.map((r) => nameOf(r.uuid)));
			return 'changed ' + count(done.length, 'object') + (names ? ' (' + names + ')' : '');
		}
		case 'delete_objects':
			return 'deleted ' + count(Number(result.deleted) || 0, 'object');
		case 'group_objects':
			return 'grouped ' + count(arr(result.members).length, 'object') + ' into ' + String(result.name ?? 'a group').replace(/_/g, ' ');
		case 'clear_scene':
			return 'cleared the scene (' + count(Number(result.cleared) || 0, 'object') + ')';
		case 'create_flow_nodes': {
			const nodes = arr(result.created);
			const types = nameList(nodes.map((n) => n?.type ?? n?.label ?? ''));
			const where = result.graph === 'scene' || !result.graph ? 'the scene' : nameOf(result.graph) || 'an object';
			return 'added ' + count(nodes.length, 'node') + (types ? ' (' + types + ')' : '') + ' to ' + where;
		}
		case 'update_flow_nodes': {
			const where = result.graph === 'scene' || !result.graph ? 'the scene' : nameOf(result.graph) || 'an object';
			const n = arr(result.updated).length;
			const removed = Number(result.removed) || 0;
			return 'changed ' + count(n, 'node') + (removed ? ', removed ' + removed : '') + ' on ' + where;
		}
		case 'create_behaviour':
		case 'edit_behaviour': {
			const b = arr(result.created ?? result.updated)[0]?.name ?? args?.name ?? 'a behaviour';
			const on = typeof args?.target === 'string' ? nameOf(args.target) : '';
			return (tool === 'create_behaviour' ? 'added ' : 'edited ') + b + (on ? ' to ' + on : '');
		}
		case 'set_physics': {
			const done = arr(result.updated).filter((r) => r && r.ok);
			const modes = [...new Set(done.map((r) => r.physics?.mode).filter(Boolean))];
			return modes.length === 1 && done.every((r) => r.physics?.mode)
				? 'set ' + count(done.length, 'object') + ' ' + modes[0]
				: 'changed physics on ' + count(done.length, 'object');
		}
		case 'create_joints': {
			const n = arr(result.created ?? result.joints).length || arr(args?.joints).length;
			return 'joined ' + count(n, 'pair') + ' of objects';
		}
		case 'control_simulation':
			return String(args?.action ?? '') === 'start' ? 'started the simulation' : String(args?.action ?? 'changed') + ' the simulation';
		case 'generate_mesh':
			return 'started generating “' + String(args?.prompt ?? '').slice(0, 50) + '”';
		case 'install_modules':
			return 'installed ' + count(arr(args?.ids ?? args?.modules).length, 'module');
		default:
			return tool.replace(/_/g, ' ');
	}
}

/** a line's id: the agent's peer id + a per-page counter (unique without a clock) @param {string} peer @param {number} n */
export const entryId = (peer, n) => String(peer) + ':' + n;

/** is this a log entry we can show? (it arrived from a peer — untrusted shape) @param {any} e */
export function isEntry(e) {
	return (
		!!e &&
		typeof e === 'object' &&
		typeof e.id === 'string' &&
		e.id.length <= 64 &&
		typeof e.peer === 'string' &&
		typeof e.text === 'string' &&
		Number.isFinite(e.at) &&
		(e.uuids === undefined || (Array.isArray(e.uuids) && e.uuids.length <= 500 && e.uuids.every((/** @type {any} */ u) => typeof u === 'string')))
	);
}

/** a received entry made safe to keep @param {any} e */
export function cleanEntry(e) {
	return {
		id: e.id,
		peer: String(e.peer).toLowerCase(),
		name: String(e.name ?? '').slice(0, 32),
		tool: String(e.tool ?? '').slice(0, 40),
		text: e.text.slice(0, TEXT_MAX),
		uuids: (e.uuids ?? []).slice(0, 500),
		at: e.at,
		ok: e.ok !== false,
		undone: e.undone === true,
		undoable: e.undoable !== false
	};
}

/**
 * Merge arriving entries into a log: by id (an arriving copy updates `undone`), ordered by
 * time then id, capped to the newest AGENT_LOG_CAP. Returns the same array when nothing changed.
 * @param {any[]} log @param {any[]} arriving
 */
export function mergeEntries(log, arriving) {
	const byId = new Map(log.map((e) => [e.id, e]));
	let changed = false;
	for (const raw of arriving) {
		if (!isEntry(raw)) continue;
		const e = cleanEntry(raw);
		const had = byId.get(e.id);
		if (!had) {
			byId.set(e.id, e);
			changed = true;
		} else if (e.undone && !had.undone) {
			byId.set(e.id, { ...had, undone: true });
			changed = true;
		}
	}
	if (!changed) return log;
	const all = [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return all.slice(-AGENT_LOG_CAP);
}

/**
 * Group consecutive lines by agent, for the window: `[{peer, name, entries}]`, oldest first.
 * @param {any[]} log
 */
export function groupEntries(log) {
	/** @type {{peer: string, name: string, entries: any[]}[]} */
	const groups = [];
	for (const e of log) {
		const last = groups[groups.length - 1];
		if (last && last.peer === e.peer) {
			last.entries.push(e);
			if (e.name) last.name = e.name;
		} else groups.push({ peer: e.peer, name: e.name, entries: [e] });
	}
	return groups;
}
