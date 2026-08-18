import {
	BlendFunction,
	BloomEffect,
	BrightnessContrastEffect,
	ChromaticAberrationEffect,
	DotScreenEffect,
	EffectPass,
	HueSaturationEffect,
	KernelSize,
	LUT3DEffect,
	LUTCubeLoader,
	LookupTexture,
	NoiseEffect,
	PixelationEffect,
	SMAAEffect,
	SMAAPreset,
	ScanlineEffect,
	ToneMappingEffect,
	ToneMappingMode,
	VignetteEffect,
	VignetteTechnique
} from 'postprocessing';
// @ts-ignore - n8ao ships no bundled type declarations
import { N8AOPostPass } from 'n8ao';
import { registerPostEffect, postEffectDef, planPostStack } from './scenePost';
// L5: a LUT is an Explorer ASSET, so it must ride the content-hash push/pull or a
// peer (and every late joiner) grades with a missing texture — golden rule 9.
import { itemByHash, itemBlob, explorerItems } from './explorer';
import { requestAsset } from './assetShare';

// L1 — the built-in post effects and the COMPILER.
//
// Split from `scenePost.js` on purpose: everything that touches `postprocessing`
// or `n8ao` lives here, so the store + planner stay a pure leaf reachable from
// peerHandler/sessions, and the merge rule can be tested with no GL context.
// `Outline.svelte` is the only consumer — it owns the composer.

/**
 * Build the real passes for an effective stack.
 *
 * The grouping decision is `planPostStack`'s (see the merge rule there); this
 * function only instantiates. Each merge group of `Effect`s becomes ONE
 * `EffectPass`; each `Pass` entry becomes itself.
 *
 * @param {any[]} entries the EFFECTIVE stack (already filtered by view mode)
 * @param {{scene: any, camera: any, width: number, height: number, dpr: number, prefs?: any}} ctx
 * @returns {{passes: any[], instances: {kind: string, id: string, object: any, def: any, isPass: boolean}[], skipped: any[], plan: any[]}}
 */
export function compilePostStack(entries, ctx) {
	const { groups, skipped } = planPostStack(entries);
	/** @type {any[]} */
	const passes = [];
	/** @type {any[]} */
	const instances = [];
	/** @type {any[]} */
	const plan = [];
	for (const group of groups) {
		/** @type {any[]} */
		const made = [];
		for (const entry of group.entries) {
			const def = postEffectDef(entry.kind);
			if (!def) continue;
			let object = null;
			try {
				object = def.make(entry.params ?? {}, ctx);
			} catch (error) {
				// one bad effect must not take the whole viewport down — the rest of
				// the chain still compiles and the scene still renders
				console.warn('post effect failed to build: ' + entry.kind, error);
				continue;
			}
			if (!object) continue;
			made.push(object);
			// the entry's PARAMS ride along: `applyLocal` needs them to know whether
			// this author pinned a value the local pref would otherwise override (L4)
			instances.push({
				kind: entry.kind,
				id: entry.id,
				object,
				def,
				params: entry.params ?? {},
				isPass: !!def.isPass
			});
		}
		if (!made.length) continue;
		if (group.type === 'pass') {
			passes.push(made[0]);
			plan.push({ type: 'pass', kinds: group.entries.map((/** @type {any} */ e) => e.kind) });
		} else {
			// THE MERGE: one EffectPass for the whole consecutive run of Effects.
			//
			// Guarded for the same reason `make` is, and #20 P6 is why it needed to be: a
			// `make` that RETURNS successfully can still return something that is not an
			// Effect (a module author's honest mistake — an object literal, a Material, a
			// promise), and postprocessing only finds out inside the EffectPass
			// constructor. Unguarded, that throw escapes into Outline's $effect and takes
			// the whole viewport down for one bad entry, which is exactly the outcome the
			// `make` guard exists to prevent.
			try {
				passes.push(new EffectPass(ctx.camera, ...made));
				plan.push({ type: 'effects', kinds: group.entries.map((/** @type {any} */ e) => e.kind) });
			} catch (error) {
				console.warn(
					'post effect group failed to build a pass: ' +
						group.entries.map((/** @type {any} */ e) => e.kind).join(', '),
					error
				);
				// drop the instances this group contributed — nothing owns them now, and
				// leaving them in would have `disposePostStack` free objects the composer
				// never took
				for (const object of made) {
					const at = instances.findIndex((entry) => entry.object === object);
					if (at >= 0) instances.splice(at, 1);
				}
				for (const entry of group.entries) skipped.push(entry);
			}
		}
	}
	return { passes, instances, skipped, plan };
}

