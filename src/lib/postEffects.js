import { EffectPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
// @ts-ignore - n8ao ships no bundled type declarations
import { N8AOPostPass } from 'n8ao';
import { registerPostEffect, postEffectDef, planPostStack } from './scenePost';

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
			// THE MERGE: one EffectPass for the whole consecutive run of Effects
			passes.push(new EffectPass(ctx.camera, ...made));
			plan.push({ type: 'effects', kinds: group.entries.map((/** @type {any} */ e) => e.kind) });
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
