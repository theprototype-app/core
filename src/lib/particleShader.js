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

// 37-fx: the simulation is ONE closed-form function, shared by every way of drawing it.
// `slotAge` says how old a slot is now, `simPos` where a particle of that slot is at any
// age — so a velocity-stretched quad, a trail and a ribbon are the same particle sampled at
// a few ages, with no per-frame state anywhere (the determinism story above holds for all).
const SIM_COMMON = /* glsl */ `
	uniform float uTime;      // wrapped synced seconds
	uniform float uMode;      // 0 continuous, 1 burst
	uniform float uBurstT;    // wrapped burst stamp; < 0 = never fired
	uniform float uCount;
	uniform float uLifetime;
	uniform float uLifeJitter;
	uniform float uPhaseNoise; // 37-fx: birth-phase jitter, s (0 for a ribbon: slots are born in index order)
	uniform float uShape;     // 0 cone, 1 sphere, 2 disc, 3 box (36 B3: a weather AREA)
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
	uniform vec3 uOffset;     // emission point offset in the object's local frame
	uniform vec4 uQuat;       // emitter world quaternion (world mode)
	uniform float uWorldSpace;
	uniform float uInherit;   // 37-fx: share of the emitter's velocity a particle is born with (world mode)
	uniform vec2 uArea;       // 36 B3: box half-extents (x, z) in the emitter frame
	uniform vec3 uWind;       // 36 B3: constant drift, m/s
	uniform float uFall;      // 36 B3: the ground this far below the emitter (0 = none)
	uniform float uGround;    // 36 B3: on landing 1 = splash (rain), 2 = settle (snow)

	vec3 qrot(vec4 q, vec3 v) {
		return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
	}

	// how old slot (r, r2, idx) is now; li = its lifetime, alive = 0 while a burst slot is not showing
	float slotAge(vec4 r, vec4 r2, float idx, out float li, out float alive) {
		li = max(uLifetime * (1.0 + uLifeJitter * (r.w - 0.5)), 0.05);
		alive = 1.0;
		float age;
		if (uMode < 0.5) {
			// continuous: slot i respawns on a fixed phase — identical on every peer
			float phase = (idx / max(uCount, 1.0)) * uLifetime + r2.w * uPhaseNoise;
			age = mod(uTime - phase, li);
		} else {
			// burst: all slots born at the replicated trigger stamp (slight stagger)
			float birth = uBurstT + r2.w * 0.12 * li;
			age = uTime - birth;
			if (uBurstT < 0.0 || age < 0.0 || age > li) alive = 0.0;
		}
		return age;
	}

	// where that particle is at \`age\`, in the Points' frame (the emitter's, or the world in
	// world mode); landed > 0 once it has reached the ground (36 B3)
	vec3 simPos(vec4 r, vec4 r2, vec3 origin, vec3 vel, float age, float li, out float landed) {
		float t = clamp(age / li, 0.0, 1.0);

		// spawn direction + offset from the emit shape
		float ph = r.y * 6.2831853;
		vec3 dir;
		vec3 posBase = vec3(0.0);
		if (uShape > 2.5) {
			// box AREA (weather): anywhere on the emitter's x/z rectangle, falling straight down
			posBase = vec3((r.z * 2.0 - 1.0) * uArea.x, 0.0, (r2.x * 2.0 - 1.0) * uArea.y);
			float ca = mix(1.0, cos(uAngle), r.x);
			float sa = sqrt(max(1.0 - ca * ca, 0.0));
			dir = vec3(sa * cos(ph), -ca, sa * sin(ph));
		} else if (uShape > 1.5) {
			// disc: ring in xz, cone-up directions
			posBase = vec3(cos(ph), 0.0, sin(ph)) * uRadius * sqrt(max(r.z, 0.001));
			float ca = mix(1.0, cos(uAngle), r.x);
			float sa = sqrt(max(1.0 - ca * ca, 0.0));
			dir = vec3(sa * cos(ph), ca, sa * sin(ph));
		} else if (uShape > 0.5) {
			// sphere: radial
			float cu = r.x * 2.0 - 1.0;
			float su = sqrt(max(1.0 - cu * cu, 0.0));
			dir = vec3(su * cos(ph), cu, su * sin(ph));
			posBase = dir * uRadius * r.z;
		} else {
			// cone about +Y
			float ca = mix(1.0, cos(uAngle), r.x);
			float sa = sqrt(max(1.0 - ca * ca, 0.0));
			dir = vec3(sa * cos(ph), ca, sa * sin(ph));
			posBase = vec3(cos(ph), 0.0, sin(ph)) * uRadius * r.z;
		}

		// emit from an offset point inside the object (default center)
		posBase += uOffset;

		// analytic motion: exponential drag + ballistic gravity + hash wobble
		float sp = uSpeed * (1.0 + uSpeedJitter * (r.z - 0.5));
		float travel = uDrag > 0.001 ? (1.0 - exp(-uDrag * age)) / uDrag : age;
		vec3 disp = dir * sp * travel;
		// 37-fx: the emitter's velocity at this slot's birth (stamped next to aOrigin, world
		// space) carries the particle on, damped like its own launch speed. Rotated into the
		// emitter frame so the ground below still catches it.
		if (uWorldSpace > 0.5 && uInherit > 0.0)
			disp += qrot(vec4(-uQuat.xyz, uQuat.w), vel) * (uInherit * travel);
		disp.y += 0.5 * uGravity * age * age;
		if (uTurbulence > 0.001) {
			float f1 = 1.7 + r2.x * 2.0;
			float f2 = 1.3 + r2.y * 2.0;
			disp += uTurbulence * 0.3 * t * vec3(
				sin(age * f1 * 3.0 + r2.x * 6.2831853),
				sin(age * f2 * 2.2 + r2.y * 6.2831853),
				cos(age * f1 * 2.6 + r2.z * 6.2831853));
		}
		disp += uWind * age;
		vec3 p = posBase + disp;
		// 36 B3: the ground. The fall is close to monotonic, so the landing moment is found by
		// proportion; x/z stop there, and the age past it drives the splash / the settled fade
		landed = 0.0;
		if (uFall > 0.0 && p.y < -uFall) {
			float drop = max(-disp.y, 1e-4);
			float hitAge = age * clamp((uFall + posBase.y) / drop, 0.0, 1.0);
			p.xz = posBase.xz + disp.xz * (hitAge / max(age, 1e-4));
			p.y = -uFall + 0.01;
			landed = uGround > 1.5 ? 1.0 : clamp((age - hitAge) / 0.18, 0.0, 1.0) + 0.001;
		}
		if (uWorldSpace > 0.5) p = origin + qrot(uQuat, p);
		return p;
	}
`;

