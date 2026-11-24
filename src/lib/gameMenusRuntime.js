// 92 (GC1 / GC2 / GC8) — THE GAME MENUS AT RUN TIME, a LAZY chunk: gameShellWire loads it the first time a
// scene carries a `menus` block (a game without one never pays for it, and behaves as in 1.74).
//
//   the pause      the pause menu (and the title over editor Play) pauses the game ONLY while nobody else
//                  is in Play (QUESTIONS-92-menus Q1/Q6): a round in use = the shell's own shared pause
//                  (setGameState 'paused': physics, flow effects, the round clock, HUD timers, the kit
//                  round); no round = the simulation's pause. Only what the menu paused is given back.
//                  Somebody else entering Play while the pause is held lifts it (the world is theirs too)
//   the audio      dips (gameMenus.menuDuck -> audioEngine.setMenuDuck, the master) while the pause holds
//   the title      entering editor Play in a game with a title screen opens ON it (exports / play links
//                  draw it as their start card instead); leaving Play forgets that it was passed
//   late joiners   Auto-admit while playing (playJoins.js) is watched from here
import { get } from 'svelte/store';
import { peers, peerPlayModes, showToast } from '../stores/appStore.js';
import { isLocked, editorMode, isVRMode } from '../stores/sceneStore';
import { gameState, setGameState } from './gameState';
import { gameMenus, titleScreen, menuPause, menuDuck, DUCK_LEVEL, pauseRefused, openTitleScreen, closeTitleScreen, titleWasPassed, markTitlePassed, sincePlayEntered } from './gameMenus';
import { pauseWanted } from './gameMenusPlan.js';
import { menusNewer } from './gameMenusCore.js';
import { shellMenu } from './gameShell';
import { embedMode } from './playMode';
import { scenePhysicsState_ } from './scenePhysics';
import { startPlayJoins } from './playJoins';

/** how many OTHER peers (open connections) are in Play right now */
export function othersPlaying() {
	/** @type {any} */
	const pc = get(peers);
	const open = pc?.openedPeers;
	const isOpen = (/** @type {string} */ id) => (open ? (typeof open.has === 'function' ? open.has(id) : Array.isArray(open) ? open.includes(id) : true) : false);
	return Object.entries(get(peerPlayModes) ?? {}).filter(([id, mode]) => mode === 'playing' && isOpen(id)).length;
}

// take / drop are async (physics is a dynamic import): a token makes a drop that lands before its take
// finished win, so a quick open-close never leaves the game paused
let pauseToken = 0;
/** pause for the menu when the rule allows it (alone) */
export async function takeMenuPause() {
	if (get(menuPause)) return get(menuPause);
	const token = ++pauseToken;
	const rule = get(gameMenus).pause;
	if (!pauseWanted({ rule, othersPlaying: othersPlaying() })) {
		pauseRefused.set(rule);
		return null;
	}
	pauseRefused.set(false);
	if (get(gameState).state === 'playing') {
		setGameState('paused');
		menuPause.set('game');
		return 'game';
	}
	try {
		const physics = await import('./physics');
		if (token !== pauseToken) return null;
		if (get(physics.simulating) && !get(physics.simPaused)) {
			physics.pauseSimulation(true);
			menuPause.set('sim');
			return 'sim';
		}
	} catch {
		/* no physics chunk: nothing to pause */
	}
	return null;
}

/** give back what the menu paused (only what IT paused) */
export async function dropMenuPause() {
	pauseToken++;
	const held = get(menuPause);
	pauseRefused.set(false);
	if (!held) return;
	menuPause.set(null);
	if (held === 'game' && get(gameState).state === 'paused') setGameState('playing');
	if (held === 'sim') {
		try {
			const physics = await import('./physics');
			if (get(physics.simulating) && get(physics.simPaused)) physics.pauseSimulation(false);
		} catch {
			/* nothing to resume */
		}
	}
}

/** GC2 Restart level: the level in play again from its start (its checkpoint forgotten) */
export async function restartCurrentLevel() {
	try {
		const { kit } = await import('./kit/runtime.js');
		const current = kit.impls.levels?.current?.() || get(scenePhysicsState_)?.levels?.list?.[0]?.id;
		const cp = await import('./gameLevels/checkpoints.js');
		cp.forgetCheckpoint();
		const travel = await import('./gameLevels/travel.js');
		return await travel.goToLevel(current);
	} catch {
		showToast('The level could not be restarted.');
		return { ok: false };
	}
}

