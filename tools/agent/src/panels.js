// Agent panels on the bridge side (roadmap 67). The page owns panels: open_panel / update_panel / close_panel /
// list_panels are tools the app lists (tpAgent 1.2.0), and a person's changes and button presses arrive through
// the same inbox as chat messages (kind "panel"). What the bridge adds:
//   · the MACHINE the agent runs on, for the panel header ("Panel by Claude on <machine>"): `--machine <name>`,
//     else TP_AGENT_MACHINE, else the host name; `--machine ''` leaves it out;
//   · P6 DECLARED TOOLS: `--tools-dir <dir>` (or TP_AGENT_TOOLS) holds one JSON manifest per local tool —
//     {id, name, description?, panel?} — and each is declared to the page, so a person can open the tool's panel
//     from the app. Only the declaration crosses: a manifest's command (66 S4b wave 2) never leaves this machine
//     and nothing here runs it;
//   · how a panel event reads to a model (the MCP JSON note, the REPL's user turn).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';

/** manifests read from a tools directory, at most */
export const MANIFESTS_MAX = 32;
/** one manifest file, at most (a panel spec with a preview image fits) */
export const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The machine name a panel header shows. @param {Record<string, any>} args @param {{env?: any, host?: () => string}} [io]
 * @returns {string}
 */
export function machineName(args = {}, io = {}) {
	const env = io.env ?? process.env;
	const raw = args.machine !== undefined && args.machine !== true ? String(args.machine) : env.TP_AGENT_MACHINE !== undefined ? String(env.TP_AGENT_MACHINE) : (io.host ?? hostname)();
	// a short name: no domain, no markup, no control characters
	return raw.split('.')[0].replace(/[<>\u0000-\u001F]/g, '').trim().slice(0, 64);
}

/**
 * The manifests in a tools directory: `*.json` files, each `{id, name, description?, panel?}`. A file that
 * does not read or parse is skipped with a log line; the page validates what it is handed again.
 * @param {string | undefined} dir @param {{log?: (m: string) => void, list?: (d: string) => string[], read?: (p: string) => string}} [io]
 * @returns {{id: string, name: string, description?: string, panel?: any}[]}
 */
export function readToolManifests(dir, io = {}) {
	if (!dir || typeof dir !== 'string') return [];
	const log = io.log ?? (() => {});
	const list = io.list ?? ((/** @type {string} */ d) => readdirSync(d));
	const read = io.read ?? ((/** @type {string} */ p) => readFileSync(p, 'utf8'));
	let files;
	try {
		files = list(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
	} catch (e) {
		log('tools dir ' + dir + ': ' + String(/** @type {any} */ (e).code || /** @type {any} */ (e).message));
		return [];
	}
	/** @type {any[]} */
	const out = [];
	for (const f of files.slice(0, MANIFESTS_MAX)) {
		try {
			const text = read(join(dir, f));
			if (text.length > MANIFEST_MAX_BYTES) throw new Error('larger than ' + MANIFEST_MAX_BYTES / 1048576 + ' MB');
			const m = JSON.parse(text.replace(/^﻿/, ''));
			if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.name !== 'string') throw new Error('a manifest needs id and name');
			/** @type {any} */
			const row = { id: m.id, name: m.name };
			if (typeof m.description === 'string') row.description = m.description;
			if (m.panel && typeof m.panel === 'object') row.panel = m.panel;
			out.push(row);
		} catch (e) {
			log('tool manifest ' + f + ' skipped: ' + String(/** @type {any} */ (e).message).split('\n')[0]);
		}
	}
	return out;
}

/**
 * Tell the page who we are (machine) and what we declare. Feature-detected: an app before tpAgent 1.2.0 has
 * neither method and this does nothing.
 * @param {{call: (method: string, ...args: any[]) => Promise<any>}} engine
 * @param {{machine?: string, tools?: any[]}} setup @param {(m: string) => void} [log]
 */
export async function announcePanels(engine, setup, log = () => {}) {
	if (!engine || typeof engine.call !== 'function') return { ok: false };
	const id = await engine.call('panelIdentity', { machine: setup.machine ?? '' }).catch(() => null);
	if (!id || id.__missing) return { ok: false, missing: true };
	/** @type {any[]} */
	const declared = [];
	for (const m of setup.tools ?? []) {
		const r = await engine.call('declareTool', m).catch((/** @type {any} */ e) => ({ error: e.message }));
		if (r?.error) log('tool ' + m.id + ' not declared: ' + r.error);
		else declared.push(m.id);
	}
	return { ok: true, declared };
}

/** the note an MCP agent reads beside a panel event */
export const PANEL_EVENT_NOTE =
	'A person used one of your panels (not a chat message): event change / press / reopened / opened / shared / closed, the control, its value, and `values` = every value now. ' +
	'Act on it with your tools (e.g. re-render and update_panel the preview, or import_file on Render), then wait_for_message again. No reply is needed.';

/**
 * A panel event as one line of user text (the REPL's turn).
 * @param {any} msg
 */
export function panelEventText(msg) {
	const who = (msg.name || String(msg.from || '').toUpperCase() || 'someone') + ' (' + (msg.role || 'editor') + ')';
	const where = 'panel "' + (msg.title || msg.panelId) + '" (' + msg.panelId + ')';
	let what;
	if (msg.event === 'change') what = 'set ' + (msg.label || msg.control) + ' [' + msg.control + '] to ' + JSON.stringify(msg.value);
	else if (msg.event === 'press') what = 'pressed ' + (msg.label || msg.control) + ' [' + msg.control + ']';
	else if (msg.event === 'reopened') what = 'reopened your saved ' + where.replace('panel ', 'panel ') + ' — it is yours again';
	else what = String(msg.event || 'used');
	return (
		'[' + who + ' in the app, ' + where + ']: ' + what + '. All values: ' + JSON.stringify(msg.values ?? {}) +
		'. Answer with tool calls (update_panel for the panel itself); no chat reply is needed.'
	);
}
