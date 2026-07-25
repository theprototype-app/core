// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

// Analytic ("stateless") particle shader (PFX-A). Every particle's state is a
// CLOSED-FORM function of (per-particle hash attributes, config uniforms, the
// synced clock) evaluated in the VERTEX shader — no per-frame integration and
// no CPU state, so any peer at any time computes identical visuals (golden
// rule 8: deterministic sync). Time arrives pre-wrapped to a 1-hour window
// (TIME_WRAP) because float32 precision at 86400s would visibly jitter fast
// particles; every peer wraps with the same formula so determinism holds
// (one single-frame re-phase per hour is the accepted cost).

export const TIME_WRAP = 3600;

/** Wrap the synced clock for shader consumption. @param {number} t seconds */
export function wrapTime(t) {
	return ((t % TIME_WRAP) + TIME_WRAP) % TIME_WRAP;
}

export const particleVertexShader = /* glsl */ `
	attribute vec4 aRand;    // per-particle hashed randoms [0,1)
	attribute vec4 aRand2;
	attribute float aIndex;
	attribute vec3 aOrigin;  // world-space spawn base (world mode only)

	uniform float uTime;      // wrapped synced seconds
	uniform float uMode;      // 0 continuous, 1 burst
	uniform float uBurstT;    // wrapped burst stamp; < 0 = never fired
	uniform float uCount;
	uniform float uLifetime;
	uniform float uLifeJitter;
	uniform float uShape;     // 0 cone, 1 sphere, 2 disc
	uniform float uAngle;     // cone half-angle (rad)
	uniform float uRadius;
	uniform float uSpeed;
	uniform float uSpeedJitter;
	uniform float uGravity;
	uniform float uDrag;
	uniform float uTurbulence;
	uniform float uSizeStart;
	uniform float uSizeEnd;
	uniform float uSpin;
	uniform float uSizeScale; // px = size * uSizeScale / depth
	uniform vec3 uOffset;     // emission point offset in the object's local frame
	uniform vec4 uQuat;       // emitter world quaternion (world mode)
	uniform float uWorldSpace;

	varying float vLife;
	varying float vRot;
	varying float vSeed;

	vec3 qrot(vec4 q, vec3 v) {
		return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
	}

	void main() {
		float li = max(uLifetime * (1.0 + uLifeJitter * (aRand.w - 0.5)), 0.05);
		float age;
		float alive = 1.0;
		if (uMode < 0.5) {
			// continuous: slot i respawns on a fixed phase — identical on every peer
			float phase = (aIndex / max(uCount, 1.0)) * uLifetime + aRand2.w * 0.05;
			age = mod(uTime - phase, li);
		} else {
			// burst: all slots born at the replicated trigger stamp (slight stagger)
			float birth = uBurstT + aRand2.w * 0.12 * li;
			age = uTime - birth;
			if (uBurstT < 0.0 || age < 0.0 || age > li) alive = 0.0;
		}
		float t = clamp(age / li, 0.0, 1.0);

		// spawn direction + offset from the emit shape
		float ph = aRand.y * 6.2831853;
		vec3 dir;
		vec3 posBase = vec3(0.0);
		if (uShape > 1.5) {
			// disc: ring in xz, cone-up directions
			posBase = vec3(cos(ph), 0.0, sin(ph)) * uRadius * sqrt(max(aRand.z, 0.001));
			float ca = mix(1.0, cos(uAngle), aRand.x);
			float sa = sqrt(max(1.0 - ca * ca, 0.0));
			dir = vec3(sa * cos(ph), ca, sa * sin(ph));
		} else if (uShape > 0.5) {
			// sphere: radial
			float cu = aRand.x * 2.0 - 1.0;
			float su = sqrt(max(1.0 - cu * cu, 0.0));
			dir = vec3(su * cos(ph), cu, su * sin(ph));
			posBase = dir * uRadius * aRand.z;
		} else {
			// cone about +Y
			float ca = mix(1.0, cos(uAngle), aRand.x);
			float sa = sqrt(max(1.0 - ca * ca, 0.0));
			dir = vec3(sa * cos(ph), ca, sa * sin(ph));
			posBase = vec3(cos(ph), 0.0, sin(ph)) * uRadius * aRand.z;
		}

		// emit from an offset point inside the object (default center)
		posBase += uOffset;

		// analytic motion: exponential drag + ballistic gravity + hash wobble
		float sp = uSpeed * (1.0 + uSpeedJitter * (aRand.z - 0.5));
		vec3 disp = uDrag > 0.001 ? dir * sp * (1.0 - exp(-uDrag * age)) / uDrag : dir * sp * age;
		disp.y += 0.5 * uGravity * age * age;
		if (uTurbulence > 0.001) {
			float f1 = 1.7 + aRand2.x * 2.0;
			float f2 = 1.3 + aRand2.y * 2.0;
			disp += uTurbulence * 0.3 * t * vec3(
				sin(age * f1 * 3.0 + aRand2.x * 6.2831853),
				sin(age * f2 * 2.2 + aRand2.y * 6.2831853),
				cos(age * f1 * 2.6 + aRand2.z * 6.2831853));
		}
		vec3 p = posBase + disp;
		if (uWorldSpace > 0.5) p = aOrigin + qrot(uQuat, p);

		vec4 mv = modelViewMatrix * vec4(p, 1.0);
		float size = mix(uSizeStart, uSizeEnd, t) * (0.8 + 0.4 * aRand2.z);
		gl_PointSize = alive > 0.5 ? min(size * uSizeScale / max(-mv.z, 0.1), 256.0) : 0.0;
		gl_Position = alive > 0.5 ? projectionMatrix * mv : vec4(0.0, 0.0, 2.0, 1.0);
		vLife = t;
		vRot = uSpin * age + aRand.y * 6.2831853;
		vSeed = aRand.x;
	}
`;

