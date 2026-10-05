// 37-hdri — the desktop composer's half of "exposure-aware".
//
// The composer renders the scene into a TARGET, and three applies `renderer.toneMapping` only
// when drawing to the canvas or an XR target — so on the desktop an HDRI sky (radiance up to
// tens of thousands) would clip at 1.0 into an 8-bit buffer and the Exposure slider would do
// nothing (CLAUDE.md "renderer.toneMapping NEVER REACHES A COMPOSED FRAME"). While an HDRI
// shows, Outline.svelte asks this module for two things:
//   1. HALF-FLOAT frame buffers, so the render keeps the range for the tone mapper;
//   2. an environment-owned ToneMapping pass (ACES/AgX/Neutral, reading the renderer's
//      toneMappingExposure, which three feeds every program) right before the outline passes —
//      unless the scene's post stack already has a Tone mapping entry (it owns the curve then).
// With no HDRI both are undone and the chain is the stock 8-bit one, byte-identical to before.
import { HalfFloatType, UnsignedByteType, SRGBColorSpace, NoColorSpace } from 'three';
import { EffectPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';

/** @param {string} mode */
function ppMode(mode) {
	if (mode === 'agx') return ToneMappingMode.AGX;
	if (mode === 'neutral') return ToneMappingMode.NEUTRAL;
	return ToneMappingMode.ACES_FILMIC;
}

/**
 * Switch the composer's main buffers between 8-bit and half float, re-initializing every pass
 * so its own targets follow (postprocessing's addPass/setRenderer contract).
 * @param {any} composer @param {any} renderer @param {boolean} hdr
 */
export function setComposerHdr(composer, renderer, hdr) {
	const type = hdr ? HalfFloatType : UnsignedByteType;
	if (composer.inputBuffer.texture.type === type) return false;
	const srgb = !hdr && renderer.outputColorSpace === SRGBColorSpace;
	for (const buffer of [composer.inputBuffer, composer.outputBuffer]) {
		buffer.texture.type = type;
		buffer.texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
		buffer.dispose();
	}
	const alpha = renderer.getContext().getContextAttributes()?.alpha ?? false;
	for (const pass of composer.passes) pass.initialize?.(renderer, alpha, type);
	return true;
}

/**
 * Keep the environment's tone-mapping pass in the chain (or out of it). `before` is the first
 * outline pass — the env pass sits right in front of it, after the scene's stack, so editor
 * gizmos are never graded (Outline.svelte's chain-position rule).
 * @param {{composer: any, camera: any, before: any, mode: string | null, current: any}} o
 * @returns {any} the live pass (or null)
 */
export function syncEnvTonePass({ composer, camera, before, mode, current }) {
	if (!mode) {
		if (current) {
			composer.removePass(current);
			current.dispose?.();
		}
		return null;
	}
	if (current) {
		const effect = current.__tpToneEffect;
		const want = ppMode(mode);
		if (effect && effect.mode !== want) effect.mode = want;
		return current;
	}
	const effect = new ToneMappingEffect({ mode: ppMode(mode) });
	const pass = new EffectPass(camera, effect);
	pass.name = 'EnvToneMappingPass';
	/** @type {any} */ (pass).__tpToneEffect = effect;
	const index = composer.passes.indexOf(before);
	composer.addPass(pass, index >= 0 ? index : undefined);
	return pass;
}
