// 65 M6 — a 2D STABLE-FLUIDS solver on the GPU, for the smoke/ink layer (fluidLayer.js).
//
// Our own code, written from the published method (Stam, "Stable Fluids", SIGGRAPH 1999, and
// the GPU formulation in GPU Gems ch. 38); Pavel Dobryakov's WebGL-Fluid-Simulation (MIT) was
// the REFERENCE for which passes are worth running in a browser (vorticity confinement, a few
// Jacobi pressure iterations, a decaying pressure field) — no code was copied from it.
//
// One step, in order: curl -> vorticity confinement (puts the swirls back that the coarse
// grid numerically damps) -> divergence -> pressure (decayed, then Jacobi) -> subtract the
// pressure gradient (the field is now divergence-free) -> advect the velocity -> advect the
// dye. Splats add velocity + dye where the pointer or a controller moved. Every field is a
// half-float ping-pong pair; the velocity is in sim TEXELS per second, so the solver behaves
// the same at every resolution the device budget picks.
//
// LOCAL by nature: the sim is each viewer's own (their pointer stirs it), like the 36-sim
// fluid particles. Only the layer's SETTINGS are scene data (the look entry).

import * as THREE from 'three';

const VERTEX = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = position.xy * 0.5 + 0.5;
		gl_Position = vec4(position.xy, 0.0, 1.0);
	}
`;

// every pass reads its four neighbours one texel away
const NEIGHBOURS = /* glsl */ `
	varying vec2 vUv;
	uniform vec2 uTexel;
	vec2 L() { return vUv - vec2(uTexel.x, 0.0); }
	vec2 R() { return vUv + vec2(uTexel.x, 0.0); }
	vec2 B() { return vUv - vec2(0.0, uTexel.y); }
	vec2 T() { return vUv + vec2(0.0, uTexel.y); }
`;

const SPLAT = /* glsl */ `
	varying vec2 vUv;
	uniform sampler2D uTarget;
	uniform float uAspect;
	uniform vec2 uPoint;
	uniform vec3 uColor;
	uniform float uRadius;
	void main() {
		vec2 p = vUv - uPoint;
		p.x *= uAspect;
		vec3 base = texture2D(uTarget, vUv).xyz;
		gl_FragColor = vec4(base + exp(-dot(p, p) / uRadius) * uColor, 1.0);
	}
`;

const ADVECT = /* glsl */ `
	varying vec2 vUv;
	uniform sampler2D uVelocity;
	uniform sampler2D uSource;
	uniform vec2 uTexel;
	uniform float uDt;
	uniform float uDissipation;
	void main() {
		// trace back along the velocity (texels/s) and read what was there — unconditionally stable
		vec2 from = vUv - uDt * texture2D(uVelocity, vUv).xy * uTexel;
		vec4 value = texture2D(uSource, from);
		gl_FragColor = value / (1.0 + uDissipation * uDt);
	}
`;

const DIVERGENCE = /* glsl */ `
	${NEIGHBOURS}
	uniform sampler2D uVelocity;
	void main() {
		float l = texture2D(uVelocity, L()).x;
		float r = texture2D(uVelocity, R()).x;
		float b = texture2D(uVelocity, B()).y;
		float t = texture2D(uVelocity, T()).y;
		vec2 c = texture2D(uVelocity, vUv).xy;
		// solid walls: the mirrored velocity at the border, so nothing flows out of the frame
		if (L().x < 0.0) l = -c.x;
		if (R().x > 1.0) r = -c.x;
		if (B().y < 0.0) b = -c.y;
		if (T().y > 1.0) t = -c.y;
		gl_FragColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
	}
`;

const CURL = /* glsl */ `
	${NEIGHBOURS}
	uniform sampler2D uVelocity;
	void main() {
		float l = texture2D(uVelocity, L()).y;
		float r = texture2D(uVelocity, R()).y;
		float b = texture2D(uVelocity, B()).x;
		float t = texture2D(uVelocity, T()).x;
		gl_FragColor = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
	}