/** Free everything a previous compile made. postprocessing does NOT dispose a
 * pass when the composer drops it. @param {any[]} passes @param {any[]} instances */
export function disposePostStack(passes, instances) {
	for (const instance of instances ?? []) {
		try {
			if (instance.def?.dispose) instance.def.dispose(instance.object);
			else instance.object?.dispose?.();
		} catch {}
	}
	for (const pass of passes ?? []) {
		try {
			// an EffectPass owns the merged shader; its Effects were disposed above
			pass?.dispose?.();
		} catch {}
	}
}

// ---- built-ins -------------------------------------------------------------

// AO is the FIRST and, in L1, the only entry — the plumbing is provable before
// any new effect exists. Its defaults are the exact numbers Outline.svelte
// hardcoded before the stack existed (aoRadius 1.5 / intensity 2.5 /
// distanceFalloff 1.0), which is what makes the legacy 'shaded-ao' view mode
// byte-compatible with today's chain.
registerPostEffect('ao', {
	label: 'Ambient occlusion',
	group: 'ao',
	// N8AO is a Pass, not an Effect, so it BREAKS a merge run — the one fact the
	// planner needs and the reason `isPass` is part of the registry contract.
	isPass: true,
	params: [
		{ key: 'aoRadius', label: 'Radius', min: 0.05, max: 10, step: 0.05, decimals: 2, default: 1.5,
			hint: 'How far a surface looks for occluders, in world units.' },
		{ key: 'intensity', label: 'Intensity', min: 0, max: 10, step: 0.1, decimals: 2, default: 2.5 },
		{ key: 'distanceFalloff', label: 'Falloff', min: 0, max: 5, step: 0.05, decimals: 2, default: 1.0 },
		// L4: quality and half-resolution have never had a UI. They default to
		// 'auto', which is the pre-L4 behaviour exactly — follow this VIEWER's
		// shadow-quality pref — so a scene that does not pin them behaves as before
		// and each viewer keeps their own performance trade-off. Pinning them makes
		// the look deterministic across the session, which is what an author wants
		// when AO is doing real work in the image.
		{ key: 'quality', label: 'Quality', type: 'select', default: 'auto',
			hint: 'Auto follows this device’s shadow-quality setting.',
			options: [
				{ value: 'auto', label: 'Auto (follow device)' },
				{ value: 'low', label: 'Low' },
				{ value: 'medium', label: 'Medium' },
				{ value: 'high', label: 'High' }
			] },
		{ key: 'halfRes', label: 'Half resolution', type: 'select', default: 'auto',
			hint: 'Renders AO at half size — much cheaper, slightly softer.',
			options: [
				{ value: 'auto', label: 'Auto (follow device)' },
				{ value: 'on', label: 'On' },
				{ value: 'off', label: 'Off' }
			] }
	],
	make: (params, ctx) => {
		const pass = new N8AOPostPass(ctx.scene, ctx.camera, ctx.width, ctx.height);
		pass.configuration.aoRadius = num(params.aoRadius, 1.5);
		pass.configuration.intensity = num(params.intensity, 2.5);
		pass.configuration.distanceFalloff = num(params.distanceFalloff, 1.0);
		// B2/HiDPI: the pass must be sized to the PHYSICAL drawing buffer, which the
		// ctx carries — the logical CSS size under-sizes the buffer and its output is
		// upsampled into a "ghost" of the shading offset from the objects
		pass.setSize(Math.round(ctx.width * ctx.dpr), Math.round(ctx.height * ctx.dpr));
		applyAoQuality(pass, params, ctx.prefs ?? {});
		return pass;
	},
	// third-party passes keep their OWN camera reference, outside the sweep
	// composer.setMainCamera does over `pass.mainCamera` (the 16-P5 lesson)
	retarget: (pass, camera) => {
		pass.camera = camera;
	},
	resize: (pass, width, height, dpr) => {
		pass.setSize(Math.round(width * dpr), Math.round(height * dpr));
	},
	// the local perf knob (shadowQuality) still applies LIVE without a rebuild —
	// but only for whichever of the two params is left on 'auto'
	applyLocal: (/** @type {any} */ pass, /** @type {any} */ prefs, /** @type {any} */ params) =>
		applyAoQuality(pass, params ?? {}, prefs ?? {})
});

/**
 * Resolve AO's two performance params against the viewer's own pref.
 *
 * 'auto' reproduces the pre-L4 mapping EXACTLY (halfRes on for anything below
 * high; quality mirrored from shadowQuality), which is what keeps a scene that
 * never touches these rows rendering as it did.
 * @param {any} pass @param {any} params @param {any} prefs
 */
