// Roadmap 107 (lane 107-ui-state) — `ui_state` and `scene_stats`, the pure half (a LEAF: imports nothing).
// uiStateTool.js reads the live stores and hands the numbers in here, so every rule below is unit-tested with
// plain objects (tests/unit/uiState.test.js).
//
//   compareTargets   one table of the Statistics ▸ Budget estimate against every device target (Quest, phone,
//                    desktop): green / amber / red per row and what is over, for "will this run on a phone?"
//   snapshotOf       the figures a named snapshot keeps (numbers only, no uuids beyond the heaviest list)
//   diffSnapshots    what changed between two snapshots, figure by figure, with the panel's own names
//   grantsList       the first-use permissions this tab holds, per app, as the person's Settings row says them

/** the most named snapshots one page keeps (oldest dropped first) */
export const SNAPSHOT_MAX = 12;
/** a snapshot name: short, printable */
export const SNAPSHOT_NAME_MAX = 40;

/** the figures a snapshot keeps and a diff compares, with the names the panels use. `from` = which panel shows it */
export const STAT_FIGURES = /** @type {const} */ ([
	{ key: 'objects', name: 'Objects', from: 'Statistics' },
	{ key: 'triangles', name: 'Triangles', from: 'Statistics ▸ Budget' },
	{ key: 'calls', name: 'Draw calls', from: 'Statistics ▸ Budget' },
	{ key: 'textureMB', name: 'Texture memory (MB)', from: 'Statistics ▸ Budget' },
	{ key: 'lights', name: 'Lights', from: 'Statistics ▸ Budget' },
	{ key: 'shadowLights', name: 'Shadow-casting lights', from: 'Statistics ▸ Budget' },
	{ key: 'shadowCasters', name: 'Shadow draws', from: 'Statistics ▸ Budget' },
	{ key: 'frameAvgMs', name: 'Frame time average (ms)', from: 'Profiler' },
	{ key: 'frameP95Ms', name: 'Frame time p95 (ms)', from: 'Profiler' },
	{ key: 'drawnCalls', name: 'Draw calls / frame (drawn)', from: 'Statistics' },
	{ key: 'drawnTriangles', name: 'Triangles / frame (drawn)', from: 'Statistics' },
	{ key: 'textures', name: 'Textures', from: 'Statistics' },
	{ key: 'geometries', name: 'Geometries', from: 'Statistics' },
	{ key: 'qualityLevel', name: 'Quality level (0 = full)', from: 'Quality' }
]);

/** the three device targets the Budget section judges for (budgetMeterCore TARGET_IDS), in its order */
export const TARGET_WORDS = /** @type {Record<string, string>} */ ({
	quest: 'Quest / VR',
	phone: 'Phone',
	desktop: 'Desktop'
});

/** what a person may call a target @param {unknown} v @returns {'quest'|'phone'|'desktop'|null} */
export function targetOf(v) {
	const s = String(v ?? '')
		.toLowerCase()
		.replace(/[^a-z]/g, '');
	if (
		s === 'quest' ||
		s === 'vr' ||
		s === 'questvr' ||
		s === 'headset' ||
		s === 'meta' ||
		s === 'metaquest'
	)
		return 'quest';
	if (s === 'phone' || s === 'mobile' || s === 'android' || s === 'iphone') return 'phone';
	if (s === 'desktop' || s === 'pc' || s === 'computer' || s === 'laptop') return 'desktop';
	return null;
}

/** @param {number} n */
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * One row per target: the verdict the Budget section shows for it, and every row that is not green.
 * @param {Record<string, {tier: string, percent: number, worst: {key: string, label: string}, rows: {key: string, label: string, value: number, limit: number, tier: string}[]}>} verdicts
 *   target id -> budgetMeterCore.judgeCost's answer for the same reading
 * @param {string} [current] the target the person's Statistics judges for now
 */
export function compareTargets(verdicts, current) {
	const rows = [];
	for (const id of Object.keys(TARGET_WORDS)) {
		const v = verdicts?.[id];
		if (!v) continue;
		const over = (v.rows ?? [])
			.filter((r) => r.tier !== 'green')
			.map((r) => r.label + ' ' + r.tier + ' (' + fmt(r.value) + ' of ' + fmt(r.limit) + ')');
		rows.push({
			target: id,
			name: TARGET_WORDS[id],
			tier: v.tier,
			percent: v.percent,
			worst: v.worst?.label ?? null,
			...(over.length ? { over } : {}),
			...(current === id ? { judgedNow: true } : {})
		});
	}
	const red = rows.filter((r) => r.tier === 'red').map((r) => r.name);
	const amber = rows.filter((r) => r.tier === 'amber').map((r) => r.name);
	const say = !rows.length
		? 'No reading yet.'
		: !red.length && !amber.length
			? 'Fits every device: Quest, phone and desktop are green.'
			: (red.length ? 'Over the budget on ' + red.join(' and ') + '. ' : '') +
				(amber.length ? 'Close to the limit on ' + amber.join(' and ') + '.' : '');
	return { rows, say: say.trim() };
}

