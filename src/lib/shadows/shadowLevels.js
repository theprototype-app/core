// 106 S1 — Soft and Far, the LAZY half (environment.js loads it the first time a scene's drawn level is Soft or
// Far; Basic and Off never load it). The rules in shadowLevelCore.js; this file only writes them onto lights.
//
// WHAT IS TOUCHED, and why nothing of it reaches a save or the wire:
//   · the environment RIG SUN lives in ENV_ROOT, which never enters a save or object sync, so its shadow may be
//     swapped freely: Far gives it a SunLightShadow (three r186's two-cascade sun shadow, rendered by the
//     WebGL renderer's own sun-light path: one atlas, no shader patch, no per-material setup) and flags the
//     instance `isSunLight`, which WebGLLights tests BEFORE isDirectionalLight. The rig sun's target sits at the
//     origin, so "direction = position" (the sun-light convention) is exactly the direction it already has.
//   · an AUTHORED light's shadow radius IS serialized (LightShadow.toJSON writes it), so Soft's wider kernel on
//     an authored light is written through a toJSON guard: the save and the wire always carry the authored
//     radius, the screen draws the level's.
// Going back to Basic restores every original, so Basic after Soft / Far is today's Basic again.
import * as THREE from 'three';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { cappedShadowSize, contactShadowsWanted } from '../lightParams';
import { registerContactShadows } from './contactShadows.js';
import { levelParams, cascadeReach, contactShadowsOn } from './shadowLevelCore.js';

/** shadow -> its authored radius, while a level overrides it */
const radiusBack = new WeakMap();
/** the rig sun -> its own DirectionalLightShadow, while Far gives it cascades */
const cascadeBack = new WeakMap();

const state = { drawn: 'basic', tier: 'pc', contact: false, sweep: /** @type {any} */ (null), sun: /** @type {any} */ (null), applies: 0 };

let guarded = false;
/** LightShadow.toJSON writes the AUTHORED radius while a level overrides it (the guard costs one WeakMap read). */
function guardToJSON() {
	if (guarded) return;
	guarded = true;
	const proto = /** @type {any} */ (THREE.LightShadow.prototype);
	const original = proto.toJSON;
	proto.toJSON = function () {
		if (!radiusBack.has(this)) return original.call(this);
		const live = this.radius;
		this.radius = radiusBack.get(this);
		try {
			return original.call(this);
		} finally {
			this.radius = live;
		}
	};
}

/** @param {any} shadow @param {number} radius */
function setRadius(shadow, radius) {
	if (!shadow) return;
	if (!radiusBack.has(shadow)) radiusBack.set(shadow, shadow.radius);
	shadow.radius = radius;
}

/** @param {any} shadow */
function restoreRadius(shadow) {
	if (!shadow || !radiusBack.has(shadow)) return;
	shadow.radius = radiusBack.get(shadow);
	radiusBack.delete(shadow);
}

/** Give the rig sun its two cascades. @param {any} sun @param {number} reach @param {number} radius */
function cascadeOn(sun, reach, radius) {
	if (!cascadeBack.has(sun)) {
		const own = sun.shadow;
		const s = new SunLightShadow();
		s.bias = own.bias;
		s.normalBias = own.normalBias;
		s.intensity = own.intensity;
		cascadeBack.set(sun, own);
		sun.shadow = s;
		sun.isSunLight = true;
	}
	const s = sun.shadow;
	const size = cappedShadowSize(levelParams('far').cascadeMap);
	if (s.mapSize.x !== size) {
		s.mapSize.set(size, size);
		s.map?.dispose();
		s.map = null;
	}
	// the cascades span the camera's near plane to this reach (the view camera's far when that is nearer)
	s.camera.far = reach;
	s.radius = radius;
}

/** @param {any} sun */
function cascadeOff(sun) {
	const own = cascadeBack.get(sun);
	if (!own) return;
	sun.shadow.map?.dispose();
	sun.shadow.dispose?.();
	sun.shadow = own;
	delete sun.isSunLight;
	cascadeBack.delete(sun);
}

/** Every authored shadow-casting light (objectsGroup). @param {(l: any) => void} fn */
function eachAuthoredLight(fn) {
	get(objectsGroup)?.traverse?.((/** @type {any} */ o) => {
		if (o.isLight && o.shadow && !o.isSunLight) fn(o);
	});
}

/** Soft's kernel on authored lights added after the apply (cheap: one traverse a second, only while Soft / Far). */
function sweepAuthored() {
	const p = levelParams(/** @type {any} */ (state.drawn));
	eachAuthoredLight((l) => {
		if (l.shadow.radius !== p.radius) setRadius(l.shadow, p.radius);
	});
}

/**
 * Apply the drawn level. Called at the tail of every applyEnvironment once this module is loaded.
 * @param {{scene: any, renderer: any, sun: any, drawn: 'off'|'basic'|'soft'|'far', tier: 'pc'|'phone'|'quest', radius: number}} input
 */
export function applyShadowLevel({ sun, drawn, tier, radius }) {
	state.applies++;
	state.tier = tier;
	const lifted = drawn === 'soft' || drawn === 'far';
	state.drawn = drawn;
	state.contact = contactShadowsOn(drawn, tier);
	if (state.contact) registerContactShadows();
	if (get(contactShadowsWanted) !== state.contact) contactShadowsWanted.set(state.contact);
	if (!lifted) {
		// Basic / Off: put back everything a level wrote
		if (state.sun) cascadeOff(state.sun);
		if (sun) cascadeOff(sun);
		restoreRadius(sun?.shadow);
		eachAuthoredLight((l) => restoreRadius(l.shadow));
		if (state.sweep) clearInterval(state.sweep);
		state.sweep = null;
		state.sun = null;
		return;
	}
	guardToJSON();
	const p = levelParams(drawn);
	if (sun) {
		if (p.cascades) {
			// Soft -> Far: the directional shadow goes back to its own radius before it is set aside
			if (!cascadeBack.has(sun)) restoreRadius(sun.shadow);
			cascadeOn(sun, cascadeReach(radius, p.reach), p.radius);
		} else {
			cascadeOff(sun);
			setRadius(sun.shadow, p.radius);
		}
		state.sun = sun;
	}
	sweepAuthored();
	if (!state.sweep && typeof setInterval === 'function') state.sweep = setInterval(sweepAuthored, 1000);
}

/** For the suites and the S0 driver. */
export function shadowLevelDebug() {
	const sun = state.sun;
	const s = sun?.shadow;
	return {
		drawn: state.drawn,
		tier: state.tier,
		contact: state.contact,
		applies: state.applies,
		sun: sun
			? {
					cascades: !!sun.isSunLight,
					radius: s?.radius,
					mapSize: s?.mapSize?.x,
					reach: s?.camera?.far,
					atlas: s?.map ? [s.map.width, s.map.height] : null,
					splits: s?._cascadeSplits ? [...s._cascadeSplits].map((v) => +v.toFixed(2)) : null
				}
			: null
	};
}
