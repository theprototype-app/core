import { describe, it, expect } from 'vitest';
import {
	normalizeBar,
	migrateLegacy,
	placeItem,
	removeItem,
	moveItem,
	labelled,
	DEFAULT_BAR,
	MAX_ITEMS,
	BAR_CATALOG,
	WINDOW_ITEMS,
	EDIT_ITEMS,
	VIEW_ITEMS
} from '../../src/lib/ui/phoneBar.js';

// 38 R9 / NOTES-38 #7: the phone bar, per device. 42 I5: ONE list with Play in it, up to seven
// items, arranged by dragging in More; the 41b four-slots-around-Play records migrate into it.
describe('phoneBar', () => {
	it('defaults to Add, Objects, Play, Explorer, More', () => {
		expect(DEFAULT_BAR).toEqual(['add', 'objects', 'play', 'explorer', 'more']);
		expect(normalizeBar(null)).toEqual(DEFAULT_BAR);
		expect(normalizeBar('nope')).toEqual(DEFAULT_BAR);
		// an empty bar cannot be got back from (nothing to hold): it reads as the default
		expect(normalizeBar([])).toEqual(DEFAULT_BAR);
	});

	it('the catalog: More ▸ Windows / Edit / Tools & View, every one placeable', () => {
		expect(WINDOW_ITEMS.slice(0, 5)).toEqual(['play', 'add', 'more', 'objects', 'stats']);
		expect(EDIT_ITEMS).toEqual(['inspect', 'move', 'rotate', 'scale', 'undo', 'redo', 'multiselect', 'interact']);
		expect(VIEW_ITEMS).toEqual(['tools', 'focus', 'budget', 'ar']);
		expect(new Set(BAR_CATALOG).size).toBe(BAR_CATALOG.length);
	});

	it('drops unknown keys and repeats, caps at seven', () => {
		expect(MAX_ITEMS).toBe(7);
		expect(normalizeBar(['add', 'bogus', 'add', 'chat', 'more'])).toEqual(['add', 'chat', 'more']);
		expect(normalizeBar(['add', 'objects', 'play', 'explorer', 'more', 'move', 'rotate', 'scale', 'undo']).length).toBe(7);
		// Play is an item like any other — it may be anywhere, or absent
		expect(normalizeBar(['play', 'add'])).toEqual(['play', 'add']);
		expect(normalizeBar(['add', 'more'])).toEqual(['add', 'more']);
	});

	it('migrates the 41b records: four slots + where Play sat', () => {
		// nothing stored but a moved Play: the old default with Play one place left
		expect(migrateLegacy(undefined, 1)).toEqual(['add', 'play', 'objects', 'explorer', 'more']);
		// the old default, Play in the middle (absent)
		expect(migrateLegacy(['add', 'objects', 'explorer', 'more'], null)).toEqual(DEFAULT_BAR);
		// a customised bar (More off, Chat on) keeps its order; Play back in the middle
		expect(migrateLegacy(['add', 'objects', 'chat'], null)).toEqual(['add', 'objects', 'play', 'chat']);
		// Play at either end
		expect(migrateLegacy(['add', 'objects', 'explorer', 'more'], 0)).toEqual(['play', 'add', 'objects', 'explorer', 'more']);
		expect(migrateLegacy(['add', 'objects', 'explorer', 'more'], 4)).toEqual(['add', 'objects', 'explorer', 'more', 'play']);
		// a remembered place past a shrunk bar clamps to its end; junk is dropped
		expect(migrateLegacy(['more', 'bogus'], 9)).toEqual(['more', 'play']);
		expect(migrateLegacy('junk', null)).toEqual(DEFAULT_BAR);
		// an empty old bar was "Play alone"
		expect(migrateLegacy([], null)).toEqual(['play']);
	});

	it('a drop places an item: along the bar, or in from More', () => {
		// along: `at` counts the OTHER items, so dragging Play to the far left is at 0
		expect(placeItem(DEFAULT_BAR, 'play', 0).list).toEqual(['play', 'add', 'objects', 'explorer', 'more']);
		expect(placeItem(DEFAULT_BAR, 'add', 4).list).toEqual(['objects', 'play', 'explorer', 'more', 'add']);
		// dropped where it already was: unchanged
		expect(placeItem(DEFAULT_BAR, 'play', 2).list).toEqual(DEFAULT_BAR);
		// in from More: a new item lands where it was dropped
		expect(placeItem(DEFAULT_BAR, 'move', 1).list).toEqual(['add', 'move', 'objects', 'play', 'explorer', 'more']);
		// past the end clamps
		expect(placeItem(['add'], 'chat', 99).list).toEqual(['add', 'chat']);
		// a full bar refuses a new one, but still reorders its own
		const full = ['add', 'objects', 'play', 'explorer', 'more', 'move', 'rotate'];
		expect(placeItem(full, 'scale', 0)).toEqual({ list: full, refused: 'full' });
		expect(placeItem(full, 'rotate', 0).list[0]).toBe('rotate');
		expect(placeItem(DEFAULT_BAR, 'bogus', 0)).toEqual({ list: DEFAULT_BAR, refused: 'unknown' });
	});

	it('a drag out removes an item — but never the last one', () => {
		expect(removeItem(DEFAULT_BAR, 'more').list).toEqual(['add', 'objects', 'play', 'explorer']);
		expect(removeItem(DEFAULT_BAR, 'play').list).toEqual(['add', 'objects', 'explorer', 'more']);
		expect(removeItem(DEFAULT_BAR, 'chat').list).toEqual(DEFAULT_BAR);
		expect(removeItem(['play'], 'play')).toEqual({ list: ['play'], refused: 'last' });
	});

	it("Play's Move left / Move right walk it along the bar (41b H6)", () => {
		expect(moveItem(DEFAULT_BAR, 'play', -1)).toEqual(['add', 'play', 'objects', 'explorer', 'more']);
		expect(moveItem(DEFAULT_BAR, 'play', 1)).toEqual(['add', 'objects', 'explorer', 'play', 'more']);
		// at an end, or off the bar, nothing changes
		expect(moveItem(['play', 'add'], 'play', -1)).toEqual(['play', 'add']);
		expect(moveItem(['add', 'play'], 'play', 1)).toEqual(['add', 'play']);
		expect(moveItem(['add', 'more'], 'play', 1)).toEqual(['add', 'more']);
	});

	it('labels at five or fewer; icons-only past five on a narrow bar, labelled on a wide one', () => {
		expect(labelled(5, 390)).toBe(true);
		expect(labelled(6, 378)).toBe(false); // the folded N6: 63 px each
		expect(labelled(7, 378)).toBe(false);
		expect(labelled(7, 620)).toBe(true); // a wider phone shell: 88 px each
		// seven on the folded phone are still thumb-sized
		expect(378 / 7).toBeGreaterThanOrEqual(44);
	});
});
