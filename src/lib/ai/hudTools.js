// Roadmap 85 H1 / H2 + `hud {panel}` — THE HUD TOOLS (agent, connector and the in-app assistant).
//
//   create_hud   screens and their elements (text, bar, image, button, timer, slider … any registered kind),
//                anchors, style, showWhile; returns the element ids a hudtext / hudbar / hudtimer node binds to
//   edit_hud     change, move or remove elements; rename, show / hide rules, make active or remove screens
//   list_hud     what is there (screens, elements, what each element is bound to) so an agent edits a person's HUD
//   hud_panel    a backdrop with rows laid out inside it (a settings menu, a scoreboard) — generic, 67 reuses it
//
// Every write goes through hudDocs' single write path inside ONE hud gesture, so a call is one undo step and one
// broadcast exactly like a drag in the HUD editor; the viewer gate, the A8 log and the batch are the caller's.
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore.js';
import { HUD_KINDS, fieldsForKind, kindDef } from '$lib/hudKinds';
import { hudDocOf, hudDocs, setHudDocFor, normalizeHudDoc, newElementId, HUD_SCENE_KEY } from '$lib/hudDocs';
import {
	HUD_ANCHOR_NAMES,
	HUD_STYLE_KEYS,
	MAX_ELEMENTS_PER_CALL,
	MAX_ROWS_PER_PANEL,
	MAX_SCREENS_PER_CALL,
	SHOW_WHILE,
	describeHudDoc,
	planElement,
	planElementPatch,
	planPanel,
	rowPlacement
} from './hudToolsCore.js';

export const HUD_TOOL_NAMES = ['create_hud', 'edit_hud', 'list_hud', 'hud_panel'];
export const HUD_READ_TOOLS = ['list_hud'];

/** the registry, as the pure planner wants it */
const REG = {
	kinds: /** @type {string[]} */ ([...HUD_KINDS]),
	fieldsOf: (/** @type {string} */ kind) => fieldsForKind(kind).map((/** @type {any} */ f) => f.key),
	heightOf: (/** @type {string} */ kind) => kindDef(kind)?.defaultSize?.h ?? 28
};

/** which HUD document: the scene's, or one attached to a camera object @param {any} args @returns {{key: string} | {error: string}} */
function docKeyOf(args) {
	const cam = args?.camera;
	if (cam === undefined || cam === null || cam === '' || cam === HUD_SCENE_KEY) return { key: HUD_SCENE_KEY };
	if (typeof cam !== 'string') return { error: 'camera: a camera object uuid (list_scene), or leave it out for the scene HUD' };
	const object = get(objectsGroup)?.getObjectByProperty('uuid', cam);
	if (!object) return { error: 'camera: no object ' + cam.slice(0, 40) };
	return { key: cam };
}

/** @param {any} doc @param {any} want id or name @returns {any} */
function findScreen(doc, want) {
	if (!doc || want === undefined || want === null || want === '') return null;
	const s = String(want);
	return doc.screens.find((/** @type {any} */ x) => x.id === s) ?? doc.screens.find((/** @type {any} */ x) => x.name.toLowerCase() === s.toLowerCase()) ?? null;
}

/** @param {any} doc @param {string} elementId @returns {{screen: any, element: any} | null} */
function findElement(doc, elementId) {
	for (const screen of doc?.screens ?? []) {
		const element = screen.elements.find((/** @type {any} */ e) => e.id === elementId);
		if (element) return { screen, element };
	}
	return null;
}

/**
 * Run `fn` on a working copy of the document and write it ONCE (one hud gesture → one undo step, one message).
 * @param {string} key @param {(doc: any, fresh: boolean) => any} fn returns the result, or {error} to write nothing
 */
async function editDoc(key, fn) {
	const { beginHudGesture, endHudGesture } = await import('$lib/hudSync');
	const existing = hudDocOf(key);
	// 85 H1: a scene with no HUD starts with NO screens here, so the agent's first screen is the only one
	const working = existing ? JSON.parse(JSON.stringify(existing)) : { screens: [], active: '' };
	const result = fn(working, !existing);
	if (result && result.error) return result;
	if (!working.screens.length) return { error: 'nothing to write: give at least one screen with elements' };
	beginHudGesture(key);
	try {
		setHudDocFor(key, working);
	} finally {
		endHudGesture(key);
	}
	return result;
}

