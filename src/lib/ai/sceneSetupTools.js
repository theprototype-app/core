// Roadmap 85 H3-H7 — THE SCENE-SETUP TOOLS: sky, light, spawn, the play camera and the opening view.
//
//   set_sky          (set_look {sky})        look preset, HDRI sky + Sky quality, background, fog, exposure
//   set_light        (set_look {light})      the rig sun + ambient, environment lights
//   get_environment  (set_look {environment}) read all of it (viewers may read)
//   place_spawn      (game_setup {spawn})    where Play starts and which way the player faces
//   set_play_camera  (game_setup {play_camera}) first person walk / fly (the Character Controller) + H6 openingView
//
// Sky and light change the OWNER's look, so they ask first (agent/confirmGate, rule 7) and apply as ONE undo step
// (the `environment` kind) through environment.js's one write path. Spawn and opening view ride the scene-settings
// singleton (scenePhysics) with the `sceneplay` undo kind; the play camera is the Character Controller node a person
// would place, so it undoes as the flow edit it is. Heavy modules load on first use.
import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup } from '../../stores/sceneStore.js';
import { ENVIRONMENT_PRESETS, environment, presetPayload } from '$lib/environment';
import { BUNDLED_HDRIS } from '$lib/hdri/catalog.js';
import { hdriOf } from '$lib/hdri/hdriCore.js';
import { scenePhysicsState_ } from '$lib/scenePhysics';
import { planSky, planLight, planSpawn, planOpeningView, planPlayCamera, SKY_QUALITY_WORDS, ENV_LIGHT_KINDS, MAX_ENV_LIGHTS, PLAY_CAMERA_MODES } from './sceneSetupCore.js';

export const SCENE_SETUP_TOOL_NAMES = ['set_sky', 'set_light', 'get_environment', 'place_spawn', 'set_play_camera'];
export const SCENE_SETUP_READ_TOOLS = ['get_environment'];

/** a CSS colour name → '#rrggbb' @param {string} name */
function named(name) {
	const n = /** @type {any} */ (THREE.Color).NAMES?.[name];
	return n === undefined ? null : '#' + n.toString(16).padStart(6, '0');
}

/** @param {string} uuid @returns {any} */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

/** the current environment, as the planners take it */
function envNow() {
	const s = get(environment);
	return { preset: s.preset ?? 'studio', exposure: s.exposure ?? 1, payload: presetPayload(s), lights: s.lights ?? [] };
}

/** @param {string} tool @param {any} args @param {string} summary @param {() => any} apply */
async function gated(tool, args, summary, apply) {
	const { gateScenewide } = await import('$lib/agent/confirmGate');
	return gateScenewide(tool, args, { summary, apply });
}

/** @param {any} args */
async function setSkyTool(args) {
	const plan = planSky(args, { ...envNow(), presets: ENVIRONMENT_PRESETS, hdris: BUNDLED_HDRIS, named });
	if ('error' in plan && args?.confirmId === undefined) return { error: plan.error };
	const words = 'error' in plan ? [] : plan.words;
	return gated('set_sky', args, 'the sky: ' + words.join(', '), async () => {
		// planned again: the sky may have moved while the host thought about it
		const now = planSky(args, { ...envNow(), presets: ENVIRONMENT_PRESETS, hdris: BUNDLED_HDRIS, named });
		if ('error' in now) return { error: now.error };
		const h = await import('./sceneSetupHistory.js');
		const { commitEnvironment } = await import('$lib/environment');
		const before = h.environmentNow();
		commitEnvironment({ ...before, ...now.state });
		h.recordEnvironment(before);
		return { updated: [{ environment: true, ok: true }], ...describeEnvironment(), ...(now.warnings.length ? { warnings: now.warnings } : {}) };
	});
}

