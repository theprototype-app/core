// 63 (63-publish + 63-export) — ONE CHECK, TWO DOORS. The row and rule shape shared by the publish
// check (Publish dialog, scene rules: sceneChecks.js) and the export preset checks (Export ▸ itch.io /
// CrazyGames / static, size and portal rules: exportChecks.js). Both lists render through
// CheckList.svelte from these rows. A PURE ESM LEAF: no imports, no $lib, no svelte —
// scripts/check-export.cjs imports it by file URL in node. Byte-identical in both lanes; change it
// only by agreement between them.
//
// THE CONTRACT
//   · a rule never throws at the caller: runChecks turns a throwing rule into one 'info' row;
//   · publish NEVER blocks (summarize(rows, 'publish').blocking === 0 whatever the rows say);
//   · an export target blocks the download on 'error' rows only; 'warn' and 'info' never block;
//   · fix buttons name a fix (row.fix.name) — the functions live UI-side in checkFixes.js, lazy;
//     names are disjoint per owner: 'scene-*' (63-publish), 'export-*' (63-export).

/** @typedef {'error'|'warn'|'info'} CheckSeverity */

/** @typedef {'publish'|'itch'|'crazygames'|'static'} CheckTarget  (embed builds nothing: no checks) */

/**
 * @typedef {{
 *   id: string,
 *   owner: 'scene'|'export',
 *   severity: CheckSeverity,
 *   title: string,
 *   detail?: string,
 *   where?: string,
 *   file?: string,
 *   items?: {label: string, bytes?: number, where?: string}[],
 *   fix?: {name: string, label: string, args?: any}
 * }} CheckRow
 * id     stable kebab rule id ('scene-no-spawn', 'export-size-total' ...)
 * title  one plain line, no emoji; detail = a second line (the numbers, the limit)
 * where  an object uuid (CheckList's select target); file = a path inside the zip
 * items  a sub-list under the row (the biggest assets); an item with `where` is a select button
 */

/**
 * @typedef {{
 *   target: CheckTarget | string,
 *   session?: any,
 *   files?: {path: string, bytes: number, text?: string}[],
 *   preset?: string,
 *   phone?: boolean,
 *   modules?: string[],
 *   limits?: any,
 *   [key: string]: any
 * }} CheckContext
 * Open: a rule may read further keys its caller supplies (ctx.assets, ctx.breakdown, ...).
 */

/**
 * @typedef {{
 *   id: string,
 *   owner: 'scene'|'export',
 *   targets?: string[],
 *   run: (ctx: CheckContext) => CheckRow[] | Promise<CheckRow[]>
 * }} CheckRule
 * targets: the CheckTargets the rule runs for; none = every target.
 */

const RANK = { error: 0, warn: 1, info: 2 };

/** @param {CheckRow[]} rows @returns {CheckRow[]} a new array: error, warn, info; then id; stable */
export function sortRows(rows) {
	return rows
		.map((r, i) => ({ r, i }))
		.sort(
			(a, b) =>
				(RANK[a.r.severity] ?? 3) - (RANK[b.r.severity] ?? 3) ||
				(a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0) ||
				a.i - b.i
		)
		.map((x) => x.r);
}

/**
 * @param {CheckRow[]} rows @param {CheckTarget | string} target
 * @returns {{error: number, warn: number, info: number, blocking: number}}
 * blocking = 0 for 'publish' (warnings never block publishing), else the error count.
 */
export function summarize(rows, target) {
	const n = { error: 0, warn: 0, info: 0, blocking: 0 };
	for (const r of rows) if (r.severity in RANK) n[r.severity]++;
	n.blocking = target === 'publish' ? 0 : n.error;
	return n;
}

/** @param {CheckRule} rule @param {string} target */
export function ruleApplies(rule, target) {
	return !Array.isArray(rule.targets) || !rule.targets.length || rule.targets.includes(target);
}

/**
 * Run every rule that applies to ctx.target, in order; a throwing rule becomes one 'info' row
 * (`<id>-failed`), so one bad rule never hides the rest. Rows come back sorted.
 * @param {CheckRule[]} rules @param {CheckContext} ctx @returns {Promise<CheckRow[]>}
 */
export async function runChecks(rules, ctx) {
	/** @type {CheckRow[]} */
	const out = [];
	for (const rule of rules) {
		if (!ruleApplies(rule, ctx.target)) continue;
		try {
			const rows = await rule.run(ctx);
			if (Array.isArray(rows)) for (const r of rows) if (r && typeof r.title === 'string') out.push({ ...r, owner: r.owner || rule.owner, id: r.id || rule.id });
		} catch (e) {
			out.push({
				id: rule.id + '-failed',
				owner: rule.owner,
				severity: 'info',
				title: 'One check could not run',
				detail: rule.id + ': ' + String(/** @type {any} */ (e)?.message ?? e).slice(0, 200)
			});
		}
	}
	return sortRows(out);
}
