// 98 P4 — lens flare, god rays and volumetric height fog as post effects with an amount.
//
// Each is its OWN pass (`isPass: true`): all three sample the image away from the pixel they shade
// (postprocessing's CONVOLUTION kind), and two convolution effects cannot share one EffectPass —
// merging them into a neighbour's run would silently drop one. OFF BY DEFAULT means "not in the
// stack": the compiler only builds entries that are present and enabled, so a scene that never adds
// one pays nothing (unit-proven in postFinish.test.js). Logic lives in `finishCore.js`, GLSL in
// `finishShaders.js` (TSL-portable rule, roadmap 2.0 S1).
import { BlendFunction, Effect, EffectAttribute, EffectPass } from 'postprocessing';
import { Color, Matrix4, Uniform, Vector2, Vector3 } from 'three';
import { registerPostEffect } from '../scenePost';
import { ENV_RIG_SUN } from '../shadowFitCore.js';
import { isHeadsetUA } from '../hdri/hdriCore.js';
import { capsFor, cappedSteps, finishTier, sunScreen } from './finishCore.js';
import { GOD_RAYS_FRAG, LENS_FLARE_FRAG, VOLUMETRIC_FOG_FRAG } from './finishShaders.js';

/** @param {any} value @param {number} fallback */
function num(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/** This device's finish tier, read once per build. @param {any} [renderer] */
export function currentFinishTier(renderer) {
	const nav = typeof navigator !== 'undefined' ? navigator : null;
	return finishTier({
		presenting: !!renderer?.xr?.isPresenting,
		headset: !!nav && isHeadsetUA(nav.userAgent),
		phone: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
	});
}

const _sunPos = new Vector3();
const _sunTarget = new Vector3();
const _viewProj = new Matrix4();

/** The rig sun's direction (toward the sun) + colour*intensity, or null without one. @param {any} scene */
function rigSun(scene) {
	const sun = scene?.getObjectByName?.(ENV_RIG_SUN);
	if (!sun || !sun.visible) return null;
	sun.getWorldPosition(_sunPos);
	if (sun.target) sun.target.getWorldPosition(_sunTarget);
	else _sunTarget.set(0, 0, 0);
	return { dir: [_sunPos.x - _sunTarget.x, _sunPos.y - _sunTarget.y, _sunPos.z - _sunTarget.z], color: sun.color, intensity: sun.intensity };
}

/**
 * One finish effect wrapped in its own EffectPass; the pass carries what `tick` needs.
 * @param {Effect} effect @param {any} ctx
 */
function ownPass(effect, ctx) {
	const pass = /** @type {any} */ (new EffectPass(ctx.camera, effect));
	pass.__finish = { effect, camera: ctx.camera, scene: ctx.scene };
	return pass;
}

const passHooks = {
	isPass: true,
	retarget: (/** @type {any} */ pass, /** @type {any} */ camera) => {
		pass.mainCamera = camera;
		if (pass.__finish) pass.__finish.camera = camera;
	},
	dispose: (/** @type {any} */ pass) => {
		pass.__finish?.effect?.dispose?.();
		pass.dispose?.();
	}
};

registerPostEffect('lensflare', {
	label: 'Lens flare',
	group: 'camera',
	...passHooks,
	params: [
		{ key: 'amount', label: 'Amount', min: 0, max: 2, step: 0.01, decimals: 2, default: 0.4 },
		{ key: 'threshold', label: 'Brightness threshold', min: 0, max: 4, step: 0.05, decimals: 2, default: 0.9,
			hint: 'Only pixels brighter than this flare.' },
		{ key: 'spacing', label: 'Ghost spacing', min: 0.05, max: 1, step: 0.01, decimals: 2, default: 0.35 },
		{ key: 'halo', label: 'Halo', min: 0, max: 2, step: 0.01, decimals: 2, default: 0.5 }
	],
	make: (params, ctx) => {
		const effect = new Effect('LensFlareEffect', LENS_FLARE_FRAG, {
			blendFunction: BlendFunction.NORMAL,
			attributes: EffectAttribute.CONVOLUTION,
			uniforms: new Map([
				['amount', new Uniform(num(params.amount, 0.4))],
				['threshold', new Uniform(num(params.threshold, 0.9))],
				['spacing', new Uniform(num(params.spacing, 0.35))],
				['halo', new Uniform(num(params.halo, 0.5))]
			])
		});
		return ownPass(effect, ctx);
	}
});

registerPostEffect('godrays', {
	label: 'God rays',
	group: 'camera',
	...passHooks,
	params: [
		{ key: 'amount', label: 'Amount', min: 0, max: 2, step: 0.01, decimals: 2, default: 0.6 },
		{ key: 'samples', label: 'Samples', min: 4, max: 64, step: 1, decimals: 0, default: 48,
			hint: 'Capped per device: a phone takes at most 16, a headset none.' },
		{ key: 'density', label: 'Length', min: 0.1, max: 1.5, step: 0.01, decimals: 2, default: 0.9 },
		{ key: 'decay', label: 'Decay', min: 0.8, max: 1, step: 0.001, decimals: 3, default: 0.96 },
		{ key: 'threshold', label: 'Sky threshold', min: 0, max: 2, step: 0.01, decimals: 2, default: 0.5 }
	],
	make: (params, ctx) => {
		const caps = capsFor(currentFinishTier(ctx.renderer));
		const samples = cappedSteps(num(params.samples, 48), caps.raySamples);
		const effect = new Effect('GodRaysFinishEffect', GOD_RAYS_FRAG, {
			blendFunction: BlendFunction.NORMAL,
			attributes: EffectAttribute.CONVOLUTION | EffectAttribute.DEPTH,
			uniforms: new Map([
				['sunUv', new Uniform(new Vector2(0.5, 0.5))],
				['strength', new Uniform(0)],
				['samples', new Uniform(samples)],
				['density', new Uniform(num(params.density, 0.9))],
				['decay', new Uniform(num(params.decay, 0.96))],
				['weight', new Uniform(1 / Math.max(1, samples) * 4)],
				['threshold', new Uniform(num(params.threshold, 0.5))]
			])
		});
		const pass = ownPass(effect, ctx);
		pass.__finish.amount = num(params.amount, 0.6);
		pass.__finish.samples = samples;
		return pass;
	},
	tick: (/** @type {any} */ pass) => {
		const f = pass.__finish;
		const u = f.effect.uniforms;
		const sun = rigSun(f.scene);
		const cam = f.camera;
		if (!sun || !cam || !f.samples) {
			u.get('strength').value = 0;
			return;
		}
		_viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
		const camPos = cam.getWorldPosition(_sunTarget);
		const at = sunScreen(sun.dir, [camPos.x, camPos.y, camPos.z], _viewProj.elements);
		u.get('sunUv').value.set(at.x, at.y);
		u.get('strength').value = at.visible ? f.amount * at.fade : 0;
	}
});

registerPostEffect('volumetricfog', {
	label: 'Volumetric fog',
	group: 'camera',
	...passHooks,
	params: [
		{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.01, decimals: 2, default: 1 },
		{ key: 'color', label: 'Colour', type: 'color', default: '#b8c6d6' },
		{ key: 'density', label: 'Density', min: 0, max: 0.5, step: 0.001, decimals: 3, default: 0.03 },
		{ key: 'falloff', label: 'Height falloff', min: 0.01, max: 2, step: 0.01, decimals: 2, default: 0.25,
			hint: 'How fast the fog thins with height.' },
		{ key: 'baseHeight', label: 'Base height', min: -50, max: 100, step: 0.1, decimals: 1, default: 0 },
		{ key: 'scatter', label: 'Sun glow', min: 0, max: 4, step: 0.05, decimals: 2, default: 1,
			hint: 'Light scattered toward you around the sun.' },
		{ key: 'steps', label: 'Steps', min: 0, max: 32, step: 1, decimals: 0, default: 24,
			hint: 'More = richer fog, more cost. Capped per device: a phone takes at most 8; 0 = flat fog.' },
		{ key: 'maxDistance', label: 'Reach', min: 10, max: 2000, step: 10, decimals: 0, default: 300 }
	],
	make: (params, ctx) => {
		const caps = capsFor(currentFinishTier(ctx.renderer));
		const asked = num(params.steps, 24);
		const steps = asked <= 0 ? 0 : cappedSteps(asked, caps.fogSteps);
		const effect = new Effect('VolumetricFogEffect', VOLUMETRIC_FOG_FRAG, {
			blendFunction: BlendFunction.NORMAL,
			attributes: EffectAttribute.DEPTH,
			uniforms: new Map([
				['projInv', new Uniform(new Matrix4())],
				['camWorld', new Uniform(new Matrix4())],
				['fogColor', new Uniform(new Color(String(params.color ?? '#b8c6d6')))],
				['sunDir', new Uniform(new Vector3(0.3, 1, 0.2))],
				['sunColor', new Uniform(new Color(0, 0, 0))],
				['amount', new Uniform(num(params.amount, 1))],
				['density', new Uniform(num(params.density, 0.03))],
				['falloff', new Uniform(num(params.falloff, 0.25))],
				['baseHeight', new Uniform(num(params.baseHeight, 0))],
				['scatter', new Uniform(num(params.scatter, 1))],
				['steps', new Uniform(steps)],
				['maxDistance', new Uniform(num(params.maxDistance, 300))],
				['fogTime', new Uniform(0)]
			])
		});
		const pass = ownPass(effect, ctx);
		pass.__finish.steps = steps;
		return pass;
	},
	tick: (/** @type {any} */ pass, /** @type {number} */ delta) => {
		const f = pass.__finish;
		const u = f.effect.uniforms;
		const cam = f.camera;
		if (cam) {
			u.get('projInv').value.copy(cam.projectionMatrixInverse);
			u.get('camWorld').value.copy(cam.matrixWorld);
		}
		const sun = rigSun(f.scene);
		if (sun) {
			u.get('sunDir').value.set(sun.dir[0], sun.dir[1], sun.dir[2]);
			u.get('sunColor').value.copy(sun.color).multiplyScalar(Math.min(4, sun.intensity ?? 1) * 0.25);
		} else u.get('sunColor').value.setRGB(0, 0, 0);
		u.get('fogTime').value += Number(delta) || 0;
	}
});
