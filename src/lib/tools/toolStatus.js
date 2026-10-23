// 59 T4/T5 — THE TOOLS & CONNECTIONS REGISTRY: one list of everything outside the app (chat and
// mesh providers, voice typing, desktop tools; later the animation providers, the AI box and the
// agents), and one answer to "can this feature run here, and if not, what is missing?".
//
// A LEAF (svelte/store only), so the Settings page, every button that needs a tool, the assistant's
// system prompt and a unit test all read the same thing without an import family behind it.
//
// TWO KINDS OF ENTRY:
//   - a ROW SOURCE per section: a readable of rows. A row is one tool the user can set up — a status
//     dot, a Test, Enable / Disable and the FEATURES it turns on. A source, not a static row,
//     because most sections are lists the user grows (one row per provider). A later roadmap adds
//     its section's rows with ONE call (`registerToolRows('animation', store)`): the page renders
//     every section that has a source, in TOOL_SECTIONS order.
//   - a FEATURE: something a button does that needs a tool ("Generate 3D model" needs a Mesh
//     provider). Buttons for a missing tool STAY VISIBLE and say what is missing (T5) — they ask
//     `featureStatus(id)` rather than hiding themselves, and the assistant lists the same answers.
//
// LOCAL: nothing here is sent, saved in a scene or undone. Each source keeps its own stores and
// storage keys (the providers' keys did not move when their Settings sections did).
import { writable, derived, get } from 'svelte/store';

/** @typedef {'ready'|'off'|'setup'|'error'|'unknown'} ToolState */

/**
 * @typedef {{
 *   id: string,
 *   section: string,
 *   label: string,
 *   detail?: string,
 *   state: ToolState,
 *   stateText: string,
 *   features: string[],
 *   enabled?: boolean | null,
 *   setEnabled?: (on: boolean) => void,
 *   test?: () => Promise<{ok: boolean, detail: string}>,
 *   configure?: () => void,
 *   form?: {kind: string, ref?: any}
 * }} ToolRow
 */

/** @typedef {{id: string, label: string, description: string}} ToolSection */

/** the page's sections, in order — a section shows once something registered rows for it */
/** @type {ToolSection[]} */
export const TOOL_SECTIONS = [
	{
		id: 'chat',
		label: 'Chat providers',
		description: 'The models behind the AI assistant, the quick prompt bar and voice typing.'
	},
	{
		id: 'mesh',
		label: 'Mesh providers',
		description: 'Text → 3D models from the Add menu or the assistant.'
	},
	{
		id: 'animation',
		label: 'Animation providers',
		description: 'Rig a model and generate animation clips.'
	},
	{
		id: 'aibox',
		label: 'theprototype AI box',
		description: 'Your own GPU box: health, models, licences.'
	},
	{
		id: 'agents',
		label: 'Agents',
		description:
			'Coding agents connected to this session, the invite link and the MCP setup command.'
	},
	{
		id: 'desktop',
		label: 'Desktop tools',
		description: 'Blender and other 3D tools: edit a model there and drop it back.'
	}
];

/** a section's title for the user ('mesh' → 'Mesh providers') @param {string} id */
export function sectionLabel(id) {
	return TOOL_SECTIONS.find((s) => s.id === id)?.label ?? id;
}

// ---- rows ------------------------------------------------------------------------------------

/** @type {import('svelte/store').Writable<{section: string, rows: import('svelte/store').Readable<ToolRow[]>, add?: {label: string, onclick?: () => void, form?: string}}[]>} */
const sources = writable([]);

/**
 * Register a section's rows. Returns the unregister function.
 * @param {string} section a TOOL_SECTIONS id (an unknown one renders after the known ones)
 * @param {import('svelte/store').Readable<ToolRow[]>} rows
 * @param {{add?: {label: string, onclick?: () => void, form?: string}}} [opts] the section's "Add …" row
 * @returns {() => void}
 */
export function registerToolRows(section, rows, opts = {}) {
	const entry = { section, rows, add: opts.add };
	sources.update((list) => [...list, entry]);
	return () => sources.update((list) => list.filter((e) => e !== entry));
}

const ORDER = (/** @type {string} */ id) => {
	const i = TOOL_SECTIONS.findIndex((s) => s.id === id);
	return i < 0 ? TOOL_SECTIONS.length : i;
};

/**
 * Every section that has rows registered, in page order, with its rows and its add action.
 * @type {import('svelte/store').Readable<{section: ToolSection, rows: ToolRow[], adds: {label: string, onclick?: () => void, form?: string}[]}[]>}
 */
