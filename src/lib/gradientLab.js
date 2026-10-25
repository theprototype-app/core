// 65 gradient — THE GRADIENT LAB RUNTIME (a lazy chunk: backgroundLayer.js imports it the first time
// a compiled background graph wires a `gradientLab` node, so nothing here is in the boot graph).
//
// It renders the ShaderGradient look offscreen: a plane ribbon, a sphere or a water plane, displaced
// along its normals by classic Perlin noise, coloured by three colours, seen from its own orbit
// camera. The background node samples the picture (and lays the dot-screen grain over it at full
// resolution). The picture is a pure function of the node's params and the SHARED clock, so every
// peer draws the same frame at the same moment and nothing new is sent.
//
// PORTED FROM ShaderGradient (https://github.com/ruucm/shadergradient, packages/shadergradient/src/
// shaders/defaults/*, MIT © ruucm, stone-skipper), which carries the classic and periodic 3D noise
// of glsl-noise (https://github.com/hughsk/glsl-noise, MIT © 2011 Stefan Gustavson). The notices are
// in src/lib/LICENSE-shadergradient.txt and on the app's third-party licences page.
// What changed in the port: plain three.js ShaderMaterial instead of a MeshPhysicalMaterial patched
// through onBeforeCompile; the "3d" light is the closed form of what that material computes from an
// ambient light alone (colour x brightness x (1 - metalness 0.2)), and "env" is a small procedural
// studio instead of downloaded HDRs; the clock is the app's shared one, wrapped (gradientClock).

import * as THREE from 'three';
import { normalizeGradient, displayRgb, gradientCamera, gradientClock, gradientBudget, targetSize } from './gradientLabCore.js';

// ---- the GLSL --------------------------------------------------------------------------

// classic + periodic 3D Perlin noise (glsl-noise, MIT © 2011 Stefan Gustavson), as ShaderGradient uses it
const NOISE = /* glsl */ `
vec3 tpgMod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 tpgMod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 tpgPermute(vec4 x) { return tpgMod289(((x * 34.0) + 1.0) * x); }
vec4 tpgTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
vec3 tpgFade(vec3 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float tpgNoise(vec3 Pi0, vec3 Pi1, vec3 Pf0) {
  vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;
  vec4 ixy = tpgPermute(tpgPermute(ix) + iy);
  vec4 ixy0 = tpgPermute(ixy + iz0);
  vec4 ixy1 = tpgPermute(ixy + iz1);
  vec4 gx0 = ixy0 * (1.0 / 7.0);
  vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
  gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
  vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  vec4 gx1 = ixy1 * (1.0 / 7.0);
  vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
  gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
  vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);
  vec3 g000 = vec3(gx0.x, gy0.x, gz0.x);
  vec3 g100 = vec3(gx0.y, gy0.y, gz0.y);
  vec3 g010 = vec3(gx0.z, gy0.z, gz0.z);
  vec3 g110 = vec3(gx0.w, gy0.w, gz0.w);
  vec3 g001 = vec3(gx1.x, gy1.x, gz1.x);
  vec3 g101 = vec3(gx1.y, gy1.y, gz1.y);
  vec3 g011 = vec3(gx1.z, gy1.z, gz1.z);
  vec3 g111 = vec3(gx1.w, gy1.w, gz1.w);
  vec4 norm0 = tpgTaylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x; g010 *= norm0.y; g100 *= norm0.z; g110 *= norm0.w;
  vec4 norm1 = tpgTaylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x; g011 *= norm1.y; g101 *= norm1.z; g111 *= norm1.w;
  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);
  vec3 fxyz = tpgFade(Pf0);
  vec4 nz = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fxyz.z);
  vec2 nyz = mix(nz.xy, nz.zw, fxyz.y);
  return 2.2 * mix(nyz.x, nyz.y, fxyz.x);
}
// classic: repeats every 289 on each axis (gradientClock wraps on that)
float tpgCnoise(vec3 P) {
  vec3 Pi0 = floor(P);
  return tpgNoise(tpgMod289(Pi0), tpgMod289(Pi0 + vec3(1.0)), fract(P));
}
// periodic, period rep (the sphere's)
float tpgPnoise(vec3 P, vec3 rep) {
  vec3 Pi0 = mod(floor(P), rep);
  vec3 Pi1 = mod(Pi0 + vec3(1.0), rep);
  return tpgNoise(tpgMod289(Pi0), tpgMod289(Pi1), fract(P));
}
`;

