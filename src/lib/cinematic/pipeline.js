// 100 C1 — THE CINEMATIC VIEW'S LIGHTING (lazy chunk, three/webgpu + three/tsl).
//
// Wired the way the 100-light spike (C0b) proved it on real Chrome, on three r186's node interface:
//   · ONE scene pass with MRT: output, normal (rgb) + roughness (a), velocity, and for the GI steps the
//     diffuse colour (rgb) + metalness (a). Packed on purpose: WebGPU's default colour-attachment budget
//     is 32 bytes per sample (16F + 16F + 8 + 8 = 24 fits; a fifth target fails every pipeline, W3).
//   · SSGI returns TWO things in r186: the AO texture (`getAONode()`, R8) and the bounced light
//     (`getGINode()`). lit = colour x AO + diffuse x GI. (Spike 1 read the r180-era `gi.rgb` / `gi.a`:
//     the "overexposed, black blotches" image was that, not a driver fault.)
//   · SSR samples a TEXTURE (W4), and its alpha is the HIT DISTANCE, not an opacity: the reflection is
//     ADDED, never blended (blending by a distance is what made negative colours).
//   · then TRAA (needs the velocity target) and bloom; the renderer's tone mapping + output colour
//     space apply at the end (RenderPipeline.outputColorTransform).
//   · Basic = tone mapping + GTAO + TRAA + bloom. Standard = SSGI + SSR at half resolution (r186's SSGI
//     has no resolution scale: its targets are scaled here). High = full resolution.
//   · the selection outline (W14) is TSL's OutlineNode over the objects Outline.svelte outlines,
//     composited LAST, after the bloom (an editor helper, never graded).
import { QUALITY } from './cinematicCore.js';

/** the lighting numbers per step (100-light presets "medium" / "high"; GI intensity as tuned there) */
const LIGHT = { slices: 2, steps: 8, giIntensity: 10, aoIntensity: 1, radius: 12, thickness: 1, ssrMaxDistance: 6, ssrIntensity: 1, dielectric: 0.25 };

/**
 * @param {{ W: any, T: any, renderer: any, scene: any, camera: any, quality: import('./cinematicCore.js').Quality, outline?: () => { selected: any[], locked: any[], colors?: { selected?: any, locked?: any } } }} o
 */
