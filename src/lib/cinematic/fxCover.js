// 100 C2-2 / C2-4 — PARTICLES, BURSTS, BUBBLES AND VERTEX DEFORMERS IN THE CINEMATIC VIEW (lazy: the view's chunk).
//
// The WebGPU renderer cannot run the GLSL these effects are drawn with, and it draws `THREE.Points` at ONE pixel
// whatever the shader asks. Here each one is drawn through TSL from the SAME data the standard view uses, so the
// two views show the same thing at the same moment (and a peer on the standard view sees the same motion phase):
//
//   particles  (particleRuntime: `particle` nodes + userData.particles) — the simulation is a closed-form function
//              of hashed per-slot attributes and the synced clock, evaluated in the VERTEX shader. It is ported to
//              TSL line for line (particleShader.js SIM_COMMON) and fed the runtime's own uniform objects.
//   bursts     (effectsBurst: the `effectburst` node) — a CPU simulation writing a position + colour buffer each
//              frame; those buffers are drawn as they are.
//   bubbles    (water runtime: userData.bubbles + water-volume bubbles) — an analytic InstancedBufferGeometry
//              shader, ported, same uniforms.
//   deformers  (vertexDeform.js: jiggle, bodywave, windsway, waterflow) — each as a TSL `positionNode` on the
//              deformer's own material clone, reading the uniforms its runtime writes every frame.
//
// HOW, without touching the runtimes: a covered Points / Mesh keeps its own material (the runtimes write to it every
// frame: effectsBurst reads `sys.points.material`, the water runtime `mesh.material.uniforms`) with `visible = false`
// while the view is on, and gets a CHILD twin (`cinematic-fx`) drawn by the view: an instanced quad per point (the
// clip-space size gl_PointSize would have given), or the source's own geometry with a TSL material. The twin rides
// its parent's transform and visibility. A deformer needs no twin: the WebGPU renderer converts a classic material by
// copying its properties (NodeLibrary.fromMaterial), so a `positionNode` set on the clone is drawn, and the standard
// view (WebGL) never reads it. Leaving the view takes all of it back.
//
// THE TWINS ARE DRAWN IN A PASS OF THEIR OWN (pipeline.js `fx`): on layer FX_LAYER, which the scene pass does not see.
// In r186 only the scene pass's `output` target follows a material's blending; normal, velocity and diffuse are
// written unblended, so a transparent sprite in the scene pass REPLACED the surface normals behind it and the AO went
// black under every particle. In their own pass they never touch the lighting inputs: each twin tests itself against
// the scene pass's depth in its fragment (when its source depth-tests: additive presets do not), the pass is cleared
// to transparent and composited premultiplied after TRAA, before the bloom.
//
// `scan()` runs every frame (a burst fires and lives for half a second; a once-a-second pass would miss it whole).
import { fxCoverKind, DEFORM_COVERED } from './cinematicCore.js';
import { deformSpecsOf } from '../vertexDeform.js';

const TAU = 6.2831853;
const TWIN = 'cinematic-fx';
/** the layer the twins are drawn on (28-31 are taken: studio, water selection, helpers, reduced) */
export const FX_LAYER = 27;

/**
 * @param {{ W: any, T: any, scene: any, glCanvas: HTMLCanvasElement }} o
 */