/** @param {any} screen @param {any} spec @returns {string | null} an error */
function applyScreenFields(screen, spec) {
	if (spec.showWhile !== undefined) {
		const sw = spec.showWhile === null ? '' : String(spec.showWhile);
		if (!SHOW_WHILE.includes(sw)) return 'showWhile: one of "menu", "playing", "paused", "over", or "" (only when a node shows it)';
		screen.showWhile = sw;
	}
	if (spec.input !== undefined) {
		if (spec.input !== 'menu' && spec.input !== 'game') return 'input: "menu" (frees the mouse to click this screen in Play) or "game"';
		screen.input = spec.input;
	}
	return null;
}

/** add planned elements to a screen, minting ids @param {any} screen @param {any[]} specs @param {string[]} warnings @param {any[]} out */
function addElements(screen, specs, warnings, out) {
	for (const [i, spec] of specs.entries()) {
		const planned = planElement(spec, REG);
		if ('error' in planned) return 'elements[' + i + ']: ' + planned.error;
		warnings.push(...planned.warnings.map((m) => 'elements[' + i + ']: ' + m));
		/** @type {any} */
		const el = { id: newElementId(planned.element.kind), ...planned.element };
		screen.elements.push(el);
		out.push({ id: el.id, kind: el.kind, ...(el.label ? { text: el.label } : {}), screen: screen.id });
	}
	return null;
}