const VERTEX = /* glsl */ `
uniform float uT;
uniform float uShape;
uniform float uDensity;
uniform float uStrength;
uniform float uFrequency;
uniform float uAmplitude;
varying vec3 vPos;
varying vec3 vNormalV;
varying vec3 vViewPos;
${NOISE}
vec3 tpgRotateY(vec3 v, float a) {
  float s = sin(a), c = cos(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c) * v;
}
void main() {
  vec3 pos;
  if (uShape > 0.5 && uShape < 1.5) {
    // the sphere: periodic noise on the normal, then a spiral twist about Y
    float distortion = tpgPnoise((normal + uT) * uDensity, vec3(10.0)) * uStrength;
    float angle = sin(uv.y * uFrequency + uT) * uAmplitude;
    pos = tpgRotateY(position + normal * distortion, angle);
  } else {
    // the ribbon and the water plane: classic noise on the position, along the normal
    float distortion = 0.75 * tpgCnoise(0.43 * position * uDensity + uT);
    pos = position + normal * distortion * uStrength;
  }
  vPos = pos;
  // as upstream, lighting reads the UNDEFORMED normal and view position
  vNormalV = normalize(normalMatrix * normal);
  vViewPos = -(modelViewMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uShape;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform float uBrightness;
uniform float uLight;
uniform float uEnv;
uniform float uRoughness;
varying vec3 vPos;
varying vec3 vNormalV;
varying vec3 vViewPos;
// the procedural studio (our stand-in for the HDRs): a sky over a floor with two soft boxes,
// tinted per preset. Radiance in DISPLAY units, like everything in this shader.
vec3 tpgStudio(vec3 d, float blur) {
  vec3 sky = uEnv < 0.5 ? vec3(0.78, 0.82, 0.88) : uEnv < 1.5 ? vec3(1.0, 0.72, 0.58) : vec3(0.98, 0.9, 0.78);
  vec3 floorC = uEnv < 0.5 ? vec3(0.22, 0.22, 0.25) : uEnv < 1.5 ? vec3(0.32, 0.2, 0.24) : vec3(0.4, 0.33, 0.27);
  vec3 c = mix(floorC, sky, smoothstep(-0.35 - blur, 0.35 + blur, d.y));
  float w = 0.08 + blur;
  float box1 = smoothstep(1.0 - w, 1.0, dot(d, normalize(vec3(0.6, 0.7, 0.4))));
  float box2 = smoothstep(1.0 - w * 1.5, 1.0, dot(d, normalize(vec3(-0.7, 0.3, 0.6))));
  return c + (box1 * 1.4 + box2 * 0.7) * (1.0 - blur);
}
void main() {
  vec3 base;
  if (uShape > 0.5 && uShape < 1.5) {
    float toCentre = distance(vPos, vec3(0.0));
    base = mix(uC3, mix(uC2, uC1, smoothstep(-1.0, 1.0, vPos.y)), toCentre);
  } else {
    base = mix(mix(uC1, uC2, smoothstep(-3.0, 3.0, vPos.x)), uC3, vPos.z);
  }
  // metalness 0.2, as upstream's material
  vec3 diffuse = base * 0.8;
  vec3 colour;
  if (uLight < 0.5) {
    colour = diffuse * uBrightness;
  } else {
    vec3 n = normalize(vNormalV) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 v = normalize(vViewPos);
    vec3 r = reflect(-v, n);
    float rough = clamp(uRoughness, 0.04, 1.0);
    vec3 irradiance = tpgStudio(n, 0.9);
    vec3 radiance = tpgStudio(r, rough * 0.9);
    vec3 f0 = mix(vec3(0.04), base, 0.2);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    vec3 fresnel = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - ndv, 5.0);
    colour = (diffuse * irradiance + radiance * fresnel * (1.0 - rough * 0.6)) * uBrightness;
  }
  gl_FragColor = vec4(clamp(colour, 0.0, 1.0), 1.0);
}
`;

// ---- the state -------------------------------------------------------------------------

const SHAPE_INDEX = { plane: 0, sphere: 1, waterPlane: 2 };
const ENV_INDEX = { city: 0, dawn: 1, lobby: 2 };

const uniforms = {
	uT: { value: 0 },
	uShape: { value: 0 },
	uDensity: { value: 1 },
	uStrength: { value: 1 },
	uFrequency: { value: 0 },
	uAmplitude: { value: 0 },
	uC1: { value: new THREE.Vector3(1, 1, 1) },
	uC2: { value: new THREE.Vector3(1, 1, 1) },
	uC3: { value: new THREE.Vector3(1, 1, 1) },
	uBrightness: { value: 1 },
	uLight: { value: 0 },
	uEnv: { value: 0 },
	uRoughness: { value: 0.9 }
};

