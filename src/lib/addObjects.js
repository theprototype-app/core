import { get } from 'svelte/store';
import { selectedObject } from '../stores/sceneStore';
import { peers, meshGenModalOpen, showSidebar, inspectorClose } from '../stores/appStore';
import { sceneCommand } from './commandsHandler.svelte';
import { primitivesCatalog } from './primitivesCatalog';
import { meshGenReady } from './ai/meshProviders';
import { addParticlesPreset } from './particleActions';
import { PARTICLE_PRESETS } from './particlePresets';
import { ARCH_TYPES, snapToMetre } from './arch/archGeometry.js';
// 36-water: a PRIMED dynamic import — waterActions reaches history (the TDZ-cycle family)
/** @type {any} */ let waterRef = null;
import('./water/waterActions.js').then((m) => (waterRef = m));

// 23-A5: device kinds (core's and every module's, one registry) as an Add-menu group.
// PRIMED dynamic import: audioDevices reaches history, and a static edge from a
// menu builder into that family is how the SSR prerender TDZ-crashes.
/** @type {any} */ let devicesRef = null;
import('./audioDevices').then((m) => (devicesRef = m));

// Spawning for the viewport Add menu (77): run the replicated create command,
// then land the new object at the clicked ground point (groups keep their
// default spot) — the position rides the normal `move` message.

/** @param {string} command @param {number[] | null | undefined} point */
export function spawnAtPoint(command, point) {
	sceneCommand(command);
	const object = get(selectedObject);
	// 37 R3: architecture lands on the 1 m grid (a wall's origin is its end, a door's and a
	// window's the middle of the opening they fill), so pieces placed apart still line up
	if (point && ARCH_TYPES.includes(object?.userData?.geometryParams?.gtype)) point = snapToMetre(point);
	if (point && object?.uuid && !command.startsWith('/group')) {
		object.position.set(point[0], point[1], point[2]);
		/** @type {any} */
		const peer = get(peers);
		if (peer)
			peer.send({
				type: 'move',
				uuid: object.uuid,
				pos: object.position.toArray(),
				rot: object.rotation.toArray(),
				scale: object.scale.toArray()
			});
	}
	// 41 G2: creating never OPENS the Inspector (Unity / Blender / Figma, and what a pack drop
	// always did) — it selects the new object, and an Inspector that is ALREADY open follows it,
	// even from another panel (Configure Scene, a different selection; 16-Q2's switch)
	if (object?.uuid && !get(inspectorClose)) showSidebar('properties');
	return object;
}

/** 36-fb F23: a Fluid emitter 1.6 m above the clicked point, pouring down onto it @param {number[] | null} point */
function placeFluidEmitter(point) {
	const object = spawnAtPoint('/create FluidEmitter', point);
	if (!object?.uuid || !point) return object;
	object.position.y += 1.6;
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'move', uuid: object.uuid, pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() });
	return object;
}

/** The Devices group(s) of the Add menu, from the registry. @param {() => number[] | null} pointOf */
function deviceMenuGroups(pointOf) {
	const catalog = devicesRef?.deviceCatalog?.() ?? [];
	if (!catalog.length) return [];
	/** @type {Record<string, any[]>} */
	const groups = {};
	for (const spec of catalog) {
		const name = spec.group && spec.group !== 'devices' ? 'Devices: ' + spec.group : 'Devices';
		(groups[name] ??= []).push({
			label: spec.label || spec.kind,
			tooltip: 'Place a ' + (spec.label || spec.kind) + ' device',
			kind: spec.kind,
			action: () => devicesRef.addDevice(spec.kind, { position: pointOf() })
		});
	}
	return Object.entries(groups).map(([label, children]) => ({ label, children }));
}

