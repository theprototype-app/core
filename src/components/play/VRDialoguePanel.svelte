<script lang="ts">
	// 92-dialogue (GC6): THE DIALOGUE IN A HEADSET — a WORLD-LOCKED panel (DOM is invisible in VR).
	// Placed once when a talk opens: above the speaker when the Dialogue node lives in an object's own
	// flow, else 1.2 m in front of the player at eye height; it turns to face them and then stays put
	// (no head-locked text, the comfort rule). Either trigger continues / picks; either stick up / down
	// moves the pick (the stick's locomotion is held while choices show). Lazy: Scene mounts it only
	// in VR while a talk is open.
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { dialogueView } from '$lib/dialogue/view.js'
	import { dialogueAdvance, dialogueChoose } from '$lib/dialogue/runtime.js'
	import { getInput, claimInput, releaseInput } from '$lib/inputRuntime'

	const { camera } = useThrelte()

	const WIDTH = 0.9
	const PAD = 0.04
	const LINE = 0.05

	let group: any = $state(null)
	let sel = $state(0)
	const view: any = $derived($dialogueView)
	// troika wraps the line; ~44 characters a row at this size is enough to keep the choices below it
	const textRows = $derived(view ? Math.max(1, Math.ceil(view.text.length / 44)) : 1)
	const choicesTop = $derived(-(view?.speaker ? 0.085 : 0.04) - textRows * 0.039 - 0.03)
	const height = $derived(-choicesTop + (view ? view.choices.length * LINE : 0) + 0.05)

	let placedFor = ''
	let wasTrigger = true // a trigger held as the talk opens (the press that started it) is not a continue
	let stickArmed = true

	$effect(() => {
		void view?.key
		sel = 0
	})

	// the stick picks while choices show, so it does not also walk the player
	$effect(() => {
		if (!view?.choices.length) return
		claimInput('locomotion')
		return () => releaseInput('locomotion')
	})

	const head = new THREE.Vector3()
	const fwd = new THREE.Vector3()

	function place() {
		const cam: any = $camera
		if (!group || !cam) return
		cam.getWorldPosition(head)
		if (Array.isArray(view.anchor)) {
			group.position.set(view.anchor[0], view.anchor[1] + 0.35, view.anchor[2])
		} else {
			cam.getWorldDirection(fwd)
			fwd.y = 0
			if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
			fwd.normalize()
			group.position.copy(head).addScaledVector(fwd, 1.2)
			group.position.y = head.y - 0.15
		}
		// face the player, upright
		group.rotation.set(0, Math.atan2(head.x - group.position.x, head.z - group.position.z), 0)
	}

	useTask(() => {
		if (!view || !group) return
		if (placedFor !== view.talk) {
			placedFor = view.talk
			place()
		}
		const input: any = getInput()
		const trigger = !!(input.vrButtons?.rtrigger || input.vrButtons?.ltrigger)
		if (trigger && !wasTrigger) {
			if (view.choices.length) dialogueChoose(sel)
			else dialogueAdvance()
		}
		wasTrigger = trigger
		const y = Math.abs(input.axes?.ry ?? 0) > Math.abs(input.axes?.ly ?? 0) ? input.axes?.ry ?? 0 : input.axes?.ly ?? 0
		if (Math.abs(y) < 0.3) stickArmed = true
		else if (stickArmed && Math.abs(y) > 0.6 && view.choices.length) {
			stickArmed = false
			const n = view.choices.length
			// stick up is -y on the WebXR gamepad
			sel = (sel + (y < 0 ? n - 1 : 1)) % n
		}
	})
</script>
<!-- tokens-ok-begin: three.js material / troika Text colours of a WebXR headset panel (meshes cannot read CSS var()) -->

{#if view}
	<T.Group bind:ref={group} name="vr-dialogue-panel">
		<T.Mesh position={[0, -height / 2, -0.004]}>
			<T.PlaneGeometry args={[WIDTH, height]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.92} side={THREE.DoubleSide} />
		</T.Mesh>
		{#if view.speaker}
			<Text text={view.speaker} color="#7fb0ff" fontSize={0.032} anchorX="left" anchorY="top" position={[-WIDTH / 2 + PAD, -PAD / 2, 0.002]} />
		{/if}
		<Text
			text={view.text}
			color="#e8ecf2"
			fontSize={0.03}
			lineHeight={1.3}
			maxWidth={WIDTH - 2 * PAD}
			anchorX="left"
			anchorY="top"
			position={[-WIDTH / 2 + PAD, view.speaker ? -PAD / 2 - 0.045 : -PAD / 2, 0.002]}
		/>
		{#each view.choices as choice, i (i)}
			<T.Mesh position={[0, choicesTop - i * LINE, 0]}>
				<T.PlaneGeometry args={[WIDTH - 2 * PAD, LINE - 0.008]} />
				<T.MeshBasicMaterial color={i === sel ? '#22304a' : '#1a202b'} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text text={i + 1 + '  ' + choice} color={i === sel ? '#e8f0ff' : '#c5ccd8'} fontSize={0.026} anchorX="left" anchorY="middle" maxWidth={WIDTH - 3 * PAD} position={[-WIDTH / 2 + 1.5 * PAD, choicesTop - i * LINE, 0.002]} />
		{/each}
		<Text
			text={view.choices.length ? 'Stick to pick · trigger to choose' : view.last ? 'Trigger · close' : 'Trigger · continue'}
			color="#8b94a7"
			fontSize={0.02}
			anchorX="right"
			anchorY="bottom"
			position={[WIDTH / 2 - PAD, -height + PAD / 2, 0.002]}
		/>
	</T.Group>
{/if}
<!-- tokens-ok-end -->
