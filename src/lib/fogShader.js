// 102b-papercuts (scout row 18): HEIGHT FOG in three's own fog chunks. Installed ONCE at import, before any
// program compiles (environment.js imports it), so every material — built-in, ShaderMaterial (water,
// lines) — gets the same code. One shared uniform carries the layer: `fogHeight` = [base, 1/thickness,
// on, 0], a Float32Array that UniformsUtils.clone passes by REFERENCE (it copies three objects and real
// arrays only), so writing it reaches every material with no recompile. While it is [0,0,0,0] the
// shader takes the stock branch, so a scene without height fog renders exactly as before.
//
// Height fog rides FOG_EXP2 (scene.fog is a FogExp2 carrying the density); linear fog is untouched.
// World height comes from the view-space position the stock chunk already has (viewMatrix is rigid, so
// its inverse is a transpose: world y = column 1 of the rotation . (view position - translation)) — no new
// attribute, no worldpos chunk dependency.

// A LAZY chunk since the boot pass: environment.js imports it the first time a scene asks for height fog,
// and then asks every live material to recompile once (installHeightFog returns true on that first call).
import * as THREE from 'three';
import { HEIGHT_FOG } from './fogModes.js';

export { HEIGHT_FOG };

let installed = false;

/** @returns {boolean} true when this call installed the patch (materials compiled before it need a recompile) */
export function installHeightFog() {
	if (installed) return false;
	installed = true;
	const C = /** @type {any} */ (THREE.ShaderChunk);
	C.fog_pars_vertex = C.fog_pars_vertex.replace('varying float vFogDepth;', 'varying float vFogDepth;\n\tvarying float vFogWorldY;');
	C.fog_vertex = C.fog_vertex.replace(
		'vFogDepth = - mvPosition.z;',
		'vFogDepth = - mvPosition.z;\n\tvFogWorldY = dot( viewMatrix[ 1 ].xyz, mvPosition.xyz - viewMatrix[ 3 ].xyz );'
	);
	C.fog_pars_fragment = C.fog_pars_fragment.replace(
		'varying float vFogDepth;',
		'varying float vFogDepth;\n\tvarying float vFogWorldY;\n\tuniform vec4 fogHeight;'
	);
	C.fog_fragment = C.fog_fragment.replace(
		'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
		[
			'float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );',
			'\t\tif ( fogHeight.z > 0.5 ) {',
			'\t\t\tfloat fogK = fogHeight.y;',
			'\t\t\tfloat fogH0 = max( cameraPosition.y - fogHeight.x, 0.0 );',
			'\t\t\tfloat fogH1 = max( vFogWorldY - fogHeight.x, 0.0 );',
			'\t\t\tfloat fogDh = fogH1 - fogH0;',
			'\t\t\tfloat fogF = abs( fogDh ) > 1e-3 ? ( exp( - fogK * fogH0 ) - exp( - fogK * fogH1 ) ) / ( fogK * fogDh ) : exp( - fogK * fogH0 );',
			'\t\t\tfogFactor = 1.0 - exp( - fogDensity * vFogDepth * fogF );',
			'\t\t}'
		].join('\n')
	);
	// every built-in material that takes fog gets the shared slot (cloned by reference when it compiles)
	for (const lib of Object.values(/** @type {any} */ (THREE.ShaderLib)))
		if (lib?.uniforms?.fogColor && !lib.uniforms.fogHeight) lib.uniforms.fogHeight = { value: HEIGHT_FOG };
	/** @type {any} */ (THREE.UniformsLib.fog).fogHeight = { value: HEIGHT_FOG };
	return true;
}
