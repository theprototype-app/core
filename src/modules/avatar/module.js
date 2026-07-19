// Avatar controller (K-D): possess the selected object and drive it with
// WASD/arrows (tank controls — W/S move along its facing, A/D turn) or the VR
// left stick, with a chase camera. No module messages: the movement is plain
// throttled `move`s and the possession itself is the selection lock peers
// already see — nothing extra to sync.

export default {
	id: 'avatar',
	name: 'Avatar Controller',
	version: '1.0.0',
	description: 'Possess the selected object: WASD drives it with a chase camera (Esc releases).',
	/** @param {any} api */
	register(api) {
		api.registerBindings([
			{ label: 'Drive forward / back (possessed)', keys: 'W / S' },
			{ label: 'Turn left / right (possessed)', keys: 'A / D' },
			{ label: 'Release possession', keys: 'Esc' }
		]);

		api.registerMenu('Possess selected object', () => {
			const uuid = api.selectedUuid?.();
			if (!uuid) {
				api.toast('Select an object first, then possess it');
				return;
			}
			if (api.possess(uuid)) api.toast('Possessed — WASD drives, Esc releases');
		});

		api.registerVRMenuEntry({
			id: 'possess',
			group: 'object', // Edit ▸ ring (needs a selection anyway)
			label: 'Possess',
			order: 20,
			closes: true,
			action: () => {
				const uuid = api.selectedUuid?.();
				if (uuid) api.possess(uuid, { camera: 'none' }); // VR keeps its own camera
			}
		});
	}
};
