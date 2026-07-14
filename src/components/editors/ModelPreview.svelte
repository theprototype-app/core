<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { itemBlob, parseObjectFile } from '$lib/explorer'

	// N4: a self-contained (non-Threlte) three.js canvas that renders an Explorer
	// object item, auto-fits it, spins gently, and lets you drag to rotate. Reports
	// tris/verts/meshes via onStats. Reused by the Properties inline preview and the
	// floating ModelPreviewWindow. Fully disposes its GL context on teardown.
	let {
		itemId,
		name = '',
		autoSpin = true,
		onStats
	}: { itemId: string; name?: string; autoSpin?: boolean; onStats?: (s: any) => void } = $props()

	let canvas: HTMLCanvasElement | undefined = $state()

	$effect(() => {
		if (!canvas) return
		const el = canvas
		const id = itemId
		const fileName = name
		let raf = 0
		let disposed = false
		let dragging = false
		let model: any = null

		const renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true })
		renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
		const scene = new THREE.Scene()
		scene.add(new THREE.HemisphereLight(0xffffff, 0x445, 2.2))
		const dir = new THREE.DirectionalLight(0xffffff, 1.1)
		dir.position.set(1, 2, 1.5)
		scene.add(dir)
		const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100)
		const pivot = new THREE.Group()
		scene.add(pivot)

		const resize = () => {
			const w = el.clientWidth || 1
			const h = el.clientHeight || 1
			renderer.setSize(w, h, false)
			camera.aspect = w / h
			camera.updateProjectionMatrix()
		}

		;(async () => {
			let blob
			try {
				blob = await itemBlob(id)
			} catch {
				return
			}
			if (!blob || disposed) return
			const buffer = await blob.arrayBuffer()
			const ext = (fileName.split('.').pop() || 'glb').toLowerCase()
			let obj: any
			try {
				obj = await parseObjectFile(buffer, ext)
			} catch {
				return
			}
			if (disposed || !obj) return
			model = obj
			const box = new THREE.Box3().setFromObject(obj)
			if (!isFinite(box.min.x)) return
			const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001)
			const center = box.getCenter(new THREE.Vector3())
			obj.position.sub(center) // center on the pivot so rotation orbits the model
			pivot.add(obj)
			camera.near = size / 100
			camera.far = size * 10
			camera.position.set(0, size * 0.12, size * 1.1)
			camera.lookAt(0, 0, 0)
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
			onStats?.({ tris: Math.round(tris), verts, meshes })
			resize()
		})()

		const down = (e: PointerEvent) => {
			dragging = true
			el.setPointerCapture(e.pointerId)
		}
		const move = (e: PointerEvent) => {
			if (!dragging) return
			pivot.rotation.y += e.movementX * 0.01
			pivot.rotation.x = Math.max(-1.4, Math.min(1.4, pivot.rotation.x + e.movementY * 0.01))
		}
		const up = () => (dragging = false)
		el.addEventListener('pointerdown', down)
		el.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)

		const loop = () => {
			if (disposed) return
			raf = requestAnimationFrame(loop)
			if (autoSpin && !dragging && model) pivot.rotation.y += 0.005
			renderer.render(scene, camera)
		}
		resize()
		loop()
		const ro = new ResizeObserver(resize)
		ro.observe(el)

		return () => {
			disposed = true
			cancelAnimationFrame(raf)
			ro.disconnect()
			el.removeEventListener('pointerdown', down)
			el.removeEventListener('pointermove', move)
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
