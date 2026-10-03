// 34 B2 — THE BUDGET RULE (pure, no browser): what `perf-games.cjs --check` holds every Games-tab
// game and every General-tab level to. The numbers live in `perf/budgets.json`; this file reads
// them and judges a measured row. Unit-tested in tests/unit/perfBudget.test.js.
//
// ONLY COUNTS ARE GATED. Draw calls, triangles, lights and the texture-MB estimate come from
// three's own bookkeeping (renderer.info, the scene graph) and are the same on a GPU and on a
// GPU-less CI runner's SwiftShader, as long as the scene is in the same state from the same
// viewpoint — which is what the check profile pins (perf-games.cjs). Frame ms is NOT gated: it
// is the one number a runner cannot reproduce.
//
// THE ALLOW-LIST is how a scene that is over budget TODAY ships without turning the gate off for
// everyone: one entry per (target, metric[, view]) with the ceiling it may not exceed, the date it
// was granted, a review date, an owner and why. A regression past the ceiling is red like any
// other; an entry whose scene came back under budget, or whose review date passed, is a WARNING
// (printed, not failed — a calendar date must not turn an unrelated PR red).
const fs = require('fs');
const path = require('path');

const BUDGETS_FILE = path.join(__dirname, '..', 'perf', 'budgets.json');

