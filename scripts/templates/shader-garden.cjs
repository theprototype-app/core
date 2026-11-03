// Template def `shader-garden` — one file per template (34 R4 A3). Authored by scripts/author-templates.cjs;
// the def schema is the comment block at the top of that file; the table is ./index.cjs.
//
// 73 AI6: the release's starter template — three objects wearing YOUR GLSL (the shader editor's </> ▸ Your
// GLSL), each a different small idea to edit: stripes on the shared clock, a pulsing glow, a rim light.
// Every pair keeps the gate's rules (no while/do, loops count to a constant, #include only the two allowed
// chunks), so it is also the docs page's worked example. Someone who opens it from the templates runs it
// only after this device's worker test passes (AI9) — on Quest only once "Turn on custom shaders" is on.

const VERT = `// three.js gives you: position, normal, uv,
// modelViewMatrix, projectionMatrix, normalMatrix, cameraPosition
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;

void main() {
	vUv = uv;
	vNormal = normalize(normalMatrix * normal);
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	vView = normalize(-mv.xyz);
	gl_Position = projectionMatrix * mv;
}
`;

const STRIPES = `// Stripes that slide on the session's shared clock: every peer sees the same frame.
uniform float uShaderTime;
uniform vec3 tint;
uniform float bands;
varying vec2 vUv;
varying vec3 vNormal;

void main() {
	float light = 0.35 + 0.65 * max(dot(normalize(vNormal), normalize(vec3(0.4, 1.0, 0.6))), 0.0);
	float s = 0.5 + 0.5 * sin((vUv.x + vUv.y) * bands + uShaderTime * 2.0);
	gl_FragColor = vec4(tint * mix(0.55, 1.0, s) * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

const PULSE = `// A glow that breathes. A Set Shader Uniform node can drive 'speed' from a game.
uniform float uShaderTime;
uniform vec3 glow;
uniform float speed;
varying vec3 vNormal;

void main() {
	float light = 0.3 + 0.7 * max(dot(normalize(vNormal), normalize(vec3(0.4, 1.0, 0.6))), 0.0);
	float pulse = 0.5 + 0.5 * sin(uShaderTime * speed);
	gl_FragColor = vec4(glow * (0.25 + 0.75 * pulse) + vec3(0.08) * light, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

const RIM = `// A rim light: bright where the surface turns away from you. The loop counts to a constant
// (the gate refuses while and do), here to soften the edge in four steps.
uniform vec3 base;
uniform vec3 rim;
varying vec3 vNormal;
varying vec3 vView;

void main() {
	float facing = 1.0 - max(dot(normalize(vNormal), normalize(vView)), 0.0);
	float edge = 0.0;
	for (int i = 0; i < 4; i++) {
		edge += pow(facing, 1.5 + float(i)) * 0.25;
	}
	gl_FragColor = vec4(base + rim * edge * 2.0, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/** a document that runs Your GLSL (the graph left empty) @param {string} fragment @param {Record<string, any>} uniforms */
const own = (fragment, uniforms) => ({ nodes: [], edges: [], code: { use: true, vertex: VERT, fragment, uniforms } });

module.exports = {
	kind: 'template',
	slug: 'shader-garden',
	title: 'Shader garden',
	description: 'Three objects in your own GLSL — sliding stripes, a breathing glow and a rim light. Open the shader editor, press </> and change a line.',
	license: 'CC0-1.0',
	author: 'theprototype',
	tags: ['shaders', 'glsl', 'materials', 'starter'],
	objects: [
		{ type: 'box', name: 'Ground', color: 0x2b3140, size: [12, 0.4, 8], pos: [0, -0.2, 0] },
		{ type: 'box', name: 'Stripes', color: 0x6a8cff, size: [1.6, 1.6, 1.6], pos: [-3, 0.8, 0], rot: [0, 0.6, 0] },
		{ type: 'sphere', name: 'Pulse', color: 0xff9a3c, r: 1, pos: [0, 1, 0] },
		{ type: 'torus', name: 'Rim', color: 0x3cc6a0, r: 0.8, tube: 0.32, pos: [3, 1.1, 0], rot: [0.5, 0.3, 0] }
	],
	shaders: {
		Stripes: own(STRIPES, { tint: [0.42, 0.55, 1], bands: 20 }),
		Pulse: own(PULSE, { glow: [1, 0.55, 0.2], speed: 3 }),
		Rim: own(RIM, { base: [0.04, 0.12, 0.1], rim: [0.25, 1, 0.75] })
	},
	view: { pos: [0, 4, 9], target: [0, 0.8, 0] }
};
