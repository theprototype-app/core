// 63 PG3 — THE CRAZYGAMES ADAPTER. An export made with the CrazyGames preset loads their HTML5 SDK
// v3 from their own URL (index.html's <head>, the one outside host that preset allows:
// exportCore.EXPORT_ALLOWED_HOSTS) and this file tells it what the game is doing. Source:
// https://docs.crazygames.com/sdk/intro/ + /sdk/game/ (read 2026-11-23):
//   · `await SDK.init()` before any call; `SDK.environment` is 'crazygames' on their site, 'local' on
//     localhost, 'disabled' elsewhere — where "all the calls to the SDK methods will throw", so the
//     adapter stays quiet unless the environment is 'crazygames' or 'local';
//   · loadingStart / loadingStop around the game's loading (the first event also sets the game's
//     measured "initial download");
//   · gameplayStart "whenever the player starts playing or resumes playing after a break (game start,
//     resume, revive, enter next level)"; gameplayStop "on every game break (entering a menu, ending
//     level, pausing the game)". "Don't call this event when the user switches focus or leaves the
//     game area (we handle this on our side)" — so a hidden tab is NOT a stop here (the brief said it
//     was; the docs win, QUESTIONS Q4).
// The SDK hears NOTHING else: no player data, no scene data, no ads calls (ads are a later card).
//
// DRIVEN BY THE GAME-FLOW STATE THE HUD READS, never by a hook of its own: the export's boot phase
// (exportRuntimeState), Play mode (isLocked), the game shell (gameState + roundCutoff — a scene that
// never uses the shell plays the whole time it is in Play), a HUD menu that freed the pointer
// (playPointerFree: the start / pause menus), and a level change (levelTransition / levelLoading).
// `portalPhase` folds them into one word and the driver calls the SDK on the EDGES only, so a store
// that re-publishes the same state twice never calls anything twice. A second portal is one more file
// beside this one with its own map from those three words to its SDK (portals/index.js).

/** @typedef {'loading' | 'gameplay' | 'break'} PortalPhase */

/**
 * PURE: the one word a portal needs, from the game-flow facts.
 * @param {{runtime: string, locked: any, shellUnused: boolean, state: string, pointerFree: boolean, transition: string, levelLoading: boolean}} f
 * @returns {PortalPhase}
 */
export function portalPhase(f) {
	if (f.runtime !== 'playing' && f.runtime !== 'failed') return 'loading';
	if (f.levelLoading) return 'loading';
	if (f.locked !== true) return 'break';
	if (f.pointerFree) return 'break';
	if (f.transition && f.transition !== 'idle') return 'break';
	if (!f.shellUnused && f.state !== 'playing') return 'break';
	return 'gameplay';
}

/**
 * The edge driver: phase changes in, SDK calls out (exactly one per edge, in order). `game` is
 * `SDK.game` (or a mock with the same four methods). Exported for the unit suite.
 * @param {{loadingStart: () => any, loadingStop: () => any, gameplayStart: () => any, gameplayStop: () => any}} game
 */
export function createPortalDriver(game) {
	/** @type {PortalPhase | ''} */
	let last = '';
	/** @type {string[]} */
	const calls = [];
	/** @param {'loadingStart' | 'loadingStop' | 'gameplayStart' | 'gameplayStop'} name */
	const call = (name) => {
		calls.push(name);
		try {
			const r = game[name]();
			if (r && typeof r.catch === 'function') r.catch(() => {});
		} catch {
			/* a portal SDK's failure never stops the game */
		}
	};
	return {
		calls,
		/** @param {PortalPhase} next */
		update(next) {
			if (next === last) return;
			if (last === 'loading') call('loadingStop');
			else if (last === 'gameplay') call('gameplayStop');
			if (next === 'loading') call('loadingStart');
			else if (next === 'gameplay') call('gameplayStart');
			last = next;
		}
	};
}

/** the environments where SDK calls work (elsewhere they throw) */
export const LIVE_ENVIRONMENTS = ['crazygames', 'local'];

/** for the suite (window.__tp.test.v1 → portalState) */
export const crazyGamesState = { status: 'idle', environment: '', calls: /** @type {string[]} */ ([]) };

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the adapter (exportRuntime calls it first thing in a CrazyGames export, so the loading
 * phase covers the whole boot). Never throws; resolves with the driver, or null when the SDK is
 * absent (an ad blocker, the page opened somewhere else) or its environment is 'disabled'.
 * @param {{getRuntimePhase: () => string}} o
 */
export async function startCrazyGames(o) {
	crazyGamesState.status = 'waiting';
	// the SDK <script> in <head> runs before the app's modules, but give a slow network a moment
	let SDK = /** @type {any} */ (globalThis).CrazyGames?.SDK;
	for (let i = 0; !SDK && i < 50; i++) {
		await sleep(100);
		SDK = /** @type {any} */ (globalThis).CrazyGames?.SDK;
	}
	if (!SDK) {
		crazyGamesState.status = 'no-sdk';
		return null;
	}
	try {
		await SDK.init();
	} catch {
		crazyGamesState.status = 'init-failed';
		return null;
	}
	crazyGamesState.environment = String(SDK.environment || '');
	if (!LIVE_ENVIRONMENTS.includes(crazyGamesState.environment)) {
		crazyGamesState.status = 'disabled';
		return null;
	}
	const driver = createPortalDriver(SDK.game);
	crazyGamesState.calls = driver.calls;
	crazyGamesState.status = 'live';

	const [{ get }, { isLocked, playPointerFree }, gs, { levelTransition }, { levelLoading }] = await Promise.all([
		import('svelte/store'),
		import('../../../stores/sceneStore'),
		import('../../gameState'),
		import('../../gameLevels/transition.js'),
		import('../../gameLevels/loading.js')
	]);
	const read = () =>
		driver.update(
			portalPhase({
				runtime: o.getRuntimePhase(),
				locked: get(isLocked),
				shellUnused: gs.roundCutoff() === null,
				state: get(gs.gameState).state,
				pointerFree: !!get(playPointerFree),
				transition: get(levelTransition).phase,
				levelLoading: !!get(levelLoading).active
			})
		);
	for (const s of [isLocked, playPointerFree, gs.gameState, levelTransition, levelLoading]) s.subscribe(() => read());
	// the boot phase is a plain object (exportRuntimeState), not a store: poll it until play
	const boot = setInterval(() => {
		read();
		const p = o.getRuntimePhase();
		if (p === 'playing' || p === 'failed') clearInterval(boot);
	}, 100);
	read();
	return driver;
}
