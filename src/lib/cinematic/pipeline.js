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
//   · C2-2: particles, bursts and bubbles (fxCover.js twins, layer FX_LAYER) are drawn in a pass of their own, cleared
//     to transparent with no background, and laid over the anti-aliased image as premultiplied colour before the bloom
//     (so sparks glow). Kept out of the scene pass because its normal / velocity / diffuse targets are written
//     unblended: a sprite there replaced the surface normals behind it and the AO went black under it.
//   · C2-3: water (waterCover.js twins, layer WATER_LAYER) in a pass of its own BEFORE the fx pass, for the same reason;
//     its twins read the scene pass's colour + depth as the standard view's refraction pre-pass. Under water, the fog,
//     tint and caustics go over the finished linear image (the runtime's fog swap and full-screen overlay).
//   · the selection outline (W14) is TSL's OutlineNode over the objects Outline.svelte outlines,
//     composited LAST, after the bloom (an editor helper, never graded).
import { QUALITY } from './cinematicCore.js';

/** the lighting numbers per step (100-light presets "medium" / "high"; GI intensity as tuned there) */
const LIGHT = { slices: 2, steps: 8, giIntensity: 10, aoIntensity: 1, radius: 12, thickness: 1, ssrMaxDistance: 6, ssrIntensity: 1, dielectric: 0.25 };

