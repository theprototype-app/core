// 100 C1 — RENDERER GENERATIONS AND THEIR DISPOSE LISTENERS (lazy: loaded with the Cinematic view).
//
// THE LEAK (100-light addendum, heap snapshot diff): three registers `dispose` listeners on every live geometry,
// texture, material and render target for the renderer that drew them. A WebGL context restore runs
// `initGLContext()`, which builds a NEW manager set (WebGLGeometries / WebGLTextures / WebGLBindingStates /
// WebGLPrograms / WebGLProperties …) while the old set's listeners stay attached to the live objects; and
// `WebGPURenderer.dispose()` leaves its own (Geometries, Textures, Background, RenderObjects, a light's shadow).
// Each dead generation stays reachable from the scene through those closures: ~3 MB per switch on the Tavern.
//
// THE FIX, from our side (no patched or vendored three): from the first switch on, every `dispose` listener
// added is recorded with the ERA it was added in — `gl:N` while the WebGL renderer draws, `gpu:K` while the
// Cinematic view does — and when a generation dies its era's listeners are removed. Listeners the app adds
// itself are marked `__keep` (ktx2Twins, the render-target registry) and never removed. Removing three's
// persistent `onMaterialDispose` with a dead era is safe: a restored context starts with an empty
// WebGLProperties, so the next draw of that material adds it again.
//
// Generation 0 (the boot's WebGL context) drew before this module existed. For it: the three per-generation
// closures (onGeometryDispose / onTextureDispose / onRenderTargetDispose) are learned from probe objects just
// before the context goes, and removed from everything reachable (the scene, its materials' textures, the
// environment, the registered render targets) and from any object later code touches. Its WebGLProperties
// (programs, uniforms, texture handles per object) is cleared outright, which is the bulk of it either way.
import * as THREE from 'three';
import { renderTargetList } from './renderTargets.js';
import { safeStorage } from '../safeStorage';

/** the memory e2e's control run: `debugNoGenPrune` = '1' leaves every listener where three put it */
const noPrune = () => safeStorage.getItem('debugNoGenPrune') === '1';

/** @typedef {[WeakRef<any>, Function]} Pair */

const G = {
	installed: false,
	/** @type {string | null} the era listeners are added in */
	era: null,
	gl: 0,
	gpu: 0,
	/** @type {Map<string, Pair[]>} */
	pairs: new Map(),
	/** @type {Set<Function>} generation-0 closures, removed wherever they are met */
	dead0: new Set(),
	stats: { recorded: 0, pruned: 0, swept: 0, lazy: 0, propsCleared: 0 }
};

const add = THREE.EventDispatcher.prototype.addEventListener;

/** a listener the app owns (never pruned with a renderer generation) @param {any} fn */
const kept = (fn) => !!fn?.__keep;

function install() {
	if (G.installed) return;
	G.installed = true;
	G.era = 'gl:' + G.gl;
	THREE.EventDispatcher.prototype.addEventListener = function (/** @type {any} */ type, /** @type {any} */ listener) {
		if (type === 'dispose') {
			const self = /** @type {any} */ (this);
			const list = self._listeners?.dispose;
			if (G.dead0.size && list?.length) dropDead0(self, list);
			if (G.era && !kept(listener) && !list?.includes(listener)) {
				let a = G.pairs.get(G.era);
				if (!a) G.pairs.set(G.era, (a = []));
				a.push([new WeakRef(self), listener]);
				G.stats.recorded++;
			}
		}
		return add.call(this, type, listener);
	};
}

/** @param {any} target @param {Function[]} list */
function dropDead0(target, list) {
	for (const l of [...list]) {
		if (G.dead0.has(l)) {
			target.removeEventListener('dispose', l);
			G.stats.lazy++;
		}
	}
}

/** @param {string} era */
function prune(era) {
	const a = G.pairs.get(era);
	G.pairs.delete(era);
	let n = 0;
	for (const [ref, l] of a ?? []) {
		const t = ref.deref();
		if (t?._listeners?.dispose?.includes(l)) {
			t.removeEventListener('dispose', l);
			n++;
		}
	}
	G.stats.pruned += n;
	return n;
}

/**
 * Generation 0's per-generation closures, learned from probe objects the WebGL renderer has to set up (they are
 * one function per manager, shared by every object it ever touched).
 * @param {any} gl
 */