/** @type {THREE.Scene|null} */
let scene = null;
/** @type {THREE.PerspectiveCamera|null} */
let camera = null;
/** @type {THREE.Mesh|null} */
let mesh = null;
/** @type {THREE.ShaderMaterial|null} */
let material = null;
/** @type {THREE.WebGLRenderTarget|null} */
let target = null;
let geometryKey = '';
let frame = 0;
let lastSignature = '';
const stats = { renders: 0, skipped: 0, tris: 0, mode: 'none', size: [0, 0], shape: '', clock: 0, geometry: '' };
const clearColour = new THREE.Color();

function ensureScene() {
	if (scene) return;
	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
	material = new THREE.ShaderMaterial({
		name: 'tp-gradient-lab',
		vertexShader: VERTEX,
		fragmentShader: FRAGMENT,
		uniforms,
		side: THREE.DoubleSide,
		toneMapped: false,
		fog: false
	});
	mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
	mesh.frustumCulled = false;
	scene.add(mesh);
}

/**
 * The shape's geometry at this budget, as upstream builds it: the ribbon is a 10 m plane with
 * ONE column and `segments` rows (so every fold runs straight across), the water plane the same
 * plane as a full grid, the sphere an icosahedron.
 * @param {string} shape @param {{segments: number, sphereDetail: number}} budget
 */
function ensureGeometry(shape, budget) {
	const key = shape + ':' + (shape === 'sphere' ? budget.sphereDetail : budget.segments);
	if (key === geometryKey || !mesh) return;
	mesh.geometry.dispose();
	mesh.geometry =
		shape === 'sphere'
			? new THREE.IcosahedronGeometry(1, budget.sphereDetail)
			: shape === 'waterPlane'
				? new THREE.PlaneGeometry(10, 10, budget.segments, budget.segments)
				: new THREE.PlaneGeometry(10, 10, 1, budget.segments);
	geometryKey = key;
	const g = mesh.geometry;
	stats.tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
	stats.geometry = key;
}

/** @param {number} w @param {number} h @param {boolean} msaa */
function ensureTarget(w, h, msaa) {
	const samples = msaa ? 4 : 0;
	if (target && target.width === w && target.height === h && target.samples === samples) return;
	target?.dispose();
	// display values in 8 bits (perceptually spaced, so smooth gradients do not band), clamped
	// edges so the dot screen's neighbour reads never wrap to the far side
	target = new THREE.WebGLRenderTarget(w, h, {
		type: THREE.UnsignedByteType,
		depthBuffer: true,
		samples,
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		wrapS: THREE.ClampToEdgeWrapping,
		wrapT: THREE.ClampToEdgeWrapping
	});
	target.texture.name = 'tp-gradient-lab';
	lastSignature = '';
}

/** @param {Record<string, any>} p normalized @param {number} t */
function writeUniforms(p, t) {
	uniforms.uT.value = t;
	uniforms.uShape.value = SHAPE_INDEX[/** @type {'plane'} */ (p.shape)] ?? 0;
	uniforms.uDensity.value = p.density;
	uniforms.uStrength.value = p.strength;
	uniforms.uFrequency.value = p.frequency;
	uniforms.uAmplitude.value = p.amplitude;
	uniforms.uC1.value.fromArray(displayRgb(p.color1));
	uniforms.uC2.value.fromArray(displayRgb(p.color2));
	uniforms.uC3.value.fromArray(displayRgb(p.color3));
	uniforms.uBrightness.value = p.brightness;
	uniforms.uLight.value = p.lighting === 'environment' ? 1 : 0;
	uniforms.uEnv.value = ENV_INDEX[/** @type {'city'} */ (p.environment)] ?? 0;
	uniforms.uRoughness.value = 1 - p.reflection;
}

/** @param {Record<string, any>} p normalized @param {number} aspect */
function placeCamera(p, aspect) {
	if (!camera || !mesh) return;
	const c = gradientCamera(p);
	camera.position.fromArray(c.position);
	camera.up.set(0, 1, 0);
	camera.lookAt(0, 0, 0);
	camera.fov = c.fov;
	camera.zoom = c.zoom;
	camera.aspect = aspect;
	camera.updateProjectionMatrix();
	mesh.position.set(p.posX, p.posY, p.posZ);
	mesh.rotation.set(p.rotX * (Math.PI / 180), p.rotY * (Math.PI / 180), p.rotZ * (Math.PI / 180));
	mesh.updateMatrixWorld(true);
}

