// 36-water — the GLSL. ONE surface program serves the water SURFACE and the tank BODY
// (walls + floor) in both tiers; the tier is a define, so a scene compiles at most two
// variants per look:
//   WATER_SS      desktop: screen-space refraction + depth absorption + shoreline foam +
//                 caustics, all read from the pre-pass (scene colour + depth, water hidden)
//   WATER_PLANAR  desktop: a mirrored-camera reflection texture instead of the sky model
//   (neither)     Quest tier: vertex waves + scrolling detail normals, a blurred-sky fake
//                 refraction, analytic thickness through the volume, alpha blending
// Waves are evaluated in WORLD metres on world x/z with the shared clock — the same
// spectrum `waves.js` expands for the CPU query, so a buoyant body bobs with this surface.

export const MAX_SHADER_WAVES = 8;
export const MAX_SHADER_RIPPLES = 16;

const WAVE_PARS = /* glsl */ `
uniform float uTime;
uniform vec4 uWaveA[${MAX_SHADER_WAVES}]; // dx, dz, k, phase (w·t mod 2π, computed in double precision on the CPU)
uniform vec2 uWaveB[${MAX_SHADER_WAVES}]; // a, q
uniform int uWaveCount;
uniform vec4 uRipple[RIPPLES]; // x, z, radius, strength
uniform float uRippleAge[RIPPLES]; // seconds since the disturbance
uniform int uRippleCount;
uniform float uFrozen;

// Gerstner displacement + its analytic normal at the rest point p (world x/z)
vec3 gerstner(vec2 p, inout vec3 nrm, inout float crest) {
	vec3 o = vec3(0.0);
	float nx = 0.0; float ny = 0.0; float nz = 0.0; float ampSum = 0.0;
	for (int i = 0; i < ${MAX_SHADER_WAVES}; i++) {
		if (i >= uWaveCount) break;
		vec4 A = uWaveA[i];
		vec2 B = uWaveB[i];
		float f = A.z * dot(A.xy, p) - A.w;
		float c = cos(f); float s = sin(f);
		o.x += B.y * B.x * A.x * c;
		o.z += B.y * B.x * A.y * c;
		o.y += B.x * s;
		float wa = A.z * B.x;
		nx -= A.x * wa * c;
		nz -= A.y * wa * c;
		ny -= B.y * wa * s;
		ampSum += B.x;
	}
	nrm = normalize(vec3(nx, 1.0 + ny, nz));
	crest = ampSum > 0.0 ? clamp(o.y / ampSum, -1.0, 1.0) : 0.0;
	return o;
}

float rippleHeight(vec2 p) {
	float h = 0.0;
	for (int i = 0; i < RIPPLES; i++) {
		if (i >= uRippleCount) break;
		vec4 R = uRipple[i];
		float age = uRippleAge[i];
		if (age < 0.0 || age > 3.0) continue;
		float r = distance(p, R.xy);
		float wl = R.z * 0.8 + 0.06;
		float front = 0.9 * age;
		float d = (r - front) / wl;
		float env = exp(-d * d) * exp(-age * 1.4);
		h += R.w * R.z * 0.12 * sin(d * 6.2831853) * env;
	}
	return h;
}
`;

export const surfaceVertex = /* glsl */ `
#define RIPPLES ${MAX_SHADER_RIPPLES}
${WAVE_PARS}
#include <common>
#include <fog_pars_vertex>
attribute float aEdge;   // surface: 1 interior → 0 at the rim (no sideways motion there)
attribute float aTop;    // body: 1 on the top edge (rides the waves vertically)
uniform float uBody;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;
varying float vViewZ;
#ifdef WATER_PLANAR
uniform mat4 uReflMatrix;
varying vec4 vReflUv;
#endif

void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vec3 nrm = normalize(mat3(modelMatrix) * normal);
	float crest = 0.0;
	if (uFrozen < 0.5) {
		vec3 gn = vec3(0.0, 1.0, 0.0);
		vec3 o = gerstner(world.xz, gn, crest);
		if (uBody < 0.5) {
			float e = aEdge;
			world.xyz += vec3(o.x * e, o.y, o.z * e);
			// ripples (W2): numeric gradient of the ring sum
			float eps = 0.04;
			float h0 = rippleHeight(world.xz);
			float hx = rippleHeight(world.xz + vec2(eps, 0.0));
			float hz = rippleHeight(world.xz + vec2(0.0, eps));
			world.y += h0;
			nrm = normalize(gn + vec3(-(hx - h0) / eps, 0.0, -(hz - h0) / eps));
		} else if (aTop > 0.5) {
			world.y += o.y + rippleHeight(world.xz);
		}
	}
	vWorld = world.xyz;
	vNormalW = nrm;
	vCrest = crest;
	vec4 mvPosition = viewMatrix * world;
	vViewZ = mvPosition.z;
	gl_Position = projectionMatrix * mvPosition;
#ifdef WATER_PLANAR
	vReflUv = uReflMatrix * world;
#endif
	#include <fog_vertex>
}
`;

