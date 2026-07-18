// Reference module: adds a "Wave" animation node to the flow editor.
// Connect Wave -> Object Selector and the object rocks side to side on
// every peer (deterministic effect: node data + synced time, no messages).

export default {
	id: 'hello',
	name: 'Hello Wave',
	version: '1.0.0',
	description: 'Reference module: a Wave animation node that rocks objects.',
	/** @param {any} api */
	register(api) {
		api.registerNodeGroup({
			group: 'Modules',
			items: [
				{
					type: 'wave',
					label: 'Wave (hello)',
					defaults: { amplitude: 0.4, speed: 2 },
					params: [
						{ key: 'amplitude', kind: 'range', min: 0, max: 1.5, step: 0.05 },
						{ key: 'speed', kind: 'range', min: 0.2, max: 10, step: 0.1 }
					]
				}
			]
		});

		api.registerEffect('wave', (object, base, data, time) => {
			const amplitude = data.amplitude ?? 0.4;
			const speed = data.speed ?? 2;
			object.rotation.z = base.rot[2] + Math.sin(time * speed) * amplitude;
		});
	}
};
