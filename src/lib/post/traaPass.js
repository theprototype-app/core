// 98 P3 — TRAA as a postprocessing Pass: jitter the projection each frame (from the registry's `tick`, BEFORE
// the beauty render), draw a velocity buffer (with the previous pose of every SkinnedMesh), reproject the
// history by it, clip to the current neighbourhood, blend. The projection is put back as soon as the pass has
// drawn, so picking, the gizmo and every later pass see the clean camera.
//
// Costs one extra scene draw (velocity) + one fullscreen resolve + one copy. Off in Play on a phone by default
// (traaCore.traaActive): then it is a plain copy with no jitter and no velocity draw.
import { CopyMaterial, Pass } from 'postprocessing';
import {
	DataTexture,
	FloatType,
	HalfFloatType,
	Matrix4,
	NoBlending,
	RGBAFormat,
	ShaderMaterial,
	UnsignedByteType,
	Vector2,
	Vector3,
	WebGLRenderTarget,
	Color
} from 'three';
import { applyJitter, isCameraCut, jitterAt } from './traaCore.js';
import { FULLSCREEN_VERT, RESOLVE_FRAG, VELOCITY_FRAG, VELOCITY_VERT } from './traaShaders.js';

const _clear = new Color();
const _pos = new Vector3();

/** the newest TRAA pass, for the post-finish suite (read through debugHooks only) */
/** @type {{last: any, renderer: any}} */
export const traaDebug = { last: null, renderer: null };

export class TRAAPass extends Pass {
	/** @param {any} scene @param {any} camera @param {{blend?: number}} [options] */
	constructor(scene, camera, options = {}) {
		super('TRAAPass');
		// postprocessing's Pass declares mainScene / mainCamera as SETTER-ONLY accessors (a plain assignment
		// is swallowed and a read gives undefined), so the views live in our own fields behind the accessors
		// overridden below — the composer's setMainCamera still reaches us through them.
		/** @type {any} */ this.viewScene = scene;
		/** @type {any} */ this.viewCamera = camera;
		/** set by the registry's tick: run the filter this frame (false = a plain copy) */
		this.active = true;
		this.blend = options.blend ?? 0.1;
		this.frame = 0;
		this.width = 1;
		this.height = 1;
		/** @type {any} */ this.cleanProjection = new Matrix4();
		/** @type {any} */ this.jitteredProjection = null;
		this.prevViewProj = new Matrix4();
		this.currViewProj = new Matrix4();
		/** @type {{camera: any, pos: number[]} | null} */ this.prevView = null;
		this.historyValid = false;
		/** @type {WeakMap<any, any>} previous matrixWorld per object */
		this.prevModel = new WeakMap();
		/** @type {WeakMap<any, any>} previous bone textures per SkinnedMesh ({tex: [2], read, fresh}) */
		this.prevBones = new WeakMap();
		/** @type {any[] | null} */ this.history = null;
		/** @type {any} */ this.velocity = null;
		this.velocityMaterial = this.makeVelocityMaterial();
		this.resolveMaterial = new ShaderMaterial({
			uniforms: {
				inputBuffer: { value: null },
				historyBuffer: { value: null },
				velocityBuffer: { value: null },
				currViewProjInverse: { value: new Matrix4() },
				prevViewProj: { value: new Matrix4() },
				texelSize: { value: new Vector2(1, 1) },
				blend: { value: this.blend },
				reset: { value: 1 }
			},
			vertexShader: FULLSCREEN_VERT,
			fragmentShader: RESOLVE_FRAG,
			blending: NoBlending,
			depthWrite: false,
			depthTest: false
		});
		this.copyMaterial = new CopyMaterial();
		this.fullscreenMaterial = this.copyMaterial;
	}

