// mcp-diorama2 (item 7) — SCREENSHOTS THROUGH THE POST STACK, AND WHY NOT. `screenshot {postEffects: true}` was
// dropped by both bridges and the shot was always the plain scene, so an agent that added bloom and a vignette saw
// neither and could not tell "I got it wrong" from "this screen does not draw post". Two halves:
//
//   postState()     what THIS tab draws right now: the effective stack (the same inputs Outline.svelte composes
//                   from: the scene's look + the camera looked through, the view mode, the person's own switch,
//                   the quality governor and the capability gate) and, when nothing is drawn, the reason in words.
//                   set_look's post answer and the screenshot both say it, so a phone that turned post off to keep
//                   its frames (the governor's last step, by design) is reported, not guessed at.
//   renderWithPost  one frame of `camera` through a TEMPORARY composer with its own compiled stack into a float
//                   target — never the live composer (it draws to the canvas at the canvas size, through the
//                   person's camera, with the selection outlines on top). The renderer is not resized and its
//                   canvas is not touched: the composer gets the renderer by field, never setRenderer (which calls
//                   renderer.setSize and turns autoClear off).
import { get } from 'svelte/store';
import * as THREE from 'three';
import { viewMode } from '../../stores/sceneStore';
import { postSupported, chromiumMajor } from '$lib/viewMode';
import { cameraPreview } from '$lib/cameraPreview';
import { postStacks, resolvedDoc, POST_SCENE_KEY, postEnabledLocal, effectivePostStack, normalizeScenePost } from '$lib/scenePost';
import { qualityOverrides, qualityState } from '$lib/qualityGovernor';
import { postOffReason } from './postShotCore.js';

export { postOffReason, QUALITY_HOW } from './postShotCore.js';

/**
 * @returns {{entries: any[], live: boolean, reason: string | null, detail: string | null, how: string | null, authored: number}}
 *   entries = what this tab would draw; reason = a short code when nothing is drawn
 */
export function postState() {
	void get(postStacks);
	const camUuid = /** @type {any} */ (get(cameraPreview))?.uuid ?? null;
	const stack = resolvedDoc(POST_SCENE_KEY);
	const cameraStack = camUuid ? resolvedDoc(camUuid) : null;
	const authored = [...(normalizeScenePost(stack).effects ?? []), ...(cameraStack ? normalizeScenePost(cameraStack).effects ?? [] : [])].filter(
		(/** @type {any} */ e) => e && e.enabled !== false
	).length;
	const reduced = /** @type {any} */ (get(qualityOverrides));
	const mode = String(get(viewMode));
	const localOn = get(postEnabledLocal) !== false;
	const ok = postSupported();
	const entries = effectivePostStack({
		stack,
		cameraStack: /** @type {any} */ (cameraStack),
		mode: reduced.aoOff && mode === 'shaded-ao' ? 'shaded' : mode,
		localEnabled: localOn && !reduced.postOff,
		postOk: ok,
		postWarm: true
	}).filter((/** @type {any} */ entry) => !(reduced.aoOff && entry.kind === 'ao'));
	if (entries.length) return { entries, live: true, reason: null, detail: null, how: null, authored };
	return { entries, live: false, ...postOffReason({ authored, mode, localOn, ok, postOff: !!reduced.postOff, level: get(qualityState).level, major: chromiumMajor() }), authored };
}

/**
 * Render `scene` from `camera` through the given post entries into a w×h linear frame.
 * @param {any} renderer @param {any} scene @param {any} camera @param {number} w @param {number} h @param {any[]} entries
 * @returns {Promise<{pixels: Float32Array | Uint8Array, float: boolean} | {error: string}>}
 */
export async function renderWithPost(renderer, scene, camera, w, h, entries) {
	const [{ EffectComposer, RenderPass, CopyPass }, { compilePostStack, disposePostStack }] = await Promise.all([import('postprocessing'), import('$lib/postEffects')]);
	const float = !!renderer.extensions?.has?.('EXT_color_buffer_float');
	const target = new THREE.WebGLRenderTarget(w, h, { type: float ? THREE.FloatType : THREE.UnsignedByteType, depthBuffer: false });
	// no renderer at construction: setRenderer would resize the canvas to its own size and switch autoClear off
	const composer = /** @type {any} */ (new EffectComposer(/** @type {any} */ (null), { frameBufferType: THREE.HalfFloatType }));
	const renderPass = new RenderPass(scene, camera);
	const dpr = 1;
	const compiled = compilePostStack(entries, { scene, camera, width: w, height: h, dpr, prefs: {} });
	const copy = new CopyPass(target, false);
	const passes = [renderPass, ...compiled.passes, copy];
	const previous = renderer.getRenderTarget();
	const autoClear = renderer.autoClear;
	try {
		// addPass reads this.renderer (drawing buffer size, context attributes): set it first
		composer.renderer = renderer;
		for (const pass of passes) composer.addPass(pass);
		composer.inputBuffer.setSize(w, h);
		composer.outputBuffer.setSize(w, h);
		const alpha = renderer.getContext().getContextAttributes()?.alpha ?? false;
		for (const pass of passes) {
			pass.renderToScreen = false;
			pass.initialize?.(renderer, alpha, THREE.HalfFloatType);
			pass.setSize?.(w, h);
		}
		for (const instance of compiled.instances) instance.def?.resize?.(instance.object, w, h, dpr);
		composer.render(1 / 60);
		const pixels = float ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
		renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
		return { pixels, float };
	} catch (error) {
		return { error: 'the post stack could not render this shot: ' + String(/** @type {any} */ (error)?.message ?? error) };
	} finally {
		renderer.setRenderTarget(previous);
		renderer.autoClear = autoClear;
		for (const pass of compiled.passes) composer.removePass(pass);
		disposePostStack(compiled.passes, compiled.instances);
		composer.renderer = null;
		renderPass.dispose?.();
		copy.dispose?.();
		composer.inputBuffer?.dispose?.();
		composer.outputBuffer?.dispose?.();
		target.dispose();
	}
}
