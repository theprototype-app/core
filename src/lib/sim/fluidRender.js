// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// 36-sim U2b: how a fluid tank DRAWS. Two tiers, picked per frame (fluidRuntime):
//
//   SCREEN-SPACE FLUID (desktop): the particles are rendered as sphere impostors into a
//   view-depth target and, additively, into a thickness target; the depth is smoothed by a
//   separable bilateral blur (it keeps edges, so drops stay drops); a COMPOSITE box (the
//   tank's inside, back faces) shades the smoothed surface — normals from depth, fresnel,
//   a specular highlight, Beer-Lambert absorption by thickness in the water look's colour —
//   and writes gl_FragDepth, so a toy floating in it is properly half under. Five draw calls.
//   The passes run inside the composite's onBeforeRender with the camera that is rendering
//   (the three.js Reflector pattern), so any camera — the editor, a camera preview — works.
//
//   POINTS (Quest / low tiers / XR): one draw call of lit sphere impostors. WebXR renders
//   two eyes through one ArrayCamera, which the screen-space passes are not built for.
//
// Nothing here is scene content: the visual group is parented OUTSIDE objectsGroup and
// tagged `__fluidVisual`, so saves, picking and physics never see it.

const POINT_VS = /* glsl */ `
uniform float uSize;
uniform float uScale;
varying vec3 vView;
void main() {
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	vView = mv.xyz;
	gl_Position = projectionMatrix * mv;
	gl_PointSize = uSize * uScale / max(-mv.z, 0.01);
}`;

