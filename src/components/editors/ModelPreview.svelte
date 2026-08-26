<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { untrack } from 'svelte'
	import { itemBlob, parseObjectFile } from '$lib/explorer'
	import { prefabObject } from '$lib/prefabs'

	// N4: a self-contained (non-Threlte) three.js canvas that renders an Explorer
	// object item, auto-fits it, spins gently, and lets you drag to rotate. Reports
	// tris/verts/meshes via onStats. Reused by the Properties inline preview and the
	// floating ModelPreviewWindow. Fully disposes its GL context on teardown.
	// 21-H2: TWO sources now. `itemId` resolves an Explorer item to a blob and parses the
	// file; `prefabId` parses the stored prefab JSON through the shared `prefabObject`
	// seam (a prefab is not an item, which is why this could not already show one). Pass
	// exactly one.
	let {
		itemId = '',
		prefabId = '',
		name = '',
		autoSpin = true,
		autoPlay = true,
		onStats,
		onToggleSpin,
		onAnim
	}: {
		itemId?: string
		prefabId?: string
		name?: string
		autoSpin?: boolean
		/** R22 round 15: whether an animated file starts PLAYING. The pref's value at
		 * opening time; the live state after that belongs to the transport. */
		autoPlay?: boolean
		onStats?: (s: any) => void
		/** the user CLICKED without dragging — the turntable's ONLY on/off switch */
		onToggleSpin?: () => void
		/** R22 round 15: does this file animate, and where is its playhead. `{clips, index,
		 * duration, playing, time}` on load and on every change; `null` for a still file. */
		onAnim?: (a: any) => void
	} = $props()

	/**
	 * R22 round 15 — the transport handle. The mixer is built inside the render effect
	 * (it is advanced by that loop's delta and by nothing else), so the three calls the
	 * window needs are published here and delegate inward. A window holding a preview
	 * whose model has not loaded yet simply gets no-ops, which is the honest behaviour:
	 * there is nothing to play.
	 */
	let animApi: { play: (on: boolean) => void; seek: (t: number) => void; clip: (i: number) => void } | null =
		null
	export function setAnimPlaying(on: boolean) {
		animApi?.play(on)
	}
	export function seekAnim(t: number) {
		animApi?.seek(t)
	}
	export function setAnimClip(i: number) {
		animApi?.clip(i)
	}

	/** the live spin flag the render loop reads. A plain `let` on purpose — see the long
	 * note inside the effect for why reading the PROP there tore the GL context down. */
	// the initial read is deliberate — the $effect below is what keeps it live
	// svelte-ignore state_referenced_locally
	let spinNow = autoSpin
	$effect(() => {
		spinNow = autoSpin
	})

	let canvas: HTMLCanvasElement | undefined = $state()

	/** how far a press may travel and still count as a click (the marquee's own slop) */
	const DRAG_SLOP = 4

	$effect(() => {
		if (!canvas) return
		const el = canvas
		const id = itemId
		const prefab = prefabId
		const fileName = name
		let raf = 0
		let disposed = false
		let dragging = false
		let model: any = null

		// 21-H2 — READ THE CALLBACK OUT OF THE TRACKED SCOPE. Every consumer passes an
		// INLINE arrow (`onStats={(s) => (stats = s)}`), which is a new function on each
		// parent render, so touching the prop inside this effect makes the effect re-run
		// whenever the parent merely re-renders. That tears the renderer down
		// (forceContextLoss) and immediately asks the SAME canvas element for a new
		// context, which returns null — three then throws "cannot read properties of null
		// (reading 'precision')" from inside the effect and takes the whole svelte flush
		// with it, so unrelated UI (here: the pop-out that was opening) never mounts. The
		// item source was accidentally safe because it only touched `onStats` after an
		// `await`; the prefab source is synchronous and had no such luck.
		const report = untrack(() => onStats)
		const reportAnim = untrack(() => onAnim)
		const startPlaying = untrack(() => autoPlay)

		/**
		 * R22 ROUND 15 — THE ANIMATION TRANSPORT.
		 *
		 * The mixer lives HERE, beside the render loop that has to advance it, rather than
		 * in the window above: a mixer is driven by a per-frame delta, and the only place
		 * that owns one is the loop. The window drives it through the three exported calls
		 * below, which is the same shape `onToggleSpin` already uses — this component owns
		 * the three.js, the window owns the chrome.
		 *
		 * PAUSE IS `action.paused`, NOT "stop updating the mixer". Freezing the mixer looks
		 * identical while the model is still, and is wrong the moment anything else moves:
		 * the delta the loop keeps feeding would be swallowed and the pose would jump when
		 * you resumed. Paused actions hold their time and let the mixer keep ticking.
		 */
		let mixer: any = null
		let action: any = null
		let clips: any[] = []
		let clipIndex = 0
		let animPlaying = false
		/** the readout is published on a ~15Hz gate. A number written 60 times a second
		 * flushes svelte 60 times a second for a reading nobody can follow at that rate;
		 * the browser's own `timeupdate` fires about four. */
		let lastPublish = 0

		const animState = () => ({
			clips: clips.map((c: any) => ({ name: c.name || 'Clip', duration: c.duration })),
			index: clipIndex,
			duration: clips[clipIndex]?.duration ?? 0,
			playing: animPlaying,
			time: action ? action.time : 0
		})
		const publishAnim = () => reportAnim?.(clips.length ? animState() : null)

		const useClip = (i: number, play: boolean) => {
			if (!mixer || !clips[i]) return
			action?.stop()
			clipIndex = i
			action = mixer.clipAction(clips[i])
			action.reset()
			action.play()
			action.paused = !play
			animPlaying = play
			mixer.update(0)
			publishAnim()
		}

		/** play/pause, reached from the top-level export below. */
		const playAnim = (on: boolean) => {
			if (!action) return
			// a transport asked to play from the very end restarts, or the button does
			// nothing and looks broken (every video player does this)
			const d = clips[clipIndex]?.duration ?? 0
			if (on && d && action.time >= d - 1e-4) action.time = 0
			action.paused = !on
			animPlaying = on
			publishAnim()
		}
		/** scrub. The mixer is nudged by ZERO so the pose lands on the new time without any
		 * time passing — the same trick a timeline scrub uses. */
		const seekTo = (t: number) => {
			if (!action || !mixer) return
			const d = clips[clipIndex]?.duration ?? 0
			action.time = Math.max(0, Math.min(d, t))
			mixer.update(0)
			publishAnim()
		}
		const pickClip = (i: number) => useClip(i, animPlaying)
		// the window drives the transport through this handle, the same way it
		// already holds the AudioPlayer
		animApi = { play: playAnim, seek: seekTo, clip: pickClip }

		// R22 round 13 — WHY `autoSpin` IS NOT READ DIRECTLY, and it is the same hazard the
		// note above describes reached by a different door.
		//
		// `loop()` is CALLED SYNCHRONOUSLY at the end of this effect body, and that first
		// call reads `autoSpin` INSIDE the tracking scope — so the effect depends on it, and
		// toggling the checkbox tore the renderer down (forceContextLoss) and asked the same
		// canvas for a second context, which returns null. MEASURED: the frames stopped
		// changing, which looks like the feature working, while the PNG of the body collapsed
		// from ~68KB to 18KB — the object had stopped being DRAWN. Reported as "when
		// auto-rotate is clicked it should stop rotating, now it just stops showing".
		//
		// So the loop reads a plain `let` that a SEPARATE tiny effect keeps current: no
		// dependency in the render effect, and the value is still live on the next frame.
		// (Checking that the canvas element survived was blind to this — the ELEMENT lives
		// through a teardown; only its context dies.)

		// 21-H2: THIS component clears the stats for a new source, rather than each
		// consumer clearing them beside its own `{#key}` — the prefab source reports
		// synchronously, so a consumer's "reset on target change" effect could otherwise
		// run afterwards and blank the box. One writer, no ordering to get right.
		report?.(null)

		// A canvas cannot hand out a second context, and a browser will refuse one when
		// too many are already live. Failing here must not throw into the flush.
		let renderer: any
		try {
			renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true })
		} catch (error) {
			console.log('model preview: no WebGL context', error)
			return
		}
		renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
		const scene = new THREE.Scene()
		scene.add(new THREE.HemisphereLight(0xffffff, 0x445, 2.2))
		const dir = new THREE.DirectionalLight(0xffffff, 1.1)
		dir.position.set(1, 2, 1.5)
		scene.add(dir)
		const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100)
		const pivot = new THREE.Group()
		scene.add(pivot)

		// the view, as three numbers — see the fit below
		let modelSize = 1
		let homeDist = 1
		let tilt = 0
		let dist = 1
		let panX = 0
		let panY = 0
		/** where the camera is, given the current dist/pan. Pans move the camera AND its
		 * look-at together, which is what makes the model slide rather than swing. */
		const placeCamera = () => {
			camera.position.set(panX, panY + tilt, dist)
			camera.lookAt(panX, panY, 0)
		}

		const resize = () => {
			const w = el.clientWidth || 1
			const h = el.clientHeight || 1
			renderer.setSize(w, h, false)
			camera.aspect = w / h
			camera.updateProjectionMatrix()
		}

		;(async () => {
			let obj: any
			if (prefab) {
				// the prefab source is SYNCHRONOUS (JSON already in memory) — no blob, no
				// file parse; still inside the async body so both sources share the fit,
				// the stats and the disposal guard below.
				obj = prefabObject(prefab)
				if (disposed || !obj) return
			} else {
				let blob
				try {
					blob = await itemBlob(id)
				} catch {
					return
				}
				if (!blob || disposed) return
				const buffer = await blob.arrayBuffer()
				const ext = (fileName.split('.').pop() || 'glb').toLowerCase()
				try {
					obj = await parseObjectFile(buffer, ext)
				} catch {
					return
				}
			}
			if (disposed || !obj) return
			model = obj
			// the clips ride ON the object (see explorer.js's parse). An FBX carries them
			// itself; a glTF's are attached there.
			clips = Array.isArray(obj.animations) ? obj.animations.filter((c: any) => c?.duration > 0) : []
			if (clips.length) {
				mixer = new THREE.AnimationMixer(obj)
				useClip(0, startPlaying)
			} else {
				publishAnim()
			}
			const box = new THREE.Box3().setFromObject(obj)
			if (!isFinite(box.min.x)) return
			const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001)
			const center = box.getCenter(new THREE.Vector3())
			obj.position.sub(center) // center on the pivot so rotation orbits the model
			pivot.add(obj)
			camera.near = size / 100
			camera.far = size * 10
			// R22 round 13 (user): "it should be possible to pan and zoom objects". The frame
			// this fit produces is the HOME view; `placeCamera` re-derives the camera from
			// {dist, panX, panY} every time one of them moves, and a double-click puts all
			// three back. Rotation stays on the PIVOT (the model orbits), so the camera only
			// ever has to answer where it is looking from and at.
			modelSize = size
			homeDist = size * 1.1
			tilt = size * 0.12
			dist = homeDist
			panX = 0
			panY = 0
			placeCamera()
			camera.updateProjectionMatrix()
			// stats
			let tris = 0
			let verts = 0
			let meshes = 0
			obj.traverse((o: any) => {
				if (o.isMesh && o.geometry) {
					meshes++
					const g = o.geometry
					const p = g.attributes?.position?.count ?? 0
					verts += p
					tris += g.index ? g.index.count / 3 : p / 3
				}
			})
			report?.({ tris: Math.round(tris), verts, meshes })
			resize()
		})()

		/**
		 * THE STANDARD DCC SET, which is what makes it feel like nothing: LEFT drag orbits,
		 * MIDDLE (or Shift + left) pans, the WHEEL dollies, and a double-click puts the view
		 * home. Middle is the one every DCC agrees on for pan; Shift+left is the fallback for
		 * a trackpad with no middle button.
		 *
		 * TAKING CONTROL STOPS THE TURNTABLE. Dragging tells `onTakeControl` so the caller
		 * can switch auto-rotate off — the behaviour every model viewer has, and the one that
		 * makes "it will stop at a place where I will stop rotating" true without the user
		 * having to find a checkbox first.
		 */
		let panning = false
		let travelled = 0
		const down = (e: PointerEvent) => {
			panning = e.button === 1 || e.shiftKey
			dragging = true
			travelled = 0
			el.setPointerCapture(e.pointerId)
			if (e.button === 1) e.preventDefault() // middle-drag would autoscroll
		}
		const move = (e: PointerEvent) => {
			if (!dragging) return
			travelled += Math.abs(e.movementX) + Math.abs(e.movementY)
			// R22 round 13: a press that TRAVELS is a rotate; a press that does not is the
			// SWITCH. Same rule the mesh and UV editors keep wherever one control carries two
			// gestures, and it is what lets the model itself be the on/off without costing
			// anyone the ability to drag it.
			//
			// A DRAG ONLY PAUSES THE TURNTABLE — the `!dragging` term in the loop does that,
			// and it picks up again on release. An earlier pass had dragging switch it off
			// for good, on the reasoning that you had "taken over"; the user's rule is better
			// and simpler: "after rotating manually object if not clicked to disable rotation
			// it should continue to rotate". One way in, one way out, and nudging the model
			// to see the other side does not silently cost you the turntable.
			if (panning) {
				// scaled by DISTANCE, so a pan covers the same amount of screen at any zoom
				const k = (dist / Math.max(1, el.clientHeight)) * 1.4
				panX -= e.movementX * k
				panY += e.movementY * k
				placeCamera()
				return
			}
			pivot.rotation.y += e.movementX * 0.01
			pivot.rotation.x = Math.max(-1.4, Math.min(1.4, pivot.rotation.x + e.movementY * 0.01))
		}
		const up = () => {
			if (dragging && travelled <= DRAG_SLOP && !panning) untrack(() => onToggleSpin)?.()
			dragging = false
			panning = false
		}
		const wheel = (e: WheelEvent) => {
			e.preventDefault()
			dist = Math.max(modelSize * 0.15, Math.min(modelSize * 8, dist * (e.deltaY > 0 ? 1.12 : 0.89)))
			placeCamera()
		}
		const reset = () => {
			dist = homeDist
			panX = 0
			panY = 0
			pivot.rotation.set(0, 0, 0)
			placeCamera()
		}
		el.addEventListener('pointerdown', down)
		el.addEventListener('pointermove', move)
		el.addEventListener('wheel', wheel, { passive: false })
		el.addEventListener('dblclick', reset)
		el.addEventListener('contextmenu', (e) => e.preventDefault())
		window.addEventListener('pointerup', up)

		const clock = new THREE.Clock()
		const loop = () => {
			if (disposed) return
			raf = requestAnimationFrame(loop)
			const dt = clock.getDelta()
			if (spinNow && !dragging && model) pivot.rotation.y += 0.005
			if (mixer) {
				mixer.update(dt)
				// the readout, gated — and only while it is actually moving, so a paused
				// transport costs nothing at all
				if (animPlaying) {
					const now = performance.now()
					if (now - lastPublish > 66) {
						lastPublish = now
						publishAnim()
					}
				}
			}
			renderer.render(scene, camera)
		}
		resize()
		loop()
		const ro = new ResizeObserver(resize)
		ro.observe(el)

		return () => {
			disposed = true
			try {
				action?.stop()
				mixer?.stopAllAction()
				if (model) mixer?.uncacheRoot(model)
			} catch {}
			mixer = null
			action = null
			animApi = null
			cancelAnimationFrame(raf)
			ro.disconnect()
			el.removeEventListener('pointerdown', down)
			el.removeEventListener('pointermove', move)
			el.removeEventListener('wheel', wheel)
			el.removeEventListener('dblclick', reset)
			window.removeEventListener('pointerup', up)
			scene.traverse((o: any) => {
				o.geometry?.dispose?.()
				if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m.dispose?.())
			})
			renderer.dispose()
			renderer.forceContextLoss?.()
		}
	})
</script>

<canvas bind:this={canvas} class="h-full w-full" style="touch-action: none; cursor: grab"></canvas>