/** @param {any} args */
async function setLightTool(args) {
	const mk = () => ({ ...envNow(), named, newId: () => crypto.randomUUID().slice(0, 8) });
	const plan = planLight(args, mk());
	if ('error' in plan && args?.confirmId === undefined) return { error: plan.error };
	const words = 'error' in plan ? [] : plan.words;
	return gated('set_light', args, 'the scene light: ' + words.join(', '), async () => {
		const now = planLight(args, mk());
		if ('error' in now) return { error: now.error };
		const h = await import('./sceneSetupHistory.js');
		const { commitEnvironment } = await import('$lib/environment');
		const before = h.environmentNow();
		commitEnvironment({ ...before, ...now.state });
		h.recordEnvironment(before);
		return { updated: [{ environment: true, ok: true }], ...(now.added.length ? { created: now.added.map((id) => ({ envLight: id })) } : {}), ...describeEnvironment() };
	});
}

/** the environment in the words the tools take */
function describeEnvironment() {
	const s = get(environment);
	const p = presetPayload(s);
	const hdri = hdriOf(p);
	return {
		preset: s.preset ?? 'studio',
		label: p.label ?? s.preset,
		exposure: s.exposure ?? 1,
		background: p.background ?? null,
		...(p.gradient ? { gradient: p.gradient } : {}),
		hdri: hdri
			? {
					name: hdri.src.startsWith('bundled:') ? hdri.src.slice(8) : undefined,
					...(hdri.src.startsWith('hash:') ? { hash: hdri.src.slice(5) } : {}),
					rotation: hdri.rotation,
					intensity: hdri.intensity,
					blur: hdri.blur,
					background: hdri.background,
					quality: hdri.quality,
					minQuality: hdri.minQuality
				}
			: null,
		fog: p.fog ? { color: p.fog.color, near: p.fog.near, far: p.fog.far } : null,
		sun: p.sun ? { color: p.sun.color, intensity: p.sun.intensity, position: p.sun.position } : null,
		ambient: p.hemi ? { sky: p.hemi.sky, ground: p.hemi.ground, intensity: p.hemi.intensity } : null,
		envLights: (s.lights ?? []).map((/** @type {any} */ l) => ({ id: l.id, kind: l.kind, color: l.color, intensity: l.intensity, position: l.position, ...(l.groundColor ? { groundColor: l.groundColor } : {}) }))
	};
}

/** @param {any} args */
function getEnvironmentTool(args) {
	/** @type {any[]} */
	const sceneLights = [];
	get(objectsGroup)?.traverse((/** @type {any} */ o) => {
		if (o.isLight && sceneLights.length < 50)
			sceneLights.push({ uuid: o.uuid, name: o.name, type: o.type.replace(/Light$/, '').toLowerCase(), intensity: o.intensity, castShadow: !!o.castShadow, ...(o.shadow?.mapSize ? { shadowMapSize: o.shadow.mapSize.x } : {}) });
	});
	const phys = get(scenePhysicsState_);
	return {
		...describeEnvironment(),
		sceneLights,
		play: { spawn: phys.play?.spawn ?? null, openingView: phys.startView ?? null },
		...(args?.names === false
			? {}
			: {
					presets: Object.entries(ENVIRONMENT_PRESETS).map(([k, v]) => k + (/** @type {any} */ (v).hdri ? ' (sky image)' : '')),
					skies: Object.entries(BUNDLED_HDRIS).map(([k, v]) => k + ': ' + v.label)
				})
	};
}

// ---- game setup -----------------------------------------------------------------------------

/** where to stand on an object: the top of its bounds, at its middle @param {any} object */
function topOf(object) {
	const box = new THREE.Box3().setFromObject(object);
	if (box.isEmpty()) return object.getWorldPosition(new THREE.Vector3()).toArray();
	const c = box.getCenter(new THREE.Vector3());
	return [c.x, box.max.y, c.z];
}

/** the scene's bounds, for the "frame" opening view */
function sceneBounds() {
	const group = get(objectsGroup);
	if (!group) return null;
	const box = new THREE.Box3().setFromObject(group);
	if (box.isEmpty()) return null;
	const sphere = box.getBoundingSphere(new THREE.Sphere());
	return { center: sphere.center.toArray(), radius: sphere.radius };
}

