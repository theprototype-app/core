// VR sleeve palette (K, experimental): a flat strip of ghost mini-primitives
// riding the sleeve-hand forearm in VR — point + trigger detaches a held
// preview (stick scales, wrist rotates), release creates it with the active
// snap rules as one undo step. Grip-drop an existing object ONTO the strip to
// capture it as a personal prefab slot (LOCAL persistence, never replicated).
// This shell only wires the feature in; the logic lives in $lib/vrSleeve.js
// and stays DORMANT until Settings ▸ VR ▸ "VR sleeve palette" is enabled
// (default off). Disabling this module removes the hooks entirely (reload).

export default {
	id: 'vrsleeve',
	name: 'VR Sleeve Palette',
	version: '1.0.0',
	description:
		'Experimental VR forearm palette: trigger-drag ghost primitives (or captured prefab slots) off your sleeve to place them. Enable it in Settings > VR.',
	/** @param {any} api */
	register(api) {
		// the sleeve is LOCAL-ONLY (nothing replicates through the module channel);
		// core VR hooks are reached via dynamic import — the moduleSDK pattern.
		import('../../lib/vrSleeve')
			.then((sleeve) => sleeve.registerVRSleeve())
			.catch((error) => console.log('vrsleeve module failed to load', error));
	}
};