/** @param {number} n */
function fmt(n) {
	if (!Number.isFinite(n)) return 'no limit';
	if (Math.abs(n) >= 1e6) return r1(n / 1e6) + 'M';
	if (Math.abs(n) >= 1e4) return Math.round(n / 1e3) + 'k';
	return String(r1(n));
}

/**
 * What a snapshot keeps: the numbers only (a later diff reads these), plus the heaviest few by name.
 * @param {string} name @param {Record<string, any>} figures @param {number} at ms since 1970
 * @param {{name: string, triangles?: number, calls?: number}[]} [heaviest]
 */
export function snapshotOf(name, figures, at, heaviest = []) {
	/** @type {Record<string, number>} */
	const kept = {};
	for (const f of STAT_FIGURES) {
		const v = figures?.[f.key];
		if (typeof v === 'number' && Number.isFinite(v)) kept[f.key] = r1(v);
	}
	return {
		name: cleanName(name),
		at,
		figures: kept,
		heaviest: (heaviest ?? [])
			.slice(0, 5)
			.map((h) => ({
				name: String(h.name ?? '').slice(0, 60),
				...(Number.isFinite(h.triangles) ? { triangles: h.triangles } : {}),
				...(Number.isFinite(h.calls) ? { calls: h.calls } : {})
			}))
	};
}

/** a snapshot name the store accepts ('' = make one up) @param {unknown} name */
export function cleanName(name) {
	return String(name ?? '')
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, SNAPSHOT_NAME_MAX);
}

/**
 * Keep a snapshot: same name replaces, the oldest goes past SNAPSHOT_MAX. PURE: returns the new list.
 * @param {{name: string, at: number}[]} list @param {{name: string, at: number}} snap
 */
export function keepSnapshot(list, snap) {
	const rest = (list ?? []).filter((s) => s.name.toLowerCase() !== snap.name.toLowerCase());
	return [...rest, snap].slice(-SNAPSHOT_MAX);
}

/**
 * Figure by figure, what changed from `a` to `b` (b - a), the panel's names, the biggest change first.
 * @param {{name: string, at: number, figures: Record<string, number>}} a
 * @param {{name: string, at: number, figures: Record<string, number>}} b
 */
export function diffSnapshots(a, b) {
	const changes = [];
	for (const f of STAT_FIGURES) {
		const was = a?.figures?.[f.key];
		const now = b?.figures?.[f.key];
		if (typeof was !== 'number' || typeof now !== 'number') continue;
		const by = r1(now - was);
		if (by === 0) continue;
		const pct = was !== 0 ? Math.round((by / Math.abs(was)) * 100) : null;
		changes.push({ figure: f.name, was, now, by, ...(pct !== null ? { percent: pct } : {}) });
	}
	changes.sort((x, y) => Math.abs(y.percent ?? 100) - Math.abs(x.percent ?? 100));
	const top = changes
		.slice(0, 3)
		.map(
			(c) =>
				c.figure.replace(/ \(.*\)$/, '') +
				' ' +
				(c.by > 0 ? 'up' : 'down') +
				' ' +
				(c.percent !== undefined ? Math.abs(c.percent) + '%' : Math.abs(c.by))
		);
	return {
		from: a?.name,
		to: b?.name,
		seconds: Math.round(((b?.at ?? 0) - (a?.at ?? 0)) / 1000),
		changes,
		say: changes.length
			? 'From "' + a?.name + '" to "' + b?.name + '": ' + top.join(', ') + '.'
			: 'Nothing changed between "' + a?.name + '" and "' + b?.name + '".'
	};
}

/** the first-use kinds, as the person's Settings rows name them (showCore.KIND_WORDS' meaning) */
export const GRANT_WORDS = /** @type {Record<string, string>} */ ({
	panel: 'open and close panels',
	camera: 'move the view',
	code: 'open code'
});

/**
 * The first-use answers this tab holds, per app: Always (stored on this device), This time and No (this page). PURE.
 * @param {string[]} kinds @param {Record<string, string[]>} always app -> the kinds stored as Always
 * @param {Iterable<[string, string]>} session `kind\napp` -> 'session' | 'no' (showTool's page answers)
 */
export function grantsList(kinds, always, session) {
	/** @type {{kind: string, what: string, answer: 'always'|'this time'|'no', app: string}[]} */
	const out = [];
	for (const [app, list] of Object.entries(always ?? {}))
		for (const kind of kinds)
			if (list.includes(kind))
				out.push({ kind, what: GRANT_WORDS[kind] ?? kind, answer: 'always', app });
	for (const [key, value] of session) {
		const [kind, app = ''] = String(key).split('\n');
		if (!kinds.includes(kind)) continue;
		if (value === 'session' && (always?.[app] ?? []).includes(kind)) continue; // Always already covers it
		out.push({
			kind,
			what: GRANT_WORDS[kind] ?? kind,
			answer: value === 'no' ? 'no' : 'this time',
			app
		});
	}
	return out;
}
