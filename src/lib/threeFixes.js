// 36-fb-water F14: fixes for three.js JSON round trips, installed once by side-effect import.
//
// THE JELLY ROOM WAS BLACK. A MeshPhysicalMaterial's `attenuationDistance` defaults to
// Infinity, three's toJSON writes it as is, and JSON.stringify turns Infinity into `null` —
// so every save, autosave, wire copy and undo snapshot of a transmissive material came back
// with attenuationDistance null (= 0 in the shader). Its volume attenuation is then
// -log(attenuationColor) / 0: 0/0 for the default white, NaN, a black object. A fresh
// material renders; the same material after any JSON trip does not (measured in Jelly room).
// The loader reads the JSON, so the loader is where Infinity comes back.
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';

const KEY = '__tpFromJsonFixed';
const proto = /** @type {any} */ (THREE.Material.prototype);
if (!proto[KEY]) {
	proto[KEY] = true;
	const fromJSON = proto.fromJSON;
	/** @this {any} @param {any} json @param {any} textures */
	proto.fromJSON = function (json, textures) {
		const out = fromJSON.call(this, json, textures);
		if (json && 'attenuationDistance' in json && !(json.attenuationDistance > 0)) this.attenuationDistance = Infinity;
		return out;
	};
}

/** for tests: is the fix installed */
export const threeFixesInstalled = true;
