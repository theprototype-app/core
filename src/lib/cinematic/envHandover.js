// 100 C1 — THE SKY AND THE ENVIRONMENT ACROSS A SWITCH (lazy chunk; WebGL side only).
//
// The environment map and an HDRI sky background are RENDER TARGETS of the WebGL context (a PMREM
// atlas, a cube render target): their pixels exist only on that context's GPU. Releasing the context
// for the Cinematic view loses them twice over — the WebGPU renderer cannot read them (spike W16: the
// sky missing, grey), and after the restore they come back EMPTY (spike W19: the scene darker, no
// reflections) because three re-creates a render target's storage but not what was drawn into it.
//
// So before the release each one is unrolled to a CPU equirect (half float, mip 0), which the WebGPU
// renderer takes as an ordinary equirect environment / background; after the restore the SAME target
// objects are refilled in place from it (PMREMGenerator.fromEquirectangular(eq, target) /
// WebGLCubeRenderTarget.fromEquirectangularTexture), so every owner (hdriRuntime's caches, the
// `applied` checks in environment.js) still holds the texture it made.
import * as THREE from 'three';
import { createRenderTarget, readPixelsSync } from '../render/renderTargets.js';

const VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const DIRECTION = `
	float phi = (vUv.x - 0.5) * 2.0 * PI;
	float theta = (vUv.y - 0.5) * PI;
	vec3 dir = vec3(cos(theta) * cos(phi), sin(theta), cos(theta) * sin(phi));`;

/** @param {any} t a PMREM atlas (CubeUV mapping, a 2D render target texture) */
const isCubeUv = (t) => !!t && !t.isCubeTexture && t.mapping === THREE.CubeUVReflectionMapping;
/** @param {any} t is this texture's content only on the GL context? */
export const livesOnGpu = (t) => !!t && !!t.isTexture && !!t.isRenderTargetTexture;

/**
 * One full-screen pass that samples `tex` along every equirect direction, read back as half floats.
 * @param {any} gl the WebGL renderer (context alive) @param {any} tex a CubeUV atlas or a cube render target texture
 * @returns {THREE.DataTexture | null}
 */
export function unrollToEquirect(gl, tex) {
	const cubeUv = isCubeUv(tex);
	if (!cubeUv && !tex?.isCubeTexture) return null;
	const size = cubeUv ? tex.image?.height : tex.image?.[0]?.height ?? tex.image?.height ?? tex.source?.data?.height;
	// a PMREM refill sizes its cube from the equirect's width / 4: keep the atlas height for a CubeUV source
	const width = cubeUv ? Math.min(4096, size) : Math.min(2048, Math.max(256, (size || 256) * 2));
	const height = width / 2;
	/** @type {THREE.ShaderMaterial} */
	let material;
	if (cubeUv) {
		const imageHeight = tex.image.height;
		const maxMip = Math.log2(imageHeight) - 2; // three's WebGLPrograms generateCubeUVSize
		const texelHeight = 1.0 / imageHeight;
		const texelWidth = 1.0 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16));
		material = new THREE.ShaderMaterial({
			defines: { ENVMAP_TYPE_CUBE_UV: '', CUBEUV_TEXEL_WIDTH: texelWidth.toFixed(10), CUBEUV_TEXEL_HEIGHT: texelHeight.toFixed(10), CUBEUV_MAX_MIP: maxMip.toFixed(1) },
			uniforms: { envMap: { value: tex } },
			vertexShader: VERTEX,
			fragmentShader: `uniform sampler2D envMap; varying vec2 vUv;
				#include <common>
				#include <cube_uv_reflection_fragment>
				void main() { ${DIRECTION} gl_FragColor = vec4(textureCubeUV(envMap, dir, 0.0).rgb, 1.0); }`
		});
	} else {
		// three samples a cube RENDER TARGET unflipped and a loaded CubeTexture with x flipped (flipEnvMap)
		const flip = tex.isRenderTargetTexture ? 1 : -1;
		material = new THREE.ShaderMaterial({
			uniforms: { envMap: { value: tex } },
			vertexShader: VERTEX,
			fragmentShader: `uniform samplerCube envMap; varying vec2 vUv;
				#include <common>
				void main() { ${DIRECTION} gl_FragColor = vec4(textureCube(envMap, vec3(${flip.toFixed(1)} * dir.x, dir.yz)).rgb, 1.0); }`
		});
	}
	material.depthTest = false;
	material.depthWrite = false;
	material.toneMapped = false;
	const target = createRenderTarget(width, height, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false });
	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
	quad.frustumCulled = false;
	const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const prevTarget = gl.getRenderTarget();
	const prevXr = gl.xr?.enabled;
	try {
		if (gl.xr) gl.xr.enabled = false;
		gl.setRenderTarget(target);
		gl.render(quad, cam);
		const data = new Float32Array(width * height * 4);
		readPixelsSync(gl, target, 0, 0, width, height, data);
		// half floats: the WebGPU renderer filters them everywhere (float32 filtering is an optional feature)
		const half = new Uint16Array(data.length);
		for (let i = 0; i < data.length; i++) {
			const v = data[i];
			half[i] = THREE.DataUtils.toHalfFloat(v > 65000 ? 65000 : v >= 0 ? v : 0);
		}
		const eq = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
		eq.mapping = THREE.EquirectangularReflectionMapping;
		eq.colorSpace = THREE.LinearSRGBColorSpace;
		eq.minFilter = THREE.LinearFilter;
		eq.magFilter = THREE.LinearFilter;
		eq.generateMipmaps = false;
		eq.flipY = false;
		eq.name = 'cinematic-equirect';
		eq.needsUpdate = true;
		return eq;
	} catch {
		return null;
	} finally {
		gl.setRenderTarget(prevTarget);
		if (gl.xr) gl.xr.enabled = prevXr;
		target.dispose();
		material.dispose();
		quad.geometry.dispose();
	}
}

