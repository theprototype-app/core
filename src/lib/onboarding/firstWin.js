// 76 FW1 — THE FIRST WIN on the existing tours engine: the Welcome card's answer arms a three-step
// quest (change something → Play → share, see quests.js), and this module owns everything around it:
//
//   · the SIGNAL PRODUCERS the steps wait for — a new undo entry (`scene-edited`: an add, a move, a
//     recolour, an AI batch — whatever the user can undo is a change they made), Play starting
//     (`play-entered`), the invite link copied (`share-copied`, signalled by Connect's copy) and a
//     peer's connection opening (`peer-joined`);
//   · WHEN the quest starts: a template / remix starts it once the scene has loaded, Play starts it
//     after that first game ends (it becomes the remix quest — "now make it yours"), Describe it and
//     an empty scene start it at once;
//   · how it ENDED: every step done by doing it → a celebration toast with the next step;
//   · the progressive-disclosure switch's other half: the first Play clears `simpleUntilPlay`.
//
// Under test nothing starts by itself unless the suite opts in with `toursUnderTest` (the tours
// precedent): the whole e2e battery must not grow a card over the canvas.

import { get } from 'svelte/store';
import { tours, activeTour } from '../tours/index.js';
import { safeStorage } from '../safeStorage';
import { coarsePointer } from '../inputDevice';
import { isLocked } from '../../stores/sceneStore';
import { showToast, templatesModalOpen } from '../../stores/appStore.js';
import { peerJoinedAt } from '../connectionState';
import { undoStack } from '../history';
import { templateLoaded } from '../sceneTemplates';
import {
	FIRST_WIN_TOUR,
	SIGNALS,
	firstWinSteps,
	questFor,
	questComplete,
	playEdge
} from './quests.js';
import { onboardChoice, simpleUntilPlay } from './onboardState.js';
import { funnelEvent, offerFunnelNote } from './funnel.js';

/** may the quest start by itself on this page? (not under test unless the suite asks) */
function allowed() {
	if (!safeStorage.getItem('debugStores')) return true;
	return safeStorage.getItem('toursUnderTest') === 'true';
}

/** the quest owed for after the first game ends (the Play answer) @type {{entry: any} | null} */
let afterPlay = null;
/** the quest owed for when the next template / game loads (Remix / Template) @type {string} */
let afterLoad = '';
/** step ids an ACTION completed in the running quest */
let advancedBy = new Set();
/** set by the card's Skip / Don't show again just before the engine closes the quest */
let skippedAt = '';
/** the quest the suites can read back @type {{choice: string, quest: string, steps: string[]} | null} */
let lastQuest = null;
/** @type {(() => void) | null} injected by the tours installer (builtin.js imports us, not the reverse) */
let startEditorTour = null;
/** @type {Set<(e: {kind: string, step?: string}) => void>} */
const endListeners = new Set();

/**
 * Start the quest now (from the top, replacing any running tour). `force`: a manual start (Settings),
 * which the under-test guard does not apply to.
 * @param {{choice?: string, entry?: any, force?: boolean}} [options]
 * @returns {boolean}
 */
export function startFirstWin({ choice = get(onboardChoice), entry = null, force = false } = {}) {
	if (!force && (!allowed() || !tours.autoStartEnabled())) return false;
	const quest = questFor(entry, choice);
	tours.register(FIRST_WIN_TOUR, {
		title: 'Your first game',
		surface: 'card',
		hideWhilePlaying: true,
		quiet: true,
		steps: firstWinSteps({ quest, touch: coarsePointer() })
	});
	advancedBy = new Set();
	skippedAt = '';
	lastQuest = { choice, quest, steps: ['change', 'play', 'share'] };
	tours.reset(FIRST_WIN_TOUR);
	return tours.start(FIRST_WIN_TOUR, { from: 'start' });
}

/**
 * The Welcome card's answer. Records it, and either starts the quest or arms it:
 *   'play'               after the first game ends
 *   'remix' / 'template' when the next template / game has loaded (any card — the Welcome's own
 *                        list or the Templates window it links to)
 *   'prompt' / 'empty'   now
 * @param {string} choice @param {{entry?: any, loaded?: boolean}} [options]
 */
export function chooseOnboarding(choice, { entry = null, loaded = false } = {}) {
	onboardChoice.set(choice);
	// 76 FW2: the funnel counts the answer (once per browser; funnel.js decides)
	funnelEvent('ob_choice');
	if (choice === 'play') {
		afterPlay = { entry };
		return false;
	}
	if ((choice === 'remix' || choice === 'template') && !loaded) {
		afterLoad = choice;
		return false;
	}
	return startFirstWin({ choice, entry });
}

/** TourCard's Skip / Don't show again, just before the engine closes the tour @param {any} tour */
export function noteTourSkip(tour) {
	if (tour?.id === FIRST_WIN_TOUR) skippedAt = String(tour.step?.id ?? '');
}

