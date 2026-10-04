// 36 U3b/I5 — the three built-in tours on the one engine, and what starts them.
//
//   vr-welcome    "Welcome to ThePrototype VR mode" — on the FIRST ever VR entry. Each step waits
//                 for the user to do the thing (the VR watcher signals it) or for Next.
//   editor        the desktop first-run tour (mouse + keyboard), ≤ 6 steps
//   editor-touch  the same tour for a touch screen (fingers, the + button, on-screen controls)
//
// FIRST RUN: the editor tour follows the first-visit Welcome card (when it closes — and not while
// the Templates window it may have opened is still up); a visit that skipped the Welcome (an
// invite or a scene link) is somebody who came for the session, so no tour either. The VR welcome
// starts a moment after the first session begins. Under test (the debug hook is on) nothing
// starts by itself unless the suite opts in with `toursUnderTest` — the whatsNew precedent: the
// whole e2e battery must not grow a card over the canvas.

import { get } from 'svelte/store';
import { tours, activeTour } from './index.js';
import { safeStorage } from '../safeStorage';
import { isVRMode, vrMenuHand, vrMenuOpen, editorMode } from '../../stores/sceneStore';
import { templatesModalOpen, showToast } from '../../stores/appStore.js';
import { welcomeOpen } from '../whatsNew';
import { coarsePointer } from '../inputDevice';

export const VR_TOUR = 'vr-welcome';
export const EDITOR_TOUR = 'editor';
export const TOUCH_TOUR = 'editor-touch';

/** the editor tour for THIS device: the touch variant on a coarse pointer */
export function editorTourId() {
	return coarsePointer() ? TOUCH_TOUR : EDITOR_TOUR;
}

/** may a tour start by itself on this page? (see the header: not under test unless asked) */
export function autoStartAllowed() {
	if (!safeStorage.getItem('debugStores')) return true;
	return safeStorage.getItem('toursUnderTest') === 'true';
}

const menuHand = () => /** @type {'left' | 'right'} */ (get(vrMenuHand) === 'left' ? 'left' : 'right');
const otherHand = () => (menuHand() === 'left' ? 'right' : 'left');
const upperName = (/** @type {'left' | 'right'} */ hand) => (hand === 'left' ? 'Y' : 'B');
const handName = (/** @type {'left' | 'right'} */ hand) => (hand === 'left' ? 'left' : 'right');

/** @type {import('./engine.js').TourStep[]} */
export const VR_STEPS = [
	{
		id: 'welcome',
		title: 'Welcome to ThePrototype VR mode',
		body: 'A one-minute tour of your controllers. Do what each step asks to move on — or press Next. Skip any time; you can replay it from Settings.',
		controls: { hand: 'both', parts: [] }
	},
	{
		id: 'controllers',
		title: 'Your controllers',
		body: 'Trigger (index finger) points and clicks. Grip (middle finger) grabs. The thumbsticks move and turn, and the face buttons open menus.',
		controls: { hand: 'both', parts: ['trigger', 'grip', 'stick'] }
	},
	{
		id: 'move',
		title: 'Move and turn',
		body: 'Right thumbstick: push forward to aim a teleport, let go to jump there; flick left or right to turn. You can also squeeze a grip in empty air and pull to drag the world. In a game, the left thumbstick walks.',
		hint: 'Push a thumbstick',
		advanceOn: 'vr-move',
		controls: { hand: 'both', parts: ['stick'] }
	},
	{
		id: 'point',
		title: 'Point and click',
		body: 'Point a controller at an object, a menu or a button: the laser shows where. Pull the trigger to select or press it.',
		hint: 'Pull a trigger',
		advanceOn: 'vr-trigger',
		controls: { hand: 'both', parts: ['trigger'] }
	},
	{
		id: 'grab',
		title: 'Grab',
		body: 'Squeeze the grip on an object to pick it up, move your hand, and let go to drop it. Two grips on one object scale it.',
		hint: 'Squeeze a grip',
		advanceOn: 'vr-grip',
		controls: { hand: 'both', parts: ['grip'] }
	},
	{
		id: 'menu',
		title: 'Your menu',
		body: () =>
			`Press ${upperName(menuHand())} on your ${handName(menuHand())} hand to open the radial menu: add things, tools, the scene and System ▸ Settings. Choose a slice with the thumbstick or point at it and pull the trigger.`,
		hint: () => `Press ${upperName(menuHand())}`,
		advanceOn: 'vr-menu',
		controls: () => ({ hand: menuHand(), parts: ['face-upper', 'stick'] })
	},
	{
		id: 'play',
		title: 'Play a game',
		body: () =>
			`Open a game (Templates on the desktop, or a shared link), then press ${upperName(otherHand())} on your ${handName(otherHand())} hand to switch between Edit and Interact — Interact is where you play. In a game, X opens its pause menu.`,
		hint: () => `Press ${upperName(otherHand())} to switch to Interact`,
		advanceOn: 'vr-interact',
		controls: () => ({ hand: otherHand(), parts: ['face-upper'] })
	},
	{
		id: 'exit',
		title: 'Leaving VR',
		body: 'Press the Meta button on your right controller and choose Exit — or open the menu: System ▸ Exit VR. Replay this tour any time from the menu: System ▸ Welcome tour.',
		hint: 'Exit VR, or press Done',
		advanceOn: 'vr-exit',
		controls: { hand: 'right', parts: ['meta'] }
	}
];