function applyAoQuality(pass, params, prefs) {
	const q = prefs?.shadowQuality;
	const quality = params?.quality && params.quality !== 'auto' ? params.quality : q;
	const half = params?.halfRes;
	pass.configuration.halfRes =
		half === 'on' ? true : half === 'off' ? false : q === 'low' || q === 'medium' || q === 'off';
	if (pass.setQualityMode)
		pass.setQualityMode(quality === 'high' ? 'High' : quality === 'medium' ? 'Medium' : 'Low');
}

// L4 — TONE MAPPING. It lands here rather than with the rest of the grading set
// because it is half of the reconciliation story: the renderer applies
// ACESFilmic + environment's exposure by default, so a ToneMapping entry in the
// stack would map an already-mapped image. `ownsToneMapping` is what
// Outline.svelte reports through environment's registerToneMappingOwner, which
// switches the renderer to NoToneMapping while this entry is live.
registerPostEffect('tonemapping', {
	label: 'Tone mapping',
	group: 'grading',
	ownsToneMapping: true,
	params: [
		{ key: 'mode', label: 'Curve', type: 'select', default: 'AGX',
			hint: 'Replaces the renderer’s own ACES Filmic mapping while this effect is in the stack.',
			options: [
				{ value: 'AGX', label: 'AgX' },
				{ value: 'ACES_FILMIC', label: 'ACES Filmic' },
				{ value: 'NEUTRAL', label: 'Neutral' },
				{ value: 'REINHARD', label: 'Reinhard' },
				{ value: 'REINHARD2', label: 'Reinhard 2' },
				{ value: 'CINEON', label: 'Cineon' },
				{ value: 'UNCHARTED2', label: 'Uncharted 2' },
				{ value: 'LINEAR', label: 'Linear (none)' }
			] },
		{ key: 'whitePoint', label: 'White point', min: 0.1, max: 32, step: 0.1, decimals: 2, default: 4 },
		{ key: 'middleGrey', label: 'Middle grey', min: 0.01, max: 2, step: 0.01, decimals: 2, default: 0.6 }
	],
	make: (params) =>
		new ToneMappingEffect({
			mode: /** @type {any} */ (ToneMappingMode)[params.mode] ?? ToneMappingMode.AGX,
			whitePoint: num(params.whitePoint, 4),
			middleGrey: num(params.middleGrey, 0.6)
		})
});

