// Roadmap 85 H3-H7 — the PURE half of the scene-setup tools (imports nothing; the unit layer runs it).
//
//   set_sky          a look preset, an HDRI sky by name (+ rotation, strength, blur, Sky quality, minimum), the
//                    background colour or gradient, fog (colour + near / far, or a density), exposure
//   set_light        the environment rig's sun and ambient, and the environment lights (add / update / remove)
//   place_spawn      where Play starts: a point (or an object's spot) and the way the player faces
//   set_play_camera  how Play looks: first person (walk or fly) — and the H6 editor OPENING VIEW
//
// The planners take the current payload / state as plain data and return the next one, so the tools stay a thin
// apply + undo + confirm layer over environment.js / scenePhysics.js.

const HEX = /^#[0-9a-f]{6}$/i;

/** @param {any} v */
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {any} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {any} v */
const triple = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);
/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * A colour an agent may pass: '#rrggbb', '#rgb' or a CSS name the caller resolves.
 * @param {any} v @param {(name: string) => string | null} [named] @returns {string | null}
 */
export function colorOf(v, named = () => null) {
	if (typeof v !== 'string') return null;
	const s = v.trim();
	if (HEX.test(s)) return s.toLowerCase();
	if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
	return named(s.toLowerCase());
}

/** match a name against a table by key or label, case- and space-blind @param {any} raw @param {Record<string, {label?: string}>} table */
export function findByName(raw, table) {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	const want = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
	for (const [key, row] of Object.entries(table)) {
		if (key.toLowerCase().replace(/[\s_-]+/g, '') === want) return key;
		if (String(row?.label ?? '').toLowerCase().replace(/[\s_-]+/g, '') === want) return key;
	}
	return null;
}

export const SKY_QUALITY_WORDS = ['auto', 'standard', 'high', 'max'];
/** a FogExp2 density is turned into the linear fog the scene renders: ~98% fogged at 2 / density */
export const DENSITY_FAR = 2;

/**
 * Plan a set_sky call.
 * @param {any} args
 * @param {{presets: Record<string, any>, hdris: Record<string, any>, payload: any, preset: string, exposure: number,
 *   named?: (name: string) => string | null}} now the current preset key + its payload, the tables
 * @returns {{state: {preset: string, exposure: number, customPreset: any}, words: string[], warnings: string[]} | {error: string}}
 */