/** hear how a quest ended: {kind: 'done'} or {kind: 'skip', step} @param {(e: {kind: string, step?: string}) => void} fn */
export function onQuestEnd(fn) {
	endListeners.add(fn);
	return () => endListeners.delete(fn);
}

/** @param {{kind: string, step?: string}} e */
function ended(e) {
	for (const fn of endListeners) {
		try {
			fn(e);
		} catch {
			/* a listener must not wedge the quest */
		}
	}
}

function celebrate() {
	/** @type {{label: string, action: () => void}[]} */
	const actions = [{ label: 'More templates', action: () => templatesModalOpen.set(true) }];
	if (startEditorTour)
		actions.unshift({ label: 'Tour the interface', action: () => startEditorTour?.() });
	showToast(
		'First win! You changed a game, played it and shared it. Save it from the logo menu ▸ Save.',
		actions
	);
}

/**
 * Wire the producers (idempotent; the tours installer calls it).
 * @param {{startEditorTour?: () => void}} [options] @returns {() => void}
 */
export function installFirstWin(options = {}) {
	startEditorTour = options.startEditorTour ?? null;
	/** @type {(() => void)[]} */
	const off = [];

	// scene-edited: a NEW top entry on the undo stack (a selection pick is not a change)
	const seen = new WeakSet();
	for (const e of get(undoStack)) seen.add(e);
	off.push(
		undoStack.subscribe((stack) => {
			const top = stack[stack.length - 1];
			if (!top || seen.has(top)) return;
			seen.add(top);
			if (top.kind === 'selection') return;
			// the funnel before the signal: a signal can end the quest, whose own event comes after
			funnelEvent('ob_first_edit');
			tours.signal(SIGNALS.edited);
		})
	);

	// play-entered, the first Play's disclosure, and the Play answer's quest after the game
	/** @type {'edit' | 'play' | 'leaving'} */
	let phase = get(isLocked) === true ? 'play' : 'edit';
	/** 76 consent: this Play is the first one; the card asks when the person is back from it */
	let askAfterPlay = false;
	off.push(
		isLocked.subscribe((v) => {
			const edge = playEdge(phase, v);
			phase = edge.phase;
			if (edge.entered) {
				funnelEvent('ob_first_play');
				tours.signal(SIGNALS.played);
				if (get(simpleUntilPlay)) {
					simpleUntilPlay.set(false);
					askAfterPlay = true;
				}
			}
			if (edge.left && askAfterPlay) {
				askAfterPlay = false;
				offerFunnelNote();
			}
			if (edge.left && afterPlay) {
				const owed = afterPlay;
				afterPlay = null;
				// the remix quest, a beat after the editor is back (the toolbar re-mounts)
				setTimeout(() => startFirstWin({ choice: 'play', entry: owed.entry }), 600);
			}
		})
	);

	// remix / template: the scene the answer waits for has loaded
	let lastLoad = get(templateLoaded);
	off.push(
		templateLoaded.subscribe((load) => {
			if (!load || load === lastLoad) return;
			lastLoad = load;
			if (!afterLoad) return;
			const choice = afterLoad;
			afterLoad = '';
			setTimeout(() => startFirstWin({ choice, entry: load.entry }), 400);
		})
	);

	// peer-joined: a peer id we have not seen join before
	const known = new Set(Object.keys(get(peerJoinedAt)));
	off.push(
		peerJoinedAt.subscribe((map) => {
			let fresh = false;
			for (const id of Object.keys(map)) {
				if (known.has(id)) continue;
				known.add(id);
				fresh = true;
			}
			if (!fresh) return;
			funnelEvent('ob_first_share');
			tours.signal(SIGNALS.joined);
		})
	);

	// how the quest ended
	off.push(
		tours.onAdvanced((e) => {
			if (e.tour === FIRST_WIN_TOUR) advancedBy.add(e.step);
		})
	);
	let wasQuest = get(activeTour)?.id === FIRST_WIN_TOUR;
	off.push(
		activeTour.subscribe((t) => {
			const isQuest = t?.id === FIRST_WIN_TOUR;
			if (wasQuest && !isQuest) {
				if (questComplete(advancedBy)) {
					ended({ kind: 'done' });
					funnelEvent('ob_quest_done');
					celebrate();
				} else if (skippedAt) {
					ended({ kind: 'skip', step: skippedAt });
					funnelEvent('ob_tour_skip', { x: skippedAt });
				}
				skippedAt = '';
			}
			wasQuest = isQuest;
		})
	);

	return () => {
		for (const fn of off.splice(0)) fn();
		startEditorTour = null;
	};
}

/** the suites' view */
export function firstWinDebug() {
	return {
		lastQuest,
		advancedBy: [...advancedBy],
		afterPlay: !!afterPlay,
		afterLoad,
		choice: get(onboardChoice),
		simple: get(simpleUntilPlay)
	};
}
