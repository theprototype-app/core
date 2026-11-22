// 98 P3 — the GLSL of temporal anti-aliasing (TRAA), ONE file for the 2.0 S2 port (TSL-portable rule).
// The jitter sequence, the history bookkeeping, the per-tier on/off and the camera-cut reset are plain JS in
// `traaCore.js` / `traaPass.js`; these bodies only draw. TSL twins: three's `VelocityNode` (velocity) and
// `TRAANode` (resolve) are the S2 targets — the maths below follows them so the port is a swap, not a rewrite.

// TSL twin: VelocityNode — (currentClip.xy / w - previousClip.xy / w) * 0.5, with the previous pose of a
// SkinnedMesh from its previous bone texture (the "no smear on animated characters" row).
export const VELOCITY_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>

uniform mat4 currViewProj;
uniform mat4 prevViewProj;
uniform mat4 prevModelMatrix;
#ifdef USE_SKINNING
uniform highp sampler2D prevBoneTexture;
uniform float hasPrevBones;
mat4 getPrevBoneMatrix(const in float i) {
	int size = textureSize(prevBoneTexture, 0).x;
	int j = int(i) * 4;
	int x = j % size;
	int y = j / size;
	vec4 v1 = texelFetch(prevBoneTexture, ivec2(x, y), 0);
	vec4 v2 = texelFetch(prevBoneTexture, ivec2(x + 1, y), 0);
	vec4 v3 = texelFetch(prevBoneTexture, ivec2(x + 2, y), 0);
	vec4 v4 = texelFetch(prevBoneTexture, ivec2(x + 3, y), 0);
	return mat4(v1, v2, v3, v4);
}
#endif

varying vec4 vCurr;
varying vec4 vPrev;

void main() {
	vec3 transformed = vec3(position);
	vec3 prevTransformed = vec3(position);
	#ifdef USE_SKINNING
		#include <skinbase_vertex>
		#include <skinning_vertex>
		if (hasPrevBones > 0.5) {
			vec4 pv = bindMatrix * vec4(prevTransformed, 1.0);
			vec4 ps = vec4(0.0);
			ps += getPrevBoneMatrix(skinIndex.x) * pv * skinWeight.x;
			ps += getPrevBoneMatrix(skinIndex.y) * pv * skinWeight.y;
			ps += getPrevBoneMatrix(skinIndex.z) * pv * skinWeight.z;
			ps += getPrevBoneMatrix(skinIndex.w) * pv * skinWeight.w;
			prevTransformed = (bindMatrixInverse * ps).xyz;
		} else prevTransformed = transformed;
	#endif
	#ifdef USE_INSTANCING
		transformed = (instanceMatrix * vec4(transformed, 1.0)).xyz;
		prevTransformed = (instanceMatrix * vec4(prevTransformed, 1.0)).xyz;
	#endif
	vCurr = currViewProj * modelMatrix * vec4(transformed, 1.0);
	vPrev = prevViewProj * prevModelMatrix * vec4(prevTransformed, 1.0);
	// the depth test runs on the JITTERED projection the beauty pass used, so velocity and colour agree
	gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;

export const VELOCITY_FRAG = /* glsl */ `
varying vec4 vCurr;
varying vec4 vPrev;
void main() {
	vec2 curr = vCurr.xy / vCurr.w;
	vec2 prev = vPrev.xy / vPrev.w;
	// alpha 1 = geometry wrote this pixel; 0 (the clear) = sky, reprojected from the camera alone
	gl_FragColor = vec4((curr - prev) * 0.5, 0.0, 1.0);
}
`;

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = position.xy * 0.5 + 0.5;
	gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

// TSL twin: TRAANode — reproject the history by velocity, clip it to the current 3x3 neighbourhood in YCoCg
// (variance clipping), blend. Disocclusion / off-screen / reset take the current frame.
export const RESOLVE_FRAG = /* glsl */ `
uniform sampler2D inputBuffer;
uniform sampler2D historyBuffer;
uniform sampler2D velocityBuffer;
uniform mat4 currViewProjInverse;
uniform mat4 prevViewProj;
uniform vec2 texelSize;
uniform float blend;
uniform float reset;
varying vec2 vUv;

vec3 toYCoCg(vec3 c) {
	return vec3(c.r * 0.25 + c.g * 0.5 + c.b * 0.25, c.r * 0.5 - c.b * 0.5, -c.r * 0.25 + c.g * 0.5 - c.b * 0.25);
}
vec3 fromYCoCg(vec3 c) {
	return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z);
}

void main() {
	vec4 current = texture2D(inputBuffer, vUv);
	if (reset > 0.5) {
		gl_FragColor = current;
		return;
	}
	vec4 vel = texture2D(velocityBuffer, vUv);
	vec2 prevUv;
	if (vel.a > 0.5) prevUv = vUv - vel.xy;
	else {
		vec4 w = currViewProjInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
		vec4 p = prevViewProj * vec4(w.xyz / w.w, 1.0);
		prevUv = (p.xy / p.w) * 0.5 + 0.5;
	}
	if (prevUv.x < 0.0 || prevUv.y < 0.0 || prevUv.x > 1.0 || prevUv.y > 1.0) {
		gl_FragColor = current;
		return;
	}
	vec3 m1 = vec3(0.0);
	vec3 m2 = vec3(0.0);
	for (int x = -1; x <= 1; x++) {
		for (int y = -1; y <= 1; y++) {
			vec3 s = toYCoCg(texture2D(inputBuffer, vUv + vec2(float(x), float(y)) * texelSize).rgb);
			m1 += s;
			m2 += s * s;
		}
	}
	vec3 mean = m1 / 9.0;
	vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3(0.0)));
	vec3 lo = mean - 1.25 * sigma;
	vec3 hi = mean + 1.25 * sigma;
	vec3 hist = toYCoCg(texture2D(historyBuffer, prevUv).rgb);
	// clip toward the mean (not a per-channel clamp: that shifts hue)
	vec3 centre = 0.5 * (hi + lo);
	vec3 extent = 0.5 * (hi - lo) + 1e-4;
	vec3 d = hist - centre;
	vec3 unit = abs(d / extent);
	float m = max(unit.x, max(unit.y, unit.z));
	if (m > 1.0) hist = centre + d / m;
	// moving pixels lean on the current frame: the ghosting guard
	float speed = length(vel.xy / texelSize);
	float w = mix(blend, 0.5, clamp(speed * 0.02, 0.0, 1.0));
	gl_FragColor = vec4(mix(fromYCoCg(hist), current.rgb, w), current.a);
}
`;