export function planSky(args, now) {
	const a = args ?? {};
	const keys = ['preset', 'hdri', 'sky', 'background', 'gradient', 'fog', 'exposure'];
	if (!keys.some((k) => a[k] !== undefined)) return { error: 'nothing to set: give preset, hdri, background, fog or exposure' };
	/** @type {string[]} */
	const words = [];
	/** @type {string[]} */
	const warnings = [];
	let presetKey = now.preset;
	let payload = JSON.parse(JSON.stringify(now.payload ?? {}));
	if (a.preset !== undefined) {
		const key = findByName(a.preset, now.presets);
		if (!key) return { error: 'preset "' + String(a.preset).slice(0, 40) + '": one of ' + Object.keys(now.presets).join(', ') };
		presetKey = key;
		payload = JSON.parse(JSON.stringify(now.presets[key]));
		words.push('the ' + (now.presets[key].label ?? key) + ' look');
	}
	let custom = false;
	// the sky image: a bundled CC0 sky by name, or a library HDR by hash
	const hdriIn = a.hdri ?? a.sky;
	if (hdriIn !== undefined) {
		const spec = hdriIn === null || typeof hdriIn === 'string' ? { name: hdriIn } : hdriIn;
		if (spec === null || spec.name === null || spec.name === 'none') {
			if (payload.hdri) {
				delete payload.hdri;
				custom = true;
				words.push('no sky image');
			}
		} else {
			if (!spec || typeof spec !== 'object') return { error: 'hdri: a sky name (' + Object.keys(now.hdris).join(', ') + ') or {name, rotation, intensity, blur, quality, minQuality, background}' };
			/** @type {Record<string, any>} */
			const next = { ...(payload.hdri ?? {}) };
			if (spec.name !== undefined || spec.hash !== undefined) {
				const hash = typeof spec.hash === 'string' ? spec.hash.replace(/^hash:/, '') : '';
				if (hash) {
					if (!/^[0-9a-f]{16,128}$/.test(hash)) return { error: 'hdri.hash: a library HDR file\'s content hash' };
					if (next.src !== 'hash:' + hash) delete next.name;
					next.src = 'hash:' + hash;
				} else {
					const key = findByName(spec.name, now.hdris);
					if (!key) return { error: 'hdri "' + String(spec.name).slice(0, 40) + '": one of ' + Object.keys(now.hdris).join(', ') + ' (or {hash} of an HDR in the library; never a URL)' };
					next.src = 'bundled:' + key;
					delete next.name;
				}
			}
			if (!next.src) return { error: 'hdri: name a sky first (' + Object.keys(now.hdris).join(', ') + ')' };
			for (const [k, lo, hi] of /** @type {[string, number, number][]} */ ([['rotation', -3600, 3600], ['intensity', 0, 4], ['blur', 0, 1]])) {
				if (spec[k] === undefined) continue;
				if (!finite(spec[k])) return { error: 'hdri.' + k + ' is a number' };
				next[k] = clamp(spec[k], lo, hi);
			}
			if (spec.background !== undefined) next.background = spec.background !== false;
			for (const k of ['quality', 'minQuality']) {
				if (spec[k] === undefined) continue;
				const q = String(spec[k]).toLowerCase();
				const allowed = k === 'quality' ? SKY_QUALITY_WORDS : SKY_QUALITY_WORDS.slice(1);
				if (!allowed.includes(q)) return { error: 'hdri.' + k + ': one of ' + allowed.join(', ') };
				next[k] = q;
			}
			payload.hdri = next;
			custom = true;
			words.push('sky ' + next.src.replace(/^bundled:/, '').replace(/^hash:(.{8}).*/, 'library HDR $1'));
		}
	}
	if (a.background !== undefined) {
		const c = colorOf(a.background, now.named);
		if (!c) return { error: 'background: a colour like "#87ceeb" or "skyblue"' };
		payload.background = c;
		delete payload.gradient;
		if (payload.hdri && a.hdri === undefined && a.sky === undefined) {
			// a flat colour only shows where no sky image covers it
			payload.hdri = { ...payload.hdri, background: false };
			warnings.push('the sky image now lights the scene only, so the colour shows');
		}
		custom = true;
		words.push('background ' + c);
	}
	if (a.gradient !== undefined) {
		if (a.gradient === null) delete payload.gradient;
		else {
			const top = colorOf(a.gradient?.top, now.named);
			const bottom = colorOf(a.gradient?.bottom, now.named);
			if (!top || !bottom) return { error: 'gradient: {"top": colour, "bottom": colour}' };
			payload.gradient = { top, bottom };
			payload.background = payload.background ?? bottom;
			words.push('a gradient sky');
		}
		custom = true;
	}
	if (a.fog !== undefined) {
		if (a.fog === null || a.fog === false) {
			payload.fog = null;
			words.push('no fog');
		} else {
			const f = a.fog;
			if (typeof f !== 'object') return { error: 'fog: {"color": colour, "near": m, "far": m} or {"color": colour, "density": 0.02}, or null for none' };
			/** @type {Record<string, any>} */
			const fog = { ...(payload.fog ?? { color: payload.background ?? '#ffffff', near: 1, far: 50 }) };
			if (f.color !== undefined) {
				const c = colorOf(f.color, now.named);
				if (!c) return { error: 'fog.color: a colour' };
				fog.color = c;
			}
			if (f.density !== undefined) {
				if (!finite(f.density) || f.density <= 0) return { error: 'fog.density: a number above 0 (0.01 thin, 0.1 thick)' };
				fog.near = 0;
				fog.far = r3(clamp(DENSITY_FAR / f.density, 1, 20000));
				fog.fit = false;
				warnings.push('density ' + f.density + ' became linear fog from 0 to ' + fog.far + ' m (the scene renders linear fog)');
			}
			for (const k of ['near', 'far']) {
				if (f[k] === undefined) continue;
				if (!finite(f[k]) || f[k] < 0) return { error: 'fog.' + k + ' is metres (0 or more)' };
				fog[k] = r3(clamp(f[k], 0, 20000));
				fog.fit = false;
			}
			if (fog.far <= fog.near) return { error: 'fog: far must be beyond near' };
			payload.fog = fog;
			words.push('fog ' + fog.color + ' ' + fog.near + '-' + fog.far + ' m');
		}
		custom = true;
	}
	let exposure = now.exposure;
	if (a.exposure !== undefined) {
		if (!finite(a.exposure)) return { error: 'exposure: a number (1 = normal, 0.5 darker, 2 brighter)' };
		exposure = clamp(a.exposure, 0.1, 4);
		words.push('exposure ' + exposure);
	}
	if (custom) {
		payload.label = 'Custom';
		return { state: { preset: 'custom', exposure, customPreset: payload }, words, warnings };
	}
	return { state: { preset: presetKey, exposure, customPreset: presetKey === 'custom' ? payload : null }, words, warnings };
}

