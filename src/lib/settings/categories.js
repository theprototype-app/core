// 37-settings (R21) — WHERE A SETTINGS CATEGORY SITS. A LEAF (imports nothing): the grouped menu,
// the page descriptions and the mobile list read it; the sections themselves still REGISTER
// (settingsNav), so a section another lane adds with one line still appears — under "More",
// before About, until it is given a place here.
//
// The key is the section's deep-link key (`sectionKeyOf(label)`: 'Touch controls' → 'touchcontrols';
// `settingsSection` also accepts a prefix, 'touch').

/** @typedef {{id: string, label: string}} SettingsGroup */
/** @typedef {{group: string, order: number, description: string}} CategoryMeta */

/** @type {SettingsGroup[]} the menu's groups, in order (About is pinned below them, ungrouped) */
export const SETTINGS_GROUPS = [
	{ id: 'general', label: 'General' },
	{ id: 'workspace', label: 'Workspace' },
	{ id: 'devices', label: 'Devices & services' },
	{ id: 'more', label: 'More' }
];

/** @type {Record<string, CategoryMeta>} */
const META = {
	interface: { group: 'general', order: 1, description: 'How the app looks, sounds and greets you.' },
	controls: { group: 'general', order: 2, description: 'Keyboard, mouse and trackpad.' },
	input: { group: 'general', order: 3, description: 'Gamepad and the node editor’s mouse.' },
	touchcontrols: { group: 'general', order: 4, description: 'The on-screen stick and action buttons for phones and tablets.' },
	shortcuts: { group: 'general', order: 5, description: 'Click a shortcut’s keys, then press the new combination.' },
	scene: { group: 'workspace', order: 6, description: 'How the 3D view draws, saves and behaves on this device.' },
	explorer: { group: 'workspace', order: 7, description: 'Files, sharing and the recycle bin.' },
	nodetypes: { group: 'workspace', order: 8, description: 'Hide the node types you never use from the palette, add menus and search on this device.' },
	export: { group: 'workspace', order: 9, description: 'What the next exported game starts with.' },
	vr: { group: 'devices', order: 10, description: 'Comfort, body, buttons and display in the headset — the same table as the headset’s own Settings.' },
	ai: { group: 'devices', order: 11, description: 'The scene assistant, voice typing and mesh generation.' },
	connection: { group: 'devices', order: 12, description: 'How you find other people.' },
	aboutwhatsnew: { group: 'about', order: 99, description: '' }
};

/** @param {string} key a section key @returns {CategoryMeta} */
export function categoryMeta(key) {
	return META[key] ?? { group: 'more', order: 50, description: '' };
}

/** the menu label of the pinned last entry (the section itself is titled "About") */
export const ABOUT_MENU_LABEL = 'About & what’s new';

/**
 * Order a list of section keys the way the menu shows them (registration order breaks ties, so a
 * section another lane adds keeps its place among the unknown ones).
 * @param {string[]} keys @returns {string[]}
 */
export function orderSections(keys) {
	return keys
		.map((k, i) => ({ k, i, m: categoryMeta(k) }))
		.sort((a, b) => a.m.order - b.m.order || a.i - b.i)
		.map((x) => x.k);
}

/**
 * The grouped menu: [{group, keys}] in order, About left out (it is pinned separately), empty
 * groups dropped. @param {string[]} keys
 */
export function groupSections(keys) {
	const ordered = orderSections(keys).filter((k) => k !== 'about');
	return SETTINGS_GROUPS.map((g) => ({ group: g, keys: ordered.filter((k) => categoryMeta(k).group === g.id) })).filter((g) => g.keys.length);
}
