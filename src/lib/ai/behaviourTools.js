// 34 D5 — `create_behaviour` / `edit_behaviour`: the assistant writes game logic as CODE.
//
// Proposal §4.4's finding: plain JS is what models write best (lowest error rate), and a
// behaviour is testable and diffable where a 300-node graph is not. The behaviour FORMAT and
// RUNTIME belong to 34-behaviours (D1); this file is the assistant's half, wired to it
// through the feature-detect seam (aiExtensions.js). With no host registered the two tools
// are not offered at all — a model shown a tool that can only fail learns nothing useful.
//
// THE LINT RUNS BEFORE APPLY (proposal D5): core's determinism lint (scriptLint — no DOM, no
// Math.random/Date.now, no storage, no timers, no loop without an exit) and then the host's
// own checks. A refused source comes back as a tool ERROR listing every issue with its line,
// which is the shape a model self-corrects from; nothing reaches the host.
//
// Imports only leaves (scriptLint, aiExtensions), so it runs under vitest with a fake host.

import { lintScript } from '../scriptLint.js';
import { behaviourHost } from './aiExtensions.js';
import { sessionNow } from '../sessionClock.js';

const NAME = /^[A-Za-z_][\w-]{0,63}$/;
const MAX_SOURCE = 40_000;

/** Tool schemas, or [] when behaviours are not in this build. @returns {any[]} */
export function behaviourToolSchemas() {
	if (!behaviourHost()) return [];
	const source = {
		type: 'string',
		description:
			'the whole behaviour module source (plain JavaScript, the format in the system prompt). Must be deterministic: no Math.random (use rand()), no Date.now/new Date (use the session clock), no DOM, no localStorage, no timers (use this.after), no loop without an exit.'
	};
	return [
		{
			type: 'function',
			function: {
				name: 'create_behaviour',
				description:
					'Create a code behaviour: game logic (rules, waves, scoring, reach limits) written as JavaScript, run on the session authority and replicated. Prefer this over large node graphs for game rules. It is linted before it is applied; errors come back with line numbers.',
				parameters: {
					type: 'object',
					properties: {
						name: { type: 'string', description: 'a short unique name, letters/digits/_/-' },
						target: { type: 'string', description: '"scene" (default) or an object uuid the behaviour belongs to' },
						source
					},
					required: ['name', 'source']
				}
			}
		},
		{
			type: 'function',
			function: {
				name: 'edit_behaviour',
				description:
					'Replace an existing behaviour\'s source (the scene summary lists them; read the current source with the name). Linted before it is applied.',
				parameters: {
					type: 'object',
					properties: { name: { type: 'string' }, source },
					required: ['name', 'source']
				}
			}
		}
	];
}

/**
 * Lint a behaviour source: core's determinism rules, then the host's. Returns every issue.
 * @param {string} source @returns {Promise<{line: number, message: string, rule?: string}[]>}
 */
export async function lintBehaviour(source) {
	/** @type {{line: number, message: string, rule?: string}[]} */
	const issues = lintScript(source).map((i) => ({ line: i.line, message: i.message, rule: i.rule }));
	const host = behaviourHost();
	if (host?.lint) {
		try {
			const more = await host.lint(source);
			if (Array.isArray(more)) issues.push(...more.map((i) => ({ line: Number(i?.line) || 0, message: String(i?.message ?? i) })));
		} catch (error) {
			issues.push({ line: 0, message: 'the behaviour checker failed: ' + (error instanceof Error ? error.message : String(error)) });
		}
	}
	return issues.sort((a, b) => a.line - b.line);
}

/** @param {any} args @returns {{name: string, source: string} | {error: string}} */
function readArgs(args) {
	const name = String(args?.name ?? '').trim();
	const source = typeof args?.source === 'string' ? args.source : '';
	if (!NAME.test(name)) return { error: 'name must be 1-64 letters/digits/_/- starting with a letter, got ' + JSON.stringify(args?.name) };
	if (!source.trim()) return { error: 'source is empty — pass the whole behaviour module' };
	if (source.length > MAX_SOURCE) return { error: 'source is ' + source.length + ' chars; the limit is ' + MAX_SOURCE };
	return { name, source };
}

/** how long a fresh behaviour is watched for errors (its first handlers, a peer's reply on the wire) */
const SETTLE_MS = 2500;

/** a behaviour's errors after its first moments, only those raised since `since` (the old code's are not
 * the new one's) — [] when the host cannot say @param {any} host @param {string} name @param {number} since */
async function settleErrors(host, name, since) {
	if (typeof host?.errorsOf !== 'function') return [];
	const until = Date.now() + SETTLE_MS;
	let errors = [];
	while (Date.now() < until) {
		await new Promise((r) => setTimeout(r, 250));
		try {
			errors = (host.errorsOf(name) ?? []).filter((/** @type {any} */ e) => !Number.isFinite(e?.at) || e.at >= since).map((/** @type {any} */ e) => ({ where: e.where, message: e.message }));
		} catch {
			errors = [];
		}
		if (errors.length) break;
	}
	return errors;
}

/**
 * create_behaviour / edit_behaviour. Never throws (the tools.js convention).
 * @param {'create_behaviour' | 'edit_behaviour'} tool @param {any} args @returns {Promise<any>}
 */
export async function behaviourTool(tool, args) {
	const host = behaviourHost();
	if (!host) return { error: 'code behaviours are not available in this build — use create_flow_nodes' };
	const read = readArgs(args);
	if ('error' in read) return read;
	const issues = await lintBehaviour(read.source);
	if (issues.length)
		return {
			error: 'the behaviour was NOT applied: ' + issues.length + ' lint issue(s) — fix them and call ' + tool + ' again',
			issues
		};
	const since = sessionNow();
	try {
		const result =
			tool === 'create_behaviour'
				? await host.create(read.name, read.source, { target: typeof args?.target === 'string' ? args.target : 'scene' })
				: await host.edit(read.name, read.source);
		if (result && typeof result === 'object' && result.error) return { error: String(result.error) };
		const done = { [tool === 'create_behaviour' ? 'created' : 'updated']: [{ name: read.name }] };
		// 55 (41's gem test): a behaviour that loads and then THROWS (a bare findAll(), a typo in a
		// handler) used to read as success here and "running" in list_scene. Watch its first moments
		// (its start/load handlers run then, on whichever peer is the authority) and report what failed.
		const errors = await settleErrors(host, read.name, since);
		return errors.length
			? { ...done, errors, warning: 'the behaviour was applied but its handlers threw (' + errors.length + ') — fix what errors[] names with edit_behaviour' }
			: done;
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** The scene summary's `behaviours` row, or undefined. SYNCHRONOUS (the summary is built
 * per turn, synchronously): a host whose list() returns a promise is simply not listed.
 * @returns {any[] | undefined} */
export function summarizeBehaviours() {
	const host = behaviourHost();
	if (!host?.list) return undefined;
	try {
		const list = host.list();
		if (!Array.isArray(list) || !list.length) return undefined;
		// a SHORT behaviour travels with its source, so "make the waves faster" can be an
		// edit_behaviour without a round trip; a long one is listed by name and summary only
		let budget = 4000;
		return list.slice(0, 50).map((b) => {
			const row = { ...b };
			const source = host.read ? host.read(String(b?.name ?? '')) : null;
			if (typeof source === 'string' && source.length <= 1500 && source.length <= budget) {
				row.source = source;
				budget -= source.length;
			}
			return row;
		});
	} catch {
		return undefined;
	}
}