export const particleFragmentShader = /* glsl */ `
	uniform sampler2D uMap;
	uniform vec3 uColorStart;
	uniform vec3 uColorEnd;
	uniform float uColorMode; // 0 = gradient over life, 1 = per-particle mix
	uniform float uOpacity;
	uniform float uFadeIn;
	uniform float uFadeOut;

	varying float vLife;
	varying float vRot;
	varying float vSeed;

	void main() {
		vec2 c = gl_PointCoord - 0.5;
		float s = sin(vRot);
		float co = cos(vRot);
		vec4 tex = texture2D(uMap, vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5);
		float fadeIn = uFadeIn > 0.0 ? smoothstep(0.0, uFadeIn, vLife) : 1.0;
		float fadeOut = uFadeOut > 0.0 ? 1.0 - smoothstep(1.0 - uFadeOut, 1.0, vLife) : 1.0;
		vec3 col = mix(uColorStart, uColorEnd, uColorMode > 0.5 ? vSeed : vLife);
		float a = tex.a * uOpacity * fadeIn * fadeOut;
		if (a < 0.01) discard;
		gl_FragColor = vec4(col * tex.rgb, a);
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
	}
`;

// ---- procedural sprite textures ------------------------------------------
// Small white CanvasTextures (tinted in the shader). 2px transparent margin so
// the rotated gl_PointCoord sampling clamps to nothing at the corners.

/** @type {Record<string, any>} */
const spriteCache = {};

/** @param {(ctx: CanvasRenderingContext2D, s: number) => void} draw */
function makeSprite(draw) {
	const s = 64;
	const canvas = document.createElement('canvas');
	canvas.width = s;
	canvas.height = s;
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	draw(ctx, s);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

/** Sprite texture by shape name (cached). @param {string} name */
export function spriteTexture(name) {
	if (spriteCache[name]) return spriteCache[name];
	/** @type {any} */
	let tex;
	if (name === 'streak') {
		tex = makeSprite((ctx, s) => {
			const g = ctx.createLinearGradient(0, 4, 0, s - 4);
			g.addColorStop(0, 'rgba(255,255,255,0)');
			g.addColorStop(0.5, 'rgba(255,255,255,1)');
			g.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = g;
			ctx.fillRect(s / 2 - 4, 4, 8, s - 8);
			const glow = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2 - 4);
			glow.addColorStop(0, 'rgba(255,255,255,0.6)');
			glow.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = glow;
			ctx.fillRect(0, 0, s, s);
		});
	} else if (name === 'puff') {
		tex = makeSprite((ctx, s) => {
			// fuzzy blob: overlapping soft discs
			const blobs = [
				[0.5, 0.5, 0.42, 0.55], [0.36, 0.42, 0.26, 0.4], [0.64, 0.44, 0.24, 0.4],
				[0.44, 0.62, 0.24, 0.35], [0.6, 0.6, 0.22, 0.35]
			];
			for (const [x, y, r, a] of blobs) {
				const g = ctx.createRadialGradient(x * s, y * s, 0, x * s, y * s, r * s);
				g.addColorStop(0, `rgba(255,255,255,${a})`);
				g.addColorStop(1, 'rgba(255,255,255,0)');
				ctx.fillStyle = g;
				ctx.fillRect(0, 0, s, s);
			}
		});
	} else if (name === 'star') {
		tex = makeSprite((ctx, s) => {
			const c = s / 2;
			ctx.strokeStyle = 'rgba(255,255,255,0.95)';
			ctx.lineCap = 'round';
			for (const [dx, dy, w, l] of [[1, 0, 3, 26], [0, 1, 3, 26], [1, 1, 2, 14], [1, -1, 2, 14]]) {
				ctx.lineWidth = w;
				const n = Math.hypot(dx, dy);
				ctx.beginPath();
				ctx.moveTo(c - (dx / n) * l, c - (dy / n) * l);
				ctx.lineTo(c + (dx / n) * l, c + (dy / n) * l);
				ctx.stroke();
			}
			const g = ctx.createRadialGradient(c, c, 0, c, c, 12);
			g.addColorStop(0, 'rgba(255,255,255,1)');
			g.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, s, s);
		});
	} else if (name === 'square') {
		tex = makeSprite((ctx, s) => {
			// confetti rectangle with a soft 2px edge
			ctx.fillStyle = 'rgba(255,255,255,1)';
			ctx.fillRect(s * 0.25, s * 0.15, s * 0.5, s * 0.7);
		});
	} else {
		// 'dot' — soft radial disc
		tex = makeSprite((ctx, s) => {
			const c = s / 2;
			const g = ctx.createRadialGradient(c, c, 0, c, c, c - 2);
			g.addColorStop(0, 'rgba(255,255,255,1)');
			g.addColorStop(0.4, 'rgba(255,255,255,0.9)');
			g.addColorStop(1, 'rgba(255,255,255,0)');
			ctx.fillStyle = g;
			ctx.fillRect(0, 0, s, s);
		});
	}
	spriteCache[name] = tex;
	return tex;
}