export async function buildPipeline(o) {
	const { W, T, renderer, scene, camera } = o;
	const q = QUALITY[o.quality] ?? QUALITY.standard;
	const { pass, mrt, output, normalView, velocity, diffuseColor, directionToColor, colorToDirection, sample, vec3, vec4, max, metalness, roughness, convertToTexture, uniform } = T;
	const [{ ao }, { traa }, { bloom }, { outline }] = await Promise.all([
		import('three/examples/jsm/tsl/display/GTAONode.js'),
		import('three/examples/jsm/tsl/display/TRAANode.js'),
		import('three/examples/jsm/tsl/display/BloomNode.js'),
		import('three/examples/jsm/tsl/display/OutlineNode.js')
	]);
	const pipeline = new W.RenderPipeline(renderer);
	const scenePass = pass(scene, camera);
	const gi = q.gi || q.ssr;
	/** @type {Record<string, any>} */
	const outs = { output, normal: vec4(directionToColor(normalView), roughness), velocity };
	if (gi) outs.diffuseColor = vec4(diffuseColor.rgb, metalness);
	scenePass.setMRT(mrt(outs));
	scenePass.getTexture('normal').type = W.UnsignedByteType;
	if (gi) scenePass.getTexture('diffuseColor').type = W.UnsignedByteType;
	const color = scenePass.getTextureNode('output');
	const depth = scenePass.getTextureNode('depth');
	const normalTex = scenePass.getTextureNode('normal');
	const vel = scenePass.getTextureNode('velocity');
	const sceneNormal = sample((/** @type {any} */ uv) => colorToDirection(normalTex.sample(uv).rgb));
	/** @type {Record<string, any>} */
	const nodes = { scenePass };
	/** @type {any} */
	let lit;
	if (q.gi) {
		const diffuse = scenePass.getTextureNode('diffuseColor');
		/** @type {any} SSGINode (its typings miss setSize) */
		const SSGINode = (await import('three/examples/jsm/tsl/display/SSGINode.js')).default;
		const scale = q.scale;
		const native = /resolutionScale/.test(String(SSGINode.prototype.setSize));
		/** @type {any} */
		const ScaledSSGI = class extends SSGINode {
			/** @param {number} w @param {number} h */
			setSize(w, h) {
				const k = native ? 1 : scale;
				super.setSize(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
			}
		};
		/** @type {any} */
		const ssgi = new ScaledSSGI(convertToTexture(color), depth, sceneNormal, camera);
		if (native) ssgi.resolutionScale = scale;
		ssgi.sliceCount.value = LIGHT.slices;
		ssgi.stepCount.value = LIGHT.steps;
		ssgi.giIntensity.value = LIGHT.giIntensity;
		ssgi.aoIntensity.value = LIGHT.aoIntensity;
		ssgi.radius.value = LIGHT.radius;
		ssgi.thickness.value = LIGHT.thickness;
		nodes.ssgi = ssgi;
		lit = vec4(color.rgb.mul(ssgi.getAONode().r).add(diffuse.rgb.mul(ssgi.getGINode().rgb)), color.a);
		if (q.ssr) {
			const { ssr } = await import('three/examples/jsm/tsl/display/SSRNode.js');
			const litTex = convertToTexture(lit);
			nodes.litTex = litTex;
			const rough = normalTex.a;
			// the node weights a hit by "metalness": a smooth non-metal (a polished floor) gets a share too
			const reflectivity = max(diffuse.a, rough.oneMinus().mul(rough.oneMinus()).mul(LIGHT.dielectric));
			/** @type {any} */
			const refl = ssr(litTex, depth, sceneNormal, { metalnessNode: reflectivity, roughnessNode: rough, camera, reflectNonMetals: true });
			refl.resolutionScale = scale;
			refl.maxDistance.value = LIGHT.ssrMaxDistance;
			refl.quality.value = scale < 1 ? 0.4 : 0.5;
			refl.intensity.value = LIGHT.ssrIntensity;
			nodes.ssr = refl;
			lit = vec4(litTex.rgb.add(refl.rgb), litTex.a);
		}
	} else {
		const gtao = ao(depth, sceneNormal, camera);
		nodes.gtao = gtao;
		lit = vec4(color.rgb.mul(gtao.getTextureNode().r), color.a);
	}
	const aa = traa(lit, depth, vel, camera);
	nodes.traa = aa;
	const glow = bloom(aa, 0.25, 0.4, 0.85);
	nodes.bloom = glow;
	let final = aa.add(glow);
	// the selection + lock outlines, last (the selected objects array is refreshed every frame)
	/** @type {any} */
	let sel = null;
	/** @type {any} */
	let lock = null;
	const selColor = uniform(new W.Color(0xff9a1f));
	const lockColor = uniform(new W.Color(0x0a0000));
	if (o.outline) {
		sel = outline(scene, camera, { selectedObjects: [], edgeThickness: T.float(1), edgeGlow: T.float(0) });
		lock = outline(scene, camera, { selectedObjects: [], edgeThickness: T.float(1), edgeGlow: T.float(0) });
		nodes.outline = sel;
		nodes.lockOutline = lock;
		// visible and hidden edges alike (xRay, as the WebGL outline): an editor mark, drawn over the image
		const edge = (/** @type {any} */ n) => n.visibleEdge.add(n.hiddenEdge).clamp(0, 1);
		const e1 = edge(sel);
		const e2 = edge(lock);
		/** @type {any} */
		const rgb = final.rgb;
		final = vec4(rgb.mix(lockColor, e2).mix(selColor, e1), final.a);
	}
	pipeline.outputNode = final;
	return {
		pipeline,
		nodes,
		quality: o.quality,
		/** the camera the passes were built for (another camera = the view rebuilds the pipeline) */
		camera,
		/** one frame of the view */
		render() {
			if (o.outline && sel) {
				const s = o.outline();
				sel.selectedObjects = s.selected;
				lock.selectedObjects = s.locked;
				if (s.colors?.selected) selColor.value.copy(s.colors.selected);
				if (s.colors?.locked) lockColor.value.copy(s.colors.locked);
			}
			pipeline.render();
		},
		dispose() {
			try {
				pipeline.dispose?.();
			} catch {
				/* best effort */
			}
			for (const n of Object.values(nodes)) {
				try {
					n?.dispose?.();
				} catch {
					/* best effort */
				}
			}
		}
	};
}