/** a fresh screen id @param {any} doc */
function newScreenId(doc) {
	return 'screen-' + (doc.screens.length + 1) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/** @param {any} args */
async function createHudTool(args) {
	const where = docKeyOf(args);
	if ('error' in where) return { error: where.error };
	/** @type {any[]} */
	let screensIn = Array.isArray(args?.screens) ? args.screens : [];
	if (!screensIn.length && (args?.screen !== undefined || Array.isArray(args?.elements))) screensIn = [{ name: args?.screen, elements: args?.elements, active: args?.active, showWhile: args?.showWhile, input: args?.input }];
	if (!screensIn.length) return { error: 'give screens: [{"name": "Race", "elements": [{"kind": "timer"}, {"kind": "text", "text": "Score: 0"}]}]' };
	if (screensIn.length > MAX_SCREENS_PER_CALL) return { error: 'at most ' + MAX_SCREENS_PER_CALL + ' screens in one call' };
	const total = screensIn.reduce((n, s) => n + (Array.isArray(s?.elements) ? s.elements.length : 0), 0);
	if (total > MAX_ELEMENTS_PER_CALL) return { error: 'at most ' + MAX_ELEMENTS_PER_CALL + ' elements in one call' };
	/** @type {string[]} */
	const warnings = [];
	return editDoc(where.key, (doc, fresh) => {
		/** @type {any[]} */
		const screens = [];
		/** @type {any[]} */
		const elements = [];
		let activate = '';
		for (const [i, spec] of screensIn.entries()) {
			if (!spec || typeof spec !== 'object') return { error: 'screens[' + i + ']: an object like {"name": "Race", "elements": [...]}' };
			let screen = findScreen(doc, spec.id ?? spec.name);
			const created = !screen;
			if (!screen) {
				const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim().slice(0, 60) : 'Screen ' + (doc.screens.length + 1);
				screen = { id: newScreenId(doc), name, showWhile: '', input: 'game', elements: [] };
				doc.screens.push(screen);
			}
			const bad = applyScreenFields(screen, spec);
			if (bad) return { error: 'screens[' + i + ']: ' + bad };
			const err = addElements(screen, Array.isArray(spec.elements) ? spec.elements : [], warnings, elements);
			if (err) return { error: 'screens[' + i + '].' + err };
			screens.push({ id: screen.id, name: screen.name, created });
			// 85 H1 (the tester's trap): a new screen is the one that shows — when asked, when the HUD is new, or
			// when the screen showing now is empty (the stray `main` addHudScreen used to leave active)
			const current = findScreen(doc, doc.active);
			if (spec.active === true || (spec.active !== false && created && (fresh || !current || !current.elements.length) && !activate)) activate = screen.id;
		}
		if (activate) doc.active = activate;
		return {
			hud: where.key,
			screens,
			elements,
			active: doc.active,
			note: 'Bind a live value with create_flow_nodes: a hudtext / hudbar / hudtimer node whose element is one of these ids (e.g. counter -> hudtext).',
			...(warnings.length ? { warnings } : {})
		};
	});
}

/** @param {any} args */
async function editHudTool(args) {
	const where = docKeyOf(args);
	if ('error' in where) return { error: where.error };
	if (!hudDocOf(where.key)) return { error: 'there is no HUD here yet: create_hud first' };
	const updates = Array.isArray(args?.updates) ? args.updates : [];
	const remove = Array.isArray(args?.remove) ? args.remove.map(String) : [];
	const screensIn = Array.isArray(args?.screens) ? args.screens : [];
	if (!updates.length && !remove.length && !screensIn.length) return { error: 'nothing to change: give updates, remove or screens' };
	if (updates.length > MAX_ELEMENTS_PER_CALL) return { error: 'at most ' + MAX_ELEMENTS_PER_CALL + ' updates in one call' };
	/** @type {string[]} */
	const warnings = [];
	return editDoc(where.key, (doc) => {
		/** @type {any[]} */
		const updated = [];
		/** @type {string[]} */
		const removed = [];
		for (const [i, u] of updates.entries()) {
			const found = findElement(doc, String(u?.id ?? ''));
			if (!found) return { error: 'updates[' + i + ']: no element "' + String(u?.id ?? '').slice(0, 40) + '" (list_hud)' };
			const { id: _id, screen: moveTo, ...fields } = u;
			const planned = planElementPatch(fields, found.element.kind, REG);
			if ('error' in planned) return { error: 'updates[' + i + ']: ' + planned.error };
			warnings.push(...planned.warnings.map((m) => 'updates[' + i + ']: ' + m));
			const { style, ...rest } = planned.patch;
			// a panel carries its rows: a move of the panel moves them by the same amount
			if (found.element.kind === 'panel' && (rest.x !== undefined || rest.y !== undefined || rest.anchor !== undefined)) {
				const dx = (rest.x ?? found.element.x) - found.element.x;
				const dy = (rest.y ?? found.element.y) - found.element.y;
				for (const row of found.screen.elements) {
					if (row.panel !== found.element.id) continue;
					if (rest.anchor !== undefined && rest.anchor !== found.element.anchor) {
						warnings.push('the panel\'s rows keep their own anchor: move them with updates too');
						break;
					}
					row.x += dx;
					row.y += dy;
				}
			}
			Object.assign(found.element, rest);
			if (style) found.element.style = { ...(found.element.style ?? {}), ...style };
			if (moveTo !== undefined) {
				const target = findScreen(doc, moveTo);
				if (!target) return { error: 'updates[' + i + '].screen: no screen "' + String(moveTo).slice(0, 40) + '"' };
				if (target !== found.screen) {
					found.screen.elements = found.screen.elements.filter((/** @type {any} */ e) => e !== found.element);
					target.elements.push(found.element);
				}
			}
			updated.push({ id: found.element.id, ok: true });
		}
		for (const id of remove) {
			const found = findElement(doc, id);
			if (!found) {
				warnings.push('remove: no element "' + id.slice(0, 40) + '"');
				continue;
			}
			// removing a panel removes its rows with it
			const drop = new Set([id, ...(found.element.kind === 'panel' ? found.screen.elements.filter((/** @type {any} */ e) => e.panel === id).map((/** @type {any} */ e) => e.id) : [])]);
			found.screen.elements = found.screen.elements.filter((/** @type {any} */ e) => !drop.has(e.id));
			removed.push(...drop);
		}
		/** @type {any[]} */
		const screens = [];
		for (const [i, s] of screensIn.entries()) {
			const screen = findScreen(doc, s?.id ?? s?.name);
			if (!screen) return { error: 'screens[' + i + ']: no screen "' + String(s?.id ?? s?.name ?? '').slice(0, 40) + '" (list_hud)' };
			if (s.remove === true) {
				if (doc.screens.length <= 1) return { error: 'screens[' + i + ']: a HUD keeps at least one screen' };
				doc.screens = doc.screens.filter((/** @type {any} */ x) => x !== screen);
				if (doc.active === screen.id) doc.active = doc.screens[0].id;
				screens.push({ id: screen.id, removed: true });
				continue;
			}
			if (typeof s.rename === 'string' && s.rename.trim()) screen.name = s.rename.trim().slice(0, 60);
			const bad = applyScreenFields(screen, s);
			if (bad) return { error: 'screens[' + i + ']: ' + bad };
			if (s.active === true) doc.active = screen.id;
			else if (s.active === false && doc.active === screen.id) doc.active = '';
			screens.push({ id: screen.id, name: screen.name, ok: true });
		}
		return { hud: where.key, updated, ...(removed.length ? { removed } : {}), ...(screens.length ? { screens } : {}), active: doc.active, ...(warnings.length ? { warnings } : {}) };
	});
}

/** @param {any} args */
async function listHudTool(args) {
	const where = docKeyOf(args);
	if ('error' in where) return { error: where.error };
	const keys = args?.camera ? [where.key] : Object.keys(get(hudDocs));
	if (!keys.length) return { huds: [], note: 'no HUD yet: create_hud makes one' };
	/** @type {(id: string) => string[]} */
	let boundBy = () => [];
	try {
		const { bindingsFor } = await import('$lib/hudActions');
		boundBy = (id) =>
			bindingsFor(id)
				.map((b) => (b.role === 'drives' ? b.label + (b.source ? ' ← ' + b.source : '') : b.role + ' → ' + b.label))
				.slice(0, 6);
	} catch {
		/* the bindings are a courtesy */
	}
	return {
		huds: keys
			.map((key) => {
				const doc = hudDocOf(key);
				return doc ? { hud: key, ...describeHudDoc(normalizeHudDoc(doc), boundBy) } : null;
			})
			.filter(Boolean)
	};
}

/** @param {any} args */
async function hudPanelTool(args) {
	const where = docKeyOf(args);
	if ('error' in where) return { error: where.error };
	const plan = planPanel(args ?? {}, REG);
	if ('error' in plan) return { error: plan.error };
	return editDoc(where.key, (doc, fresh) => {
		let screen = findScreen(doc, args?.screen ?? doc.active);
		let created = false;
		if (!screen) {
			const name = typeof args?.screen === 'string' && args.screen.trim() ? args.screen.trim().slice(0, 60) : 'Panel';
			screen = { id: newScreenId(doc), name, showWhile: '', input: 'game', elements: [] };
			doc.screens.push(screen);
			created = true;
		}
		const bad = applyScreenFields(screen, args ?? {});
		if (bad) return { error: bad };
		/** @type {any} */
		const panel = { id: newElementId('panel'), ...plan.panel };
		screen.elements.push(panel);
		/** @type {any[]} */
		const rows = [];
		for (const row of plan.rows) {
			const placed = rowPlacement(panel, /** @type {any} */ (row));
			/** @type {any} */
			const el = { ...row, id: newElementId(row.kind), panel: panel.id, ...placed };
			screen.elements.push(el);
			rows.push({ id: el.id, kind: el.kind, ...(el.label ? { text: el.label } : {}) });
		}
		if (created && (fresh || args?.active !== false)) doc.active = screen.id;
		else if (args?.active === true) doc.active = screen.id;
		return { hud: where.key, screen: { id: screen.id, name: screen.name, created }, panel: panel.id, rows, active: doc.active, ...(plan.warnings.length ? { warnings: plan.warnings } : {}) };
	});
}

/** @param {string} name @param {any} args */
export async function hudTool(name, args) {
	switch (name) {
		case 'create_hud':
			return createHudTool(args ?? {});
		case 'edit_hud':
			return editHudTool(args ?? {});
		case 'list_hud':
			return listHudTool(args ?? {});
		case 'hud_panel':
			return hudPanelTool(args ?? {});
		default:
			return { error: 'unknown HUD tool ' + name };
	}
}

// ---- schemas --------------------------------------------------------------------------------

const KIND_WORDS = 'text, bar, image, button, timer, list, slider, toggle, dropdown, textfield, panel, crosshair, minimap, progressradial, iconrow, hotbar, keyhint …';
const ELEMENT_SCHEMA = {
	type: 'object',
	description:
		'one HUD element: kind (' +
		KIND_WORDS +
		'), text, anchor (' +
		HUD_ANCHOR_NAMES.join(' / ') +
		') + x / y pixel offsets from that corner or edge, w / h in pixels, style {' +
		HUD_STYLE_KEYS.join(', ') +
		'}, plus the kind\'s own fields (bar: min, max, value, orientation; timer: duration, countDown; image: src = a library image hash; slider: min, max, value; dropdown: options; button: enabled)',
	properties: {
		kind: { type: 'string' },
		text: { type: 'string' },
		anchor: { type: 'string', enum: HUD_ANCHOR_NAMES },
		x: { type: 'number' },
		y: { type: 'number' },
		w: { type: 'number' },
		h: { type: 'number' },
		style: { type: 'object' }
	}
};
const CAMERA_SCHEMA = { type: 'string', description: 'a camera object uuid: the HUD shows only while looking through that camera (default: the scene HUD)' };
const SCREEN_FIELDS = {
	showWhile: { type: 'string', enum: SHOW_WHILE, description: 'show this screen while the game is menu / playing / paused / over ("" = only when a hudscreen node shows it)' },
	input: { type: 'string', enum: ['game', 'menu'], description: 'menu = the mouse is free to click this screen in Play' },
	active: { type: 'boolean', description: 'the screen that shows by default' }
};

export const HUD_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'create_hud',
			description:
				'Give the game a HUD (2D screen overlay): screens of elements — a timer, a score text, a health bar, buttons, an image. A screen named like an existing one gets the elements added. Returns every element id: bind live values with create_flow_nodes (a hudtext / hudbar / hudtimer node with data.element = the id, e.g. counter -> hudtext). A new screen becomes the one that shows unless active: false. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					screens: {
						type: 'array',
						maxItems: MAX_SCREENS_PER_CALL,
						items: {
							type: 'object',
							properties: { name: { type: 'string' }, ...SCREEN_FIELDS, elements: { type: 'array', maxItems: MAX_ELEMENTS_PER_CALL, items: ELEMENT_SCHEMA } }
						}
					},
					camera: CAMERA_SCHEMA
				},
				required: ['screens']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'edit_hud',
			description:
				'Change a HUD that exists (list_hud first): updates = [{id, …any element field to change, screen?: move it to that screen}], remove = element ids (a panel takes its rows with it), screens = [{id or name, rename?, showWhile?, input?, active?, remove?: true}]. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					updates: { type: 'array', maxItems: MAX_ELEMENTS_PER_CALL, items: { ...ELEMENT_SCHEMA, properties: { id: { type: 'string' }, screen: { type: 'string' }, ...ELEMENT_SCHEMA.properties } } },
					remove: { type: 'array', items: { type: 'string' } },
					screens: {
						type: 'array',
						items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, rename: { type: 'string' }, remove: { type: 'boolean' }, ...SCREEN_FIELDS } }
					},
					camera: CAMERA_SCHEMA
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_hud',
			description: 'Read the HUD: its screens (which one shows, showWhile), every element (id, kind, text, place, size) and what each element is bound to. Read this before editing a HUD a person made.',
			parameters: { type: 'object', properties: { camera: CAMERA_SCHEMA } }
		}
	},
	{
		type: 'function',
		function: {
			name: 'hud_panel',
			description:
				'A panel on the HUD: a backdrop box with a title and rows laid out top-down inside it (a settings menu with sliders and toggles, a scoreboard, a start menu with buttons). Goes on `screen` (made if missing) or the screen showing. Returns the panel id and each row id; moving or removing the panel with edit_hud moves or removes its rows. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					rows: { type: 'array', maxItems: MAX_ROWS_PER_PANEL, items: ELEMENT_SCHEMA },
					screen: { type: 'string', description: 'screen id or name (made when missing)' },
					anchor: { type: 'string', enum: HUD_ANCHOR_NAMES, description: 'default center' },
					x: { type: 'number' },
					y: { type: 'number' },
					w: { type: 'number', description: 'default 260' },
					h: { type: 'number', description: 'default: fits the rows' },
					gap: { type: 'number' },
					pad: { type: 'number' },
					style: { type: 'object', description: 'the backdrop: bg, border, radius, opacity' },
					...SCREEN_FIELDS,
					camera: CAMERA_SCHEMA
				},
				required: ['rows']
			}
		}
	}
];

export const HUD_PROMPT =
	'\n\nHUD: create_hud adds screens of 2D elements (timer, score text, bars, buttons) and returns their ids; bind live values with hudtext / hudbar / hudtimer flow nodes whose element is that id. hud_panel lays out a menu or scoreboard; list_hud / edit_hud read and change what is there.';