export const ENV_LIGHT_KINDS = ['directional', 'point', 'hemisphere'];
export const MAX_ENV_LIGHTS = 8;

/** @param {any} spec @param {string} where @param {(name: string) => string | null} [named] @returns {{patch: Record<string, any>} | {error: string}} */
function lightPatch(spec, where, named) {
	/** @type {Record<string, any>} */
	const patch = {};
	if (spec.color !== undefined) {
		const c = colorOf(spec.color, named);
		if (!c) return { error: where + '.color: a colour' };
		patch.color = c;
	}
	if (spec.groundColor !== undefined) {
		const c = colorOf(spec.groundColor, named);
		if (!c) return { error: where + '.groundColor: a colour' };
		patch.groundColor = c;
	}
	if (spec.intensity !== undefined) {
		if (!finite(spec.intensity) || spec.intensity < 0) return { error: where + '.intensity: 0 or more' };
		patch.intensity = clamp(spec.intensity, 0, 50);
	}
	if (spec.position !== undefined) {
		if (!triple(spec.position)) return { error: where + '.position: [x, y, z]' };
		patch.position = spec.position.map(r3);
	}
	return { patch };
}

/**
 * Plan a set_light call.
 * @param {any} args {sun?: {color, intensity, direction | position} | null, ambient?: {sky, ground, intensity} | null,
 *   add?: [{kind, color, intensity, position, groundColor}], update?: [{id, ...}], remove?: [ids]}
 * @param {{payload: any, preset: string, lights: any[], exposure: number, newId: () => string, named?: (name: string) => string | null}} now
 * @returns {{state: {preset: string, exposure: number, customPreset: any, lights: any[]}, added: string[], words: string[]} | {error: string}}
 */