/** @param {any} args */
async function placeSpawnTool(args) {
	const a = { ...(args ?? {}) };
	if (typeof a.object === 'string') {
		const object = objectOf(a.object);
		if (!object) return { error: 'object: no object ' + a.object.slice(0, 40) + ' (list_scene)' };
		a.position = topOf(object);
	}
	if (typeof a.facing === 'string') {
		const target = objectOf(a.facing);
		if (!target) return { error: 'facing: no object ' + a.facing.slice(0, 40) };
		a.facing = target.getWorldPosition(new THREE.Vector3()).toArray();
	}
	const plan = planSpawn(a);
	if ('error' in plan) return { error: plan.error };
	const h = await import('./sceneSetupHistory.js');
	const { setScenePhysics } = await import('$lib/scenePhysics');
	const before = h.scenePlayNow();
	setScenePhysics({ play: { spawn: plan.spawn } });
	h.recordScenePlay(before);
	return plan.spawn
		? { updated: [{ spawn: true, ok: true }], spawn: plan.spawn, note: 'Play starts here, facing yaw ' + plan.spawn.yaw + ' rad (0 faces -Z).' }
		: { updated: [{ spawn: true, ok: true }], spawn: null, note: 'No spawn: Play starts where the editor camera is.' };
}

/** @param {any} args */
async function setPlayCameraTool(args) {
	const a = args ?? {};
	if (a.mode === undefined && a.openingView === undefined) return { error: 'give mode (first, or none for the default) and / or openingView' };
	/** @type {any} */
	const out = { updated: [] };
	/** @type {string[]} */
	const notes = [];
	if (a.openingView !== undefined) {
		const phys = get(scenePhysicsState_);
		const plan = planOpeningView(a.openingView, { spawn: phys.play?.spawn ?? null, bounds: a.openingView === 'frame' ? sceneBounds() : null });
		if ('error' in plan) return { error: plan.error };
		const h = await import('./sceneSetupHistory.js');
		const { setScenePhysics } = await import('$lib/scenePhysics');
		const before = h.scenePlayNow();
		setScenePhysics({ startView: plan.view });
		h.recordScenePlay(before);
		out.openingView = plan.view;
		out.updated.push({ openingView: true, ok: true });
		notes.push(plan.view ? 'The scene now opens on this view (saved with the scene; nobody\'s camera moved).' : 'The scene opens where it was saved from again.');
	}
	if (a.mode !== undefined) {
		const plan = planPlayCamera(a);
		if ('error' in plan) return { error: plan.error, ...(out.updated.length ? { applied: out } : {}) };
		if ('later' in plan) {
			if (!out.updated.length) return { error: plan.later, unavailable: true };
			notes.push(plan.later);
		} else {
			const flow = await controllerNodes(plan.controller);
			if ('error' in flow) return { error: flow.error, ...(out.updated.length ? { applied: out } : {}) };
			out.playCamera = { mode: plan.controller ? 'first' : 'none', ...(plan.controller ?? {}) };
			out.updated.push({ playCamera: true, ok: true });
			if (flow.nodeId) out.created = [{ node: flow.nodeId }];
			notes.push(flow.note);
		}
	}
	return { ...out, note: notes.join(' ') };
}