/** @type {import('./engine.js').TourStep[]} */
export const EDITOR_STEPS = [
	{
		id: 'add',
		title: 'Welcome! Start by adding something',
		body: 'Right-click the viewport (or press this +) for shapes, lights, models and more. Shift+A opens the same menu.',
		target: 'add'
	},
	{
		id: 'navigate',
		title: 'Look around',
		body: 'Left-drag orbits, right-drag pans, the wheel zooms. W A S D fly, Q and E go down and up (hold Shift to go faster). F frames the selection.',
		placement: 'center'
	},
	{
		id: 'tools',
		title: 'Your tools',
		body: 'Move, rotate and scale (1 2 3), the object list, the node editor that drives behaviour, and the Explorer with your files.',
		target: 'tools'
	},
	{
		id: 'play',
		title: 'Play it',
		body: 'Play runs your scene as a game. Its arrow switches Edit / Interact / Play — and with a headset connected, Play enters VR.',
		target: 'play'
	},
	{
		id: 'connect',
		title: 'Build together',
		body: 'Share your ID (click to copy) and anyone who connects edits the same scene with you — peer to peer, no account.',
		target: 'connect'
	},
	{
		id: 'menu',
		title: 'Everything else',
		body: 'The logo menu has Templates, Save and Load, Modules and Settings. This tour lives there too, under "Tours".',
		target: 'logo'
	}
];

/** @type {import('./engine.js').TourStep[]} */
export const TOUCH_STEPS = [
	{
		id: 'add',
		title: 'Welcome! Start by adding something',
		body: 'Tap + for shapes, lights and models — or long-press the viewport.',
		target: 'add'
	},
	{
		id: 'navigate',
		title: 'Look around',
		body: 'One finger orbits, two fingers pan, pinch to zoom. Tap an object to select it.',
		placement: 'center'
	},
	{
		id: 'tools',
		title: 'Your tools',
		body: 'Move, rotate and scale, the object list, the node editor that drives behaviour, and your files.',
		target: 'tools'
	},
	{
		id: 'play',
		title: 'Play it',
		body: 'Tap Play to run the scene as a game. On a touch screen a stick and action buttons (jump, fire…) appear for the game’s controls.',
		target: 'play'
	},
	{
		id: 'connect',
		title: 'Build together',
		body: 'Share your ID and anyone who connects edits the same scene with you — peer to peer, no account.',
		target: 'connect'
	},
	{
		id: 'menu',
		title: 'Everything else',
		body: 'The logo menu has Templates, Save and Load, Modules and Settings — and this tour, under "Tours".',
		target: 'logo'
	}
];

/**
 * Where the built-in tours point. Core's own chrome predates `data-tour`, so the first-run tour
 * maps its ids onto the existing element ids HERE rather than touching four hot components;
 * a `[data-tour="<id>"]` element, when a lane adds one, always wins.
 * @type {Record<string, string>}
 */
export const BUILTIN_TARGETS = {
	add: '#mobile-add-button',
	tools: '#controls-pill',
	play: '#play-button',
	connect: '.connect-pill',
	logo: '#logo-menu'
};