export function planLight(args, now) {
	const a = args ?? {};
	if (!['sun', 'ambient', 'add', 'update', 'remove'].some((k) => a[k] !== undefined)) return { error: 'nothing to set: give sun, ambient, add, update or remove' };
	const payload = JSON.parse(JSON.stringify(now.payload ?? {}));
	let lights = JSON.parse(JSON.stringify(now.lights ?? []));
	/** @type {string[]} */
	const words = [];
	/** @type {string[]} */
	const added = [];
	let custom = false;
	if (a.sun !== undefined) {
		if (a.sun === null || a.sun === false) {
			payload.sun = null;
			words.push('no sun');
		} else {
			const p = lightPatch(a.sun, 'sun', now.named);
			if ('error' in p) return p;
			const sun = { color: '#ffffff', intensity: 1.5, position: [8, 14, 6], ...(payload.sun ?? {}), ...p.patch };
			if (a.sun.direction !== undefined) {
				// the direction the light TRAVELS (down and away); the rig sun sits opposite it
				if (!triple(a.sun.direction) || a.sun.direction.every((/** @type {number} */ n) => n === 0)) return { error: 'sun.direction: [x, y, z], the way the light shines (y below 0)' };
				const [x, y, z] = a.sun.direction;
				const len = Math.hypot(x, y, z);
				const dist = Math.max(10, Math.hypot(...(/** @type {number[]} */ (sun.position))));
				sun.position = [r3((-x / len) * dist), r3((-y / len) * dist), r3((-z / len) * dist)];
				if (sun.position[1] <= 0) return { error: 'sun.direction: a sun shines downward (its y must be below 0)' };
			}
			payload.sun = sun;
			words.push('the sun');
		}
		custom = true;
	}
	if (a.ambient !== undefined) {
		if (a.ambient === null || a.ambient === false) {
			payload.hemi = null;
			words.push('no ambient light');
		} else {
			const spec = a.ambient;
			/** @type {Record<string, any>} */
			const hemi = { sky: '#ffffff', ground: '#4c525c', intensity: 1, ...(payload.hemi ?? {}) };
			for (const [k, key] of [['sky', 'sky'], ['color', 'sky'], ['ground', 'ground'], ['groundColor', 'ground']]) {
				if (spec[k] === undefined) continue;
				const c = colorOf(spec[k], now.named);
				if (!c) return { error: 'ambient.' + k + ': a colour' };
				hemi[key] = c;
			}
			if (spec.intensity !== undefined) {
				if (!finite(spec.intensity) || spec.intensity < 0) return { error: 'ambient.intensity: 0 or more' };
				hemi.intensity = clamp(spec.intensity, 0, 20);
			}
			payload.hemi = hemi;
			words.push('the ambient light');
		}
		custom = true;
	}
	for (const [i, spec] of (Array.isArray(a.add) ? a.add : []).entries()) {
		const kind = String(spec?.kind ?? 'point').toLowerCase();
		if (!ENV_LIGHT_KINDS.includes(kind)) return { error: 'add[' + i + '].kind: one of ' + ENV_LIGHT_KINDS.join(', ') + ' (spot / area lights are objects: create_objects kind light)' };
		const p = lightPatch(spec, 'add[' + i + ']', now.named);
		if ('error' in p) return p;
		const id = now.newId();
		lights.push({ id, kind, color: '#ffffff', ...(kind === 'hemisphere' ? { groundColor: '#444444' } : {}), intensity: 1, position: [4, 8, 2], ...p.patch });
		added.push(id);
	}
	if (added.length) words.push('add ' + added.length + ' environment light' + (added.length === 1 ? '' : 's'));
	for (const [i, spec] of (Array.isArray(a.update) ? a.update : []).entries()) {
		const at = lights.findIndex((/** @type {any} */ l) => l.id === spec?.id);
		if (at < 0) return { error: 'update[' + i + ']: no environment light "' + String(spec?.id ?? '').slice(0, 20) + '" (get_environment lists them)' };
		const p = lightPatch(spec, 'update[' + i + ']', now.named);
		if ('error' in p) return p;
		lights[at] = { ...lights[at], ...p.patch };
		words.push('adjust light ' + lights[at].id);
	}
	if (Array.isArray(a.remove) && a.remove.length) {
		const drop = new Set(a.remove.map(String));
		const missing = [...drop].filter((id) => !lights.some((/** @type {any} */ l) => l.id === id));
		if (missing.length) return { error: 'remove: no environment light ' + missing.join(', ') };
		lights = lights.filter((/** @type {any} */ l) => !drop.has(l.id));
		words.push('remove ' + drop.size + ' environment light' + (drop.size === 1 ? '' : 's'));
	}
	if (lights.length > MAX_ENV_LIGHTS) return { error: 'at most ' + MAX_ENV_LIGHTS + ' environment lights (more lights = objects: create_objects kind light)' };
	if (custom) payload.label = 'Custom';
	return {
		state: custom ? { preset: 'custom', exposure: now.exposure, customPreset: payload, lights } : { preset: now.preset, exposure: now.exposure, customPreset: now.preset === 'custom' ? payload : null, lights },
		added,
		words
	};
}

/** three's yaw (rotation.y; 0 faces -Z) of a look from `from` toward `to` @param {number[]} from @param {number[]} to */
export function yawToward(from, to) {
	return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
}

/**
 * Plan a place_spawn call.
 * @param {any} args {position?: [x,y,z], at?: point from an object (the tool resolves it), yaw? (radians), facing?: [x,y,z], clear?: true}
 * @returns {{spawn: {position: number[], yaw: number} | null} | {error: string}}
 */
export function planSpawn(args) {
	const a = args ?? {};
	if (a.clear === true || a.position === null) return { spawn: null };
	const pos = a.position ?? a.at;
	if (!triple(pos)) return { error: 'position: [x, y, z] where the player\'s feet go (or object: a uuid to stand on)' };
	if (pos.some((/** @type {number} */ n) => Math.abs(n) > 100000)) return { error: 'position: too far out' };
	let yaw = 0;
	if (a.facing !== undefined) {
		if (!triple(a.facing)) return { error: 'facing: [x, y, z], a point the player looks toward' };
		if (a.facing[0] === pos[0] && a.facing[2] === pos[2]) return { error: 'facing: a point away from the spawn' };
		yaw = yawToward(pos, a.facing);
	} else if (a.yaw !== undefined) {
		if (!finite(a.yaw)) return { error: 'yaw: radians (0 faces -Z, the way a new scene looks)' };
		yaw = a.yaw;
	} else if (a.yawDegrees !== undefined) {
		if (!finite(a.yawDegrees)) return { error: 'yawDegrees: a number' };
		yaw = (a.yawDegrees * Math.PI) / 180;
	}
	const pi = Math.PI;
	yaw = ((((yaw + pi) % (2 * pi)) + 2 * pi) % (2 * pi)) - pi;
	return { spawn: { position: pos.map(r3), yaw: r3(yaw) } };
}