/**
 * @param {{ W: any, T: any, renderer: any, scene: any, camera: any, quality: import('./cinematicCore.js').Quality, outline?: () => { selected: any[], locked: any[], colors?: { selected?: any, locked?: any } }, fx?: { layer: number, count: number, setSceneDepth: (tex: any) => void } | null, water?: { layer: number, count: number, under: Record<string, any>, setSceneTextures: (color: any, depth: any) => void } | null }} o
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
	// a post node runs on the full-screen quad's own camera: the scene camera's matrices go in as uniforms (the same
	// objects three updates in place), as GTAO and SSR take the camera explicitly
	const projInv = uniform(camera.projectionMatrixInverse);
	const camWorld = uniform(camera.matrixWorld);
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
	/** @type {any} */
	let shown = aa;
	/** @type {any} where the water / fx passes drew (their alpha): not the scene's pixels */
	let drawn = null;
	if (o.water) {
		const w = waterOver(o.water, shown);
		shown = w.img;
		drawn = w.a;
	}
	if (o.fx) {
		const f = fxOver(o.fx, shown);
		shown = f.img;
		drawn = drawn ? max(drawn, f.a) : f.a;
	}
	const glow = bloom(shown, 0.25, 0.4, 0.85);
	nodes.bloom = glow;
	let final = shown.add(glow);
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
		// the FUNCTION form: TSL's chained `x.mix(a, b)` is mix(a, b, x) (x is the factor), which blended the
		// colours BY THE IMAGE and drew one flat grey over the whole view
		final = vec4(T.mix(T.mix(rgb, lockColor, e2), selColor, e1), final.a);
	}
	if (o.water) {
		// under water the look is laid over the finished LINEAR image, before the output transform (tone mapping +
		// sRGB): the standard view draws the scene into a render target, so its fog and overlay mix in linear too
		final = underwater(o.water.under, final, drawn ?? T.float(0));
	}
	pipeline.outputNode = final;

	/**
	 * A pass of its own over the scene's twins on `layer`: no background, cleared to (0, 0, 0, 0), drawn from the
	 * UN-JITTERED camera (TRAA jitters the camera for the whole pipeline through its view offset; these twins are not
	 * accumulated by it, so a jittered twin would shimmer by a sub-pixel every frame); skipped while there are none (one
	 * empty render clears what the last one left). Returns the pass's colour, premultiplied.
	 * @param {number} layer @param {() => number} count @param {string} key */
	function ownPass(layer, count, key) {
		const own = pass(scene, camera);
		const layers = new W.Layers();
		layers.set(layer);
		own.setLayers(layers);
		const clear = new W.Color();
		let empty = false;
		const draw = own.updateBefore.bind(own);
		own.updateBefore = (/** @type {any} */ frame) => {
			if (!count()) {
				if (empty) return;
				empty = true;
			} else empty = false;
			const bg = scene.background;
			renderer.getClearColor(clear);
			const alpha = renderer.getClearAlpha();
			const v = camera.view;
			const jitter = v?.enabled ? [v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height] : null;
			if (jitter) camera.clearViewOffset();
			scene.background = null;
			renderer.setClearColor(0x000000, 0);
			try {
				draw(frame);
			} finally {
				scene.background = bg;
				renderer.setClearColor(clear, alpha);
				if (jitter) camera.setViewOffset(...jitter);
			}
		};
		nodes[key] = own;
		return own.getTextureNode('output');
	}

	/** the fx pass (particles, bursts, bubbles: fxCover.js) over `under` @param {any} fx @param {any} under */
	function fxOver(fx, under) {
		fx.setSceneDepth(scenePass.getTexture('depth'));
		const c = ownPass(fx.layer, () => fx.count, 'fxPass');
		return { img: vec4(under.rgb.mul(c.a.oneMinus()).add(c.rgb), under.a), a: c.a };
	}

	/**
	 * C2-3: the water pass (waterCover.js) over `under`. Its twins read the scene pass's colour and depth as the
	 * standard view's pre-pass (the water is on a layer the scene pass does not draw); opaque where drawn.
	 * @param {any} water @param {any} under */
	function waterOver(water, under) {
		water.setSceneTextures(scenePass.getTexture('output'), scenePass.getTexture('depth'));
		const c = ownPass(water.layer, () => water.count, 'waterPass');
		return { img: vec4(under.rgb.mul(c.a.oneMinus()).add(c.rgb), under.a), a: c.a };
	}

	/** what the scene pass saw at `uv` in view space (water and fx twins are not in it) @param {any} uv */
	function viewAt(uv) {
		return T.getViewPosition(uv, depth.sample(uv).x, projInv);
	}

	/**
	 * Under water (the camera inside a volume): the standard view swaps the scene's fog for the water's (three's linear
	 * fog, near 0.05 m, far = the water's Visibility), paints the sky in the fog colour, and draws a full-screen tint +
	 * caustic net over the frame (waterShader.js overlayFragment, blended One / OneMinusSrcAlpha). It draws into a
	 * render target, so all of that mixes in LINEAR, before the output pass tone-maps it (measured: the fog colour
	 * reaches the screen lighter and greyer than its hex). The same here, last before the output transform; the water
	 * and fx twins are not fogged (the water fades its own walls; bubbles skip fog). Not under water every term is 0.
	 * @param {Record<string, any>} u waterCover's `under` uniforms @param {any} img @param {any} drawn the twins' alpha */
	function underwater(u, img, drawn) {
		const out = img;
		const uv = T.screenUV;
		const d = depth.sample(uv).x;
		const vp = viewAt(uv);
		const sky = d.greaterThanEqual(0.99999);
		const f = T.select(sky, T.float(1), T.smoothstep(T.float(0.05), u.fogFar, vp.z.negate())).mul(u.on).mul(T.float(1).sub(drawn));
		/** @type {any} */
		let rgb = T.mix(out.rgb, u.fogColor, f);
		const vgn = T.length(uv.sub(0.5)).mul(1.4);
		const a = u.strength.mul(vgn.mul(0.4).add(0.6)).mul(u.on);
		const w = camWorld.mul(vec4(vp, 1)).xyz;
		/** @type {any} */
		let c = T.float(0);
		/** @type {any} */
		let q = w.xz.div(u.causticScale);
		const t = u.time.mul(u.causticSpeed);
		for (let i = 0; i < 3; i++) {
			q = q.add(T.vec2(T.sin(q.y.mul(1.7).add(t.mul(0.9 + i * 0.3))), T.cos(q.x.mul(1.3).sub(t.mul(0.7 + i * 0.2)))).mul(0.35));
			const g = T.fract(q.mul(1 + i * 0.37)).sub(0.5);
			c = c.add(T.pow(max(T.float(1).sub(T.length(g).mul(2.2)), 0), 3));
		}
		c = T.clamp(c.mul(0.8), 0, 2);
		const below = T.step(w.y, u.surfaceY).mul(T.float(1).sub(T.select(d.greaterThanEqual(0.9999), T.float(1), T.float(0)))).mul(T.step(T.float(1e-6), u.caustics));
		const add = vec3(c.mul(u.caustics).mul(0.18).mul(u.sun)).mul(T.exp(u.surfaceY.sub(w.y).mul(-0.25))).mul(T.exp(T.length(vp).mul(-0.08))).mul(below).mul(u.on);
		rgb = T.max(u.tint.mul(a).add(add), vec3(0, 0, 0)).add(rgb.mul(a.oneMinus()));
		return vec4(rgb, out.a);
	}

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