/** write / update / remove the scene graph's Character Controller @param {Record<string, any> | null} controller */
async function controllerNodes(controller) {
	const { graphOf, SCENE_GRAPH } = await import('../../stores/flowStore');
	const { createFlowNodesTool, updateFlowNodesTool } = await import('./flowTools.js');
	const graph = graphOf(SCENE_GRAPH);
	const existing = (graph?.nodes ?? []).filter((/** @type {any} */ n) => n.type === 'charcontroller');
	if (!controller) {
		if (!existing.length) return { note: 'Play already uses its default camera.' };
		const r = updateFlowNodesTool({ graph: 'scene', remove: existing.map((/** @type {any} */ n) => n.id) });
		if (r?.error) return { error: r.error };
		return { note: 'Removed the Character Controller: Play uses its default camera.' };
	}
	if (existing.length) {
		// the newest one is the one that runs: change it rather than stacking a second (the several-controllers toast)
		const node = existing[existing.length - 1];
		const r = updateFlowNodesTool({ graph: 'scene', updates: [{ id: node.id, data: controller }] });
		if (r?.error) return { error: r.error };
		return { nodeId: node.id, note: 'Changed the scene\'s Character Controller node (' + controller.mode + ').' };
	}
	const r = createFlowNodesTool({ graph: 'scene', nodes: [{ type: 'charcontroller', data: controller }] });
	if (r?.error) return { error: r.error };
	const id = r?.created?.[0]?.id ?? r?.nodes?.[0]?.id ?? r?.ids?.[0];
	return { nodeId: id, note: 'Added a Character Controller node to the scene graph (' + controller.mode + ').' };
}

/** @param {string} name @param {any} args */
export async function sceneSetupTool(name, args) {
	switch (name) {
		case 'set_sky':
			return setSkyTool(args ?? {});
		case 'set_light':
			return setLightTool(args ?? {});
		case 'get_environment':
			return getEnvironmentTool(args ?? {});
		case 'place_spawn':
			return placeSpawnTool(args ?? {});
		case 'set_play_camera':
			return setPlayCameraTool(args ?? {});
		default:
			return { error: 'unknown scene tool ' + name };
	}
}

// ---- schemas --------------------------------------------------------------------------------

const SKY_NAMES = Object.keys(BUNDLED_HDRIS).join(', ');
const PRESET_NAMES = Object.keys(ENVIRONMENT_PRESETS).join(', ');
const CONFIRM = {
	confirmId: { type: 'string', description: 'the id a needsConfirm answer gave: repeat the call with it to get the host\'s answer and apply' },
	wait: { type: 'number', description: 'with confirmId: seconds to wait for the answer (up to 60)' }
};
const TRIPLE = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const LIGHT_FIELDS = { color: { type: 'string' }, intensity: { type: 'number', minimum: 0 }, position: TRIPLE };

