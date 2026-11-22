// 98 P4 — the GLSL bodies of the lens and film finish, ONE file for all three effects so the 2.0 S2
// port has a single place to rewrite (roadmap 2.0 TSL-portable rule). Every decision — tier caps,
// step counts, the sun's screen position, the fade — is made in plain JS (`finishCore.js`) and only
// arrives here as a uniform. Each body is a postprocessing `mainImage`; the TSL twin of each is noted
// above it.

// TSL twin: Fn(() => { ghosts = loop(4, i => sample(inputBuffer, fract(flipped + ghostVec * i)))
//   .max(threshold).mul(falloff); halo = ring sample; return input + (ghosts + halo) * amount })
export const LENS_FLARE_FRAG = /* glsl */ `
uniform float amount;
uniform float threshold;
uniform float spacing;
uniform float halo;

vec3 flareSample(vec2 at) {
	vec3 c = texture2D(inputBuffer, at).rgb;
	return max(c - vec3(threshold), vec3(0.0));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
	vec2 flipped = vec2(1.0) - uv;
	vec2 ghostVec = (vec2(0.5) - flipped) * spacing;
	vec3 acc = vec3(0.0);
	for (int i = 1; i < 5; i++) {
		vec2 at = fract(flipped + ghostVec * float(i));
		float w = pow(1.0 - clamp(length(vec2(0.5) - at) / 0.7071, 0.0, 1.0), 5.0);
		// a faint per-ghost tint, the coloured rings a real lens leaves
		vec3 tint = vec3(1.0 - 0.12 * float(i), 0.9, 0.8 + 0.06 * float(i));
		acc += flareSample(at) * w * tint;
	}
	vec2 haloVec = normalize(ghostVec + vec2(1e-5)) * 0.45;
	vec2 hat = fract(flipped + haloVec);
	float hw = pow(1.0 - clamp(abs(length(vec2(0.5) - hat) - 0.35) / 0.15, 0.0, 1.0), 3.0);
	acc += flareSample(hat) * hw * halo;
	outputColor = vec4(inputColor.rgb + acc * amount, inputColor.a);
}
`;

// TSL twin: Fn(() => { c = uv; loop(samples, () => { c -= delta; s = sky(depth(c)) ? sample(c) : 0;
//   acc += max(s - threshold, 0) * illum * weight; illum *= decay }); return input + acc * strength })
export const GOD_RAYS_FRAG = /* glsl */ `
uniform vec2 sunUv;
uniform float strength;
uniform float samples;
uniform float density;
uniform float decay;
uniform float weight;
uniform float threshold;

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
	if (strength <= 0.0 || samples < 1.0) {
		outputColor = inputColor;
		return;
	}
	vec2 delta = (uv - sunUv) * density / samples;
	vec2 c = uv;
	float illum = 1.0;
	vec3 acc = vec3(0.0);
	for (int i = 0; i < 64; i++) {
		if (float(i) >= samples) break;
		c -= delta;
		// only the SKY emits: anything in front of it (depth < 1) blocks the shaft, which is what
		// makes these light shafts rather than a radial blur
		float d = readDepth(c);
		vec3 s = d >= 0.9999 ? texture2D(inputBuffer, c).rgb : vec3(0.0);
		acc += max(s - vec3(threshold), vec3(0.0)) * illum * weight;
		illum *= decay;
	}
	outputColor = vec4(inputColor.rgb + acc * strength, inputColor.a);
}
`;

// TSL twin: Fn(() => { ray = cameraRay(uv); dist = min(viewDistance(depth), maxDistance);
//   od = steps == 0 ? analyticHeightFog(ray, dist) : march(steps, noisyDensity);
//   inscatter = fogColor + sunColor * henyeyGreenstein(dot(ray, sunDir), 0.6) * scatter;
//   return mix(inscatter, input, mix(1, exp(-od), amount)) })
export const VOLUMETRIC_FOG_FRAG = /* glsl */ `
uniform mat4 projInv;
uniform mat4 camWorld;
uniform vec3 fogColor;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float amount;
uniform float density;
uniform float falloff;
uniform float baseHeight;
uniform float scatter;
uniform float steps;
uniform float maxDistance;
uniform float fogTime;

float fogHash(vec3 p) {
	p = fract(p * 0.3183099 + 0.1);
	p *= 17.0;
	return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float fogNoise(vec3 x) {
	vec3 i = floor(x);
	vec3 f = fract(x);
	f = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(mix(fogHash(i), fogHash(i + vec3(1, 0, 0)), f.x), mix(fogHash(i + vec3(0, 1, 0)), fogHash(i + vec3(1, 1, 0)), f.x), f.y),
		mix(mix(fogHash(i + vec3(0, 0, 1)), fogHash(i + vec3(1, 0, 1)), f.x), mix(fogHash(i + vec3(0, 1, 1)), fogHash(i + vec3(1, 1, 1)), f.x), f.y),
		f.z);
}

float heightDensity(float y) {
	return density * exp(-falloff * (y - baseHeight));
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
	vec4 v = projInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
	vec3 dirV = normalize(v.xyz / v.w);
	float viewZ = depth >= 0.9999 ? -maxDistance : getViewZ(depth);
	float dist = min(viewZ / min(dirV.z, -1e-4), maxDistance);
	vec3 ro = camWorld[3].xyz;
	vec3 rd = normalize((camWorld * vec4(dirV, 0.0)).xyz);
	float od;
	if (steps < 1.0) {
		// analytic exponential height fog: the integral of density along the ray
		float k = falloff * rd.y * dist;
		float shape = abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
		od = heightDensity(ro.y) * dist * shape;
	} else {
		// the capped march: the same density, broken up by slow-moving noise so the fog has body
		float stepLen = dist / steps;
		float jitter = fogHash(vec3(uv * 512.0, fogTime));
		od = 0.0;
		for (int i = 0; i < 32; i++) {
			if (float(i) >= steps) break;
			vec3 p = ro + rd * stepLen * (float(i) + jitter);
			float n = fogNoise(p * 0.15 + vec3(fogTime * 0.05, 0.0, fogTime * 0.03));
			od += heightDensity(p.y) * (0.4 + 1.2 * n) * stepLen;
		}
	}
	float t = exp(-max(od, 0.0));
	float g = 0.6;
	float mu = dot(rd, normalize(sunDir));
	float phase = (1.0 - g * g) / (12.566 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
	vec3 inscatter = fogColor + sunColor * phase * scatter;
	outputColor = vec4(mix(inscatter, inputColor.rgb, mix(1.0, t, amount)), inputColor.a);
}
`;