/** a menu is up over the game (the pause menu, not its standalone cards; or the title over Play) */
function menuUp() {
	const playing = get(isLocked) === true || get(editorMode) === 'interact';
	const m = get(shellMenu);
	return playing && ((m.open && !m.standalone) || get(titleScreen).open);
}

/** VR (claude:9): no title in a headset yet (DOM-only) — pass it and start the game instead */
function skipTitleInVR() {
	markTitlePassed(true);
	closeTitleScreen();
	void import('./titleActions.js').then((m) => m.startWithoutTitle()).catch(() => {});
}
/** the title would open over editor Play now (the author's setting, not passed yet, not an export) */
function titleDue() {
	const t = get(gameMenus).title;
	return !!t && t.editor !== false && !get(embedMode) && !titleWasPassed();
}

/** a Play entered at most this long before the runtime started still opens on the title */
const LATE_TITLE_MS = 10000;
/** @type {(() => void)[]} */
let offs = [];
let warnedFor = '';
/** Start (idempotent). Returns stop. */
export function startMenusRuntime() {
	if (offs.length) return stopMenusRuntime;
	// "made with a newer version": said ONCE per newer config version seen (a scene opened or received)
	offs.push(
		scenePhysicsState_.subscribe(($s) => {
			const m = $s?.play?.menus;
			if (!menusNewer(m) || warnedFor === String(m?.v)) return;
			warnedFor = String(m?.v);
			queueMicrotask(() =>
				showToast('This game’s title screen and menus were made with a newer version of theprototype.app — some of them may not show here. Reload to update.')
			);
		})
	);
	const follow = () => {
		const up = menuUp();
		menuDuck.set(up && get(gameMenus).pause ? DUCK_LEVEL : 1);
		if (up) void takeMenuPause();
		else void dropMenuPause();
	};
	let wasPlaying = get(isLocked) === true;
	// Play was pressed while this chunk was still loading: open on the title all the same
	if (wasPlaying && titleDue() && sincePlayEntered() < LATE_TITLE_MS) {
		if (get(isVRMode)) skipTitleInVR();
		else openTitleScreen('play');
	}
	offs.push(
		isLocked.subscribe((v) => {
			const now = v === true;
			if (now && !wasPlaying && titleDue()) {
				if (get(isVRMode)) skipTitleInVR();
				else openTitleScreen('play');
			}
			if (!now && wasPlaying) {
				markTitlePassed(false);
				if (!get(embedMode)) closeTitleScreen();
			}
			wasPlaying = now;
		})
	);
	// a headset session starting while the title is up (Enter VR from editor Play): nobody could see it
	let wasVR = get(isVRMode);
	offs.push(
		isVRMode.subscribe((vr) => {
			if (vr && get(titleScreen).open) skipTitleInVR();
			// the session ended: a later Play on a screen opens on the title again
			if (!vr && wasVR && get(isLocked) !== true) markTitlePassed(false);
			wasVR = vr;
		})
	);
	// a headset plays in Interact (no pointer lock): its Play passes the title and starts the game the way
	// the title's Play would (a new game in an empty slot); back in Edit the next Play does it again
	let wasInteract = get(editorMode) === 'interact';
	offs.push(
		editorMode.subscribe((m) => {
			const now = m === 'interact';
			if (now && !wasInteract && get(isVRMode) && titleDue()) skipTitleInVR();
			// leaving Interact ends a headset's Play (the session may already be over: no VR test here)
			if (!now && wasInteract && get(isLocked) !== true) markTitlePassed(false);
			wasInteract = now;
		})
	);
	offs.push(startPlayJoins());
	offs.push(shellMenu.subscribe(follow));
	offs.push(titleScreen.subscribe(follow));
	offs.push(isLocked.subscribe(follow));
	offs.push(
		peerPlayModes.subscribe(() => {
			if (get(menuPause) && othersPlaying() > 0) {
				void dropMenuPause().then(() => {
					pauseRefused.set(true);
					showToast('Another player is in the game — it keeps running while your menu is open.');
				});
			}
		})
	);
	return stopMenusRuntime;
}
export function stopMenusRuntime() {
	for (const off of offs) off();
	offs = [];
	menuDuck.set(1);
}