export const SCENE_SETUP_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_sky',
			description:
				'The sky and the air: a look preset (' +
				PRESET_NAMES +
				'), a sky image by name (' +
				SKY_NAMES +
				'; or {hash} of an HDR in the library — never a URL) with rotation, intensity, blur and Sky quality (auto / standard / high / max, plus a minimum), a background colour or {top, bottom} gradient, fog ({color, near, far} in metres, or {color, density}; null = none) and exposure. "Make it night": preset night or hdri starlight + a dark fog. Changes the whole scene\'s look, so the host is asked first: it answers needsConfirm, then repeat with confirmId. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					preset: { type: 'string', description: PRESET_NAMES },
					hdri: {
						type: ['string', 'object', 'null'],
						description: 'a sky name (' + SKY_NAMES + '), null for none, or {name | hash, rotation (degrees), intensity 0-4, blur 0-1, background (false = light only), quality, minQuality}',
						properties: {
							name: { type: 'string' },
							hash: { type: 'string' },
							rotation: { type: 'number' },
							intensity: { type: 'number', minimum: 0, maximum: 4 },
							blur: { type: 'number', minimum: 0, maximum: 1 },
							background: { type: 'boolean' },
							quality: { type: 'string', enum: SKY_QUALITY_WORDS },
							minQuality: { type: 'string', enum: SKY_QUALITY_WORDS.slice(1) }
						}
					},
					background: { type: 'string', description: 'a colour: hex or a CSS name' },
					gradient: { type: ['object', 'null'], properties: { top: { type: 'string' }, bottom: { type: 'string' } } },
					fog: {
						type: ['object', 'null'],
						properties: { color: { type: 'string' }, near: { type: 'number', minimum: 0 }, far: { type: 'number', minimum: 0 }, density: { type: 'number', exclusiveMinimum: 0 } }
					},
					exposure: { type: 'number', minimum: 0.1, maximum: 4 },
					...CONFIRM
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_light',
			description:
				'The scene\'s own lighting: sun {color, intensity, direction [x,y,z] the light shines (y below 0)} or null for none, ambient {sky, ground, intensity} or null, and environment lights (' +
				ENV_LIGHT_KINDS.join(' / ') +
				', at most ' +
				MAX_ENV_LIGHTS +
				'): add [{kind, color, intensity, position}], update [{id, …}], remove [ids] (get_environment lists their ids). Lamps, spots and area lights in the scene are objects: create_objects kind light. Changes the whole scene\'s look, so the host is asked first (needsConfirm, then repeat with confirmId). One undo step.',
			parameters: {
				type: 'object',
				properties: {
					sun: { type: ['object', 'null'], properties: { color: { type: 'string' }, intensity: { type: 'number', minimum: 0 }, direction: TRIPLE } },
					ambient: { type: ['object', 'null'], properties: { sky: { type: 'string' }, ground: { type: 'string' }, intensity: { type: 'number', minimum: 0 } } },
					add: { type: 'array', maxItems: MAX_ENV_LIGHTS, items: { type: 'object', properties: { kind: { type: 'string', enum: ENV_LIGHT_KINDS }, groundColor: { type: 'string' }, ...LIGHT_FIELDS } } },
					update: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, groundColor: { type: 'string' }, ...LIGHT_FIELDS } } },
					remove: { type: 'array', items: { type: 'string' } },
					...CONFIRM
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'get_environment',
			description:
				'Read the scene\'s sky and light: the preset, the sky image and its quality, background, fog, exposure, the sun and ambient, the environment lights (ids for set_light), the light objects (uuid, shadows) and the spawn / opening view; plus the preset and sky names. Read this before changing the look.',
			parameters: { type: 'object', properties: { names: { type: 'boolean', description: 'false = leave out the preset and sky name lists' } } }
		}
	},
	{
		type: 'function',
		function: {
			name: 'place_spawn',
			description:
				'Where Play starts: position [x, y, z] of the player\'s feet (or object: a uuid to stand on top of), facing a point [x, y, z] or an object uuid (or yaw in radians, 0 faces -Z); clear: true removes it. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					position: TRIPLE,
					object: { type: 'string' },
					facing: { type: ['array', 'string'], items: { type: 'number' } },
					yaw: { type: 'number' },
					clear: { type: 'boolean' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_play_camera',
			description:
				'How Play looks and where the editor opens. mode: first = first person through the player\'s eyes, walking (fly: true to fly) with speed, jumpHeight, eyeHeight, gravity — a Character Controller node in the scene graph, changed in place on a second call; none = the default Play camera. third / orbit / fixed are not Play cameras yet (the answer says what to use instead). openingView (H6): where the editor camera starts when the scene opens — {position, target}, "spawn" (behind the player), "frame" (the whole scene) or null; saved with the scene, nobody\'s view moves now.',
			parameters: {
				type: 'object',
				properties: {
					mode: { type: 'string', enum: PLAY_CAMERA_MODES },
					fly: { type: 'boolean' },
					speed: { type: 'number', minimum: 0.01, maximum: 1 },
					jumpHeight: { type: 'number', minimum: 0, maximum: 5 },
					eyeHeight: { type: 'number', minimum: 0.2, maximum: 3 },
					gravity: { type: 'boolean' },
					openingView: {
						type: ['object', 'string', 'null'],
						description: '{position: [x,y,z], target: [x,y,z]}, "spawn", "frame" or null',
						properties: { position: TRIPLE, target: TRIPLE }
					}
				}
			}
		}
	}
];

export const SCENE_SETUP_PROMPT =
	'\n\nSky, light and game setup: set_sky (preset, sky image, background, fog, exposure) and set_light (sun, ambient, environment lights) change the whole look, so they answer needsConfirm until the host allows it — then repeat with confirmId; get_environment reads both. place_spawn sets where Play starts; set_play_camera picks first person (walk or fly) and the scene\'s opening view.';