/** the metrics the gate holds, in table order */
const METRICS = ['calls', 'triangles', 'lights', 'textureMB'];
const ALLOW_KEYS = ['target', 'metric', 'max', 'measured', 'since', 'review', 'owner', 'note'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {string} [file] */
function loadBudgets(file = BUDGETS_FILE) {
	const budgets = JSON.parse(fs.readFileSync(file, 'utf8'));
	const errors = validateBudgets(budgets);
	if (errors.length) throw new Error('perf/budgets.json is invalid:\n  ' + errors.join('\n  '));
	return budgets;
}

/** @param {any} b @returns {string[]} */
function validateBudgets(b) {
	const errors = [];
	if (!b || b.version !== 1) errors.push('version must be 1');
	for (const m of METRICS) if (!Number.isFinite(b?.defaults?.[m])) errors.push(`defaults.${m} must be a number`);
	for (const kind of ['games', 'levels']) {
		for (const [slug, over] of Object.entries(b?.[kind] ?? {})) {
			for (const k of Object.keys(over ?? {})) if (!METRICS.includes(k) && k !== 'note') errors.push(`${kind}.${slug}.${k} is not a gated metric (${METRICS.join(', ')})`);
		}
	}
	const seen = new Set();
	(b?.allow ?? []).forEach((/** @type {any} */ a, /** @type {number} */ i) => {
		const at = `allow[${i}]`;
		for (const k of ALLOW_KEYS) if (a?.[k] === undefined || a?.[k] === '') errors.push(`${at}.${k} is required`);
		if (a?.target && !/^(game|level):[a-z0-9-]+$/.test(a.target)) errors.push(`${at}.target must be game:<slug> or level:<slug> (got ${a.target})`);
		if (a?.metric && !METRICS.includes(a.metric)) errors.push(`${at}.metric must be one of ${METRICS.join(', ')}`);
		if (a?.max !== undefined && !Number.isFinite(a.max)) errors.push(`${at}.max must be a number`);
		for (const k of ['since', 'review']) if (a?.[k] && !DATE.test(a[k])) errors.push(`${at}.${k} must be YYYY-MM-DD`);
		const key = `${a?.target}|${a?.metric}|${a?.view ?? ''}`;
		if (seen.has(key)) errors.push(`${at} duplicates an earlier entry for ${key}`);
		seen.add(key);
	});
	return errors;
}

/** the budget for one target, before any allow entry: defaults < per-target override
 * @param {any} b @param {'game'|'level'} kind @param {string} slug */
function limitsFor(b, kind, slug) {
	const over = b[kind === 'game' ? 'games' : 'levels']?.[slug] ?? {};
	/** @type {Record<string, number>} */
	const out = {};
	for (const m of METRICS) out[m] = Number.isFinite(over[m]) ? over[m] : b.defaults[m];
	return out;
}

/** a view-specific entry wins over a target-wide one
 * @param {any} b @param {string} target @param {string} metric @param {string | undefined} view @returns {any} */
function allowFor(b, target, metric, view) {
	const list = (b.allow ?? []).filter((/** @type {any} */ a) => a.target === target && a.metric === metric);
	return list.find((/** @type {any} */ a) => view && a.view === view) ?? list.find((/** @type {any} */ a) => a.view === undefined) ?? null;
}

/**
 * Judge measured rows. A row is `{kind, slug, view?, calls, triangles, lights, textureMB}` or
 * `{kind, slug, view?, error}` — a probe that could not measure is a FAILURE, never a pass.
 * @param {any} b budgets
 * @param {any[]} rows
 * @param {{today?: string}} [opts]
 */
function judge(b, rows, opts = {}) {
	const today = opts.today ?? new Date().toISOString().slice(0, 10);
	/** @type {{target: string, view: string|null, metric: string, value: number, limit: number, budget: number, allow: any, status: 'ok'|'over'|'allowed'}[]} */
	const checks = [];
	const failures = [];
	const warnings = [];
	const used = new Set();
	for (const r of rows) {
		const target = `${r.kind}:${r.slug}`;
		const where = target + (r.view ? ` @ ${r.view}` : '');
		if (r.error || r.skipped) {
			failures.push(`${where}: NOT MEASURED — ${r.error ?? r.skipped}`);
			continue;
		}
		const limits = limitsFor(b, r.kind, r.slug);
		for (const metric of METRICS) {
			const value = r[metric];
			if (!Number.isFinite(value)) {
				failures.push(`${where}: ${metric} NOT MEASURED`);
				continue;
			}
			const allow = allowFor(b, target, metric, r.view);
			if (allow) used.add(allow);
			const limit = allow ? allow.max : limits[metric];
			const status = value > limit ? 'over' : value > limits[metric] ? 'allowed' : 'ok';
			checks.push({ target, view: r.view ?? null, metric, value, limit, budget: limits[metric], allow, status });
			if (status === 'over')
				failures.push(
					`${where}: ${metric} ${value} > ${limit}` +
						(allow ? ` (the allow-list ceiling of ${allow.since}, owner ${allow.owner}; the budget is ${limits[metric]})` : ' (the budget)')
				);
		}
	}
	for (const a of used) {
		const mine = checks.filter((c) => c.allow === a);
		if (mine.length && mine.every((c) => c.value <= c.budget))
			warnings.push(`allow ${a.target} ${a.metric}${a.view ? ' @ ' + a.view : ''}: now within the budget (${Math.max(...mine.map((c) => c.value))} ≤ ${mine[0].budget}) — remove the entry`);
		if (a.review < today) warnings.push(`allow ${a.target} ${a.metric}${a.view ? ' @ ' + a.view : ''}: review date ${a.review} has passed (owner ${a.owner}) — re-measure and tighten or re-date it`);
	}
	const measured = new Set(rows.map((r) => `${r.kind}:${r.slug}`));
	for (const a of b.allow ?? []) if (!used.has(a) && measured.has(a.target)) warnings.push(`allow ${a.target} ${a.metric}${a.view ? ' @ ' + a.view : ''}: matched no measured row — stale entry`);
	return { ok: failures.length === 0, checks, failures, warnings };
}

/** the gate's report as markdown @param {ReturnType<typeof judge>} verdict */
function report(verdict) {
	const byRow = new Map();
	for (const c of verdict.checks) {
		const k = c.target + '|' + (c.view ?? '');
		if (!byRow.has(k)) byRow.set(k, { target: c.target, view: c.view, cells: {} });
		byRow.get(k).cells[c.metric] = c;
	}
	const cell = (/** @type {any} */ c) => (!c ? '—' : `${c.value}${c.status === 'over' ? ' ❌' : c.status === 'allowed' ? ' (allowed ≤ ' + c.limit + ')' : ''}`);
	let md = '| target | view | ' + METRICS.join(' | ') + ' |\n|---|---|' + METRICS.map(() => '---:').join('|') + '|\n';
	for (const r of byRow.values()) md += `| ${r.target} | ${r.view ?? ''} | ${METRICS.map((m) => cell(r.cells[m])).join(' | ')} |\n`;
	md += '\n' + (verdict.ok ? '**BUDGET GATE: GREEN**' : '**BUDGET GATE: RED**') + '\n';
	for (const f of verdict.failures) md += `- FAIL ${f}\n`;
	for (const w of verdict.warnings) md += `- WARN ${w}\n`;
	return md;
}

module.exports = { BUDGETS_FILE, METRICS, loadBudgets, validateBudgets, limitsFor, judge, report };
