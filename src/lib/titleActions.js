// 92 (GC1) — WHAT THE TITLE SCREEN'S BUTTONS DO, for both renderers (TitleScreen.svelte on a screen; the
// headset's game panel reads `titleModel`). A LAZY chunk (the title screen's own).
//
//   Continue    the newest save slot (GC5): play starts, then the slot loads (level, kept state, checkpoint)
//   Play        no slots: play. Slots on: a NEW game in the first empty slot; all three full = pick the
//   / New game  one to overwrite (asked first)
//   Load game   the slot list; a slot made with a newer version is shown, not loadable
//   Settings    the pause menu's Settings page on its own (Back returns here)
//   Quit        editor Play only: back to the editor
//
// `start` mode (a play link / export before play): the press IS the gesture the pointer lock and the
// fullscreen want, so requestPlay runs FIRST, synchronously, and the slot work follows it.
import { get } from 'svelte/store';
import { gameMenus, titleScreen, closeTitleScreen, showTitlePage, markTitlePassed } from './gameMenus';
import { titleItems } from './gameMenusPlan.js';
import { requestPlay, embedMode } from './playMode';
import { leaveToEditor, openSettingsCard } from './gameShell';
import { exportConfig } from './export/exportBoot.js';
import { showToast } from '../stores/appStore';
import { listSlots, newestSlot, firstEmptySlot, loadSlot, newGameInSlot } from './saveSlots.js';

/** the buttons right now */
export function titleButtons() {
	const rules = get(gameMenus);
	const hasSave = rules.saves && !!newestSlot();
	return titleItems({ hasSave, saves: rules.saves, canQuit: !get(embedMode) });
}

/** the words on the title (the authored title, else the export's / game's name) @param {string} [fallback] */
export function titleWords(fallback = '') {
	const t = get(gameMenus).title;
	return {
		title: t?.title || exportConfig?.title || fallback || 'Game',
		subtitle: t?.subtitle || ''
	};
}

/** leave the title for the game (start mode: the gesture's requestPlay) */
function enterGame() {
	const mode = get(titleScreen).mode;
	markTitlePassed(true);
	closeTitleScreen();
	if (mode === 'start' || get(embedMode)) {
		// the export's "start fullscreen" asks inside THIS gesture, before the lock does
		if (exportConfig?.startFullscreen && typeof document !== 'undefined' && document.fullscreenEnabled && !document.fullscreenElement) {
			try {
				document.documentElement.requestFullscreen?.().catch(() => {});
			} catch {
				/* refused — play anyway */
			}
		}
		requestPlay({ flat: true });
	}
}

/** @param {{ok: boolean, reason?: string}} res */
function sayIfFailed(res) {
	if (!res.ok && res.reason) showToast(res.reason);
	return res.ok;
}

/** Run a title button by id. @param {string} id @returns {boolean} acted */
export function runTitleItem(id) {
	debug.items.push(id);
	const rules = get(gameMenus);
	switch (id) {
		case 'continue': {
			const slot = newestSlot();
			enterGame();
			if (slot) void loadSlot(slot.n).then(sayIfFailed);
			return true;
		}
		case 'play': {
			if (!rules.saves) {
				enterGame();
				return true;
			}
			const n = firstEmptySlot();
			if (n == null) {
				// all three slots hold a game: the player picks which one the new game replaces
				showTitlePage('new');
				return true;
			}
			enterGame();
			void newGameInSlot(n).then(sayIfFailed);
			return true;
		}
		case 'load':
			showTitlePage('load');
			return true;
		case 'settings':
			openSettingsCard();
			return true;
		case 'quit':
			closeTitleScreen();
			markTitlePassed(false);
			leaveToEditor();
			return true;
		case 'back':
			showTitlePage('');
			return true;
	}
	return false;
}

/**
 * A slot pressed on the title's Load / New page. `new` overwrites (the caller asked first).
 * @param {'load' | 'new'} page @param {number} n
 */
export function pickTitleSlot(page, n) {
	const slot = listSlots().find((s) => s.n === n);
	if (!slot) return false;
	if (page === 'load') {
		if (slot.empty || slot.newer || slot.broken) return false;
		enterGame();
		void loadSlot(n).then(sayIfFailed);
		return true;
	}
	enterGame();
	void newGameInSlot(n).then(sayIfFailed);
	return true;
}

/** @type {{items: string[]}} */
const debug = { items: [] };
/** the suites' view */
export function titleDebug() {
	return { ...get(titleScreen), items: [...debug.items], buttons: titleButtons() };
}