	makeVelocityMaterial() {
		const pass = this;
		const material = new ShaderMaterial({
			uniforms: {
				currViewProj: { value: new Matrix4() },
				prevViewProj: { value: new Matrix4() },
				prevModelMatrix: { value: new Matrix4() },
				prevBoneTexture: { value: null },
				hasPrevBones: { value: 0 }
			},
			vertexShader: VELOCITY_VERT,
			fragmentShader: VELOCITY_FRAG
		});
		// per object: its previous transform + (skinned) previous pose, then remember this frame's
		/** @type {any} */ (material).onBeforeRender = (/** @type {any} */ _r, /** @type {any} */ _s, /** @type {any} */ _c, /** @type {any} */ _g, /** @type {any} */ object) => {
			const u = material.uniforms;
			const prev = pass.prevModel.get(object);
			u.prevModelMatrix.value.copy(prev ?? object.matrixWorld);
			if (prev) prev.copy(object.matrixWorld);
			else pass.prevModel.set(object, object.matrixWorld.clone());
			u.hasPrevBones.value = 0;
			const skeleton = object.isSkinnedMesh ? object.skeleton : null;
			if (skeleton?.boneTexture) {
				let slot = pass.prevBones.get(object);
				const size = skeleton.boneTexture.image.width;
				if (!slot || slot.tex[0].image.width !== size) {
					const make = () => {
						const t = new DataTexture(new Float32Array(skeleton.boneMatrices), size, size, RGBAFormat, FloatType);
						t.needsUpdate = true;
						return t;
					};
					slot = { tex: [make(), make()], read: 0, fresh: true };
					pass.prevBones.set(object, slot);
				}
				u.prevBoneTexture.value = slot.tex[slot.read];
				u.hasPrevBones.value = slot.fresh ? 0 : 1;
				// write THIS frame's pose into the other texture (uploaded when it is bound next frame)
				const write = slot.tex[1 - slot.read];
				write.image.data.set(skeleton.boneMatrices);
				write.needsUpdate = true;
				slot.read = 1 - slot.read;
				slot.fresh = false;
			}
			material.uniformsNeedUpdate = true;
		};
		return material;
	}

	get mainCamera() {
		return this.viewCamera;
	}
	set mainCamera(camera) {
		this.setMainCamera(camera);
	}
	get mainScene() {
		return this.viewScene;
	}
	set mainScene(scene) {
		this.viewScene = scene;
	}

	/** @param {any} camera */
	setMainCamera(camera) {
		if (camera === this.viewCamera) return;
		this.restoreProjection();
		this.viewCamera = camera;
		this.historyValid = false;
	}

	/** @param {number} width @param {number} height */
	setSize(width, height) {
		this.width = Math.max(1, width);
		this.height = Math.max(1, height);
		for (const target of this.history ?? []) target.setSize(this.width, this.height);
		this.velocity?.setSize(this.width, this.height);
		this.resolveMaterial.uniforms.texelSize.value.set(1 / this.width, 1 / this.height);
		this.historyValid = false;
	}

	/** Put back the camera's clean projection if our jittered one is still on it. */
	restoreProjection() {
		const cam = this.viewCamera;
		if (cam && this.jitteredProjection && cam.projectionMatrix.equals(this.jitteredProjection)) {
			cam.projectionMatrix.copy(this.cleanProjection);
			cam.projectionMatrixInverse.copy(this.cleanProjection).invert();
		}
		this.jitteredProjection = null;
	}

	/** Called by the registry's tick before the composer renders: jitter for this frame's beauty pass. */
	prepareFrame() {
		this.restoreProjection();
		const cam = this.viewCamera;
		if (!cam || !this.active) {
			this.historyValid = false;
			return;
		}
		this.cleanProjection.copy(cam.projectionMatrix);
		this.frame++;
		applyJitter(cam.projectionMatrix.elements, jitterAt(this.frame), this.width, this.height);
		cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
		this.jitteredProjection = cam.projectionMatrix.clone();
	}