/**
 * ONE call per frame from the background layer's tick, while a compiled graph wires the node.
 * Draws (or keeps) the picture and returns what the background material needs.
 * @param {any} renderer
 * @param {{data: any, seconds: number, width: number, height: number, sphere: boolean, tier: 'high'|'low', xr: boolean, reducedMotion: boolean, dpr: number}} o
 *   width/height = the LAYER's pixels (the screen's, a plane's, or the XR sphere's notional ones)
 * @returns {{texture: any, px: [number, number], dot: number}}
 */
export function renderGradientLab(renderer, o) {
	ensureScene();
	const p = normalizeGradient(o.data);
	const budget = gradientBudget({ tier: o.tier, xr: o.xr, reducedMotion: o.reducedMotion });
	const [tw, th] = targetSize(o.width, o.height, budget, o.sphere);
	ensureGeometry(p.shape, budget);
	ensureTarget(tw, th, budget.mode === 'high');
	const t = budget.animate ? gradientClock(o.seconds, p.speed, p.shape) : 0;
	stats.mode = budget.mode;
	stats.size = [tw, th];
	stats.shape = p.shape;
	stats.clock = t;
	const px = /** @type {[number, number]} */ ([Math.max(1, o.width), Math.max(1, o.height)]);
	const out = { texture: /** @type {any} */ (target).texture, px, dot: 2 * Math.max(1, o.dpr || 1) };
	// still: redraw only when what it shows changes; animating: every `every` frames
	const signature = budget.animate ? '' : JSON.stringify([p, tw, th, budget.mode]);
	frame++;
	if (budget.animate ? frame % budget.every !== 0 && stats.renders > 0 && lastSignature === 'anim' : signature === lastSignature) {
		stats.skipped++;
		return out;
	}
	lastSignature = budget.animate ? 'anim' : signature;
	writeUniforms(p, t);
	placeCamera(p, tw / th);
	if (!renderer || !scene || !camera) return out;
	const prevTarget = renderer.getRenderTarget();
	const xrOn = renderer.xr?.enabled ?? false;
	const prevAlpha = renderer.getClearAlpha();
	renderer.getClearColor(clearColour);
	const prevAutoClear = renderer.autoClear;
	try {
		// an offscreen pass inside an XR frame must not be drawn per eye (the fluidLayer rule)
		if (renderer.xr) renderer.xr.enabled = false;
		renderer.autoClear = true;
		renderer.setRenderTarget(target);
		renderer.setClearColor(0x000000, 1);
		renderer.clear(true, true, false);
		renderer.render(scene, camera);
		stats.renders++;
	} finally {
		renderer.setRenderTarget(prevTarget);
		renderer.setClearColor(clearColour, prevAlpha);
		renderer.autoClear = prevAutoClear;
		if (renderer.xr) renderer.xr.enabled = xrOn;
	}
	return out;
}

/** Free the GPU side (the background no longer wires the node). Idempotent. */
export function releaseGradientLab() {
	target?.dispose();
	target = null;
	mesh?.geometry.dispose();
	if (mesh) mesh.geometry = new THREE.BufferGeometry();
	geometryKey = '';
	lastSignature = '';
	stats.mode = 'none';
	stats.size = [0, 0];
}

/** test/debug view (backgroundLayerDebug().gradient) */
export function gradientLabDebug() {
	return { ...stats, size: [...stats.size], live: !!target };
}

/**
 * test seam: read the picture back — a mean colour and a cheap hash over a sampled grid, so two
 * peers (or two runs) can be compared without shipping pixels. @param {any} renderer
 */
export function readGradientForTest(renderer) {
	if (!target || !renderer) return null;
	const w = target.width;
	const h = target.height;
	const buf = new Uint8Array(w * h * 4);
	renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
	let r = 0, g = 0, b = 0, hash = 2166136261;
	const n = w * h;
	for (let i = 0; i < n; i++) {
		r += buf[i * 4];
		g += buf[i * 4 + 1];
		b += buf[i * 4 + 2];
	}
	// FNV over a 32 x 32 grid of samples, quantised to 4 bits so a 1-LSB driver difference does not flip it
	for (let y = 0; y < 32; y++)
		for (let x = 0; x < 32; x++) {
			const i = (Math.floor((y + 0.5) * h / 32) * w + Math.floor((x + 0.5) * w / 32)) * 4;
			for (let k = 0; k < 3; k++) hash = Math.imul(hash ^ (buf[i + k] >> 4), 16777619) >>> 0;
		}
	return { width: w, height: h, mean: [r / n, g / n, b / n], hash };
}

/** test seam: the two programs, for the no-browser GLSL check (tests/e2e/background-presets) */
export const GRADIENT_PROGRAMS = { vertex: VERTEX, fragment: FRAGMENT };
