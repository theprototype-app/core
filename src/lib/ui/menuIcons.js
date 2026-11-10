// 78 PL2 — every context-menu COMMAND row carries an icon. About thirty menus build their own item lists and
// most rows never named one, so a menu read as a mix of iconed and bare rows. Rather than hand an icon to
// several hundred rows (and to every row added later), ContextMenuItems asks this table for the row's VERB
// when the row names none: the first word of the label decides, the same word always gets the same glyph.
//
// Only commands are matched. A CHOICE row (one carrying `checked`, the active pick of a group: High / Low,
// On / Off) keeps no icon, so a group of options stays uniform; a row that should stay bare passes
// `icon: ''`. Every name here exists in ui/Icon.svelte's MAP (tests/unit/menuIcons.test.js). Pure, imports
// nothing.

/** leading verb (lower case) -> Icon.svelte MAP name */
export const VERB_ICONS = {
	add: 'plus',
	new: 'plus',
	create: 'plus',
	insert: 'plus',
	open: 'external-link',
	edit: 'pencil',
	rename: 'square-pen',
	copy: 'copy',
	duplicate: 'copy',
	paste: 'clipboard-paste',
	cut: 'scissors',
	delete: 'trash-2',
	remove: 'trash-2',
	clear: 'circle-x',
	close: 'x',
	save: 'save',
	export: 'download',
	download: 'download',
	import: 'upload',
	upload: 'upload',
	share: 'share-2',
	unshare: 'unlink',
	restore: 'history',
	reset: 'rotate-ccw',
	undo: 'undo-2',
	redo: 'redo-2',
	show: 'eye',
	view: 'eye',
	preview: 'eye',
	watch: 'eye',
	hide: 'eye-off',
	select: 'square-mouse-pointer',
	move: 'move',
	rotate: 'rotate-cw',
	scale: 'scaling',
	size: 'scaling',
	flip: 'flip-horizontal',
	align: 'align-center-horizontal',
	snap: 'magnet',
	frame: 'focus',
	focus: 'focus',
	fit: 'maximize-2',
	locate: 'locate-fixed',
	reveal: 'locate-fixed',
	find: 'search',
	search: 'search',
	filter: 'filter',
	sort: 'list',
	group: 'group',
	ungroup: 'ungroup',
	merge: 'combine',
	split: 'columns-2',
	pin: 'pin',
	unpin: 'pin-off',
	lock: 'lock',
	unlock: 'lock-open',
	dock: 'panel-bottom',
	undock: 'picture-in-picture-2',
	float: 'picture-in-picture-2',
	expand: 'unfold-vertical',
	collapse: 'unfold-vertical',
	play: 'play',
	resume: 'play',
	pause: 'pause',
	stop: 'square',
	record: 'video',
	mute: 'volume-x',
	unmute: 'volume-2',
	toggle: 'toggle-left',
	settings: 'settings',
	customize: 'settings-2',
	properties: 'sliders-horizontal',
	update: 'refresh-cw',
	refresh: 'refresh-cw',
	reload: 'refresh-cw',
	replace: 'refresh-cw',
	apply: 'check',
	detach: 'unlink',
	disconnect: 'unlink',
	connect: 'link',
	link: 'link',
	unlink: 'unlink',
	invite: 'user-plus',
	join: 'users',
	leave: 'door-open',
	back: 'arrow-left',
	go: 'arrow-right',
	travel: 'arrow-right',
	help: 'circle-help'
};

/**
 * The icon a row shows: its own (an empty string = deliberately none), else its verb's, else none.
 * @param {any} item a ContextMenu item
 * @returns {string|null}
 */
export function rowIcon(item) {
	if (!item || typeof item !== 'object' || item.section || item.header) return null;
	if (typeof item.icon === 'string') return item.icon || null;
	if ('checked' in item) return null;
	const label = typeof item.label === 'string' ? item.label : '';
	const verb = label.trim().split(/[\s…:(]/)[0].toLowerCase();
	return verb && Object.prototype.hasOwnProperty.call(VERB_ICONS, verb) ? /** @type {Record<string, string>} */ (VERB_ICONS)[verb] : null;
}