export const toolSections = derived(sources, (list, set) => {
	const stores = list.map((e) => e.rows);
	if (!stores.length) {
		set([]);
		return;
	}
	return derived(stores, (values) => {
		/** @type {Map<string, {section: ToolSection, rows: ToolRow[], adds: any[]}>} */
		const by = new Map();
		list.forEach((e, i) => {
			const meta = TOOL_SECTIONS.find((s) => s.id === e.section) ?? {
				id: e.section,
				label: e.section,
				description: ''
			};
			if (!by.has(e.section)) by.set(e.section, { section: meta, rows: [], adds: [] });
			const slot = /** @type {any} */ (by.get(e.section));
			slot.rows.push(...(values[i] ?? []));
			if (e.add) slot.adds.push(e.add);
		});
		return [...by.values()].sort((a, b) => ORDER(a.section.id) - ORDER(b.section.id));
	}).subscribe(set);
});

/** the last Test result per row id (in memory: a Test is a question about NOW) */
/** @type {import('svelte/store').Writable<Record<string, {ok: boolean, detail: string, at: number}>>} */
export const toolTests = writable({});

/** Run a row's Test and remember its answer. @param {ToolRow} row */
export async function runToolTest(row) {
	if (!row.test) return null;
	let result;
	try {
		result = await row.test();
	} catch (err) {
		result = { ok: false, detail: String(/** @type {any} */ (err)?.message ?? err) };
	}
	const entry = { ok: !!result?.ok, detail: String(result?.detail ?? ''), at: Date.now() };
	toolTests.update((m) => ({ ...m, [row.id]: entry }));
	return entry;
}

/** The dot a row shows: a failed Test turns a ready row red until the next Test passes. @param {ToolRow} row @param {Record<string, {ok: boolean}>} [tests] */
export function rowState(row, tests = get(toolTests)) {
	const t = tests[row.id];
	if (t && !t.ok && row.state === 'ready') return 'error';
	return row.state;
}

// ---- features --------------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   section: string,
 *   needs: string,
 *   fix?: string,
 *   ready: import('svelte/store').Readable<boolean>,
 *   row?: () => string | null
 * }} ToolFeature
 */

/** @type {import('svelte/store').Writable<ToolFeature[]>} */
const features = writable([]);

/**
 * Register a feature that needs a tool. `needs` completes "<label> needs …" ("a Mesh provider").
 * @param {ToolFeature} feature @returns {() => void}
 */
export function registerFeature(feature) {
	features.update((list) => [...list.filter((f) => f.id !== feature.id), feature]);
	return () => features.update((list) => list.filter((f) => f !== feature));
}

/**
 * @typedef {{id: string, label: string, section: string, ready: boolean, needs: string, message: string, row: string | null}} FeatureStatus
 */

/** @param {ToolFeature} f @returns {FeatureStatus} */
function statusOf(f) {
	const ready = !!get(f.ready);
	return {
		id: f.id,
		label: f.label,
		section: f.section,
		ready,
		needs: f.needs,
		message: ready ? '' : missingMessage(f.label, f.needs, f.fix),
		row: f.row?.() ?? null
	};
}

/** "Generate 3D model needs a Mesh provider: set one up in Settings ▸ Tools & connections."
 * @param {string} label @param {string} needs @param {string} [fix] what to do (default "set one up") */
export function missingMessage(label, needs, fix = 'set one up') {
	return `${label} needs ${needs}: ${fix} in Settings ▸ Tools & connections.`;
}

/** What a feature needs right now; an unregistered id reads as ready (nothing to explain). @param {string} id @returns {FeatureStatus} */
export function featureStatus(id) {
	const f = get(features).find((x) => x.id === id);
	return f
		? statusOf(f)
		: { id, label: id, section: '', ready: true, needs: '', message: '', row: null };
}

/** Every feature's status, live. @type {import('svelte/store').Readable<FeatureStatus[]>} */
export const featureStatuses = derived(features, (list, set) => {
	if (!list.length) {
		set([]);
		return;
	}
	return derived(
		list.map((f) => f.ready),
		() => list.map(statusOf)
	).subscribe(set);
});

/**
 * The lines the AI assistant (and, later, agents) read: what can and cannot run here.
 * @returns {{ready: FeatureStatus[], missing: FeatureStatus[]}}
 */
export function toolSummary() {
	const all = get(features).map(statusOf);
	return { ready: all.filter((f) => f.ready), missing: all.filter((f) => !f.ready) };
}

// ---- where the page should land -------------------------------------------------------------

/** the row (or section) Settings ▸ Tools & connections scrolls to and flashes; `at` makes a repeat a change */
/** @type {import('svelte/store').Writable<{section: string, row: string | null, at: number} | null>} */
export const toolsFocus = writable(null);

/** TEST: forget every registration (unit tests only) */
export function _resetToolRegistry() {
	sources.set([]);
	features.set([]);
	toolTests.set({});
	toolsFocus.set(null);
}