/** the eye height above a spawn's feet (playSpawn.SPAWN_EYE) */
export const SPAWN_EYE = 1.7;

/**
 * The H6 opening view: an explicit pose, from the spawn, or a frame of the scene's bounds.
 * @param {any} raw {position, target} | 'spawn' | 'frame' | null
 * @param {{spawn: {position: number[], yaw: number} | null, bounds: {center: number[], radius: number} | null}} ctx
 * @returns {{view: {position: number[], target: number[]} | null} | {error: string}}
 */
export function planOpeningView(raw, ctx) {
	if (raw === null || raw === false || raw === 'none') return { view: null };
	if (raw === 'spawn') {
		if (!ctx.spawn) return { error: 'openingView "spawn": there is no spawn yet (game_setup spawn first)' };
		const [x, y, z] = ctx.spawn.position;
		const yaw = ctx.spawn.yaw;
		// a step behind and above the player's eye, looking where they look
		const eye = [x + Math.sin(yaw) * 2.5, y + SPAWN_EYE + 0.8, z + Math.cos(yaw) * 2.5];
		const target = [x - Math.sin(yaw) * 4, y + SPAWN_EYE * 0.6, z - Math.cos(yaw) * 4];
		return { view: { position: eye.map(r3), target: target.map(r3) } };
	}
	if (raw === 'frame') {
		if (!ctx.bounds) return { error: 'openingView "frame": the scene is empty' };
		const { center, radius } = ctx.bounds;
		const d = Math.max(radius, 1) * 2.4;
		const dir = [0.6, 0.55, 0.85];
		const len = Math.hypot(...dir);
		return { view: { position: center.map((c, i) => r3(c + (dir[i] / len) * d)), target: center.map(r3) } };
	}
	if (raw && typeof raw === 'object' && triple(raw.position)) {
		const target = raw.target === undefined ? [0, 0, 0] : raw.target;
		if (!triple(target)) return { error: 'openingView.target: [x, y, z]' };
		if (raw.position.every((/** @type {number} */ n, /** @type {number} */ i) => n === target[i])) return { error: 'openingView: the camera cannot stand on its target' };
		return { view: { position: raw.position.map(r3), target: target.map(r3) } };
	}
	return { error: 'openingView: {"position": [x,y,z], "target": [x,y,z]}, "spawn", "frame", or null to forget it' };
}

export const PLAY_CAMERA_MODES = ['first', 'third', 'orbit', 'fixed', 'none'];

/** what the app cannot do yet, said so an agent can take the route that works today */
export const PLAY_CAMERA_LATER =
	'is not a Play camera this build has: Play always looks through the player\'s own eyes. For a vehicle or character, a Possess Object node (camera chase / orbit) on a click or key gives third person; for a fixed shot, put a camera object in the scene and a Set Active Camera / Game Start node look through it. Set first person here, or only openingView.';

/**
 * Plan the Character Controller a first-person play camera is.
 * @param {any} args {mode, walk?: boolean (default true), speed?, jumpHeight?, eyeHeight?, gravity?}
 * @returns {{controller: Record<string, any> | null, words: string} | {later: string} | {error: string}}
 */
export function planPlayCamera(args) {
	const mode = String(args?.mode ?? '').toLowerCase();
	if (!PLAY_CAMERA_MODES.includes(mode)) return { error: 'mode: one of first, third, orbit, fixed, none' };
	if (mode === 'none') return { controller: null, words: 'the default Play camera' };
	if (mode !== 'first') return { later: '"' + mode + '" ' + PLAY_CAMERA_LATER };
	const fly = args?.fly === true || args?.walk === false;
	/** @type {Record<string, any>} */
	const controller = { mode: fly ? 'fly' : 'walk', speed: 0.1, jumpHeight: 1.2, eyeHeight: 1.7, gravity: true };
	for (const [k, lo, hi] of /** @type {[string, number, number][]} */ ([['speed', 0.01, 1], ['jumpHeight', 0, 5], ['eyeHeight', 0.2, 3]])) {
		if (args?.[k] === undefined) continue;
		if (!finite(args[k])) return { error: k + ' is a number' };
		controller[k] = r3(clamp(args[k], lo, hi));
	}
	if (args?.gravity !== undefined) controller.gravity = args.gravity !== false;
	return { controller, words: 'first person, ' + controller.mode + 'ing' };
}