function learnGeneration0(gl) {
	/** @type {Set<Function>} */
	const found = new Set();
	const before = G.era;
	G.era = null; // the probes are not anybody's era
	const watch = (/** @type {any} */ t) => {
		const seen = new Set(t._listeners?.dispose ?? []);
		return () => {
			for (const l of t._listeners?.dispose ?? []) if (!seen.has(l) && !kept(l)) found.add(l);
		};
	};
	const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
	tex.needsUpdate = true;
	const rt = new THREE.WebGLRenderTarget(1, 1);
	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
	const mat = new THREE.MeshBasicMaterial({ map: tex });
	const scene = new THREE.Scene();
	scene.add(new THREE.Mesh(geo, mat));
	const cam = new THREE.OrthographicCamera();
	const done = [watch(tex), watch(rt), watch(geo)];
	const prevTarget = gl.getRenderTarget();
	try {
		gl.setRenderTarget(rt);
		gl.render(scene, cam);
	} catch {
		/* a probe that fails teaches nothing: generation 0 then keeps its listeners (bounded, once) */
	} finally {
		gl.setRenderTarget(prevTarget);
		for (const d of done) d();
		G.era = before;
		geo.dispose();
		mat.dispose();
		tex.dispose();
		rt.dispose();
	}
	return found;
}

/** everything reachable that generation 0 may have listened on @param {any} scene */
function* reachable(scene) {
	/** @type {Set<any>} */
	const seen = new Set();
	/** @param {any} t */
	function* tex(t) {
		if (!t?.isTexture || seen.has(t)) return;
		seen.add(t);
		yield t;
	}
	/** @param {any} m */
	function* material(m) {
		if (!m || seen.has(m)) return;
		seen.add(m);
		yield m;
		for (const v of Object.values(m)) yield* tex(v);
		for (const u of Object.values(m.uniforms ?? {})) yield* tex(/** @type {any} */ (u)?.value);
	}
	yield* tex(scene.environment);
	yield* tex(scene.background);
	/** @type {any[]} */
	const objects = [];
	scene.traverse((/** @type {any} */ o) => objects.push(o));
	for (const o of objects) {
		if (o.geometry && !seen.has(o.geometry)) {
			seen.add(o.geometry);
			yield o.geometry;
		}
		for (const m of Array.isArray(o.material) ? o.material : [o.material]) yield* material(m);
		const map = o.shadow?.map;
		if (map && !seen.has(map)) {
			seen.add(map);
			yield map;
			yield* tex(map.texture);
		}
	}
	for (const rt of renderTargetList()) {
		if (seen.has(rt)) continue;
		seen.add(rt);
		yield rt;
		for (const t of rt.textures ?? [rt.texture]) yield* tex(t);
		yield* tex(rt.depthTexture);
	}
}

/**
 * The main WebGL context is about to go (the switch to the Cinematic view). Call BEFORE `releaseMainContext`.
 * Returns what to call once the context is lost (the generation is then dead).
 * @param {any} gl @param {any} scene
 */
export function glGenerationEnding(gl, scene) {
	if (noPrune()) return () => 0;
	const first = !G.installed;
	const dead0 = first ? learnGeneration0(gl) : null;
	install();
	const props = gl.properties;
	const era = 'gl:' + G.gl;
	return () => {
		G.era = null;
		const n = prune(era);
		if (dead0?.size) {
			for (const l of dead0) G.dead0.add(l);
			for (const t of reachable(scene)) {
				for (const l of [...(t._listeners?.dispose ?? [])]) {
					if (G.dead0.has(l)) {
						t.removeEventListener('dispose', l);
						G.stats.swept++;
					}
				}
			}
		}
		// the dead generation's per-object state (programs, uniform caches, texture and buffer handles)
		try {
			props?.dispose?.();
			G.stats.propsCleared++;
		} catch {
			/* nothing to clear */
		}
		G.gl++;
		return n;
	};
}

/** a WebGPU renderer starts drawing (the view is on) @returns {string} its era */
export function gpuGenerationStarting() {
	if (noPrune()) return 'off';
	install();
	G.era = 'gpu:' + ++G.gpu;
	return G.era;
}

/** that WebGPU renderer was disposed: its era's listeners go @param {string} era */
export function gpuGenerationEnded(era) {
	if (era === 'off') return 0;
	if (G.era === era) G.era = null;
	return prune(era);
}

/** the WebGL renderer draws again (its context was restored) */
export function glGenerationStarting() {
	if (noPrune()) return 'off';
	install();
	G.era = 'gl:' + G.gl;
	return G.era;
}

/** for the memory e2e and the debug hook */
export function generationStats() {
	return { ...G.stats, off: noPrune(), era: G.era, gl: G.gl, gpu: G.gpu, tracked: [...G.pairs.entries()].map(([k, v]) => [k, v.length]), dead0: G.dead0.size };
}