	/** @param {any} renderer */
	ensureTargets(renderer) {
		if (this.history) return;
		const floatOk = renderer.capabilities?.isWebGL2 && renderer.extensions?.has?.('EXT_color_buffer_float');
		const type = floatOk ? HalfFloatType : UnsignedByteType;
		const make = () => new WebGLRenderTarget(this.width, this.height, { type, depthBuffer: false });
		this.history = [make(), make()];
		this.velocity = new WebGLRenderTarget(this.width, this.height, { type: floatOk ? HalfFloatType : UnsignedByteType, depthBuffer: true });
	}

	/** @param {any} renderer @param {any} inputBuffer @param {any} outputBuffer */
	render(renderer, inputBuffer, outputBuffer) {
		const target = this.renderToScreen ? null : outputBuffer;
		const cam = this.viewCamera;
		if (!this.active || !cam) {
			this.copyMaterial.inputBuffer = inputBuffer.texture;
			this.fullscreenMaterial = this.copyMaterial;
			renderer.setRenderTarget(target);
			renderer.render(this.scene, this.camera);
			return;
		}
		this.ensureTargets(renderer);
		traaDebug.last = this;
		traaDebug.renderer = renderer;
		const history = /** @type {any[]} */ (this.history);
		// the CLEAN view-projection (velocity must not carry the jitter, or a still scene would shimmer)
		cam.updateMatrixWorld();
		this.currViewProj.multiplyMatrices(this.cleanProjection, cam.matrixWorldInverse);
		cam.getWorldPosition(_pos);
		const view = { camera: cam, pos: [_pos.x, _pos.y, _pos.z] };
		const reset = !this.historyValid || isCameraCut(this.prevView, view);
		if (reset) this.prevViewProj.copy(this.currViewProj);

		// 1. velocity
		const vu = this.velocityMaterial.uniforms;
		vu.currViewProj.value.copy(this.currViewProj);
		vu.prevViewProj.value.copy(this.prevViewProj);
		const scene = this.viewScene;
		const override = scene.overrideMaterial;
		const background = scene.background;
		renderer.getClearColor(_clear);
		const clearAlpha = renderer.getClearAlpha();
		// the shadow maps were drawn by the beauty pass this frame: a second scene draw must not redraw them
		const shadowMap = renderer.shadowMap;
		const shadowAuto = shadowMap.autoUpdate;
		shadowMap.autoUpdate = false;
		scene.overrideMaterial = this.velocityMaterial;
		scene.background = null;
		renderer.setClearColor(0x000000, 0);
		renderer.setRenderTarget(this.velocity);
		renderer.clear();
		renderer.render(scene, cam);
		scene.overrideMaterial = override;
		scene.background = background;
		shadowMap.autoUpdate = shadowAuto;
		renderer.setClearColor(_clear, clearAlpha);

		// 2. resolve into the write history
		const write = history[this.frame % 2];
		const read = history[1 - (this.frame % 2)];
		const ru = this.resolveMaterial.uniforms;
		ru.inputBuffer.value = inputBuffer.texture;
		ru.historyBuffer.value = read.texture;
		ru.velocityBuffer.value = this.velocity.texture;
		ru.currViewProjInverse.value.copy(this.currViewProj).invert();
		ru.prevViewProj.value.copy(this.prevViewProj);
		ru.blend.value = this.blend;
		ru.reset.value = reset ? 1 : 0;
		this.fullscreenMaterial = /** @type {any} */ (this.resolveMaterial);
		renderer.setRenderTarget(write);
		renderer.render(this.scene, this.camera);

		// 3. present
		this.copyMaterial.inputBuffer = write.texture;
		this.fullscreenMaterial = this.copyMaterial;
		renderer.setRenderTarget(target);
		renderer.render(this.scene, this.camera);

		this.prevViewProj.copy(this.currViewProj);
		this.prevView = view;
		this.historyValid = true;
		this.restoreProjection();
	}

	dispose() {
		this.restoreProjection();
		for (const target of this.history ?? []) target.dispose();
		this.velocity?.dispose();
		this.velocityMaterial.dispose();
		this.resolveMaterial.dispose();
		this.copyMaterial.dispose();
		super.dispose();
	}
}
