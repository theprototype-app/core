// 100 C2-3 — WATER IN THE CINEMATIC VIEW (lazy: the view's chunk).
//
// The standard view draws water with one GLSL program (waterShader.js surfaceVertex / surfaceFragment, the desktop
// WATER_SS tier) that the WebGPU renderer cannot run; before C2-3 the view swapped it for a flat stand-in and the
// author's placeholder mesh showed as a solid box (the "Water" chip; in Aquarium it hid the tank's inside). Here the
// same program is written in TSL and fed the runtime's OWN uniform objects, so every setting of a water object drives
// the view exactly as it drives the standard view, and the waves are in phase with the CPU buoyancy query:
//
//   vertex    Gerstner waves (8 components, world metres, the shared clock) + the ripple rings, as a positionNode;
//             the analytic normal and the crest factor go to the fragment as varyings
//   fragment  detail normals (the shared tiling map), Fresnel, the sky model or the scene's HDRI (its PMREM), the sun
//             highlight, refraction + chromatic split + depth absorption + shoreline foam + caustics read from the
//             SCENE PASS (its colour and depth already are "the scene with the water hidden": the water is on a layer
//             the scene pass does not draw), opacity / visibility / opaque liquids / glow / crest + rim foam, and the
//             underwater fade of its own walls, and WATER_PLANAR's mirror (TSL's reflector node: the same mirrored
//             camera, for the nearest volume that asks). Everything the GLSL has except the Quest tier and the editor's
//             selection un-refract mask.
//
// THE SAME LIFECYCLE AS fxCover.js: each water mesh (surface, tank body) keeps its runtime material, hidden while the
// view is on, and gets a CHILD twin on WATER_LAYER drawn in a pass of its own after TRAA (pipeline.js), so it never
// writes the scene pass's normal / velocity / diffuse targets (GTAO and SSGI would treat it as an opaque wall). The
// author's placeholder mesh is swapped for an invisible material for the length of each view frame only (the
// runtime's own bracket under WebGL), so no save, sync or undo ever sees it. Leaving the view takes all of it back.
//
// The underwater look (the runtime swaps the scene's fog and draws a full-screen tint under WebGL) is three post
// nodes in pipeline.js fed by `under` (fog by the scene depth, the tint and the caustics on what is below the surface).
import { waterCoverKind } from './cinematicCore.js';

const TAU = 6.2831853;
const TWIN = 'cinematic-water';
/** the layer the water twins are drawn on (27 = fx twins; 28-31 are taken: studio, water selection, helpers, reduced) */
export const WATER_LAYER = 26;
/** waterShader.js MAX_SHADER_WAVES / MAX_SHADER_RIPPLES (the arrays are the runtime's, read at their full length) */
const WAVES = 8;

/**
 * @param {{ W: any, T: any, scene: any, viewState: (camera: any, out?: any[]) => { entries: any[], overlay: any, under: any, sun: any }, camera: () => any }} o
 */