export const particleVertexShader = /* glsl */ `
	attribute vec4 aRand;    // per-particle hashed randoms [0,1)
	attribute vec4 aRand2;
	attribute float aIndex;
	attribute vec3 aOrigin;  // world-space spawn base (world mode only)
	attribute vec3 aVel;     // 37-fx: the emitter's world velocity at this slot's birth

	uniform float uSizeScale; // px = size * uSizeScale / depth
	${SIM_COMMON}

	varying float vLife;
	varying float vLanded;
	varying float vRot;
	varying float vSeed;

	void main() {
		float li;
		float alive;
		float age = slotAge(aRand, aRand2, aIndex, li, alive);
		float t = clamp(age / li, 0.0, 1.0);
		float landed;
		vec3 p = simPos(aRand, aRand2, aOrigin, aVel, age, li, landed);
		vLanded = landed;

		vec4 mv = modelViewMatrix * vec4(p, 1.0);
		float size = mix(uSizeStart, uSizeEnd, t) * (0.8 + 0.4 * aRand2.z);
		if (vLanded > 0.0 && uGround < 1.5) size *= 1.0 + 3.0 * vLanded; // a rain splash grows
		gl_PointSize = alive > 0.5 ? min(size * uSizeScale / max(-mv.z, 0.1), 256.0) : 0.0;
		gl_Position = alive > 0.5 ? projectionMatrix * mv : vec4(0.0, 0.0, 2.0, 1.0);
		vLife = t;
		vRot = uSpin * age + aRand.y * 6.2831853;
		vSeed = aRand.x;
	}
`;