export function createFxCover(o) {
	const { W, T, scene, glCanvas } = o;
	const {
		uniform, attribute, bufferAttribute, positionGeometry, modelViewMatrix, cameraProjectionMatrix, cameraViewMatrix,
		varying, select, texture, screenUV, vec2, vec3, vec4, float, mix, clamp, pow, exp, sin, cos, sqrt, cross, length, dot, min, max,
		smoothstep, fract, step, uv
	} = T;

	/** the scene pass's depth (the pipeline hands its texture over: setSceneDepth), for the twins' own depth test */
	const placeholder = new W.DepthTexture(1, 1);
	const sceneDepth = texture(placeholder);

	/** the WebGL canvas's drawing-buffer size: gl_PointSize is in its pixels */
	const viewPx = uniform(new W.Vector2(1, 1));
	/** the plane every point is drawn as (corners at +-0.5) */
	const quad = new W.PlaneGeometry(1, 1);

	/** @type {Map<any, any>} source object -> its twin record */
	const twins = new Map();
	/** @type {Map<any, { mesh: any, sig: string }>} deformer clone material -> its record */
	const deforms = new Map();
	/** @type {Set<any>} source materials hidden while the view is on */
	const hidden = new Set();
	const stats = { particles: 0, bursts: 0, bubbles: 0, deform: 0, scanMs: 0 };
	let frame = 0;

	/**
	 * A source attribute read once per INSTANCE (one quad per point). r186's `instancedBufferAttribute()` does not mark a
	 * plain BufferAttribute instanced, and the step mode comes from the attribute object: an InstancedBufferAttribute
	 * over the SAME array, its version kept up with the source's (the runtimes flag their writes there).
	 * @param {any} rec the twin record collecting the pairs @param {any} src */
	function perInstance(rec, src) {
		const a = new W.InstancedBufferAttribute(src.array, src.itemSize);
		a.version = src.version;
		rec.pairs.push([src, a]);
		return bufferAttribute(a);
	}

	/** a uniform that follows a GLSL uniform holder (same object, same value, every render) @param {{ value: any }} holder */
	const bridge = (holder) => uniform(holder.value).onRenderUpdate(() => holder.value);
	/** bridges for every uniform in a holder map @param {Record<string, { value: any }>} holders */
	const bridgeAll = (holders) => {
		/** @type {Record<string, any>} */
		const out = {};
		for (const [k, v] of Object.entries(holders)) if (v && typeof v === 'object' && 'value' in v && !v.value?.isTexture) out[k] = bridge(v);
		return out;
	};
	/** GLSL mod (floored), not WGSL's truncated `%` @param {any} x @param {any} y */
	const gmod = (x, y) => x.sub(y.mul(x.div(y).floor()));
	/** rotate v by quaternion q @param {any} q @param {any} v */
	const qrot = (q, v) => v.add(cross(q.xyz, cross(q.xyz, v).add(q.w.mul(v))).mul(2));

	/** a twin material: unlit, its own clip position, and `occlude` (1 = test against the scene's depth) */
	function fxMaterial() {
		const m = new W.MeshBasicNodeMaterial();
		m.lights = false;
		m.userData.occlude = uniform(1);
		return m;
	}

	/**
	 * The clip position and the opacity, with the depth test the pass itself cannot do (it has no scene depth): z and w
	 * interpolate perspective-correct, so z / w per fragment is the depth the scene pass would compare.
	 * @param {any} m @param {any} clip @param {any} opacity */
	function place(m, clip, opacity) {
		m.vertexNode = clip;
		const z = varying(clip.z);
		const w = varying(clip.w);
		const behind = m.userData.occlude.greaterThan(0.5).and(z.div(w).greaterThan(sceneDepth.sample(screenUV).x.add(1e-5)));
		m.opacityNode = select(behind, float(0), opacity);
	}

	// ---- particles: particleShader.js SIM_COMMON in TSL ------------------------------------------------------

	/** @param {Record<string, any>} U bridged uniforms */
	function sim(U) {
		const world = U.uWorldSpace.greaterThan(0.5);
		const inv = vec4(U.uQuat.xyz.negate(), U.uQuat.w);
		/** how old slot (r, r2, idx) is now @param {any} r @param {any} r2 @param {any} idx */
		function slotAge(r, r2, idx) {
			const li = max(U.uLifetime.mul(float(1).add(U.uLifeJitter.mul(r.w.sub(0.5)))), 0.05);
			const phase = idx.div(max(U.uCount, 1)).mul(U.uLifetime).add(r2.w.mul(U.uPhaseNoise));
			const ageC = gmod(U.uTime.sub(phase), li);
			const ageB = U.uTime.sub(U.uBurstT.add(r2.w.mul(0.12).mul(li)));
			const deadB = U.uBurstT.lessThan(0).or(ageB.lessThan(0)).or(ageB.greaterThan(li));
			const burst = U.uMode.greaterThanEqual(0.5);
			return { li, age: select(burst, ageB, ageC), alive: select(burst, select(deadB, float(0), float(1)), float(1)) };
		}
		/** where that particle is at `age`, in the object's frame (the world in world mode) @param {any} r @param {any} r2 @param {any} origin @param {any} vel @param {any} age @param {any} li */
		function simPos(r, r2, origin, vel, age, li) {
			const t = clamp(age.div(li), 0, 1);
			const ph = r.y.mul(TAU);
			const ca = mix(float(1), cos(U.uAngle), r.x);
			const sa = sqrt(max(float(1).sub(ca.mul(ca)), 0));
			const ring = vec3(cos(ph), 0, sin(ph));
			const up = vec3(sa.mul(cos(ph)), ca, sa.mul(sin(ph)));
			const cu = r.x.mul(2).sub(1);
			const su = sqrt(max(float(1).sub(cu.mul(cu)), 0));
			const dirS = vec3(su.mul(cos(ph)), cu, su.mul(sin(ph)));
			const box = U.uShape.greaterThan(2.5);
			const disc = U.uShape.greaterThan(1.5);
			const sphere = U.uShape.greaterThan(0.5);
			let dir = select(box, vec3(sa.mul(cos(ph)), ca.negate(), sa.mul(sin(ph))), select(disc, up, select(sphere, dirS, up)));
			let posBase = select(
				box,
				vec3(r.z.mul(2).sub(1).mul(U.uArea.x), 0, r2.x.mul(2).sub(1).mul(U.uArea.y)),
				select(disc, ring.mul(U.uRadius).mul(sqrt(max(r.z, 0.001))), select(sphere, dirS.mul(U.uRadius).mul(r.z), ring.mul(U.uRadius).mul(r.z)))
			);
			const aimWorld = world.and(U.uAimWorld.greaterThan(0.5));
			dir = select(aimWorld, qrot(inv, dir), dir);
			posBase = select(aimWorld, qrot(inv, posBase), posBase).add(U.uOffset);
			const sp = U.uSpeed.mul(float(1).add(U.uSpeedJitter.mul(r.z.sub(0.5))));
			const travel = select(U.uDrag.greaterThan(0.001), float(1).sub(exp(U.uDrag.negate().mul(age))).div(max(U.uDrag, 0.001)), age);
			let disp = dir.mul(sp).mul(travel);
			disp = disp.add(qrot(inv, vel).mul(select(world, max(U.uInherit, 0), float(0)).mul(travel)));
			const gUp = select(world, qrot(inv, vec3(0, 1, 0)), vec3(0, 1, 0));
			disp = disp.add(gUp.mul(U.uGravity.mul(0.5).mul(age).mul(age)));
			const f1 = r2.x.mul(2).add(1.7);
			const f2 = r2.y.mul(2).add(1.3);
			const turb = vec3(sin(age.mul(f1).mul(3).add(r2.x.mul(TAU))), sin(age.mul(f2).mul(2.2).add(r2.y.mul(TAU))), cos(age.mul(f1).mul(2.6).add(r2.z.mul(TAU))));
			disp = disp.add(turb.mul(select(U.uTurbulence.greaterThan(0.001), U.uTurbulence, float(0)).mul(0.3).mul(t)));
			disp = disp.add(U.uWind.mul(age));
			const p = posBase.add(disp);
			// the ground: x/z stop where the fall crossed it, the age past it drives the splash / the settled fade
			const hit = U.uFall.greaterThan(0).and(p.y.lessThan(U.uFall.negate()));
			const drop = max(disp.y.negate(), 1e-4);
			const hitAge = age.mul(clamp(U.uFall.add(posBase.y).div(drop), 0, 1));
			const xz = posBase.xz.add(disp.xz.mul(hitAge.div(max(age, 1e-4))));
			const landedP = vec3(xz.x, U.uFall.negate().add(0.01), xz.y);
			const landed = select(hit, select(U.uGround.greaterThan(1.5), float(1), clamp(age.sub(hitAge).div(0.18), 0, 1).add(0.001)), float(0));
			const local = select(hit, landedP, p);
			return { p: select(world, origin.add(qrot(U.uQuat, local)), local), landed };
		}
		return { slotAge, simPos, world };
	}

	/** fade in / out over life, and the colour (gradient over life or per particle) @param {Record<string, any>} U @param {any} life @param {any} seed */
	function lifeLook(U, life, seed) {
		const fadeIn = select(U.uFadeIn.greaterThan(0), smoothstep(float(0), max(U.uFadeIn, 1e-6), life), float(1));
		const fadeOut = select(U.uFadeOut.greaterThan(0), float(1).sub(smoothstep(float(1).sub(U.uFadeOut), float(1), life)), float(1));
		const col = mix(U.uColorStart, U.uColorEnd, select(U.uColorMode.greaterThan(0.5), seed, life));
		return { fade: fadeIn.mul(fadeOut), col };
	}
	/** the rain splash fades out @param {Record<string, any>} U @param {any} landed */
	const splashFade = (U, landed) => select(landed.greaterThan(0).and(U.uGround.lessThan(1.5)), float(1).sub(landed).mul(0.8), float(1));

	/**
	 * The point-mode particle material (one instanced quad per slot).
	 * @param {any} src the particle ShaderMaterial (its uniforms are the runtime's) @param {any} g its geometry
	 * @param {any} pairs where the per-instance attributes are listed
	 */
	function particlePointsMaterial(src, g, pairs) {
		const U = bridgeAll(src.uniforms);
		const map = texture(src.uniforms.uMap.value);
		const A = (/** @type {string} */ n) => perInstance(pairs, g.getAttribute(n));
		const r = A('aRand');
		const r2 = A('aRand2');
		const S = sim(U);
		const { li, age, alive } = S.slotAge(r, r2, A('aIndex'));
		const t = clamp(age.div(li), 0, 1);
		const { p, landed } = S.simPos(r, r2, A('aOrigin'), A('aVel'), age, li);
		const mv = modelViewMatrix.mul(vec4(p, 1));
		const size = mix(U.uSizeStart, U.uSizeEnd, t).mul(r2.z.mul(0.4).add(0.8)).mul(select(landed.greaterThan(0).and(U.uGround.lessThan(1.5)), landed.mul(3).add(1), float(1)));
		const px = min(size.mul(U.uSizeScale).div(max(mv.z.negate(), 0.1)), 256);
		const clip = cameraProjectionMatrix.mul(mv);
		const corner = positionGeometry.xy;
		const at = clip.xy.add(corner.mul(px).mul(2).div(viewPx).mul(clip.w));
		const m = fxMaterial();
		const clipOut = select(alive.greaterThan(0.5), vec4(at, clip.zw), vec4(0, 0, 2, 1));
		const life = varying(t);
		const vLanded = varying(landed);
		const vRot = varying(U.uSpin.mul(age).add(r.y.mul(TAU)));
		const vSeed = varying(r.x);
		// gl_PointCoord - 0.5 (y down) from the quad corner (y up)
		const c = varying(vec2(corner.x, corner.y.negate()));
		const s = sin(vRot);
		const co = cos(vRot);
		const tex = map.sample(vec2(c.x.mul(co).sub(c.y.mul(s)), c.x.mul(s).add(c.y.mul(co))).add(0.5));
		const { fade, col } = lifeLook(U, life, vSeed);
		m.colorNode = col.mul(tex.rgb);
		place(m, clipOut, tex.a.mul(U.uOpacity).mul(fade).mul(splashFade(U, vLanded)));
		m.alphaTest = 0.01;
		return { m, map };
	}

	/** camera-facing side of a strip @param {any} path @param {any} point */
	function stripSide(path, point) {
		const s = cross(path, point);
		const l = length(s);
		return select(l.greaterThan(1e-7), s.div(max(l, 1e-7)), vec3(1, 0, 0));
	}

	/**
	 * stretch / trails / ribbon: the source's own geometry, the strip vertex shaders ported.
	 * @param {any} src @param {boolean} ribbon
	 */
	function particleStripMaterial(src, ribbon) {
		const U = bridgeAll(src.uniforms);
		const map = texture(src.uniforms.uMap.value);
		const r = attribute('aRand', 'vec4');
		const r2 = attribute('aRand2', 'vec4');
		const S = sim(U);
		const side = attribute('aSide', 'float');
		const m = fxMaterial();
		/** @type {any} */
		let clipOut;
		/** @type {any} */
		let life;
		/** @type {any} */
		let landedOut;
		/** @type {any} */
		let along;
		if (!ribbon) {
			const { li, age, alive } = S.slotAge(r, r2, attribute('aIndex', 'float'));
			const al = attribute('aSeg', 'float').div(max(U.uSegs, 1));
			const segAge = max(age.sub(al.mul(U.uTrail)), 0);
			const eps = max(U.uTrail.div(max(U.uSegs, 1)), 0.004).mul(0.5);
			const origin = attribute('aOrigin', 'vec3');
			const vel = attribute('aVel', 'vec3');
			const { p, landed } = S.simPos(r, r2, origin, vel, segAge, li);
			const a = S.simPos(r, r2, origin, vel, max(segAge.sub(eps), 0), li).p;
			const b = S.simPos(r, r2, origin, vel, segAge.add(eps), li).p;
			const mv = modelViewMatrix.mul(vec4(p, 1));
			const path = modelViewMatrix.mul(vec4(b.sub(a), 0)).xyz;
			const t = clamp(segAge.div(li), 0, 1);
			const width = mix(U.uSizeStart, U.uSizeEnd, t).mul(r2.z.mul(0.4).add(0.8));
			const trails = U.uRender.greaterThan(1.5);
			const pl = length(path);
			const fwd = select(pl.greaterThan(1e-7), path.div(max(pl, 1e-7)), vec3(0, 1, 0));
			const base = select(trails, mv.xyz, mv.xyz.add(fwd.mul(width).mul(float(0.5).sub(al))));
			const w = select(trails, width.mul(float(1).sub(al.mul(0.7))), width);
			const at = base.add(stripSide(path, base).mul(side).mul(w).mul(0.5));
			clipOut = select(alive.greaterThan(0.5), cameraProjectionMatrix.mul(vec4(at, 1)), vec4(0, 0, 2, 1));
			life = varying(t);
			landedOut = varying(landed);
			along = varying(al);
		} else {
			const A = S.slotAge(r, r2, attribute('aIndex', 'float'));
			const rN = attribute('aRandN', 'vec4');
			const r2N = attribute('aRand2N', 'vec4');
			const B = S.slotAge(rN, r2N, attribute('aIndexN', 'float'));
			const { p, landed } = S.simPos(r, r2, attribute('aOrigin', 'vec3'), attribute('aVel', 'vec3'), A.age, A.li);
			const pN = S.simPos(rN, r2N, attribute('aOriginN', 'vec3'), attribute('aVelN', 'vec3'), B.age, B.li).p;
			const end = attribute('aEnd', 'float').lessThan(0.5);
			const older = select(end, A.age, B.age);
			const younger = select(end, B.age, A.age);
			const show = A.alive.greaterThan(0.5).and(B.alive.greaterThan(0.5)).and(older.greaterThanEqual(younger));
			const mv = modelViewMatrix.mul(vec4(p, 1));
			const path = modelViewMatrix.mul(vec4(select(end, pN.sub(p), p.sub(pN)), 0)).xyz;
			const t = clamp(A.age.div(A.li), 0, 1);
			const width = mix(U.uSizeStart, U.uSizeEnd, t);
			const at = mv.xyz.add(stripSide(path, mv.xyz).mul(side).mul(width).mul(0.5));
			clipOut = select(show, cameraProjectionMatrix.mul(vec4(at, 1)), vec4(0, 0, 2, 1));
			life = varying(t);
			landedOut = varying(landed);
			along = varying(t);
		}
		const vSide = varying(side);
		const vSeed = varying(r.x);
		const { fade, col } = lifeLook(U, life, vSeed);
		const tex = map.sample(vec2(vSide.mul(0.5).add(0.5), along));
		const stretch = U.uRender.lessThan(1.5);
		const band = float(1).sub(vSide.mul(vSide)).mul(select(U.uRender.lessThan(2.5), float(1).sub(along), float(1)));
		m.colorNode = select(stretch, col.mul(tex.rgb), col);
		place(m, clipOut, select(stretch, tex.a, band).mul(U.uOpacity).mul(fade).mul(splashFade(U, landedOut)));
		m.alphaTest = 0.01;
		return { m, map };
	}

	// ---- bursts: PointsMaterial over CPU buffers --------------------------------------------------------------

	/** @param {any} src the burst PointsMaterial @param {any} g its geometry @param {any} pairs */
	function burstMaterial(src, g, pairs) {
		const size = uniform(src.size).onRenderUpdate(() => src.size);
		const opacity = uniform(src.opacity).onRenderUpdate(() => src.opacity);
		const map = texture(src.map);
		const pos = perInstance(pairs, g.getAttribute('position'));
		const colour = perInstance(pairs, g.getAttribute('color'));
		const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(pos, 1)));
		// WebGL: gl_PointSize = size * pixelRatio * (cssHeight / 2) / depth, i.e. `size` across half the view height at depth 1
		const corner = positionGeometry.xy;
		const m = fxMaterial();
		const clipOut = vec4(clip.xy.add(corner.mul(size).mul(vec2(viewPx.y.div(viewPx.x), 1))), clip.zw);
		const c = varying(colour);
		// PointsMaterial samples (gl_PointCoord.x, 1 - gl_PointCoord.y): the quad's own uv
		const tex = map.sample(uv());
		m.colorNode = c.mul(tex.rgb);
		place(m, clipOut, tex.a.mul(opacity));
		// PointsMaterial does not discard; a hair above zero only drops the texels that add nothing
		m.alphaTest = 1e-4;
		m.fog = src.fog;
		return { m, map };
	}

	// ---- bubbles: waterShader.js bubbleVertex / bubbleFragment -------------------------------------------------

	/** @param {any} src the bubble ShaderMaterial */
	function bubbleMaterial(src) {
		const U = bridgeAll(src.uniforms);
		const seed = attribute('aSeed', 'vec4');
		const speed = U.uSpeed.mul(seed.y.mul(0.5).add(0.75));
		const life = U.uRiseH.div(max(speed, 0.001));
		const popDur = select(U.uPop.greaterThan(0.5), float(0.35), float(0));
		const period = max(life.add(popDur), U.uCount.div(max(U.uRate, 0.01)));
		const age = select(U.uBurstMode.greaterThan(0.5), U.uBurstAge.sub(seed.x.mul(0.5)), gmod(U.uTime.add(seed.x.mul(period)), period));
		const shown = step(float(0), age).mul(step(age, life.add(popDur)));
		const size = mix(U.uSizeMin, U.uSizeMax, seed.z.mul(seed.z));
		const base = U.uOrigin.add(U.uAxisX.mul(seed.w.mul(2).sub(1))).add(U.uAxisZ.mul(fract(seed.x.mul(7.13).add(seed.y.mul(3.7))).mul(2).sub(1)));
		const y = min(age, life).mul(speed);
		const sway = U.uWobble.mul(size).mul(4);
		const center = base.add(vec3(sin(age.mul(seed.y.mul(4).add(3)).add(seed.w.mul(6.28))).mul(sway), y, cos(age.mul(seed.z.mul(3).add(2.5)).add(seed.x.mul(6.28))).mul(sway)));
		const pop = select(age.greaterThan(life), age.sub(life).div(max(popDur, 0.001)), float(0));
		const corner = positionGeometry.xy;
		const ringR = size.mul(pop.mul(4).add(1.2));
		const ring = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(center.add(vec3(corner.x.mul(ringR), 0, corner.y.negate().mul(ringR))), 1)));
		const mvC = cameraViewMatrix.mul(vec4(center, 1));
		const bill = cameraProjectionMatrix.mul(vec4(mvC.xy.add(corner.mul(size)), mvC.zw));
		const m = fxMaterial();
		const clipOut = select(pop.greaterThan(0), ring, bill).mul(shown);
		const vPop = varying(pop);
		const vFade = varying(smoothstep(float(0), float(0.15), age));
		const q = uv().mul(2).sub(1);
		const d = length(q);
		const ringA = smoothstep(float(0.7), float(0.85), d).mul(float(1).sub(smoothstep(float(0.9), float(1), d))).mul(float(1).sub(vPop));
		const rim = smoothstep(float(0.55), float(0.98), d).mul(float(1).sub(smoothstep(float(0.98), float(1), d)));
		const glint = smoothstep(float(0.35), float(0), length(q.sub(vec2(-0.35, 0.4))));
		const edge = smoothstep(float(0.8), float(0.93), d).mul(float(1).sub(smoothstep(float(0.96), float(1), d)));
		const popping = vPop.greaterThan(0);
		const inside = d.lessThanEqual(1);
		m.colorNode = select(popping, U.uColor, mix(U.uColor, U.uColor.mul(0.35), edge.mul(float(1).sub(glint))));
		const a = select(popping, ringA, max(rim.mul(0.85).add(glint.mul(0.9)).add(0.08), edge.mul(0.75)));
		place(m, clipOut, select(inside, a.mul(U.uOpacity).mul(vFade), float(0)));
		m.alphaTest = 1e-4;
		m.fog = false;
		return { m, map: null };
	}

	// ---- deformers: vertexDeform.js specs as one positionNode ---------------------------------------------------

	/** @type {Record<string, (u: Record<string, any>, p: any) => any>} each GLSL block, the same maths */
	const DEFORM = {
		jiggle(u, p) {
			const rel = p.sub(u.jPivot);
			const w = pow(clamp(length(rel).div(max(u.jRadius, 1e-4)), 0, 1), u.jFalloff);
			return p.add(u.jOffset.mul(w)).add(rel.mul(vec3(u.jWobble.mul(-0.5), u.jWobble, u.jWobble.mul(-0.5))).mul(w));
		},
		bodywave(u, p) {
			const R = u.bwToRoot.mul(vec4(p, 1)).xyz;
			const U = clamp(u.bwRange.x.sub(dot(R, u.bwAxis)).div(max(u.bwRange.y, 1e-4)), 0, 1);
			const X = clamp(U.sub(u.bwShape.y).div(max(float(1).sub(u.bwShape.y), 1e-3)), 0, 1);
			const env = pow(X, u.bwShape.z);
			const off = u.bwDrive.x.mul(env).mul(sin(U.mul(u.bwShape.x).sub(u.bwShape.w.mul(u.bwDrive.z)).mul(TAU))).add(u.bwDrive.y.mul(U).mul(U));
			return p.add(u.bwFromRoot.mul(u.bwSide.mul(off)));
		},
		windsway(u, p) {
			const R = u.wsToRoot.mul(vec4(p, 1)).xyz;
			const U = clamp(dot(R, u.wsAxis).sub(u.wsRange.x).div(max(u.wsRange.y, 1e-4)), 0, 1);
			const P = dot(R, vec3(0.37, 0.21, 0.53));
			const D = u.wsDrive;
			const plant = D.x.mul(U).mul(U).mul(sin(D.z.mul(TAU).add(P)).mul(0.35).add(0.65)).add(D.x.mul(D.w).mul(0.15).mul(U).mul(sin(D.z.mul(TAU * 3.7).add(P.mul(7)))));
			const flag = D.x.mul(U).mul(sin(U.mul(u.wsRange.y).mul(D.y).sub(D.z).mul(TAU))).add(D.x.mul(D.w).mul(0.2).mul(U).mul(sin(D.z.mul(TAU * 2.3).add(P.mul(5)))));
			return p.add(u.wsFromRoot.mul(u.wsBend.mul(select(u.wsMode.lessThan(0.5), plant, flag))));
		},
		waterflow(u, p) {
			const R = u.wfToRoot.mul(vec4(p, 1)).xyz;
			const D = u.wfDrive;
			const off = D.x.mul(sin(R.x.mul(D.y).add(D.z.mul(TAU)))).mul(cos(R.z.mul(D.y).mul(0.8).add(D.z.mul(TAU * 1.3))));
			return p.add(u.wfFromRoot.mul(vec3(0, off, 0)));
		}
	};

	/**
	 * The GLSL composes each deformer by replacing `#include <begin_vertex>` with "itself + its block", so the LAST one
	 * added runs FIRST on the raw position; the node walks the list the same way.
	 * @param {{ kind: string, uniforms: Record<string, { value: any }> }[]} specs */
	function deformNode(specs) {
		/** @type {any} */
		let p = T.positionLocal;
		for (let i = specs.length - 1; i >= 0; i--) p = DEFORM[specs[i].kind](bridgeAll(specs[i].uniforms), p);
		const deformed = p;
		// The velocity target compares this position with `positionPrevious`, which is the UNDEFORMED geometry (moved
		// by last frame's instance / batch matrix): without this every deformed vertex reported its displacement as
		// motion, TRAA reprojected its history from the wrong place and the mesh's edges shimmered. The displacement
		// is added to the previous position too (Line2NodeMaterial assigns it the same way), so only real motion counts.
		return T.Fn(() => {
			const d = deformed.toVar();
			T.positionPrevious.assign(T.positionPrevious.add(d.sub(T.positionLocal)));
			return d;
		})();
	}

	// ---- the per-frame pass ------------------------------------------------------------------------------------

	/** @param {any} src @param {any} geometry @param {any} m @param {any} map @param {string} kind @param {any[]} [pairs] */
	function addTwin(src, geometry, m, map, kind, pairs = []) {
		const sm = src.material;
		m.name = TWIN;
		m.transparent = true;
		m.depthWrite = false;
		m.depthTest = false;
		// every twin faces the camera by construction (or is a strip whose face depends on its path)
		m.side = W.DoubleSide;
		const twin = new W.Mesh(geometry, m);
		twin.name = TWIN;
		twin.userData.localOnly = true;
		twin.userData.cinematicFx = true;
		twin.frustumCulled = false;
		twin.renderOrder = src.renderOrder;
		twin.raycast = () => {};
		twin.castShadow = twin.receiveShadow = false;
		twin.layers.set(FX_LAYER);
		src.add(twin);
		sm.visible = false;
		hidden.add(sm);
		const rec = { src, sm, twin, m, map, kind, geometry, pairs, seen: frame, ownGeometry: geometry !== src.geometry, additive: /** @type {boolean | null} */ (null) };
		sync(rec);
		twins.set(src, rec);
		return rec;
	}

	/** the twin follows what the runtime changes on its source material every frame @param {any} rec */
	function sync(rec) {
		const { sm, m, src } = rec;
		// the fx pass is composited as PREMULTIPLIED colour over the lit image: normal blending already leaves rgb = c * a,
		// alpha = coverage; additive must add colour and NO coverage (three's additive also adds alpha, which would
		// darken the image under every spark), so it is spelled out as custom blending
		const additive = sm.blending === W.AdditiveBlending;
		if (rec.additive !== additive) {
			rec.additive = additive;
			if (additive) {
				m.blending = W.CustomBlending;
				m.blendEquation = m.blendEquationAlpha = W.AddEquation;
				m.blendSrc = W.SrcAlphaFactor;
				m.blendDst = W.OneFactor;
				m.blendSrcAlpha = W.ZeroFactor;
				m.blendDstAlpha = W.OneFactor;
			} else m.blending = W.NormalBlending;
			m.needsUpdate = true;
		}
		// the source's depth test, done in the twin's fragment (the fx pass has no scene depth of its own)
		m.userData.occlude.value = sm.depthTest === false ? 0 : 1;
		if (rec.map) {
			const tex = sm.uniforms?.uMap?.value ?? sm.map;
			if (tex && rec.map.value !== tex) rec.map.value = tex;
		}
		for (const [a, b] of rec.pairs) if (b.version !== a.version) b.version = a.version;
		if (rec.ownGeometry) {
			const g = src.geometry;
			const n = g.getAttribute('position')?.count ?? 0;
			rec.geometry.instanceCount = Math.max(0, Math.min(n, g.drawRange.count));
		}
	}

	/** @param {any} rec */
	function dropTwin(rec) {
		rec.twin.removeFromParent();
		rec.m.dispose();
		if (rec.ownGeometry) rec.geometry.dispose();
		if (hidden.delete(rec.sm)) rec.sm.visible = true;
		twins.delete(rec.src);
	}

	/** an instanced quad geometry for `n` points */
	function quadGeometry() {
		const g = new W.InstancedBufferGeometry();
		g.index = quad.index;
		g.setAttribute('position', quad.getAttribute('position'));
		g.setAttribute('uv', quad.getAttribute('uv'));
		g.instanceCount = 0;
		return g;
	}

	/** @param {any} obj @param {any} sm @param {string} kind */
	function cover(obj, sm, kind) {
		if (kind === 'particles') {
			/** @type {any[]} */
			const list = [];
			const { m, map } = particlePointsMaterial(sm, obj.geometry, { pairs: list });
			return addTwin(obj, quadGeometry(), m, map, kind, list);
		}
		if (kind === 'particleStrip') {
			const { m, map } = particleStripMaterial(sm, !!obj.geometry.getAttribute('aEnd'));
			return addTwin(obj, obj.geometry, m, map, 'particles');
		}
		if (kind === 'burst') {
			/** @type {any[]} */
			const list = [];
			const { m, map } = burstMaterial(sm, obj.geometry, { pairs: list });
			return addTwin(obj, quadGeometry(), m, map, kind, list);
		}
		if (kind === 'bubbles') {
			const { m } = bubbleMaterial(sm);
			return addTwin(obj, obj.geometry, m, null, kind);
		}
		return null;
	}

	/** @param {any} mesh @param {any} m */
	function coverDeform(mesh, m) {
		const specs = deformSpecsOf(mesh);
		const sig = specs.map((s) => s.kind + s.slot).join('|');
		const rec = deforms.get(m);
		if (rec && rec.sig === sig) return;
		if (!specs.length || !specs.every((s) => DEFORM_COVERED.includes(s.kind))) {
			if (rec) undoDeform(m);
			return;
		}
		m.positionNode = deformNode(specs);
		m.needsUpdate = true;
		deforms.set(m, { mesh, sig });
	}

	/** @param {any} m */
	function undoDeform(m) {
		delete m.positionNode;
		m.needsUpdate = true;
		deforms.delete(m);
	}

	/** the deformer kinds on a mesh (the cover rule reads them) @param {any} mesh */
	const deformKinds = (mesh) => deformSpecsOf(mesh).map((s) => s.kind);

	function scan() {
		const t0 = performance.now();
		frame++;
		const b = glCanvas.width && glCanvas.height ? glCanvas : null;
		if (b) viewPx.value.set(b.width, b.height);
		/** @type {Set<any>} */
		const liveDeform = new Set();
		scene.traverse((/** @type {any} */ obj) => {
			if (obj.userData?.cinematicFx) return;
			const rec = twins.get(obj);
			if (rec) {
				// the runtime replaced the source material (a render-mode switch): cover it again
				if (obj.material !== rec.sm) dropTwin(rec);
				else {
					rec.seen = frame;
					sync(rec);
					return;
				}
			}
			const m = obj.material;
			if (!m || Array.isArray(m)) return;
			const kind = fxCoverKind(obj, m, deformKinds);
			if (!kind) return;
			if (kind === 'deform') {
				coverDeform(obj, m);
				if (deforms.has(m)) liveDeform.add(m);
				return;
			}
			try {
				cover(obj, m, kind);
			} catch (e) {
				// a cover that cannot be built leaves the stand-in (and the chip) to say so
				coverErrors.push(String(/** @type {any} */ (e)?.message ?? e).slice(0, 200));
				refused.add(m);
			}
		});
		for (const r of [...twins.values()]) if (r.seen !== frame) dropTwin(r);
		for (const m of [...deforms.keys()]) if (!liveDeform.has(m)) undoDeform(m);
		stats.particles = stats.bursts = stats.bubbles = 0;
		for (const r of twins.values()) {
			if (r.kind === 'particles') stats.particles++;
			else if (r.kind === 'burst') stats.bursts++;
			else if (r.kind === 'bubbles') stats.bubbles++;
		}
		stats.deform = deforms.size;
		stats.scanMs = performance.now() - t0;
	}

	/** @type {string[]} */
	const coverErrors = [];
	/** @type {WeakSet<any>} materials whose cover failed (they keep the stand-in) */
	const refused = new WeakSet();

	return {
		scan,
		layer: FX_LAYER,
		/** how many twins exist (the fx pass skips its render while there are none) */
		get count() {
			return twins.size;
		},
		/** the pipeline's scene-pass depth texture (each rebuild hands over its own) @param {any} tex */
		setSceneDepth(tex) {
			if (tex) sceneDepth.value = tex;
		},
		/**
		 * Does the view draw this (object, material) itself? The stand-in pass leaves it alone and the chip does not
		 * list it. @param {any} obj @param {any} m */
		covered(obj, m) {
			if (refused.has(m)) return false;
			const rec = twins.get(obj);
			if (rec && rec.sm === m) return true;
			if (deforms.has(m)) return true;
			return !!fxCoverKind(obj, m, deformKinds) && fxCoverKind(obj, m, deformKinds) !== 'deform';
		},
		undo() {
			for (const r of [...twins.values()]) dropTwin(r);
			for (const m of [...deforms.keys()]) undoDeform(m);
			for (const m of hidden) m.visible = true;
			hidden.clear();
			quad.dispose();
			placeholder.dispose();
		},
		stats() {
			return { ...stats, errors: coverErrors.slice(-10) };
		}
	};
}
