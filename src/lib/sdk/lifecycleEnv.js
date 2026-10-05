// Module lifecycle — the TEST SEAM for contract T2 (34 R6). The lifecycle contract
// (tests/fixtures/sdkLifecycleFixtures.js) proves every registering SDK member has a teardown
// path by checking CORE's registries directly, so it needs the app's own module instances:
// in the browser this file is reached through the debug hook (`__stores.moduleLifecycle`,
// loaded by the app's own import graph — never a second instance), in node vitest it is
// imported directly. A module that cannot load where it runs (the `.svelte.js` family in
// node) comes back null, and the fixtures that need it are skipped there and run in the
// browser suite (module-lifecycle).

import { get } from 'svelte/store';
import * as THREE from 'three';

/** @param {Promise<any>} p */
const tryLoad = (p) => p.then(
	(m) => m,
	() => null
);

/** Everything a lifecycle fixture may read. Loaded lazily, once. */
export async function lifecycleEnv() {
	const [
		sdk,
		index,
		context,
		registries,
		lifecycle,
		sceneStore,
		flowStore,
		customNodes,
		moduleNodeIO,
		customGeometries,
		moduleContent,
		playSettings,
		moduleToolboxes,
		shortcuts,
		vrRadialMenu,
		inputRuntime,
		knock,
		gameMusic,
		possess,
		vrPointer,
		gameShell,
		gameSettings,
		gameState,
		lod,
		qualityGovernor,
		peerVars,
		uvUnwrap,
		shaderBackends,
		audioDevices,
		scenePost,
		postBackends,
		flowRuntime,
		moduleHudKinds,
		audioEngine,
		micCapture,
		musicClock,
		kitRuntime,
		modelLoader,
		waterVolumes,
		coreModuleIndex,
		touchActions,
		engines,
		vrSeat
	] = await Promise.all([
		import('../moduleSDK.js'),
		import('./index.js'),
		import('./context.js'),
		import('./registries.js'),
		import('./lifecycle.js'),
		tryLoad(import('../../stores/sceneStore')),
		tryLoad(import('../../stores/flowStore')),
		tryLoad(import('../customNodes')),
		tryLoad(import('../moduleNodeIO')),
		tryLoad(import('../customGeometries')),
		tryLoad(import('../moduleContent')),
		tryLoad(import('../playSettings')),
		tryLoad(import('../moduleToolboxes')),
		tryLoad(import('../shortcuts')),
		tryLoad(import('../vrRadialMenu')),
		tryLoad(import('../inputRuntime')),
		tryLoad(import('../knock')),
		tryLoad(import('../gameMusic')),
		tryLoad(import('../possess')),
		tryLoad(import('../vr/pointer.js')),
		tryLoad(import('../gameShell')),
		tryLoad(import('../gameSettings')),
		tryLoad(import('../gameState')),
		tryLoad(import('../lod')),
		tryLoad(import('../qualityGovernor')),
		tryLoad(import('../peerVars')),
		tryLoad(import('../uvUnwrap')),
		tryLoad(import('../shaderBackends')),
		tryLoad(import('../audioDevices')),
		tryLoad(import('../scenePost')),
		tryLoad(import('../postBackends')),
		tryLoad(import('../flowRuntime')),
		tryLoad(import('../moduleHudKinds')),
		tryLoad(import('../audioEngine')),
		tryLoad(import('../micCapture')),
		tryLoad(import('../musicClock')),
		tryLoad(import('../kit/runtime.js')),
		tryLoad(import('../modelLoader')),
		tryLoad(import('../water/volumes.js')),
		// the bundled modules, for the leak suite's load/unload cycles (a .svelte import: browser only)
		tryLoad(import('../../modules/index.js')),
		tryLoad(import('../touchActions')),
		tryLoad(import('../behaviours/engines.js')),
		tryLoad(import('../vr/seat.js'))
	]);
	const browser = typeof window !== 'undefined' && typeof document !== 'undefined';
	return {
		get,
		THREE,
		browser,
		sdk,
		SDK_TABLE: index.SDK_TABLE,
		makeContext: context.makeModuleContext,
		registries,
		lifecycle,
		coreModules: coreModuleIndex?.coreModules ?? [],
		mods: {
			sceneStore,
			flowStore,
			customNodes,
			moduleNodeIO,
			customGeometries,
			moduleContent,
			playSettings,
			moduleToolboxes,
			shortcuts,
			vrRadialMenu,
			inputRuntime,
			knock,
			gameMusic,
			possess,
			vrPointer,
			gameShell,
			gameSettings,
			gameState,
			lod,
			qualityGovernor,
			peerVars,
			uvUnwrap,
			shaderBackends,
			audioDevices,
			scenePost,
			postBackends,
			flowRuntime,
			moduleHudKinds,
			// the WebAudio and capture members only make sense where those exist
			audioEngine: browser && typeof AudioContext !== 'undefined' ? audioEngine : null,
			micCapture: browser && typeof navigator !== 'undefined' && navigator.mediaDevices ? micCapture : null,
			musicClock,
			kitRuntime,
			modelLoader,
			touchActions,
			engines,
			waterVolumes,
			vrSeat
		}
	};
}