/** Nested `Add ▸` children for the viewport menu @param {() => number[] | null} pointOf */
export function buildAddChildren(pointOf) {
	return [
		...primitivesCatalog.map((group) => ({
			label: group.group,
			children: group.items.map((item) => ({
				label: item.label,
				action: () => spawnAtPoint(item.command, pointOf())
			}))
		})),
		{ label: 'Group', tooltip: 'Create an empty group', action: () => spawnAtPoint('/group New', null) },
		// 23-A5: instruments and effects. Built from the registry at menu-open time, so a
		// module registering (or going away) needs no menu plumbing of its own. A device is
		// created through addDevice (a replicated toJSON), never through /create.
		...deviceMenuGroups(pointOf),
		// PFX-A: standalone emitters — a small marker sphere carries the config
		// (userData.particles rides object sync / GLTF extras, so it replicates
		// and saves like any object)
		{
			label: 'Effects',
			children: PARTICLE_PRESETS.map((preset) => ({
				label: preset.name,
				tooltip: 'Place a ' + preset.name + ' particle emitter',
				action: () => {
					const object = spawnAtPoint('/create Sphere 0.15', pointOf());
					if (!object?.uuid) return;
					/** @type {any} */
					const peer = get(peers);
					object.name = preset.name + ' emitter';
					if (peer) peer.send({ type: 'name', uuid: object.uuid, name: object.name });
					// the marker itself should not cast a shadow (userData.shadow
					// keeps the opt-out through GLTF sync, V-1)
					object.castShadow = false;
					object.userData.shadow = false;
					if (peer) peer.send({ type: 'objectParameters', parameter: 'castShadow', uuid: object.uuid, castShadow: false });
					// nor join simulations (primitives spawn dynamic by default now —
					// an emitter marker must stay scenery, not tumble away)
					delete object.userData.physics;
					if (peer) peer.send({ type: 'objectParameters', parameter: 'physics', uuid: object.uuid, physics: null });
					addParticlesPreset(object.uuid, preset.key);
					// 36 B3: a weather emitter hangs at cloud height over the clicked ground
					const fall = Number(/** @type {any} */ (preset.config).fall) || 0;
					if (fall > 0) {
						object.position.y += fall;
						if (peer) peer.send({ type: 'move', uuid: object.uuid, pos: object.position.toArray(), rot: object.rotation.toArray(), scale: object.scale.toArray() });
					}
				}
			}))
		},
		// 36-water: tanks, pools, an ocean, bubbles — a /create container made into water
		{
			label: 'Water',
			children: [
				...(waterRef?.WATER_KINDS ?? []).map((/** @type {any} */ kind) => ({
					label: kind.label,
					tooltip: 'Place ' + kind.label.toLowerCase() + ' (' + kind.preset + ' preset)',
					action: () => waterRef?.makeWater(spawnAtPoint(kind.command, pointOf()), kind.key)
				})),
				{
					label: 'Bubbles',
					tooltip: 'Place a bubble emitter (rises to the surface of the water it sits in)',
					action: () => waterRef?.makeBubbles(spawnAtPoint('/create Sphere 0.08', pointOf()))
				},
				// 36-fb-water F17: a spout that pours drops (they splash into water and settle)
				{
					label: 'Pour',
					tooltip: 'Place a pour emitter (drops arc out, splash into water and settle)',
					action: () => {
						const o = spawnAtPoint('/create Sphere 0.08', pointOf());
						if (!o?.uuid) return;
						o.position.y += 1.2; // a spout pours from above the ground
						/** @type {any} */
						const peer = get(peers);
						if (peer) peer.send({ type: 'move', uuid: o.uuid, pos: o.position.toArray(), rot: o.rotation.toArray(), scale: o.scale.toArray() });
						waterRef?.makePour(o);
					}
				},
				{
					// 36-fb F23: particle fluid poured into the scene (a spout 1.6 m above the click)
					label: 'Fluid',
					tooltip: 'Place a fluid emitter: real particle water that pours, splashes and pools (hard caps keep it bounded)',
					action: () => placeFluidEmitter(pointOf())
				},
				{
					// 36-fb F24: a flow path streams water and floating things toward its end
					label: 'Flow path',
					tooltip: 'Place a flow path: a river, chute or pipe that carries fluid (and floating objects) toward its end',
					action: () => spawnAtPoint('/create FlowPath', pointOf())
				}
			]
		},
		// Generate a custom mesh from a prompt (roadmap #11) — only when configured
		...(meshGenReady()
			? [
					{
						label: '✨ Generate 3D model…',
						tooltip: 'Create a custom mesh from a text prompt',
						action: () => meshGenModalOpen.set({ position: pointOf() })
					}
			  ]
			: [])
	];
}