/** @type {(() => void)[]} */
let teardown = [];

/** Register the built-in tours and their first-run triggers (idempotent; TourCard mounts it). */
export function installTours() {
	if (teardown.length) return () => {};
	teardown.push(tours.register(VR_TOUR, { title: 'Welcome to ThePrototype VR', surface: 'vr', steps: VR_STEPS }));
	teardown.push(tours.register(EDITOR_TOUR, { title: 'Editor tour', surface: 'card', steps: EDITOR_STEPS }));
	teardown.push(tours.register(TOUCH_TOUR, { title: 'Editor tour', surface: 'card', steps: TOUCH_STEPS }));

	// ---- the VR welcome: the first session, a beat after it starts (controllers enumerate) ----
	/** @type {any} */ let vrTimer = null;
	let wasVR = get(isVRMode);
	teardown.push(
		isVRMode.subscribe((vr) => {
			if (vr === wasVR) return;
			wasVR = vr;
			clearTimeout(vrTimer);
			if (vr) {
				// a screen tour is invisible in a headset: park it (it resumes later)
				const now = get(activeTour);
				if (now && now.surface !== 'vr') tours.close();
				if (!autoStartAllowed()) return;
				vrTimer = setTimeout(() => tours.maybeAutoStart(VR_TOUR), VR_START_DELAY);
			} else {
				// leaving VR is the last step's action; anywhere else it PAUSES the tour
				tours.signal('vr-exit');
				if (get(activeTour)?.surface === 'vr') tours.close();
			}
		})
	);
	// the radial opening and Interact are actions the VR tour waits for
	teardown.push(
		vrMenuOpen.subscribe((open) => {
			if (open && get(isVRMode)) tours.signal('vr-menu');
		})
	);
	teardown.push(
		editorMode.subscribe((mode) => {
			if (mode === 'interact' && get(isVRMode)) tours.signal('vr-interact');
		})
	);

	// ---- the editor tour: after the first-visit Welcome card closes ----
	let welcomeWasOpen = get(welcomeOpen);
	let owed = false;
	/** @type {any} */ let editorTimer = null;
	const tryEditor = () => {
		clearTimeout(editorTimer);
		if (!owed || get(welcomeOpen) || get(templatesModalOpen) || get(isVRMode)) return;
		editorTimer = setTimeout(() => {
			if (!owed || get(welcomeOpen) || get(templatesModalOpen) || get(isVRMode)) return;
			owed = false;
			tours.maybeAutoStart(editorTourId());
		}, EDITOR_START_DELAY);
	};
	teardown.push(
		welcomeOpen.subscribe((open) => {
			if (welcomeWasOpen && !open && autoStartAllowed()) owed = true;
			welcomeWasOpen = open;
			tryEditor();
		})
	);
	teardown.push(templatesModalOpen.subscribe(() => tryEditor()));
	teardown.push(() => {
		clearTimeout(vrTimer);
		clearTimeout(editorTimer);
	});
	return () => {
		for (const fn of teardown.splice(0)) fn();
	};
}

/** ms after the session starts before the welcome shows (controller profiles arrive late) */
export const VR_START_DELAY = 1200;
/** ms after the Welcome card closes before the editor tour's first card */
export const EDITOR_START_DELAY = 500;

/** the last controller family a session reported (the desktop preview draws the same pair) */
export const FAMILY_KEY = 'tourControllerFamily';

/** Settings / logo menu / radial: the VR welcome. In a headset it starts now, from the top;
 * on a screen it is ARMED for the next VR entry, with a preview offered here. */
export function startVRWelcome() {
	if (get(isVRMode)) return tours.start(VR_TOUR, { from: 'start' });
	tours.reset(VR_TOUR);
	showToast('The VR welcome will play the next time you enter VR.', [
		{ label: 'Preview it here', action: () => tours.start(VR_TOUR, { preview: true }) }
	]);
	return false;
}
/** Settings / logo menu: this device's editor tour, from the top */
export function startEditorTour() {
	return tours.start(editorTourId(), { from: 'start' });
}
/** Settings: forget every tour record and turn auto-start back on */
export function resetAllTours() {
	tours.close();
	tours.reset();
	showToast('Tours reset — each one shows again the first time it applies.');
}