export const surfaceFragment = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
uniform float uTime;
uniform float uBody;
uniform float uFrozen;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uClarity;
uniform float uOpacity;
uniform float uRefraction;
uniform float uChromatic;
uniform float uReflectivity;
uniform float uReflectOn;
uniform float uFresnel;
uniform float uRoughness;
uniform float uFoam;
uniform vec3 uFoamColor;
uniform float uFoamWidth;
uniform float uCaustics;
uniform float uCausticScale;
uniform float uCausticSpeed;
uniform vec3 uEmissive;
uniform float uDetail;
uniform float uDetailScale;
uniform float uDetailSpeed;
uniform vec2 uFlow;
uniform vec3 uFogColor;
uniform float uFogDistance;
uniform float uUnderwater;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyBottom;
uniform sampler2D uNormalMap;
uniform mat4 uWorldToLocal;
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform float uOpen; // plane: no floor (an ocean)
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;
varying float vViewZ;
#ifdef WATER_SS
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform vec2 uViewport;
uniform float uSSActive;
uniform float uCamNear;
uniform float uCamFar;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
#endif
#ifdef WATER_PLANAR
uniform sampler2D uReflTex;
varying vec4 vReflUv;
#endif

vec3 sky(vec3 d, float blur) {
	float y = d.y;
	vec3 up = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 0.6, y));
	vec3 dn = mix(uSkyHorizon, uSkyBottom, smoothstep(0.0, 0.35, -y));
	vec3 c = y >= 0.0 ? up : dn;
	vec3 avg = (uSkyTop + uSkyHorizon * 2.0 + uSkyBottom) * 0.25;
	return mix(c, avg, blur);
}

// a cheap animated caustic net: three warped cell layers, sharpened
float caustic(vec2 p, float t) {
	float c = 0.0;
	vec2 q = p;
	for (int i = 0; i < 3; i++) {
		float fi = float(i);
		q += vec2(sin(q.y * 1.7 + t * (0.9 + fi * 0.3)), cos(q.x * 1.3 - t * (0.7 + fi * 0.2))) * 0.35;
		vec2 g = fract(q * (1.0 + fi * 0.37)) - 0.5;
		c += pow(max(0.0, 1.0 - length(g) * 2.2), 3.0);
	}
	return clamp(c * 0.8, 0.0, 2.0);
}

// distance the view ray travels inside the local AABB from p (world) along dir (world)
float exitDistance(vec3 p, vec3 dir) {
	vec3 lp = (uWorldToLocal * vec4(p, 1.0)).xyz;
	vec3 ld = mat3(uWorldToLocal) * dir;
	float scale = length(ld);
	if (scale < 1e-6) return 1e3;
	ld /= scale;
	vec3 inv = 1.0 / max(abs(ld), vec3(1e-6)) * sign(ld + 1e-9);
	vec3 bmin = uBoxMin; vec3 bmax = uBoxMax;
	if (uOpen > 0.5) bmin.y = -1e4;
	vec3 t0 = (bmin - lp) * inv;
	vec3 t1 = (bmax - lp) * inv;
	vec3 tf = max(t0, t1);
	float tExit = min(min(tf.x, tf.y), tf.z);
	return max(tExit, 0.0) / scale;
}

bool insideBox(vec3 w) {
	vec3 lp = (uWorldToLocal * vec4(w, 1.0)).xyz;
	vec3 bmin = uBoxMin;
	if (uOpen > 0.5) bmin.y = -1e4;
	return all(greaterThanEqual(lp, bmin - 0.01)) && all(lessThanEqual(lp, uBoxMax + 0.02));
}

