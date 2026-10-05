// 36-fb-water F14: "Start simulation on load" — a scene that is a simulation (Jelly room, the
// fluid tank toy, Pool party) starts running when it opens instead of sitting frozen until
// somebody finds P. SCENE data: `scenePhysics.simOnLoad` (present only when on, so every other
// scene stays byte-identical), saved and replicated with the rest of that singleton.
//
// WHO STARTS IT: the peer that LOADED the scene (sessions/autosave with replicate on), once
// the load has finished — kit pieces still arriving from a pack have no body yet. Physics is
// authoritative (golden rule 8): the other peers see the run through the ordinary `simulate`
// message, and a late joiner through the handshake push. A level-travel load (replicate off,
// every peer loads it itself) does not start one: N peers would race (simAuthority would
// settle it, but a scene switch is no place to start that fight).
import { get } from 'svelte/store';

/** @param {any} physics a payload's scenePhysics block (or the live state) */
export function sceneStartsSimulation(physics) {
	return physics?.simOnLoad === true;
}

/**
 * Start the run if the scene asks for it and nobody is simulating yet.
 * @param {any} physics @returns {Promise<boolean>} started
 */
export async function startSimOnLoad(physics) {
	if (!sceneStartsSimulation(physics)) return false;
	try {
		const p = await import('../physics');
		if (get(p.simulating) || get(p.remoteSimulating)) return false;
		await p.warmup().catch(() => {});
		if (get(p.simulating) || get(p.remoteSimulating)) return false;
		await p.toggleSimulation();
		return !!get(p.simulating);
	} catch {
		return false; // physics failing to load never breaks a scene load
	}
}

// ── 36-fb-water S9: ONE transport for every simulation in the scene ──────────────────────
// The physics pill (SimControls) paused and reset the RIGID BODIES only, while fluid tanks
// and pour/spill drops (each peer's own, always running) carried on regardless. These are the
// pill's verbs now: paused means everything holds still (on every peer — a peer's pause rides
// its `simulate` message), and Reset puts the whole thing back to how it opened.

/** is the scene's simulation paused (here, or by the peer running it)? */
export async function simPausedAnywhere() {
	const p = await import('../physics');
	return (get(p.simulating) && get(p.simPaused)) || get(p.remoteSimPaused);
}

/**
 * Reset: the initial layout back (physics' own reset), every fluid tank refilled from its
 * fill, every drop gone — and a run that was going starts again from the start (a Reset in
 * a simulation scene is "play it again", not "stop").
 * @returns {Promise<boolean>} restarted
 */
export async function resetWholeSimulation() {
	const p = await import('../physics');
	const wasRunning = get(p.simulating);
	if (wasRunning) p.resetSimulation();
	const [{ resetFluid }, { resetPours }] = await Promise.all([import('./fluidRuntime.js'), import('../water/pourDrops.js')]);
	resetFluid();
	resetPours();
	if (!wasRunning) return false;
	await new Promise((r) => setTimeout(r, 50)); // the reset's restore lands first
	if (!get(p.simulating) && !get(p.remoteSimulating)) await p.toggleSimulation();
	return !!get(p.simulating);
}