// lit impostor: the Quest tier
const POINT_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uClarity;
varying vec3 vView;
void main() {
	vec2 c = gl_PointCoord * 2.0 - 1.0;
	float r2 = dot(c, c);
	if (r2 > 1.0) discard;
	vec3 n = vec3(c.x, -c.y, sqrt(1.0 - r2));
	vec3 l = normalize(vec3(0.4, 0.8, 0.5));
	float diff = max(dot(n, l), 0.0);
	float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 32.0);
	float fres = pow(1.0 - n.z, 3.0);
	vec3 col = uColor * (0.35 + 0.65 * diff) + vec3(spec * 0.8) + fres * 0.25;
	gl_FragColor = vec4(col, mix(0.95, 0.6, uClarity));
}`;

// depth impostor: linear view depth (positive metres) in R
const DEPTH_FS = /* glsl */ `
uniform float uRadius;
uniform mat4 uProj;
varying vec3 vView;
void main() {
	vec2 c = gl_PointCoord * 2.0 - 1.0;
	float r2 = dot(c, c);
	if (r2 > 1.0) discard;
	float z = vView.z + sqrt(1.0 - r2) * uRadius;
	gl_FragColor = vec4(-z, 0.0, 0.0, 1.0);
	vec4 clip = uProj * vec4(vView.xy, z, 1.0);
	gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
}`;

// thickness: additive gaussian-ish splat
const THICK_FS = /* glsl */ `
uniform float uRadius;
void main() {
	vec2 c = gl_PointCoord * 2.0 - 1.0;
	float r2 = dot(c, c);
	if (r2 > 1.0) discard;
	gl_FragColor = vec4(sqrt(1.0 - r2) * uRadius * 2.0, 0.0, 0.0, 1.0);
}`;

const camPos = new THREE.Vector3();
const tankPos = new THREE.Vector3();

const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// separable bilateral blur over view depth (0 = empty)
const BLUR_FS = /* glsl */ `
uniform sampler2D tDepth;
uniform vec2 uDir;
uniform float uFalloff;
varying vec2 vUv;
void main() {
	float d0 = texture2D(tDepth, vUv).r;
	if (d0 <= 0.0) { gl_FragColor = vec4(0.0); return; }
	float sum = 0.0;
	float wsum = 0.0;
	for (int i = -6; i <= 6; i++) {
		float d = texture2D(tDepth, vUv + uDir * float(i)).r;
		if (d <= 0.0) continue;
		float ws = exp(-float(i * i) / 18.0);
		float dd = (d - d0) * uFalloff;
		float wr = exp(-dd * dd);
		sum += d * ws * wr;
		wsum += ws * wr;
	}
	gl_FragColor = vec4(sum / max(wsum, 1e-5), 0.0, 0.0, 1.0);
}`;

const COMPOSITE_VS = /* glsl */ `
void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const COMPOSITE_FS = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tThick;
uniform vec2 uResolution;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec3 uColor;
uniform vec3 uDeep;
uniform float uClarity;
uniform vec3 uSky;
vec3 viewPos(vec2 uv, float d) {
	vec4 ndc = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
	vec4 v = uProjInv * ndc;
	vec3 dir = v.xyz / v.w;
	return dir * (d / -dir.z);
}
void main() {
	vec2 uv = gl_FragCoord.xy / uResolution;
	float d = texture2D(tDepth, uv).r;
	if (d <= 0.0) discard;
	vec2 px = 1.0 / uResolution;
	vec3 p = viewPos(uv, d);
	// normal from the smoothed depth (pick the smaller difference per axis: edge-safe)
	float dxp = texture2D(tDepth, uv + vec2(px.x, 0.0)).r;
	float dxn = texture2D(tDepth, uv - vec2(px.x, 0.0)).r;
	float dyp = texture2D(tDepth, uv + vec2(0.0, px.y)).r;
	float dyn = texture2D(tDepth, uv - vec2(0.0, px.y)).r;
	// a missing side (the silhouette) takes the other; both missing = facing the camera
	vec3 ddx = vec3(0.0);
	vec3 ddy = vec3(0.0);
	bool hx = false;
	bool hy = false;
	if (dxp > 0.0) { ddx = viewPos(uv + vec2(px.x, 0.0), dxp) - p; hx = true; }
	if (dxn > 0.0) { vec3 o = p - viewPos(uv - vec2(px.x, 0.0), dxn); if (!hx || abs(o.z) < abs(ddx.z)) ddx = o; hx = true; }
	if (dyp > 0.0) { ddy = viewPos(uv + vec2(0.0, px.y), dyp) - p; hy = true; }
	if (dyn > 0.0) { vec3 o = p - viewPos(uv - vec2(0.0, px.y), dyn); if (!hy || abs(o.z) < abs(ddy.z)) ddy = o; hy = true; }
	vec3 cr = cross(ddx, ddy);
	vec3 n = (hx && hy && dot(cr, cr) > 1e-20) ? normalize(cr) : vec3(0.0, 0.0, 1.0);
	vec3 v = normalize(-p);
	float thick = texture2D(tThick, uv).r;
	// Beer-Lambert: thin = the shallow colour, thick = the deep colour, clarity = how far you see
	float absorb = 1.0 - exp(-thick * mix(9.0, 1.2, uClarity));
	vec3 body = mix(uColor, uDeep, absorb);
	float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
	vec3 l = normalize(vec3(0.3, 0.9, 0.4));
	vec3 h = normalize(l + v);
	float spec = pow(max(dot(n, h), 0.0), 120.0) * 1.5;
	vec3 col = mix(body, uSky, fres) + vec3(spec);
	float alpha = clamp(mix(0.55, 0.97, absorb) + fres * 0.3, 0.0, 1.0);
	gl_FragColor = vec4(col, alpha);
	vec4 clip = uProj * vec4(p, 1.0);
	gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
	#include <colorspace_fragment>
}`;

/**
 * One tank's visual. `update(positions, count, frame)` feeds particles; `setMode`
 * switches tier; `dispose()` frees every GPU resource.
 */
export class FluidVisual {
	/** @param {{capacity: number, radius: number, size: number[]}} o */
	constructor(o) {
		this.capacity = o.capacity;
		this.radius = o.radius;
		this.group = new THREE.Group();
		this.group.name = 'Fluid (visual)';
		this.group.userData.__fluidVisual = true;
		this.group.matrixAutoUpdate = false;
		this.geometry = new THREE.BufferGeometry();
		this.positions = new Float32Array(o.capacity * 3);
		const attr = new THREE.BufferAttribute(this.positions, 3);
		attr.setUsage(THREE.DynamicDrawUsage);
		this.geometry.setAttribute('position', attr);
		this.geometry.setDrawRange(0, 0);
		// a generous static bound (the tank): positions change every frame
		const half = new THREE.Vector3(o.size[0] / 2, o.size[1] / 2, o.size[2] / 2);
		this.geometry.boundingBox = new THREE.Box3(half.clone().negate(), half);
		this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), half.length());
		this.color = new THREE.Color('#2f8fd8');
		this.deep = new THREE.Color('#0b3a66');
		this.clarity = 0.55;
		/** @type {'ssf' | 'points'} */
		this.mode = 'points';
		this.size = o.size;
		this.buildPoints();
		this.buildSSF();
		this.setMode('points');
	}

	buildPoints() {
		this.pointsMaterial = new THREE.ShaderMaterial({
			vertexShader: POINT_VS,
			fragmentShader: POINT_FS,
			uniforms: {
				uSize: { value: this.radius * 2 },
				uScale: { value: 800 },
				uColor: { value: this.color },
				uClarity: { value: this.clarity }
			},
			transparent: true
		});
		this.points = new THREE.Points(this.geometry, this.pointsMaterial);
		this.points.userData.__fluidVisual = true;
		this.points.frustumCulled = false;
		this.group.add(this.points);
	}

	buildSSF() {
		const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
		this.rtDepth = new THREE.WebGLRenderTarget(4, 4, rtOpts);
		this.rtBlur = new THREE.WebGLRenderTarget(4, 4, { ...rtOpts, depthBuffer: false });
		this.rtThick = new THREE.WebGLRenderTarget(4, 4, { ...rtOpts, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
		const sizeU = { value: this.radius * 2 };
		const scaleU = { value: 800 };
		this.depthMaterial = new THREE.ShaderMaterial({
			vertexShader: POINT_VS,
			fragmentShader: DEPTH_FS,
			uniforms: { uSize: sizeU, uScale: scaleU, uRadius: { value: this.radius }, uProj: { value: new THREE.Matrix4() } }
		});
		this.thickMaterial = new THREE.ShaderMaterial({
			vertexShader: POINT_VS,
			fragmentShader: THICK_FS,
			uniforms: { uSize: sizeU, uScale: scaleU, uRadius: { value: this.radius } },
			blending: THREE.AdditiveBlending,
			depthTest: false,
			depthWrite: false,
			transparent: true
		});
		this.passScene = new THREE.Scene();
		this.passPoints = new THREE.Points(this.geometry, this.depthMaterial);
		this.passPoints.frustumCulled = false;
		this.passPoints.matrixAutoUpdate = false;
		this.passScene.add(this.passPoints);
		this.blurMaterial = new THREE.ShaderMaterial({
			vertexShader: QUAD_VS,
			fragmentShader: BLUR_FS,
			uniforms: { tDepth: { value: null }, uDir: { value: new THREE.Vector2() }, uFalloff: { value: 12 } },
			depthTest: false,
			depthWrite: false
		});
		this.quadScene = new THREE.Scene();
		this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMaterial);
		this.quad.frustumCulled = false;
		this.quadScene.add(this.quad);
		this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		this.compositeMaterial = new THREE.ShaderMaterial({
			vertexShader: COMPOSITE_VS,
			fragmentShader: COMPOSITE_FS,
			uniforms: {
				tDepth: { value: this.rtDepth.texture },
				tThick: { value: this.rtThick.texture },
				uResolution: { value: new THREE.Vector2(1, 1) },
				uProj: { value: new THREE.Matrix4() },
				uProjInv: { value: new THREE.Matrix4() },
				uColor: { value: this.color },
				uDeep: { value: this.deep },
				uClarity: { value: this.clarity },
				uSky: { value: new THREE.Color('#cfe6ff') }
			},
			transparent: true,
			depthWrite: false,
			depthTest: true,
			side: THREE.BackSide
		});
		// the composite covers the tank's inside (back faces: still drawn with the camera inside)
		const pad = this.radius * 2;
		this.composite = new THREE.Mesh(new THREE.BoxGeometry(this.size[0] + pad, this.size[1] + pad, this.size[2] + pad), this.compositeMaterial);
		this.composite.userData.__fluidVisual = true;
		this.composite.renderOrder = 10;
		this.composite.onBeforeRender = (/** @type {any} */ renderer, /** @type {any} */ _scene, /** @type {any} */ camera) => this.runPasses(renderer, camera);
		this.group.add(this.composite);
		this.passSize = new THREE.Vector2();
		this.passStats = { runs: 0 };
	}

	/** @param {'ssf' | 'points'} mode */
	setMode(mode) {
		this.mode = mode;
		this.points.visible = mode === 'points';
		this.composite.visible = mode === 'ssf';
	}

	/** @param {string} color @param {number} clarity */
	setLook(color, clarity) {
		this.color.set(color);
		// the deep colour: the same hue, darker and more saturated
		const hsl = { h: 0, s: 0, l: 0 };
		this.color.getHSL(hsl);
		this.deep.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), hsl.l * 0.35);
		this.clarity = clarity;
		this.pointsMaterial.uniforms.uClarity.value = clarity;
		this.compositeMaterial.uniforms.uClarity.value = clarity;
	}

	/**
	 * New particle positions (tank frame, metres) + the tank frame's world matrix.
	 * @param {Float32Array} positions @param {number} count @param {THREE.Matrix4} frameWorld @param {any} parent
	 */
	update(positions, count, frameWorld, parent) {
		this.positions.set(positions.subarray(0, count * 3));
		const attr = this.geometry.getAttribute('position');
		attr.needsUpdate = true;
		attr.clearUpdateRanges?.();
		attr.addUpdateRange?.(0, count * 3);
		this.geometry.setDrawRange(0, count);
		// the visual lives OUTSIDE objectsGroup: express the tank frame in the parent's space
		parent.updateWorldMatrix(true, false);
		this.group.matrix.copy(parent.matrixWorld).invert().multiply(frameWorld);
		this.group.matrixWorldNeedsUpdate = true;
	}

	/** the camera-dependent point scale: pixels per metre at 1 m @param {any} camera @param {number} heightPx */
	pointScale(camera, heightPx) {
		const fov = camera.isPerspectiveCamera ? camera.fov : 50;
		return heightPx / (2 * Math.tan((fov * Math.PI) / 360));
	}

	/** the SSF passes, run with the camera about to draw the composite @param {any} renderer @param {any} camera */
	runPasses(renderer, camera) {
		if (this.mode !== 'ssf') return;
		const target = renderer.getRenderTarget();
		const w = target ? target.width : renderer.getDrawingBufferSize(this.passSize).x;
		const h = target ? target.height : renderer.getDrawingBufferSize(this.passSize).y;
		if (this.rtDepth.width !== w || this.rtDepth.height !== h) {
			this.rtDepth.setSize(w, h);
			this.rtBlur.setSize(w, h);
			this.rtThick.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
		}
		const scale = this.pointScale(camera, h);
		this.depthMaterial.uniforms.uScale.value = scale;
		this.depthMaterial.uniforms.uProj.value.copy(camera.projectionMatrix);
		this.passPoints.matrixWorld.copy(this.group.matrixWorld);
		const xrWas = renderer.xr.enabled;
		const autoClearWas = renderer.autoClear;
		const clearColor = renderer.getClearColor(new THREE.Color());
		const clearAlpha = renderer.getClearAlpha();
		const shadowWas = renderer.shadowMap.autoUpdate;
		renderer.xr.enabled = false;
		renderer.shadowMap.autoUpdate = false;
		renderer.autoClear = true;
		renderer.setClearColor(0x000000, 0);
		// 1. depth
		this.passPoints.material = this.depthMaterial;
		renderer.setRenderTarget(this.rtDepth);
		renderer.render(this.passScene, camera);
		// 2. thickness (half res)
		this.passPoints.material = this.thickMaterial;
		this.thickMaterial.uniforms.uScale.value = scale * 0.5;
		renderer.setRenderTarget(this.rtThick);
		renderer.render(this.passScene, camera);
		this.thickMaterial.uniforms.uScale.value = scale;
		// 3. bilateral blur H then V (back into rtDepth), twice. The tap spacing follows the
		// particle's size ON SCREEN — a fixed pixel kernel smooths a far tank into a blob and
		// leaves a near one as a bag of marbles.
		camPos.setFromMatrixPosition(camera.matrixWorld);
		tankPos.setFromMatrixPosition(this.group.matrixWorld);
		const rPx = (this.radius * scale) / Math.max(camPos.distanceTo(tankPos), 0.1);
		const stepPx = Math.min(8, Math.max(1, rPx / 3));
		this.blurMaterial.uniforms.uFalloff.value = 1 / Math.max(this.radius * 2, 1e-3);
		for (let pass = 0; pass < 2; pass++) {
			this.blurMaterial.uniforms.tDepth.value = this.rtDepth.texture;
			this.blurMaterial.uniforms.uDir.value.set(stepPx / w, 0);
			renderer.setRenderTarget(this.rtBlur);
			renderer.render(this.quadScene, this.quadCamera);
			this.blurMaterial.uniforms.tDepth.value = this.rtBlur.texture;
			this.blurMaterial.uniforms.uDir.value.set(0, stepPx / h);
			renderer.setRenderTarget(this.rtDepth);
			renderer.render(this.quadScene, this.quadCamera);
		}
		// restore
		renderer.setRenderTarget(target);
		renderer.setClearColor(clearColor, clearAlpha);
		renderer.autoClear = autoClearWas;
		renderer.shadowMap.autoUpdate = shadowWas;
		renderer.xr.enabled = xrWas;
		const u = this.compositeMaterial.uniforms;
		u.uResolution.value.set(w, h);
		u.uProj.value.copy(camera.projectionMatrix);
		u.uProjInv.value.copy(camera.projectionMatrixInverse);
		this.passStats.runs++;
	}

	/** per-frame camera uniforms for the points tier @param {any} camera @param {number} heightPx */
	prepare(camera, heightPx) {
		this.pointsMaterial.uniforms.uScale.value = this.pointScale(camera, heightPx);
	}

	dispose() {
		this.group.removeFromParent();
		this.geometry.dispose();
		this.pointsMaterial.dispose();
		this.depthMaterial.dispose();
		this.thickMaterial.dispose();
		this.blurMaterial.dispose();
		this.compositeMaterial.dispose();
		this.composite.geometry.dispose();
		this.quad.geometry.dispose();
		this.rtDepth.dispose();
		this.rtBlur.dispose();
		this.rtThick.dispose();
	}
}