void main() {
	vec3 V = normalize(cameraPosition - vWorld);
	vec3 N = normalize(vNormalW);
	bool front = gl_FrontFacing;
	float t = uTime;
	vec2 flowOff = uFlow * t * 0.25;

	// detail ripples: two scrolling layers of the tiling normal map (surface only)
	float foamNoise = 0.5;
	if (uBody < 0.5) {
		float sp = uDetailSpeed * (1.0 - uFrozen);
		vec2 uv1 = vWorld.xz / uDetailScale + vec2(0.7, 0.3) * t * sp * 0.25 - flowOff / uDetailScale;
		vec2 uv2 = vWorld.xz / (uDetailScale * 0.57) - vec2(0.4, -0.6) * t * sp * 0.25 - flowOff / uDetailScale;
		vec4 a = texture2D(uNormalMap, uv1);
		vec4 b = texture2D(uNormalMap, uv2);
		vec2 dn = (a.xy * 2.0 - 1.0) + (b.xy * 2.0 - 1.0);
		N = normalize(N + vec3(dn.x, 0.0, dn.y) * uDetail * 0.6);
		foamNoise = a.w * 0.6 + b.w * 0.4;
	}
	if (!front) N = -N;
	float NdV = clamp(dot(N, V), 0.0, 1.0);

	// Fresnel (Schlick, water F0 ~ 0.02) shaped by the look's exponent
	float F = 0.02 + 0.98 * pow(1.0 - NdV, uFresnel);
	F = clamp(F * uReflectivity * uReflectOn, 0.0, 1.0);

	// ── reflection ─────────────────────────────────────────────────────────────────────
	vec3 R = reflect(-V, N);
	vec3 refl = sky(R, uRoughness * 0.8);
#ifdef WATER_PLANAR
	if (front && uBody < 0.5) {
		vec4 ru = vReflUv;
		ru.xy += N.xz * 0.04 * ru.w;
		vec3 planar = texture2DProj(uReflTex, ru).rgb;
		refl = mix(planar, refl, uRoughness * 0.5);
	}
#endif
	vec3 L = normalize(uSunDir);
	vec3 H = normalize(L + V);
	float shin = clamp(2.0 / max(pow(uRoughness, 4.0), 1e-4) - 2.0, 8.0, 2048.0);
	float spec = pow(max(dot(N, H), 0.0), shin) * (shin + 8.0) / 25.0 * uReflectOn;
	vec3 sunSpec = uSunColor * spec * (front ? 1.0 : 0.15) * uReflectivity;

	// ── transmission ───────────────────────────────────────────────────────────────────
	float thickness;
	vec3 refr;
	float shore = 0.0;
	float alpha = 1.0;
	float camInside = uUnderwater;
	if (!front || camInside > 0.5) thickness = length(cameraPosition - vWorld);
	else thickness = exitDistance(vWorld, -V);
	thickness = max(thickness, 0.0);

	vec3 refrDir = refract(-V, N, front ? 1.0 / 1.33 : 1.33);
	bool tir = !front && dot(refrDir, refrDir) < 0.5; // total internal reflection from below
	refr = sky(length(refrDir) > 0.0 ? refrDir : R, 0.55);

#ifdef WATER_SS
	if (uSSActive > 0.5) {
		vec2 uv = gl_FragCoord.xy / uViewport;
		vec2 off = N.xz * uRefraction * 0.06 / max(1.0, -vViewZ * 0.15);
		float fragZ = -vViewZ;
		vec2 uvr = clamp(uv + off, vec2(0.001), vec2(0.999));
		float d = texture2D(uSceneDepth, uvr).x;
		float sceneZ = -perspectiveDepthToViewZ(d, uCamNear, uCamFar);
		if (isOrthographic) sceneZ = -orthographicDepthToViewZ(d, uCamNear, uCamFar);
		if (sceneZ < fragZ) { uvr = uv; d = texture2D(uSceneDepth, uv).x; sceneZ = isOrthographic ? -orthographicDepthToViewZ(d, uCamNear, uCamFar) : -perspectiveDepthToViewZ(d, uCamNear, uCamFar); }
		vec2 ch = off * uChromatic * 0.6;
		vec3 sc = vec3(
			texture2D(uSceneColor, clamp(uvr + ch, vec2(0.001), vec2(0.999))).r,
			texture2D(uSceneColor, uvr).g,
			texture2D(uSceneColor, clamp(uvr - ch, vec2(0.001), vec2(0.999))).b);
		float behind = max(sceneZ - fragZ, 0.0);
		if (front && camInside < 0.5) {
			thickness = min(thickness, behind);
			shore = 1.0 - smoothstep(0.0, uFoamWidth, behind);
			// caustics on whatever the refraction lands on, when it lies in the water
			vec4 ndc = vec4(uvr * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
			vec4 vp = uProjInv * ndc; vp /= vp.w;
			vec3 floorW = (uCamWorld * vp).xyz;
			if (uCaustics > 0.0 && insideBox(floorW)) {
				float depthBelow = max(vWorld.y - floorW.y, 0.0);
				float c = caustic(floorW.xz / uCausticScale + uFlow * t * 0.1, t * uCausticSpeed);
				float sunLit = clamp(max(L.y, 0.0) * 1.5, 0.0, 1.0);
				sc += sc * c * uCaustics * exp(-depthBelow * 0.25) * sunLit * 1.6;
			}
		}
		refr = tir ? refr : sc;
	}
#endif
	float absorb = 1.0 - exp(-thickness / max(uClarity, 0.01));
	vec3 tint = mix(vec3(1.0), uShallow, 0.3 + 0.7 * clamp(thickness / max(uClarity, 0.01), 0.0, 1.0));
	vec3 trans = mix(refr * tint, uDeep, clamp(absorb * uOpacity, 0.0, 1.0));
	if (uRefraction <= 0.0) trans = mix(uShallow, uDeep, clamp(absorb + 0.2, 0.0, 1.0)) * (0.35 + 0.65 * max(dot(vec3(0.0, 1.0, 0.0), L), 0.15)) * uSunColor * 0.6 + uDeep * 0.4;
	if (tir) trans = mix(uDeep, uFogColor, 0.5);

#ifndef WATER_SS
	// Quest tier: the floor shows through by blending; opaque where the water is deep
	alpha = clamp(max(absorb * uOpacity, F) + spec, 0.0, 1.0);
	if (uRefraction <= 0.0) alpha = max(alpha, uOpacity);
	if (!front) alpha = clamp(0.35 + absorb * 0.65, 0.0, 1.0);
#endif

	vec3 col = mix(trans, refl, F) + sunSpec;

	// foam: crests + the shoreline band, broken up by the map's foam channel
	float foamMask = 0.0;
	if (uBody < 0.5 && front) {
		float crestF = smoothstep(0.45, 0.95, vCrest);
		foamMask = max(crestF * 0.9, shore) * uFoam;
		foamMask *= smoothstep(0.25, 0.75, foamNoise + foamMask * 0.4);
	}
	vec3 lit = uSkyTop * 0.45 + uSunColor * (0.35 + 0.65 * max(dot(N, L), 0.0));
	col = mix(col, uFoamColor * lit, clamp(foamMask, 0.0, 1.0));
	alpha = max(alpha, foamMask);
	col += uEmissive * (front ? 1.0 : 0.6) * (0.75 + 0.25 * foamNoise);

	gl_FragColor = vec4(col, alpha);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	if (uUnderwater < 0.5) {
		#include <fog_fragment>
	}
}
`;

// ── bubbles: one instanced draw, motion is analytic (deterministic per index + clock) ────

export const bubbleVertex = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uOrigin;   // world: centre of the spawn area at the floor
uniform vec3 uAxisX;    // world half-extents of the spawn area
uniform vec3 uAxisZ;
uniform float uRiseH;   // metres from the floor to the surface
uniform float uSpeed;
uniform float uSizeMin;
uniform float uSizeMax;
uniform float uWobble;
uniform float uCount;
uniform float uRate;
uniform float uBurstMode; // 1 = burst mode
uniform float uBurstAge;  // seconds since the last burst (burst mode)
uniform float uPop;
varying vec2 vUv;
varying float vPop;
varying float vFade;

void main() {
	vUv = uv;
	float speed = uSpeed * (0.75 + 0.5 * aSeed.y);
	float life = uRiseH / max(speed, 0.001);
	float popDur = uPop > 0.5 ? 0.35 : 0.0;
	float age;
	if (uBurstMode > 0.5) {
		age = uBurstAge - aSeed.x * 0.5;
	} else {
		float period = max(life + popDur, uCount / max(uRate, 0.01));
		age = mod(uTime + aSeed.x * period, period);
	}
	float visible = step(0.0, age) * step(age, life + popDur);
	float size = mix(uSizeMin, uSizeMax, aSeed.z * aSeed.z);
	vec3 base = uOrigin + uAxisX * (aSeed.w * 2.0 - 1.0) + uAxisZ * (fract(aSeed.x * 7.13 + aSeed.y * 3.7) * 2.0 - 1.0);
	float y = min(age, life) * speed;
	float sway = uWobble * size * 4.0;
	vec3 center = base + vec3(sin(age * (3.0 + aSeed.y * 4.0) + aSeed.w * 6.28) * sway, y, cos(age * (2.5 + aSeed.z * 3.0) + aSeed.x * 6.28) * sway);
	vPop = age > life ? (age - life) / max(popDur, 0.001) : 0.0;
	vFade = smoothstep(0.0, 0.15, age);
	vec4 world;
	if (vPop > 0.0) {
		// the splash ring lies flat on the surface and grows
		float r = size * (1.2 + vPop * 4.0);
		world = vec4(center + vec3(position.x * r, 0.0, -position.y * r), 1.0);
	} else {
		vec4 mv = viewMatrix * vec4(center, 1.0);
		mv.xy += position.xy * size;
		gl_Position = projectionMatrix * mv;
		gl_Position *= visible;
		return;
	}
	gl_Position = projectionMatrix * viewMatrix * world;
	gl_Position *= visible;
}
`;

export const bubbleFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vPop;
varying float vFade;
void main() {
	vec2 p = vUv * 2.0 - 1.0;
	float d = length(p);
	if (d > 1.0) discard;
	float a;
	if (vPop > 0.0) {
		a = smoothstep(0.7, 0.85, d) * (1.0 - smoothstep(0.9, 1.0, d)) * (1.0 - vPop);
	} else {
		float rim = smoothstep(0.55, 0.98, d) * (1.0 - smoothstep(0.98, 1.0, d));
		float glint = smoothstep(0.35, 0.0, length(p - vec2(-0.35, 0.4)));
		a = rim * 0.85 + glint * 0.9 + 0.08;
	}
	gl_FragColor = vec4(uColor, a * uOpacity * vFade);
	#include <colorspace_fragment>
}
`;

// ── underwater overlay: a full-screen triangle drawn last while the camera is inside ─────

export const overlayVertex = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const overlayFragment = /* glsl */ `
#include <packing>
uniform vec3 uTint;
uniform float uStrength;
uniform float uTime;
uniform float uCaustics;
uniform float uCausticScale;
uniform float uCausticSpeed;
uniform float uSurfaceY;
uniform float uSun;
varying vec2 vUv;
#ifdef WATER_SS
uniform sampler2D uSceneDepth;
uniform float uCamNear;
uniform float uCamFar;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform float uSSActive;
float caustic(vec2 p, float t) {
	float c = 0.0;
	vec2 q = p;
	for (int i = 0; i < 3; i++) {
		float fi = float(i);
		q += vec2(sin(q.y * 1.7 + t * (0.9 + fi * 0.3)), cos(q.x * 1.3 - t * (0.7 + fi * 0.2))) * 0.35;
		vec2 g = fract(q * (1.0 + fi * 0.37)) - 0.5;
		c += pow(max(0.0, 1.0 - length(g) * 2.2), 3.0);
	}
	return clamp(c * 0.8, 0.0, 2.0);
}
#endif
void main() {
	float v = length(vUv - 0.5) * 1.4;
	float a = uStrength * (0.6 + 0.4 * v);
	vec3 add = vec3(0.0);
#ifdef WATER_SS
	if (uSSActive > 0.5 && uCaustics > 0.0) {
		float d = texture2D(uSceneDepth, vUv).x;
		if (d < 0.9999) {
			vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
			vp /= vp.w;
			vec3 w = (uCamWorld * vp).xyz;
			if (w.y < uSurfaceY) {
				float c = caustic(w.xz / uCausticScale, uTime * uCausticSpeed);
				float dist = length(vp.xyz);
				add = vec3(c * uCaustics * 0.18 * uSun) * exp(-(uSurfaceY - w.y) * 0.25) * exp(-dist * 0.08);
			}
		}
	}
#endif
	gl_FragColor = vec4(uTint * a + add, a);
}
`;