// 37-fx: camera-facing width. The side vector is perpendicular to both the path (in view
// space) and the line of sight, so a strip always shows its face; a path pointing straight
// at the camera has no side, and any fixed one will do for that instant.
const STRIP_SIDE = /* glsl */ `
	vec3 stripSide(vec3 pathView, vec3 pointView) {
		vec3 s = cross(pathView, pointView);
		float l = length(s);
		return l > 1e-7 ? s / l : vec3(1.0, 0.0, 0.0);
	}
`;

/** 37-fx: `stretch` (one quad from where the particle was `uTrail` s ago to where it is —
 * the velocity-aligned spark) and `trails` (`uSegs` segments of its own path). */
export const stripVertexShader = /* glsl */ `
	attribute vec4 aRand;
	attribute vec4 aRand2;
	attribute float aIndex;
	attribute vec3 aOrigin;
	attribute vec3 aVel;
	attribute float aSeg;    // 0 = the head (now) .. uSegs = the tail
	attribute float aSide;   // -1 | +1 across the strip

	uniform float uSegs;
	uniform float uTrail;    // seconds of path the strip covers
	uniform float uRender;   // 1 stretch, 2 trails
	${SIM_COMMON}
	${STRIP_SIDE}

	varying float vLife;
	varying float vLanded;
	varying float vSeed;
	varying float vAlong;
	varying float vSide;

	void main() {
		float li;
		float alive;
		float age = slotAge(aRand, aRand2, aIndex, li, alive);
		float along = aSeg / max(uSegs, 1.0);
		// a trail never reaches back before its particle was born
		float segAge = max(age - along * uTrail, 0.0);
		float eps = max(uTrail / max(uSegs, 1.0), 0.004) * 0.5;
		float landed;
		float l1;
		vec3 p = simPos(aRand, aRand2, aOrigin, aVel, segAge, li, landed);
		vec3 a = simPos(aRand, aRand2, aOrigin, aVel, max(segAge - eps, 0.0), li, l1);
		vec3 b = simPos(aRand, aRand2, aOrigin, aVel, segAge + eps, li, l1);
		vec4 mv = modelViewMatrix * vec4(p, 1.0);
		vec3 path = (modelViewMatrix * vec4(b - a, 0.0)).xyz;
		float t = clamp(segAge / li, 0.0, 1.0);
		float width = mix(uSizeStart, uSizeEnd, t) * (0.8 + 0.4 * aRand2.z);
		if (uRender > 1.5) {
			width *= 1.0 - 0.7 * along; // a trail tapers to its tail
		} else {
			// a stretched sprite is never shorter than it is wide: half a width past each end
			float pl = length(path);
			vec3 fwd = pl > 1e-7 ? path / pl : vec3(0.0, 1.0, 0.0);
			mv.xyz += fwd * width * (0.5 - along);
		}
		mv.xyz += stripSide(path, mv.xyz) * aSide * width * 0.5;
		gl_Position = alive > 0.5 ? projectionMatrix * mv : vec4(0.0, 0.0, 2.0, 1.0);
		vLife = t;
		vLanded = landed;
		vSeed = aRand.x;
		vAlong = along;
		vSide = aSide;
	}
`;

/** 37-fx: `ribbon` — ONE strip through the slots in birth order, which in world space is
 * the path the emitter took (a sword swish, a comet, a car's tail light). Each quad joins
 * slot i (older) to slot i+1 (younger) and every vertex carries BOTH slots, so a quad can
 * see the seam — where i+1 is the older one, it was just reborn at the head — and fold
 * itself away. Needs equal lifetimes and no phase noise (the runtime zeroes both). */
