// 106 S2 — CONTACT SHADOWS: the small grounding shadow where an object meets what it stands on, which a shadow
// map (Soft's wide kernel above all) blurs away. A screen-space march TOWARD the scene's sun through the depth
// buffer: from each pixel's view-space position, a few steps along the light; a step that lands BEHIND the depth
// buffer (something nearer the camera covers it, within a thin slab) means a nearby caster sits between the
// pixel and the sun, and the pixel darkens a little. Short on purpose (a fraction of a metre): the shadow map
// owns everything farther.
//
// Not scene data and never in the scene's post document: the drawn shadow level adds it LOCALLY (lightParams
// `contactShadowsWanted`, written by shadowLevels.js; Outline.svelte prepends the entry), so a device whose
// tier leaves it out pays nothing and a peer's document is untouched. Lazy: loaded with Soft / Far only.
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { Matrix4, Uniform, Vector3 } from 'three';
import { registerPostEffect } from '../scenePost';
import { ENV_RIG_SUN } from '../shadowFitCore.js';

export const CONTACT_KIND = 'contactshadows';

const FRAG = /* glsl */ `
uniform mat4 projInv;
uniform mat4 proj;
uniform vec3 lightView;
uniform float reach;
uniform float thickness;
uniform float strength;
uniform float on;

vec3 viewPos(const in vec2 uv, const in float d) {
	vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
	vec4 v = projInv * ndc;
	return v.xyz / v.w;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
	outputColor = inputColor;
	if (on < 0.5 || depth >= 0.9999) return;
	vec3 p = viewPos(uv, depth);
	// the march grows a little with distance so a far object keeps a visible contact line
	float len = reach * clamp(-p.z * 0.02, 1.0, 4.0);
	float stepLen = len / float(CONTACT_STEPS);
	// a per-pixel jitter breaks the banding of a short march (TRAA smooths it where a look runs it)
	float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
	float occ = 0.0;
	for (int i = 1; i <= CONTACT_STEPS; i++) {
		vec3 q = p + lightView * stepLen * (float(i) - jitter);
		vec4 c = proj * vec4(q, 1.0);
		vec2 quv = c.xy / c.w * 0.5 + 0.5;
		if (quv.x < 0.0 || quv.x > 1.0 || quv.y < 0.0 || quv.y > 1.0) break;
		float sd = readDepth(quv);
		if (sd >= 0.9999) continue;
		float sz = viewPos(quv, sd).z;
		float diff = sz - q.z;
		if (diff > 0.002 && diff < thickness) {
			occ = 1.0 - float(i) / float(CONTACT_STEPS + 1);
			break;
		}
	}
	// fade at the screen edge (the march has no data past it)
	vec2 e = smoothstep(0.0, 0.04, uv) * smoothstep(0.0, 0.04, 1.0 - uv);
	outputColor.rgb *= 1.0 - strength * occ * e.x * e.y;
}
`;

const _sun = new Vector3();
const _target = new Vector3();

class ContactShadowEffect extends Effect {
	/** @param {any} camera @param {any} scene @param {number} steps */
	constructor(camera, scene, steps) {
		super('ContactShadowEffect', FRAG, {
			blendFunction: BlendFunction.NORMAL,
			attributes: EffectAttribute.DEPTH,
			defines: new Map([['CONTACT_STEPS', String(steps)]]),
			uniforms: /** @type {Map<string, Uniform<any>>} */ (new Map(/** @type {[string, Uniform<any>][]} */ ([
				['projInv', new Uniform(new Matrix4())],
				['proj', new Uniform(new Matrix4())],
				['lightView', new Uniform(new Vector3(0, 1, 0))],
				['reach', new Uniform(0.35)],
				['thickness', new Uniform(0.25)],
				['strength', new Uniform(0.45)],
				['on', new Uniform(0)]
			])))
		});
		this.camera = camera;
		this.sceneRef = scene;
	}

	/** @param {any} _renderer @param {any} _input @param {number} _dt */
	update(_renderer, _input, _dt) {
		const u = this.uniforms;
		const cam = this.camera;
		/** @type {any} */ (u.get('proj')).value.copy(cam.projectionMatrix);
		/** @type {any} */ (u.get('projInv')).value.copy(cam.projectionMatrixInverse);
		const sun = this.sceneRef?.getObjectByName?.(ENV_RIG_SUN);
		const lit = !!sun && sun.visible && sun.castShadow && sun.intensity > 0;
		/** @type {any} */ (u.get('on')).value = lit ? 1 : 0;
		if (!lit) return;
		sun.getWorldPosition(_sun);
		if (sun.target && !sun.isSunLight) sun.target.getWorldPosition(_target);
		else _target.set(0, 0, 0);
		_sun.sub(_target).normalize().transformDirection(cam.matrixWorldInverse);
		/** @type {any} */ (u.get('lightView')).value.copy(_sun);
	}
}

let registered = false;
/** Register the kind (once). The entry itself is added by Outline.svelte while the drawn level asks for it. */
export function registerContactShadows() {
	if (registered) return;
	registered = true;
	registerPostEffect(CONTACT_KIND, {
		label: 'Contact shadows',
		group: 'lighting',
		// added by the shadow level, never offered in the look's Add menu
		legacy: true,
		params: [{ key: 'steps', label: 'Steps', min: 4, max: 24, step: 1, decimals: 0, default: 12 }],
		make: (params, ctx) => new ContactShadowEffect(ctx.camera, ctx.scene, Math.round(Number(params.steps) || 12)),
		retarget: (/** @type {any} */ effect, /** @type {any} */ camera) => {
			effect.camera = camera;
		}
	});
}