/** @param {any} value @param {number} fallback */
function num(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

// ---- L5: colour grading ----------------------------------------------------

registerPostEffect('huesaturation', {
	label: 'Hue / saturation',
	group: 'grading',
	params: [
		{ key: 'hue', label: 'Hue', min: -Math.PI, max: Math.PI, step: 0.01, decimals: 3, default: 0,
			hint: 'Rotates every colour around the wheel, in radians.' },
		{ key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01, decimals: 2, default: 0 }
	],
	make: (params) =>
		new HueSaturationEffect({ hue: num(params.hue, 0), saturation: num(params.saturation, 0) })
});

registerPostEffect('brightnesscontrast', {
	label: 'Brightness / contrast',
	group: 'grading',
	params: [
		{ key: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.01, decimals: 2, default: 0 },
		{ key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, decimals: 2, default: 0 }
	],
	make: (params) =>
		new BrightnessContrastEffect({
			brightness: num(params.brightness, 0),
			contrast: num(params.contrast, 0)
		})
});

/**
 * A 3D LUT from an Explorer asset — the standard grading interchange.
 *
 * `make` is SYNCHRONOUS (the compiler cannot await one effect without stalling the
 * whole chain), so it returns the effect with a NEUTRAL identity LUT and swaps the
 * real one in when the bytes arrive. The frame is correct-but-ungraded for a beat
 * instead of the viewport dropping a pass.
 *
 * The asset is addressed by content HASH, never by item id: ids are local to one
 * device's Explorer. If the hash is not in our library we ask the mesh for it
 * (`requestAsset`, golden rule 9) — without that a peer, and every late joiner,
 * would grade with a missing texture. The pull lands the file in their 'Shared'
 * folder and the next rebuild picks it up.
 */
registerPostEffect('lut', {
	label: 'LUT (colour grade)',
	group: 'grading',
	params: [
		{ key: 'lut', label: 'LUT file', type: 'asset', default: '',
			hint: 'A .cube LUT or a strip image from the Explorer. Shared with peers automatically.' },
		{ key: 'tetrahedral', label: 'Smooth interpolation', type: 'bool', default: false,
			hint: 'Tetrahedral sampling — slower, avoids banding on small LUTs.' }
	],
	make: (params) => {
		// 16 is a neutral identity: it changes nothing until the real LUT lands
		const effect = new LUT3DEffect(LookupTexture.createNeutral(16), {
			tetrahedralInterpolation: !!params.tetrahedral
		});
		loadLutInto(effect, String(params.lut ?? ''));
		return effect;
	},
	dispose: (effect) => {
		try {
			effect.__lutWatch?.(); // stop watching for a pull that will never land now
			effect.lut?.dispose?.();
		} catch {}
		effect.dispose?.();
	}
});

/**
 * Resolve a LUT hash to a texture and hand it to a live effect.
 *
 * The WAIT is the load-bearing part. A peer receiving a stack that grades through
 * a LUT usually has no bytes for that hash, so it asks the mesh — but the pull is
 * asynchronous and, critically, arriving bytes do NOT change the stack, so nothing
 * rebuilds the chain and no second attempt would ever happen. Without watching the
 * library, that peer grades through the neutral identity LUT forever while its
 * stack looks perfectly correct. So: request, then watch `explorerItems` until the
 * hash appears, and unsubscribe on dispose.
 * @param {any} effect @param {string} hash
 */
async function loadLutInto(effect, hash) {
	if (!hash) return;
	const item = itemByHash(hash);
	if (!item) {
		requestAsset(hash);
		effect.__lutWatch?.();
		effect.__lutWatch = explorerItems.subscribe(() => {
			if (!itemByHash(hash)) return;
			effect.__lutWatch?.();
			effect.__lutWatch = null;
			loadLutInto(effect, hash);
		});
		return;
	}
	try {
		const blob = await itemBlob(item.id);
		if (!blob) return;
		const name = String(item.name ?? '').toLowerCase();
		let texture = null;
		if (name.endsWith('.cube')) {
			texture = new LUTCubeLoader().parse(await blob.text());
		} else {
			// a STRIP image, the other common form. LookupTexture.from unfolds the
			// strip itself, but its wide-image path tests `image instanceof Image`, so
			// it needs a real <img> — a canvas or an ImageBitmap silently takes the
			// raw-data branch and comes out wrong.
			const url = URL.createObjectURL(blob);
			try {
				const image = new Image();
				await new Promise((resolve, reject) => {
					image.onload = resolve;
					image.onerror = reject;
					image.src = url;
				});
				texture = LookupTexture.from(/** @type {any} */ ({ image }));
			} finally {
				URL.revokeObjectURL(url);
			}
		}
		if (!texture) return;
		const previous = effect.lut;
		effect.lut = texture;
		previous?.dispose?.();
	} catch (error) {
		console.warn('LUT failed to load: ' + hash, error);
	}
}

// ---- L5: camera FX ---------------------------------------------------------

registerPostEffect('bloom', {
	label: 'Bloom',
	group: 'camera',
	params: [
		{ key: 'intensity', label: 'Intensity', min: 0, max: 10, step: 0.05, decimals: 2, default: 1 },
		{ key: 'luminanceThreshold', label: 'Threshold', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.9,
			hint: 'Only pixels brighter than this bloom.' },
		{ key: 'luminanceSmoothing', label: 'Smoothing', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.025 },
		{ key: 'radius', label: 'Radius', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.85 }
	],
	make: (params) =>
		new BloomEffect({
			intensity: num(params.intensity, 1),
			luminanceThreshold: num(params.luminanceThreshold, 0.9),
			luminanceSmoothing: num(params.luminanceSmoothing, 0.025),
			radius: num(params.radius, 0.85),
			mipmapBlur: true,
			kernelSize: KernelSize.LARGE
		})
});

registerPostEffect('vignette', {
	label: 'Vignette',
	group: 'camera',
	params: [
		{ key: 'offset', label: 'Offset', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.5 },
		{ key: 'darkness', label: 'Darkness', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.5 },
		{ key: 'technique', label: 'Falloff', type: 'select', default: 'DEFAULT',
			options: [
				{ value: 'DEFAULT', label: 'Default' },
				{ value: 'ESKIL', label: 'Eskil' }
			] }
	],
	make: (params) =>
		new VignetteEffect({
			offset: num(params.offset, 0.5),
			darkness: num(params.darkness, 0.5),
			technique:
				/** @type {any} */ (VignetteTechnique)[params.technique] ?? VignetteTechnique.DEFAULT
		})
});

registerPostEffect('grain', {
	label: 'Film grain',
	group: 'camera',
	params: [
		{ key: 'opacity', label: 'Amount', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.25 },
		{ key: 'premultiply', label: 'Multiply with the image', type: 'bool', default: false,
			hint: 'On, grain follows the picture; off, it sits evenly over everything.' }
	],
	make: (params) => {
		const effect = new NoiseEffect({
			blendFunction: BlendFunction.SCREEN,
			premultiply: !!params.premultiply
		});
		// NoiseEffect has no amount of its own — the blend opacity IS the amount
		effect.blendMode.opacity.value = num(params.opacity, 0.25);
		return effect;
	}
});

registerPostEffect('chromaticaberration', {
	label: 'Chromatic aberration',
	group: 'camera',
	params: [
		{ key: 'offsetX', label: 'Offset X', min: 0, max: 0.02, step: 0.0002, decimals: 4, default: 0.001 },
		{ key: 'offsetY', label: 'Offset Y', min: 0, max: 0.02, step: 0.0002, decimals: 4, default: 0.0005 },
		{ key: 'radialModulation', label: 'Stronger at the edges', type: 'bool', default: false }
	],
	make: (params, ctx) => {
		const effect = new ChromaticAberrationEffect({
			radialModulation: !!params.radialModulation,
			modulationOffset: 0.15
		});
		// the ctor takes a Vector2 we would have to import THREE for; the live
		// uniform is the same thing and keeps this module three-free
		effect.offset.set(num(params.offsetX, 0.001), num(params.offsetY, 0.0005));
		return effect;
	}
});

registerPostEffect('pixelation', {
	label: 'Pixelation',
	group: 'camera',
	params: [
		{ key: 'granularity', label: 'Pixel size', min: 1, max: 60, step: 1, decimals: 0, default: 12 }
	],
	make: (params) => new PixelationEffect(num(params.granularity, 12))
});

registerPostEffect('scanlines', {
	label: 'Scanlines',
	group: 'camera',
	params: [
		{ key: 'density', label: 'Density', min: 0.1, max: 4, step: 0.05, decimals: 2, default: 1.25 },
		{ key: 'opacity', label: 'Amount', min: 0, max: 1, step: 0.01, decimals: 2, default: 0.5 },
		{ key: 'scrollSpeed', label: 'Scroll speed', min: 0, max: 2, step: 0.01, decimals: 2, default: 0 }
	],
	make: (params) => {
		const effect = new ScanlineEffect({ density: num(params.density, 1.25) });
		// scrollSpeed exists on the effect but not in its bundled option TYPES —
		// set it as a property rather than widening the ctor call
		/** @type {any} */ (effect).scrollSpeed = num(params.scrollSpeed, 0);
		effect.blendMode.opacity.value = num(params.opacity, 0.5);
		return effect;
	}
});

registerPostEffect('dotscreen', {
	label: 'Dot screen',
	group: 'stylize',
	params: [
		{ key: 'scale', label: 'Scale', min: 0.1, max: 8, step: 0.05, decimals: 2, default: 1 },
		{ key: 'angle', label: 'Angle', min: 0, max: Math.PI, step: 0.01, decimals: 3, default: Math.PI * 0.5 },
		{ key: 'opacity', label: 'Amount', min: 0, max: 1, step: 0.01, decimals: 2, default: 1 }
	],
	make: (params) => {
		const effect = new DotScreenEffect({
			scale: num(params.scale, 1),
			angle: num(params.angle, Math.PI * 0.5)
		});
		effect.blendMode.opacity.value = num(params.opacity, 1);
		return effect;
	}
});

// ---- L5: anti-aliasing -----------------------------------------------------

// It ships in the same drop as the stylize effects on purpose: posterise, dot
// screen and edge detect make aliasing far more visible than a shaded frame does,
// so the fix has to arrive with the thing that exposes the problem.
registerPostEffect('smaa', {
	label: 'Anti-aliasing (SMAA)',
	group: 'aa',
	params: [
		{ key: 'preset', label: 'Quality', type: 'select', default: 'MEDIUM',
			options: [
				{ value: 'LOW', label: 'Low' },
				{ value: 'MEDIUM', label: 'Medium' },
				{ value: 'HIGH', label: 'High' },
				{ value: 'ULTRA', label: 'Ultra' }
			] }
	],
	make: (params) =>
		new SMAAEffect({ preset: /** @type {any} */ (SMAAPreset)[params.preset] ?? SMAAPreset.MEDIUM })
});