export const ribbonVertexShader = /* glsl */ `
	attribute vec4 aRand;
	attribute vec4 aRand2;
	attribute float aIndex;
	attribute vec3 aOrigin;
	attribute vec3 aVel;
	attribute vec4 aRandN;   // the quad's OTHER slot
	attribute vec4 aRand2N;
	attribute float aIndexN;
	attribute vec3 aOriginN;
	attribute vec3 aVelN;
	attribute float aEnd;    // 0 = this vertex is the older slot's end, 1 = the younger's
	attribute float aSide;

	uniform float uRender;
	${SIM_COMMON}
	${STRIP_SIDE}

	varying float vLife;
	varying float vLanded;
	varying float vSeed;
	varying float vAlong;
	varying float vSide;

	void main() {
		float li;
		float alive;
		float liN;
		float aliveN;
		float age = slotAge(aRand, aRand2, aIndex, li, alive);
		float ageN = slotAge(aRandN, aRand2N, aIndexN, liN, aliveN);
		float landed;
		float lN;
		vec3 p = simPos(aRand, aRand2, aOrigin, aVel, age, li, landed);
		vec3 pN = simPos(aRandN, aRand2N, aOriginN, aVelN, ageN, liN, lN);
		float older = aEnd < 0.5 ? age : ageN;
		float younger = aEnd < 0.5 ? ageN : age;
		bool show = alive > 0.5 && aliveN > 0.5 && older >= younger;
		vec4 mv = modelViewMatrix * vec4(p, 1.0);
		vec3 path = (modelViewMatrix * vec4(aEnd < 0.5 ? pN - p : p - pN, 0.0)).xyz;
		float t = clamp(age / li, 0.0, 1.0);
		float width = mix(uSizeStart, uSizeEnd, t);
		mv.xyz += stripSide(path, mv.xyz) * aSide * width * 0.5;
		gl_Position = show ? projectionMatrix * mv : vec4(0.0, 0.0, 2.0, 1.0);
		vLife = t;
		vLanded = landed;
		vSeed = aRand.x;
		vAlong = t;
		vSide = aSide;
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
	varying float vLanded;
	uniform float uGround;

	void main() {
		vec2 c = gl_PointCoord - 0.5;
		float s = sin(vRot);
		float co = cos(vRot);
		vec4 tex = texture2D(uMap, vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5);
		float fadeIn = uFadeIn > 0.0 ? smoothstep(0.0, uFadeIn, vLife) : 1.0;
		float fadeOut = uFadeOut > 0.0 ? 1.0 - smoothstep(1.0 - uFadeOut, 1.0, vLife) : 1.0;
		vec3 col = mix(uColorStart, uColorEnd, uColorMode > 0.5 ? vSeed : vLife);
		float a = tex.a * uOpacity * fadeIn * fadeOut;
		if (vLanded > 0.0 && uGround < 1.5) a *= (1.0 - vLanded) * 0.8; // the splash fades out
		if (a < 0.01) discard;
		gl_FragColor = vec4(col * tex.rgb, a);
		#include <tonemapping_fragment>
		#include <colorspace_fragment>
	}
`;

/** 37-fx: stretch / trails / ribbon. A stretched quad shows the sprite laid along the motion;
 * a trail or a ribbon is a soft-edged band (a sprite repeated down a long path reads as
 * beads), a trail fading toward its tail and a ribbon by each slot's life. */
export const stripFragmentShader = /* glsl */ `
	uniform sampler2D uMap;
	uniform vec3 uColorStart;
	uniform vec3 uColorEnd;
	uniform float uColorMode;
	uniform float uOpacity;
	uniform float uFadeIn;
	uniform float uFadeOut;
	uniform float uGround;
	uniform float uRender;   // 1 stretch, 2 trails, 3 ribbon

	varying float vLife;
	varying float vLanded;
	varying float vSeed;
	varying float vAlong;
	varying float vSide;

	void main() {
		float fadeIn = uFadeIn > 0.0 ? smoothstep(0.0, uFadeIn, vLife) : 1.0;
		float fadeOut = uFadeOut > 0.0 ? 1.0 - smoothstep(1.0 - uFadeOut, 1.0, vLife) : 1.0;
		vec3 col = mix(uColorStart, uColorEnd, uColorMode > 0.5 ? vSeed : vLife);
		float a;
		if (uRender < 1.5) {
			vec4 tex = texture2D(uMap, vec2(vSide * 0.5 + 0.5, vAlong));
			a = tex.a;
			col *= tex.rgb;
		} else {
			a = 1.0 - vSide * vSide;
			if (uRender < 2.5) a *= 1.0 - vAlong;
		}
		a *= uOpacity * fadeIn * fadeOut;
		if (vLanded > 0.0 && uGround < 1.5) a *= (1.0 - vLanded) * 0.8;
		if (a < 0.01) discard;
		gl_FragColor = vec4(col, a);
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