/**
 * Draw `src` into `target` texel for texel (the same size: a PMREM atlas made from the unrolled copy of that
 * very target); any other size is resampled. @param {any} gl @param {any} src @param {any} target
 */
function copyInto(gl, src, target) {
	const same = src.image?.width === target.width && src.image?.height === target.height;
	// three compiles a ShaderMaterial as GLSL 300 es on WebGL2 (varying / gl_FragColor defines), so texelFetch is there
	const material = new THREE.ShaderMaterial({
		uniforms: { src: { value: src } },
		vertexShader: VERTEX,
		fragmentShader: same
			? 'uniform sampler2D src; varying vec2 vUv; void main() { gl_FragColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }'
			: 'uniform sampler2D src; varying vec2 vUv; void main() { gl_FragColor = texture2D(src, vUv); }'
	});
	material.depthTest = false;
	material.depthWrite = false;
	material.toneMapped = false;
	const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
	quad.frustumCulled = false;
	const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	const prevTarget = gl.getRenderTarget();
	const prevXr = gl.xr?.enabled;
	const prevAuto = gl.autoClear;
	try {
		if (gl.xr) gl.xr.enabled = false;
		gl.autoClear = false;
		gl.setRenderTarget(target);
		gl.render(quad, cam);
	} finally {
		gl.setRenderTarget(prevTarget);
		if (gl.xr) gl.xr.enabled = prevXr;
		gl.autoClear = prevAuto;
		material.dispose();
		quad.geometry.dispose();
	}
}

/**
 * Before the WebGL context goes: unroll what only lives on it, and point the scene at the copies.
 * @param {any} gl @param {any} scene
 * @returns {{ environment: any, background: any, eqEnv: any, eqBg: any, kind: string }}
 */
export function captureEnvironment(gl, scene) {
	/** @type {{ environment: any, background: any, eqEnv: any, eqBg: any, kind: string }} */
	const rec = { environment: scene.environment, background: scene.background, eqEnv: null, eqBg: null, kind: 'none' };
	if (livesOnGpu(scene.environment)) {
		rec.eqEnv = unrollToEquirect(gl, scene.environment);
		rec.kind = rec.eqEnv ? 'unrolled' : 'dropped';
	} else if (scene.environment) rec.kind = 'kept';
	if (livesOnGpu(scene.background))
		rec.eqBg = scene.background === scene.environment ? rec.eqEnv : unrollToEquirect(gl, scene.background);
	return rec;
}

/** the WebGPU view's scene: the copies in place of the GL-only textures @param {any} scene @param {ReturnType<typeof captureEnvironment>} rec */
export function useCopies(scene, rec) {
	if (livesOnGpu(rec.environment)) scene.environment = rec.eqEnv;
	if (livesOnGpu(rec.background)) scene.background = rec.eqBg;
}

/**
 * After the WebGL context is back: the originals return and their targets are drawn again from the
 * copies (in place, same objects). The scene's CURRENT environment wins if somebody changed it while
 * the view was on (a sky picked in the view): then only the copies are dropped.
 * @param {any} gl @param {any} scene @param {ReturnType<typeof captureEnvironment>} rec
 */
export function restoreEnvironment(gl, scene, rec) {
	/** @type {any[]} */
	const refilled = [];
	/** @type {string[]} */
	const errors = [];
	/** @param {any} tex @param {any} eq */
	const refill = (tex, eq) => {
		if (!eq || !livesOnGpu(tex) || refilled.includes(tex)) return;
		const target = tex.renderTarget;
		if (!target) return;
		try {
			if (isCubeUv(tex)) {
				// NOT gen.fromEquirectangular(eq, target): r186's PMREMGenerator builds its blur state only when it
				// allocates its own target, so with ours passed in it threw on the unset state, the catch below kept
				// the atlas EMPTY and the standard view lost its environment light after one trip (mean luma 92 -> 53
				// on the Product shot). A fresh PMREM, copied texel for texel into the same target object.
				const gen = new THREE.PMREMGenerator(gl);
				const fresh = gen.fromEquirectangular(eq);
				copyInto(gl, fresh.texture, target);
				fresh.dispose();
				gen.dispose();
			} else if (typeof target.fromEquirectangularTexture === 'function') {
				target.fromEquirectangularTexture(gl, eq);
			}
			refilled.push(tex);
		} catch (e) {
			// the original stays empty: the next environment change rebuilds it (said in the switch record)
			errors.push(String(/** @type {any} */ (e)?.message ?? e).slice(0, 200));
		}
	};
	if (scene.environment === rec.eqEnv) scene.environment = rec.environment;
	if (scene.background === rec.eqBg) scene.background = rec.background;
	refill(rec.environment, rec.eqEnv);
	refill(rec.background, rec.eqBg);
	rec.eqEnv?.dispose?.();
	if (rec.eqBg !== rec.eqEnv) rec.eqBg?.dispose?.();
	return errors.length ? { refilled: refilled.length, errors } : { refilled: refilled.length };
}