export function createWaterCover(o) {
	const { W, T, scene, viewState } = o;
	const {
		uniform, uniformArray, attribute, texture, pmremTexture, varying, select, screenUV, positionGeometry, positionWorld, positionView,
		cameraPosition, cameraProjectionMatrixInverse, cameraWorldMatrix, modelWorldMatrix, modelWorldMatrixInverse, frontFacing,
		getViewPosition, Fn, Loop, If, Break, vec2, vec3, vec4, float, mix, clamp, pow, exp, sin, cos, abs, sign, fract, length,
		distance, dot, normalize, reflect, refract, min, max, smoothstep, step, reflector
	} = T;

	/** the scene pass's colour + depth (each pipeline build hands its own over: setSceneTextures) */
	const placeholderColor = new W.DataTexture(new Uint8Array(4), 1, 1);
	const placeholderDepth = new W.DepthTexture(1, 1);
	const sceneColor = texture(placeholderColor);
	const sceneDepth = texture(placeholderDepth);
	/** an invisible material for the placeholder meshes, inside a view frame only */
	const invisible = new W.MeshBasicNodeMaterial({ visible: false });
	const _camPos = new W.Vector3();
	const _objPos = new W.Vector3();
	invisible.name = 'cinematic-water-hidden';

	/** the underwater post look (pipeline.js reads these nodes) */
	const under = {
		on: uniform(0),
		fogColor: uniform(new W.Color()),
		fogFar: uniform(10),
		tint: uniform(new W.Color()),
		strength: uniform(0.18),
		caustics: uniform(0),
		causticScale: uniform(1),
		causticSpeed: uniform(0),
		surfaceY: uniform(0),
		sun: uniform(1),
		time: uniform(0)
	};

	/** @type {Map<any, any>} water mesh -> its twin record */
	const twins = new Map();
	/** @type {Set<any>} runtime materials hidden while the view is on */
	const hidden = new Set();
	/** @type {any[]} placeholder (object, material) pairs swapped for the current view frame */
	const swapped = [];
	/** @type {any[]} */
	const list = [];
	const stats = { surfaces: 0, bodies: 0, planar: 0, underwater: false, scanMs: 0, errors: /** @type {string[]} */ ([]) };
	/** @type {WeakSet<any>} materials whose twin could not be built (they keep the stand-in and the chip) */
	const refused = new WeakSet();
	let frame = 0;
	/** @type {any} */
	let lastState = null;

	/** a uniform that follows a GLSL uniform holder @param {{ value: any }} holder */
	const bridge = (holder) => uniform(holder.value).onRenderUpdate(() => holder.value);
	/** @param {Record<string, { value: any }>} holders */
	const bridgeAll = (holders) => {
		/** @type {Record<string, any>} */
		const out = {};
		for (const [k, v] of Object.entries(holders)) {
			if (!v || typeof v !== 'object' || !('value' in v)) continue;
			const x = v.value;
			if (x == null || x.isTexture || Array.isArray(x)) continue;
			out[k] = bridge(v);
		}
		return out;
	};

	/** waterShader.js caustic(): three warped cell layers, sharpened @param {any} p @param {any} t */
	function caustic(p, t) {
		/** @type {any} */
		let c = float(0);
		/** @type {any} */
		let q = p;
		for (let i = 0; i < 3; i++) {
			q = q.add(vec2(sin(q.y.mul(1.7).add(t.mul(0.9 + i * 0.3))), cos(q.x.mul(1.3).sub(t.mul(0.7 + i * 0.2)))).mul(0.35));
			const g = fract(q.mul(1 + i * 0.37)).sub(0.5);
			c = c.add(pow(max(float(1).sub(length(g).mul(2.2)), 0), 3));
		}
		return clamp(c.mul(0.8), 0, 2);
	}

	/**
	 * The surface / body twin material: waterShader.js surfaceVertex + surfaceFragment (WATER_SS), line for line.
	 * @param {any} sm the runtime ShaderMaterial (its uniforms are the entry's) @param {boolean} body @param {any} env the scene's environment (a texture the WebGPU renderer can sample) or null
	 * @param {any} [mirror] the TSL reflector for Reflection: Planar, or null
	 */
	function waterMaterial(sm, body, env, mirror = null) {
		const S = sm.uniforms;
		const U = bridgeAll(S);
		const uUnder = uniform(0);
		const waveA = uniformArray(S.uWaveA.value, 'vec4');
		const waveB = uniformArray(S.uWaveB.value, 'vec2');
		const ripple = uniformArray(S.uRipple.value, 'vec4');
		const rippleAge = uniformArray(S.uRippleAge.value, 'float');
		const detail = texture(S.uNormalMap.value);

		// ---- vertex: Gerstner + ripples (WAVE_PARS) ----
		const rest = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
		/** @param {any} p rest point (world x/z) */
		function gerstner(p) {
			/** @type {any} */
			let ox = float(0);
			/** @type {any} */
			let oy = float(0);
			/** @type {any} */
			let oz = float(0);
			/** @type {any} */
			let nx = float(0);
			/** @type {any} */
			let ny = float(0);
			/** @type {any} */
			let nz = float(0);
			/** @type {any} */
			let amp = float(0);
			for (let i = 0; i < WAVES; i++) {
				const A = waveA.element(i);
				const B = waveB.element(i);
				// components past uWaveCount keep whatever an earlier spectrum left there: weighted out
				const a = B.x.mul(step(float(i + 0.5), U.uWaveCount));
				const f = A.z.mul(dot(A.xy, p)).sub(A.w);
				const c = cos(f);
				const s = sin(f);
				ox = ox.add(B.y.mul(a).mul(A.x).mul(c));
				oz = oz.add(B.y.mul(a).mul(A.y).mul(c));
				oy = oy.add(a.mul(s));
				const wa = A.z.mul(a);
				nx = nx.sub(A.x.mul(wa).mul(c));
				nz = nz.sub(A.y.mul(wa).mul(c));
				ny = ny.sub(B.y.mul(wa).mul(s));
				amp = amp.add(a);
			}
			const o3 = vec3(ox, oy, oz);
			return { o: o3, n: normalize(vec3(nx, ny.add(1), nz)), crest: clamp(ny.negate(), 0, 1).mul(step(float(0), oy.add(amp.mul(0.2)))) };
		}
		const rippleHeight = Fn((/** @type {any[]} */ [p]) => {
			const h = float(0).toVar();
			Loop(16, (/** @type {{ i: any }} */ { i }) => {
				If(float(i).greaterThanEqual(U.uRippleCount), () => {
					Break();
				});
				const R = ripple.element(i);
				const age = rippleAge.element(i);
				const r = distance(p, R.xy);
				const wl = R.z.mul(0.8).add(0.06);
				const d = r.sub(age.mul(0.9)).div(wl);
				const env = exp(d.mul(d).negate()).mul(exp(age.mul(-1.4)));
				const alive = step(float(0), age).mul(step(age, float(3)));
				h.addAssign(R.w.mul(R.z).mul(0.12).mul(sin(d.mul(TAU))).mul(env).mul(alive));
			});
			return h;
		});
		const frozen = U.uFrozen.greaterThan(0.5);
		const modelN = normalize(modelWorldMatrix.mul(vec4(attribute('normal', 'vec3'), 0)).xyz);
		const G = gerstner(rest.xz);
		/** @type {any} */
		let world;
		/** @type {any} */
		let nrm;
		if (!body) {
			const e = attribute('aEdge', 'float');
			const w1 = rest.add(vec3(G.o.x.mul(e), G.o.y, G.o.z.mul(e)));
			const eps = 0.04;
			const h0 = rippleHeight(w1.xz);
			const hx = rippleHeight(w1.xz.add(vec2(eps, 0)));
			const hz = rippleHeight(w1.xz.add(vec2(0, eps)));
			world = select(frozen, rest, w1.add(vec3(0, h0, 0)));
			nrm = select(frozen, modelN, normalize(G.n.add(vec3(hx.sub(h0).div(eps).negate(), 0, hz.sub(h0).div(eps).negate()))));
		} else {
			const top = attribute('aTop', 'float').greaterThan(0.5);
			world = select(frozen.or(top.not()), rest, rest.add(vec3(0, G.o.y.add(rippleHeight(rest.xz)), 0)));
			nrm = modelN;
		}
		const m = new W.MeshBasicNodeMaterial();
		m.name = TWIN;
		m.lights = false;
		m.positionNode = modelWorldMatrixInverse.mul(vec4(world, 1)).xyz;
		const vNormalW = varying(nrm);
		const vCrest = varying(select(frozen, float(0), G.crest));

		// ---- fragment ----
		const P = positionWorld;
		const V = normalize(cameraPosition.sub(P));
		const front = frontFacing;
		const t = U.uTime;
		const flowOff = U.uFlow.mul(t).mul(0.25);
		const sp = U.uDetailSpeed.mul(float(1).sub(U.uFrozen));
		/** @type {any} */
		let N = normalize(vNormalW);
		/** @type {any} */
		let foamNoise;
		if (!body) {
			const uv1 = P.xz.div(U.uDetailScale).add(vec2(0.7, 0.3).mul(t).mul(sp).mul(0.25)).sub(flowOff.div(U.uDetailScale));
			const uv2 = P.xz.div(U.uDetailScale.mul(0.57)).sub(vec2(0.4, -0.6).mul(t).mul(sp).mul(0.25)).sub(flowOff.div(U.uDetailScale));
			const a = detail.sample(uv1);
			const b = detail.sample(uv2);
			const dn = a.xy.mul(2).sub(1).add(b.xy.mul(2).sub(1));
			N = normalize(N.add(vec3(dn.x, 0, dn.y).mul(U.uDetail).mul(0.6)));
			foamNoise = a.w.mul(0.6).add(b.w.mul(0.4));
		} else {
			const gn = normalize(vNormalW);
			const wuv = select(abs(gn.y).greaterThan(0.7), P.xz, select(abs(gn.x).greaterThan(abs(gn.z)), P.zy, P.xy));
			foamNoise = detail.sample(wuv.div(U.uDetailScale).add(vec2(0.3, 0.6).mul(t).mul(sp).mul(0.1))).w;
		}
		N = select(front, N, N.negate());
		const NdV = clamp(dot(N, V), 0, 1);
		const F = clamp(float(0.02).add(pow(float(1).sub(NdV), U.uFresnel).mul(0.98)).mul(U.uReflectivity).mul(U.uReflectOn), 0, 1);

		/** the sky model, or the scene's HDRI when it shows @param {any} d @param {any} blur */
		const sky = (d, blur) => {
			const y = d.y;
			const up = mix(U.uSkyHorizon, U.uSkyTop, smoothstep(float(0), float(0.6), y));
			const dn = mix(U.uSkyHorizon, U.uSkyBottom, smoothstep(float(0), float(0.35), y.negate()));
			const c = select(y.greaterThanEqual(0), up, dn);
			const avg = U.uSkyTop.add(U.uSkyHorizon.mul(2)).add(U.uSkyBottom).mul(0.25);
			const analytic = mix(c, avg, blur);
			if (!env) return analytic;
			const hdri = pmremTexture(env, U.uEnvRot.mul(d), clamp(blur, 0, 1)).rgb.mul(U.uEnvIntensity);
			return select(U.uEnvOn.greaterThan(0.5), hdri, analytic);
		};

		// reflection: the sky / environment; WATER_PLANAR's mirrored-camera texture (TSL's reflector, the same maths)
		// on the one surface that gets it, seen from above
		const R = reflect(V.negate(), N);
		/** @type {any} */
		let refl = sky(R, U.uRoughness.mul(0.8));
		if (mirror) {
			mirror.uvNode = mirror.uvNode.add(vec2(N.x, N.z).mul(0.04));
			refl = select(front, mix(mirror.rgb, refl, U.uRoughness.mul(0.5)), refl);
		}
		const L = normalize(U.uSunDir);
		const H = normalize(L.add(V));
		const shin = clamp(float(2).div(max(pow(U.uRoughness, 4), 1e-4)).sub(2), 8, 2048);
		const spec = pow(max(dot(N, H), 0), shin).mul(shin.add(8)).div(25).mul(U.uReflectOn);
		const sunSpec = U.uSunColor.mul(spec).mul(select(front, float(1), float(0.15))).mul(U.uReflectivity);

		// transmission
		const camInside = uUnder.greaterThan(0.5);
		const lp = (/** @type {any} */ w) => U.uWorldToLocal.mul(vec4(w, 1)).xyz;
		const bmin = vec3(U.uBoxMin.x, select(U.uOpen.greaterThan(0.5), float(-1e4), U.uBoxMin.y), U.uBoxMin.z);
		const bmax = U.uBoxMax;
		/** distance the view ray travels inside the local box from p along dir (world) @param {any} p @param {any} dir */
		const exitDistance = (p, dir) => {
			const lpp = lp(p);
			const ld0 = U.uWorldToLocal.mul(vec4(dir, 0)).xyz;
			const scale = length(ld0);
			const ld = ld0.div(max(scale, 1e-6));
			const inv = float(1).div(max(abs(ld), vec3(1e-6))).mul(sign(ld.add(1e-9)));
			const t0 = bmin.sub(lpp).mul(inv);
			const t1 = bmax.sub(lpp).mul(inv);
			const tf = max(t0, t1);
			const tExit = min(min(tf.x, tf.y), tf.z);
			return select(scale.lessThan(1e-6), float(1e3), max(tExit, 0).div(max(scale, 1e-6)));
		};
		/** @param {any} w */
		const insideBox = (w) => {
			const l = lp(w);
			const lo = step(bmin.sub(0.01), l);
			const hi = step(l, bmax.add(0.02));
			return lo.x.mul(lo.y).mul(lo.z).mul(hi.x).mul(hi.y).mul(hi.z);
		};
		const thickness0 = max(select(front.not().or(camInside), length(cameraPosition.sub(P)), exitDistance(P, V.negate())), 0);
		const refrDir = refract(V.negate(), N, select(front, float(1 / 1.33), float(1.33)));
		const tir = front.not().and(dot(refrDir, refrDir).lessThan(0.5));
		const refrSky = sky(select(length(refrDir).greaterThan(0), refrDir, R), float(0.55));

		// screen space: the scene pass is the pre-pass (WebGPU's screen uv runs top-down: the offset's y turns over)
		const uv = screenUV;
		const fragZ = positionView.z.negate();
		const off0 = vec2(N.x, N.z.negate()).mul(U.uRefraction).mul(0.06).div(max(float(1), fragZ.mul(0.15)));
		const viewZAt = (/** @type {any} */ u, /** @type {any} */ d) => getViewPosition(u, d, cameraProjectionMatrixInverse).z.negate();
		const uvr0 = clamp(uv.add(off0), 0.001, 0.999);
		const d0 = sceneDepth.sample(uvr0).x;
		const dRaw = sceneDepth.sample(uv).x;
		// a refracted sample that lands IN FRONT of the water (an object above the surface) is not seen through it
		const unbent = viewZAt(uvr0, d0).lessThan(fragZ);
		const uvr = select(unbent, uv, uvr0);
		const d = select(unbent, dRaw, d0);
		const sceneZ = viewZAt(uvr, d);
		const ch = uvr.sub(uv).mul(U.uChromatic).mul(0.6);
		const sc0 = vec3(sceneColor.sample(clamp(uvr.add(ch), 0.001, 0.999)).r, sceneColor.sample(uvr).g, sceneColor.sample(clamp(uvr.sub(ch), 0.001, 0.999)).b);
		const behind = max(sceneZ.sub(fragZ), 0);
		const fromAbove = front.and(camInside.not());
		const thickness = select(fromAbove, min(thickness0, behind), thickness0);
		const shoreScene = select(fromAbove, float(1).sub(smoothstep(float(0), U.uFoamWidth, behind)), float(0));
		// caustics on whatever the refraction lands on, when it lies in the water
		const floorW = cameraWorldMatrix.mul(vec4(getViewPosition(uvr, d, cameraProjectionMatrixInverse), 1)).xyz;
		const depthBelow = max(P.y.sub(floorW.y), 0);
		const cz = caustic(floorW.xz.div(U.uCausticScale).add(U.uFlow.mul(t).mul(0.1)), t.mul(U.uCausticSpeed));
		const sunLit = clamp(max(L.y, 0).mul(1.5), 0, 1);
		const lit = select(fromAbove, step(float(1e-6), U.uCaustics).mul(insideBox(floorW)), float(0));
		const sc = sc0.add(sc0.mul(cz).mul(U.uCaustics).mul(exp(depthBelow.mul(-0.25))).mul(sunLit).mul(1.6).mul(lit));
		const refr = select(tir, refrSky, sc);

		const clar = max(U.uClarity, 0.01);
		const absorb = float(1).sub(exp(thickness.negate().div(clar)));
		const dens = exp(U.uOpacity.sub(0.85).mul(22.7));
		const absorbO = float(1).sub(exp(thickness.negate().mul(dens).div(clar)));
		const tint = mix(vec3(1, 1, 1), U.uShallow, float(0.3).add(clamp(thickness.div(clar), 0, 1).mul(0.7)));
		/** @type {any} */
		let trans = mix(refr.mul(tint), U.uDeep, clamp(absorbO.mul(U.uOpacity), 0, 1));
		const vis = smoothstep(float(0.5), float(1.5), thickness.div(max(U.uFogDistance, 0.05)));
		trans = mix(trans, U.uFogColor.mul(max(L.y, 0.15).mul(0.65).add(0.35)), vis);
		const cover = clamp(max(absorbO.mul(U.uOpacity), smoothstep(float(0.85), float(0.95), U.uOpacity)), 0, 1);
		const opaqueLiquid = U.uRefraction.lessThanEqual(0);
		const molten = mix(U.uShallow, U.uDeep, clamp(absorb.add(0.2), 0, 1)).mul(max(L.y, 0.15).mul(0.65).add(0.35)).mul(U.uSunColor).mul(0.6).add(U.uDeep.mul(0.4));
		trans = select(opaqueLiquid, mix(trans, molten, cover), trans);
		trans = select(tir, mix(U.uDeep, U.uFogColor, 0.5), trans);
		/** @type {any} */
		let col = mix(trans, refl, F).add(sunSpec);

		// glow (lava, toxic)
		const emit = max(max(U.uEmissive.r, U.uEmissive.g), U.uEmissive.b);
		const vein = smoothstep(float(0.38), float(0.72), mix(float(0.55), foamNoise, clamp(U.uDetail.mul(2), 0, 1)));
		const glowCol = select(opaqueLiquid, mix(col.mul(0.35).add(U.uDeep.mul(0.25)), col, vein), col).add(
			U.uEmissive.mul(select(front, float(1), float(0.7))).mul(select(opaqueLiquid, mix(float(0.12), float(1.5), vein), mix(float(0.6), float(1.15), vein)))
		);
		col = select(emit.greaterThan(0), glowCol, col);

		// foam: crests + the shoreline band + the meniscus line along a tank's own walls
		/** @type {any} */
		let foamMask = float(0);
		if (!body) {
			const lw = lp(P);
			const e = U.uWorldToLocal;
			// world metres per local unit along x / z (rows of the inverse matrix are 1 / scale), computed on the CPU
			const ix = uniform(1).onRenderUpdate(() => { const a = e.value.elements; return Math.hypot(a[0], a[4], a[8]) || 1; });
			const iz = uniform(1).onRenderUpdate(() => { const a = e.value.elements; return Math.hypot(a[2], a[6], a[10]) || 1; });
			const c = U.uBoxMin.xz.add(U.uBoxMax.xz).mul(0.5);
			const hs = max(U.uBoxMax.xz.sub(U.uBoxMin.xz).mul(0.5), vec2(1e-4, 1e-4));
			const r = length(lw.xz.sub(c).div(hs));
			const dd = hs.sub(abs(lw.xz.sub(c)));
			const edge = select(U.uRound.greaterThan(0.5), float(1).sub(r).mul(min(hs.x.div(ix), hs.y.div(iz))), min(dd.x.div(ix), dd.y.div(iz)));
			const rim = float(1).sub(smoothstep(float(0), U.uFoamWidth, max(edge, 0)));
			const shore = select(U.uOpen.lessThan(0.5), max(shoreScene, rim), shoreScene);
			const crestF = smoothstep(float(0.3), float(0.75), vCrest);
			const fm = max(crestF.mul(0.9), shore).mul(U.uFoam);
			foamMask = select(front, fm.mul(smoothstep(float(0.25), float(0.75), foamNoise.add(fm.mul(0.4)))), float(0));
		}
		const foamLit = U.uSkyTop.mul(0.45).add(U.uSunColor.mul(max(dot(N, L), 0).mul(0.65).add(0.35)));
		col = mix(col, U.uFoamColor.mul(foamLit), clamp(foamMask, 0, 1));
		// from inside the water its own walls and surface fade with distance (three's linear fog curve)
		col = select(camInside, mix(col, U.uFogColor, clamp(thickness.sub(0.05).div(max(U.uFogDistance.sub(0.05), 0.01)), 0, 1)), col);

		m.colorNode = col;
		// the scene pass's geometry in front of the water hides it (the pass draws against a depth buffer of its own)
		const occluded = viewZAt(uv, dRaw).lessThan(fragZ.sub(fragZ.mul(0.002).add(0.005)));
		m.opacityNode = select(occluded, float(0), float(1));
		m.alphaTest = 0.5;
		m.transparent = false;
		m.depthWrite = true;
		m.depthTest = true;
		m.fog = true;
		m.side = body ? W.FrontSide : W.DoubleSide;
		return { m, uUnder };
	}

	/** @param {any} mesh a water-surface / water-body mesh @param {boolean} body */
	function addTwin(mesh, body, planar = false) {
		const sm = mesh.material;
		const env = scene.environment && scene.environment.isTexture ? scene.environment : null;
		const mirror = planar && !body ? reflector({ resolutionScale: 0.5, bounces: false }) : null;
		const { m, uUnder } = waterMaterial(sm, body, env, mirror);
		const twin = new W.Mesh(mesh.geometry, m);
		twin.name = TWIN;
		twin.userData.localOnly = true;
		twin.userData.cinematicWater = true;
		twin.raycast = () => {};
		twin.castShadow = twin.receiveShadow = false;
		twin.frustumCulled = mesh.frustumCulled;
		twin.renderOrder = mesh.renderOrder;
		twin.layers.set(WATER_LAYER);
		mesh.add(twin);
		sm.visible = false;
		hidden.add(sm);
		const rec = { mesh, sm, twin, m, uUnder, body, env, mirror, planar: !!mirror, geometry: mesh.geometry, seen: frame };
		twins.set(mesh, rec);
		return rec;
	}

	/** @param {any} rec */
	function dropTwin(rec) {
		rec.twin.removeFromParent();
		rec.m.dispose();
		rec.mirror?.dispose?.();
		if (hidden.delete(rec.sm)) rec.sm.visible = true;
		twins.delete(rec.mesh);
	}

	/** @param {any} mesh @param {boolean} body @param {boolean} inside @param {any} [entry] the planar one, if this is it */
	function follow(mesh, body, inside, entry = null) {
		const m = mesh.material;
		const kind = waterCoverKind(mesh, m);
		let rec = twins.get(mesh);
		const env = scene.environment && scene.environment.isTexture ? scene.environment : null;
		// a new runtime material (a tier change), new geometry (a resize) or another HDRI: build it again
		if (rec && (m !== rec.sm || mesh.geometry !== rec.geometry || env !== rec.env || (!body && !!entry !== rec.planar))) {
			dropTwin(rec);
			rec = null;
		}
		if (!rec) {
			if (!kind || refused.has(m) || !m.uniforms?.uNormalMap?.value) return;
			try {
				rec = addTwin(mesh, body, !!entry);
			} catch (e) {
				stats.errors.push(String(/** @type {any} */ (e)?.message ?? e).slice(0, 200));
				if (stats.errors.length > 10) stats.errors.shift();
				refused.add(m);
				return;
			}
		}
		rec.seen = frame;
		rec.uUnder.value = inside ? 1 : 0;
		// the mirror plane: the surface's middle at the water level, facing up (the runtime's renderReflection)
		if (rec.mirror && entry) {
			const v = entry.volume;
			const b = v.bounds;
			const t = rec.mirror.target;
			t.position.set((b.minX + b.maxX) / 2, v.level, (b.minZ + b.maxZ) / 2).applyMatrix4(entry.object.matrixWorld);
			t.rotation.set(-Math.PI / 2, 0, 0);
			t.updateMatrixWorld(true);
		}
		// the tank shows its OUTER faces from outside and its INNER ones from inside (the runtime's own rule)
		if (body) {
			const side = inside ? W.BackSide : W.FrontSide;
			if (rec.m.side !== side) {
				rec.m.side = side;
				rec.m.needsUpdate = true;
			}
		}
	}

	/** every frame of the view: the twins follow the runtime's entries; the underwater look follows the camera */
	function scan() {
		const t0 = performance.now();
		frame++;
		const cam = o.camera();
		const st = viewState(cam, list);
		lastState = st;
		const inEntry = st.under?.entry ?? null;
		// one planar mirror, for the nearest visible volume that asks for it (the runtime's planarCandidate)
		/** @type {any} */
		let mirrorFor = null;
		if (cam?.matrixWorld) {
			let best = Infinity;
			_camPos.setFromMatrixPosition(cam.matrixWorld);
			for (const e of st.entries) {
				if (!e.wantsPlanar || !e.visible || !e.object) continue;
				const d = _objPos.setFromMatrixPosition(e.object.matrixWorld).distanceToSquared(_camPos);
				if (d < best) {
					best = d;
					mirrorFor = e;
				}
			}
		}
		for (const e of st.entries) {
			const inside = inEntry === e;
			if (e.surface) follow(e.surface, false, inside, e === mirrorFor ? e : null);
			if (e.body) follow(e.body, true, inside);
		}
		for (const r of [...twins.values()]) if (r.seen !== frame) dropTwin(r);
		// the runtime's full-screen underwater tint is GLSL too: the post nodes draw it here
		const ov = st.overlay;
		if (ov?.material && !hidden.has(ov.material)) {
			ov.material.visible = false;
			hidden.add(ov.material);
		}
		under.on.value = st.under ? 1 : 0;
		if (st.under) {
			const L = st.under.look;
			const fog = L.fogColor || L.deepColor || '#000000';
			try {
				under.fogColor.value.set(fog);
			} catch {
				under.fogColor.value.set(0, 0, 0);
			}
			under.tint.value.copy(under.fogColor.value);
			under.fogFar.value = Math.max(0.2, Number(L.fogDistance) || 10);
			under.caustics.value = Math.max(0, Number(L.caustics) || 0);
			under.causticScale.value = Math.max(0.05, Number(L.causticScale) || 1);
			under.causticSpeed.value = Number(L.causticSpeed) || 0;
			under.surfaceY.value = st.under.surfaceY;
			const s = st.sun;
			under.sun.value = s ? Math.min(1.5, s.r + s.g + s.b) / 1.5 : 1;
			const tw = st.under.entry.uniforms?.uTime?.value;
			if (typeof tw === 'number') under.time.value = tw;
		}
		stats.surfaces = stats.bodies = stats.planar = 0;
		for (const r of twins.values()) {
			if (r.body) stats.bodies++;
			else stats.surfaces++;
			if (r.mirror) stats.planar++;
		}
		stats.underwater = !!st.under;
		stats.scanMs = performance.now() - t0;
	}

	return {
		scan,
		layer: WATER_LAYER,
		under,
		get count() {
			return twins.size;
		},
		/** the pipeline's scene-pass colour + depth textures (each rebuild hands over its own) @param {any} color @param {any} depth */
		setSceneTextures(color, depth) {
			if (color) sceneColor.value = color;
			if (depth) sceneDepth.value = depth;
		},
		/** does the view draw this (object, material) itself? (the stand-in pass and the chip leave it alone) @param {any} obj @param {any} m */
		covered(obj, m) {
			if (refused.has(m)) return false;
			const rec = twins.get(obj);
			if (rec && rec.sm === m) return true;
			return !!waterCoverKind(obj, m);
		},
		/** the view frame starts: the placeholders the runtime hides under WebGL are hidden here (this frame only) */
		beforeRender() {
			swapped.length = 0;
			for (const e of lastState?.entries ?? []) {
				const ob = e.object;
				if (!e.ready || !ob?.isMesh || !ob.material || !twins.has(e.surface)) continue;
				swapped.push(ob, ob.material);
				ob.material = invisible;
			}
		},
		afterRender() {
			for (let i = swapped.length - 2; i >= 0; i -= 2) if (swapped[i].material === invisible) swapped[i].material = swapped[i + 1];
			swapped.length = 0;
		},
		undo() {
			this.afterRender();
			for (const r of [...twins.values()]) dropTwin(r);
			for (const m of hidden) m.visible = true;
			hidden.clear();
			invisible.dispose();
			placeholderColor.dispose();
			placeholderDepth.dispose();
		},
		stats() {
			return { ...stats, twins: twins.size, errors: stats.errors.slice(-10) };
		}
	};
}