`;

const VORTICITY = /* glsl */ `
	${NEIGHBOURS}
	uniform sampler2D uVelocity;
	uniform sampler2D uCurl;
	uniform float uStrength;
	uniform float uDt;
	void main() {
		float l = texture2D(uCurl, L()).x;
		float r = texture2D(uCurl, R()).x;
		float b = texture2D(uCurl, B()).x;
		float t = texture2D(uCurl, T()).x;
		float c = texture2D(uCurl, vUv).x;
		vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
		force /= length(force) + 0.0001;
		force *= uStrength * c;
		force.y *= -1.0;
		vec2 v = texture2D(uVelocity, vUv).xy + force * uDt;
		gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
	}
`;

const SCALE = /* glsl */ `
	varying vec2 vUv;
	uniform sampler2D uSource;
	uniform float uScale;
	void main() { gl_FragColor = uScale * texture2D(uSource, vUv); }
`;

const PRESSURE = /* glsl */ `
	${NEIGHBOURS}
	uniform sampler2D uPressure;
	uniform sampler2D uDivergence;
	void main() {
		float l = texture2D(uPressure, L()).x;
		float r = texture2D(uPressure, R()).x;
		float b = texture2D(uPressure, B()).x;
		float t = texture2D(uPressure, T()).x;
		float d = texture2D(uDivergence, vUv).x;
		gl_FragColor = vec4((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0);
	}
`;

const GRADIENT = /* glsl */ `
	${NEIGHBOURS}
	uniform sampler2D uPressure;
	uniform sampler2D uVelocity;
	void main() {
		float l = texture2D(uPressure, L()).x;
		float r = texture2D(uPressure, R()).x;
		float b = texture2D(uPressure, B()).x;
		float t = texture2D(uPressure, T()).x;
		vec2 v = texture2D(uVelocity, vUv).xy - vec2(r - l, t - b);
		gl_FragColor = vec4(v, 0.0, 1.0);
	}
`;

/** @param {number} w @param {number} h @param {any} type */
function target(w, h, type) {
	const rt = new THREE.WebGLRenderTarget(w, h, {
		type,
		format: THREE.RGBAFormat,
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		wrapS: THREE.ClampToEdgeWrapping,
		wrapT: THREE.ClampToEdgeWrapping,
		depthBuffer: false,
		stencilBuffer: false
	});
	rt.texture.generateMipmaps = false;
	return rt;
}

/** a ping-pong pair: read from `read`, render into `write`, then swap */
class Pair {
	/** @param {number} w @param {number} h @param {any} type */
	constructor(w, h, type) {
		this.read = target(w, h, type);
		this.write = target(w, h, type);
		this.w = w;
		this.h = h;
	}
	swap() {
		const t = this.read;
		this.read = this.write;
		this.write = t;
	}
	dispose() {
		this.read.dispose();
		this.write.dispose();
	}
}

/**
 * @typedef {{simRes: number, dyeRes: number, iterations: number}} FluidQuality
 * @typedef {{curl: number, velocityFade: number, dyeFade: number, pressureDecay: number, radius: number}} FluidPhysics
 */

export class FluidSim {
	/** @param {FluidQuality} quality @param {number} aspect width / height of the layer */
	constructor(quality, aspect) {
		this.quality = { ...quality };
		this.aspect = aspect;
		this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		this.scene = new THREE.Scene();
		this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
		this.quad.frustumCulled = false;
		this.scene.add(this.quad);
		/** @type {Record<string, any>} */
		this.mats = {};
		const pass = (/** @type {string} */ name, /** @type {string} */ frag, /** @type {Record<string, any>} */ uniforms) => {
			this.mats[name] = new THREE.ShaderMaterial({
				vertexShader: VERTEX,
				fragmentShader: frag,
				uniforms,
				depthTest: false,
				depthWrite: false,
				toneMapped: false
			});
		};
		const tex = () => ({ value: null });
		const v2 = () => ({ value: new THREE.Vector2() });
		pass('splat', SPLAT, { uTarget: tex(), uAspect: { value: 1 }, uPoint: v2(), uColor: { value: new THREE.Vector3() }, uRadius: { value: 0.002 } });
		pass('advect', ADVECT, { uVelocity: tex(), uSource: tex(), uTexel: v2(), uDt: { value: 0 }, uDissipation: { value: 0 } });
		pass('divergence', DIVERGENCE, { uVelocity: tex(), uTexel: v2() });
		pass('curl', CURL, { uVelocity: tex(), uTexel: v2() });
		pass('vorticity', VORTICITY, { uVelocity: tex(), uCurl: tex(), uTexel: v2(), uStrength: { value: 0 }, uDt: { value: 0 } });
		pass('scale', SCALE, { uSource: tex(), uScale: { value: 1 } });
		pass('pressure', PRESSURE, { uPressure: tex(), uDivergence: tex(), uTexel: v2() });
		pass('gradient', GRADIENT, { uPressure: tex(), uVelocity: tex(), uTexel: v2() });
		this.type = THREE.HalfFloatType;
		this.steps = 0;
		this.splats = 0;
		// set by allocate(); declared here so the checker knows they always exist after it
		/** @type {Pair} */ this.velocity = /** @type {any} */ (null);
		/** @type {Pair} */ this.pressure = /** @type {any} */ (null);
		/** @type {Pair} */ this.dye = /** @type {any} */ (null);
		/** @type {any} */ this.divergence = null;
		/** @type {any} */ this.curl = null;
		this.simTexel = new THREE.Vector2();
		this.dyeTexel = new THREE.Vector2();
		this.cleared = false;
		this.allocate();
	}

	allocate() {
		const { simRes, dyeRes } = this.quality;
		const size = (/** @type {number} */ res) => {
			// the SHORT side is `res`: the long side follows the layer's aspect
			const a = Math.max(0.25, Math.min(4, this.aspect || 1));
			return a >= 1 ? [Math.round(res * a), res] : [res, Math.round(res / a)];
		};
		const [sw, sh] = size(simRes);
		const [dw, dh] = size(dyeRes);
		this.dispose(true);
		this.velocity = new Pair(sw, sh, this.type);
		this.pressure = new Pair(sw, sh, this.type);
		this.divergence = target(sw, sh, this.type);
		this.curl = target(sw, sh, this.type);
		this.dye = new Pair(dw, dh, this.type);
		this.simTexel = new THREE.Vector2(1 / sw, 1 / sh);
		this.dyeTexel = new THREE.Vector2(1 / dw, 1 / dh);
		this.cleared = false;
	}

	/** Change the budget tier or the aspect; reallocates only when something changed. @param {FluidQuality} q @param {number} aspect */
	configure(q, aspect) {
		const same =
			q.simRes === this.quality.simRes && q.dyeRes === this.quality.dyeRes && Math.abs((aspect || 1) - (this.aspect || 1)) < 0.02;
		this.quality = { ...q };
		if (same) return false;
		this.aspect = aspect;
		this.allocate();
		return true;
	}

	/** The dye texture the presenters draw. */
	get texture() {
		return this.dye.read.texture;
	}

	/** @param {any} renderer @param {any} material @param {any} into a target or null */
	blit(renderer, material, into) {
		this.quad.material = material;
		renderer.setRenderTarget(into);
		renderer.render(this.scene, this.camera);
	}

	/** zero every field once after allocation (a new target holds garbage on some drivers) @param {any} renderer */
	clearAll(renderer) {
		const color = new THREE.Color();
		renderer.getClearColor(color);
		const alpha = renderer.getClearAlpha();
		renderer.setClearColor(0x000000, 0);
		for (const rt of [this.velocity.read, this.velocity.write, this.pressure.read, this.pressure.write, this.dye.read, this.dye.write, this.divergence, this.curl]) {
			renderer.setRenderTarget(rt);
			renderer.clear(true, false, false);
		}
		renderer.setClearColor(color, alpha);
		this.cleared = true;
	}

	/**
	 * Push velocity + dye in at a point. Coordinates are the layer's 0..1 UV; `force` is in
	 * UV per second (the pointer's own speed), `color` linear RGB.
	 * @param {any} renderer @param {number} x @param {number} y @param {number} fx @param {number} fy
	 * @param {number[]} color @param {number} radius in UV (fraction of the short side)
	 */
	splat(renderer, x, y, fx, fy, color, radius) {
		const m = this.mats.splat;
		const u = m.uniforms;
		u.uAspect.value = this.aspect || 1;
		u.uPoint.value.set(x, y);
		u.uRadius.value = Math.max(radius * radius, 1e-6);
		// velocity: UV/s -> sim texels/s
		u.uTarget.value = this.velocity.read.texture;
		u.uColor.value.set(fx * this.velocity.w, fy * this.velocity.h, 0);
		this.blit(renderer, m, this.velocity.write);
		this.velocity.swap();
		u.uTarget.value = this.dye.read.texture;
		u.uColor.value.set(color[0], color[1], color[2]);
		this.blit(renderer, m, this.dye.write);
		this.dye.swap();
		this.splats++;
	}

	/** One solver step. @param {any} renderer @param {number} dt seconds @param {FluidPhysics} phys */
	step(renderer, dt, phys) {
		const M = this.mats;
		const st = this.simTexel;
		M.curl.uniforms.uVelocity.value = this.velocity.read.texture;
		M.curl.uniforms.uTexel.value.copy(st);
		this.blit(renderer, M.curl, this.curl);

		const vort = M.vorticity.uniforms;
		vort.uVelocity.value = this.velocity.read.texture;
		vort.uCurl.value = this.curl.texture;
		vort.uTexel.value.copy(st);
		vort.uStrength.value = phys.curl;
		vort.uDt.value = dt;
		this.blit(renderer, M.vorticity, this.velocity.write);
		this.velocity.swap();

		M.divergence.uniforms.uVelocity.value = this.velocity.read.texture;
		M.divergence.uniforms.uTexel.value.copy(st);
		this.blit(renderer, M.divergence, this.divergence);

		// the last step's pressure, decayed, is the starting guess: far fewer iterations needed
		M.scale.uniforms.uSource.value = this.pressure.read.texture;
		M.scale.uniforms.uScale.value = phys.pressureDecay;
		this.blit(renderer, M.scale, this.pressure.write);
		this.pressure.swap();
		const pr = M.pressure.uniforms;
		pr.uDivergence.value = this.divergence.texture;
		pr.uTexel.value.copy(st);
		for (let i = 0; i < this.quality.iterations; i++) {
			pr.uPressure.value = this.pressure.read.texture;
			this.blit(renderer, M.pressure, this.pressure.write);
			this.pressure.swap();
		}

		const gr = M.gradient.uniforms;
		gr.uPressure.value = this.pressure.read.texture;
		gr.uVelocity.value = this.velocity.read.texture;
		gr.uTexel.value.copy(st);
		this.blit(renderer, M.gradient, this.velocity.write);
		this.velocity.swap();

		const ad = M.advect.uniforms;
		ad.uDt.value = dt;
		ad.uVelocity.value = this.velocity.read.texture;
		ad.uSource.value = this.velocity.read.texture;
		ad.uTexel.value.copy(st);
		ad.uDissipation.value = phys.velocityFade;
		this.blit(renderer, M.advect, this.velocity.write);
		this.velocity.swap();
		// the dye moves on the SAME velocity field, measured in sim texels: on the finer dye grid
		// one sim texel is several dye texels, so the trace-back uses the sim texel size
		ad.uVelocity.value = this.velocity.read.texture;
		ad.uSource.value = this.dye.read.texture;
		ad.uDissipation.value = phys.dyeFade;
		this.blit(renderer, M.advect, this.dye.write);
		this.dye.swap();
		this.steps++;
	}

	/** @param {boolean} [keepPasses] */
	dispose(keepPasses = false) {
		this.velocity?.dispose();
		this.pressure?.dispose();
		this.dye?.dispose();
		this.divergence?.dispose();
		this.curl?.dispose();
		if (!keepPasses) {
			for (const m of Object.values(this.mats)) m.dispose();
			this.quad.geometry.dispose();
		}
	}
}
