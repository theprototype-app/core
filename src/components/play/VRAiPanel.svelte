<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { onMount } from 'svelte'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrAiPanelOpen, vrMenuHand } from '../../stores/sceneStore'
	import { vrHovered, controllerIndexFor } from '$lib/vrControls'
	import { vrAiGroup, vrAiMessages, vrAiBusy, vrAiStatus, vrAiReady, vrSttReady, vrAiNotice, mountVRAiPanel, talkBindingLabel } from '$lib/vr/aiPanel.js'
	import { dictation } from '$lib/ai/sttCapture.js'
	import { vrIconTexture } from '$lib/vr/icons.js'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR AI chat panel (36-vr-ai, plan F1): Tools ▸ AI. The SAME thread as the desktop AI Assistant window
	// (aiMessages, mirrored by vr/aiPanel.js at <= 5 updates/s while an answer streams), drawn with an AI
	// look of its own — a violet header with the sparkles icon — so it never reads as the peer chat panel
	// beside it. Controls are named vrai-* for the raycast; the panel follows the menu hand and the 111
	// grab/persist applies (window id `ai`). Unconfigured: a hint row points at desktop Settings ▸ AI.
	// F2: the mic button (hold to talk, release to send) with a red dot while it listens.

	const { renderer } = useThrelte()

	const WIDTH = 0.32
	const ROW_H = 0.03
	const MAX = 7
	const HEADER_H = 0.03
	// two lines of the row font fit a row; a longer message shows its start (its END while it streams)
	const ROW_CHARS = 110
	// tokens-ok-begin: three.js material / troika Text colours of a WebXR headset panel (meshes cannot read CSS var())
	const AI_ACCENT = '#7c5cff'
	const AI_HEADER = '#2b2257'
	// tokens-ok-end

	let group: any = $state(null)

	$effect(() => {
		vrAiGroup.set($vrAiPanelOpen ? group : null)
	})

	onMount(() => mountVRAiPanel())

	let recent = $derived(($vrAiMessages as any[]).slice(-MAX))
	const panelH = HEADER_H + MAX * ROW_H + 0.075

	function rowText(m: any) {
		let text = String(m.content ?? '').replace(/\s+/g, ' ').trim()
		if (text.length > ROW_CHARS) text = m.streaming ? '…' + text.slice(-ROW_CHARS) : text.slice(0, ROW_CHARS) + '…'
		if (m.role === 'tool-status') return '⚙ ' + text
		if (m.role === 'error') return '⚠ ' + text
		return text + (m.streaming ? ' ▋' : '')
	}
	// tokens-ok-begin: three.js material / troika Text colours of a WebXR headset panel (meshes cannot read CSS var())
	const ROW_COLORS: Record<string, string> = {
		user: '#f2efff',
		assistant: '#e8ecf2',
		'tool-status': '#8b93a1',
		summary: '#5fd39a',
		error: '#ff8a80'
	}
	// tokens-ok-end

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.2, 0)

	useTask(() => {
		if (!group || !$vrAiPanelOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194/210: by handedness, reorder-safe
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'ai', pose)
	})

	const top = panelH / 2
	const bottom = -panelH / 2
	const statusY = bottom + 0.05
	const MIC_W = 0.03

	// tokens-ok-begin: three.js material / troika Text colours of a WebXR headset panel (meshes cannot read CSS var())
	// the hovered state passed in so the template re-renders on it (a helper reading a store is untracked)
	function micColor(state: string, hovered: string | null, ready: boolean) {
		if (state === 'recording') return '#d93025'
		if (state === 'transcribing') return '#6b5bd6'
		if (!ready) return '#30343c'
		return hovered === 'ai:mic' ? '#4b3aa8' : '#3a3f4a'
	}
	// tokens-ok-end
	const inputY = bottom + 0.018
</script>
<!-- tokens-ok-begin: three.js material / troika Text colours of a WebXR headset panel (meshes cannot read CSS var()) -->

{#if $vrAiPanelOpen}
	<T.Group bind:ref={group} name="vr-ai-panel">
		<!-- backdrop -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.92} side={THREE.DoubleSide} />
		</T.Mesh>
		<!-- the AI header: violet bar, sparkles, title, close -->
		<T.Mesh position={[0, top - HEADER_H / 2 + 0.004, -0.002]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, HEADER_H]} />
			<T.MeshBasicMaterial color={AI_HEADER} side={THREE.DoubleSide} />
		</T.Mesh>
		{#if vrIconTexture('sparkles')}
			<T.Mesh position={[-WIDTH / 2 + 0.012, top - HEADER_H / 2 + 0.004, 0.002]}>
				<T.PlaneGeometry args={[0.014, 0.014]} />
				<T.MeshBasicMaterial map={vrIconTexture('sparkles')} color="#c9bcff" transparent depthWrite={false} side={THREE.DoubleSide} />
			</T.Mesh>
		{/if}
		<Text
			text="AI Assistant"
			color="#f2efff"
			fontSize={0.011}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2 + 0.026, top - HEADER_H / 2 + 0.004, 0.002]}
		/>
		<T.Mesh name="vrai-close" position={[WIDTH / 2 - 0.012, top - HEADER_H / 2 + 0.004, 0]}>
			<T.CircleGeometry args={[0.009, 20]} />
			<T.MeshBasicMaterial color={$vrHovered === 'ai:close' ? '#ff4000' : '#463a80'} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text text="✕" color="#ffffff" fontSize={0.008} anchorX="center" anchorY="middle"
			position={[WIDTH / 2 - 0.012, top - HEADER_H / 2 + 0.004, 0.002]} />

		<!-- the thread (the last few turns) -->
		{#if !$vrAiReady}
			<Text
				text={'Configure an AI provider in Settings ▸ AI on desktop — the assistant uses the same provider here.'}
				color="#c9bcff"
				fontSize={0.0085}
				anchorX="center"
				anchorY="middle"
				textAlign="center"
				maxWidth={WIDTH - 0.04}
				position={[0, 0.01, 0.002]}
			/>
		{:else if recent.length === 0}
			<Text text={'Ask the assistant to build or change the scene.'} color="#9aa4b2" fontSize={0.008}
				anchorX="center" anchorY="middle" maxWidth={WIDTH - 0.04} position={[0, 0.01, 0.002]} />
		{/if}
		{#each recent as m, i (i)}
			{@const y = top - HEADER_H - 0.012 - i * ROW_H - ROW_H / 2}
			{#if m.role === 'user'}
				<!-- your turn: a violet chip on the right -->
				<T.Mesh position={[WIDTH / 2 - 0.01 - (WIDTH * 0.7) / 2, y, 0.0005]}>
					<T.PlaneGeometry args={[WIDTH * 0.7, ROW_H - 0.004]} />
					<T.MeshBasicMaterial color={AI_ACCENT} transparent opacity={0.35} side={THREE.DoubleSide} />
				</T.Mesh>
				<Text
					text={rowText(m)}
					color={ROW_COLORS.user}
					fontSize={0.0075}
					anchorX="right"
					anchorY="middle"
					textAlign="right"
					position={[WIDTH / 2 - 0.014, y, 0.002]}
					maxWidth={WIDTH * 0.7 - 0.01}
					clipRect={[-WIDTH, -ROW_H / 2, 0, ROW_H / 2]}
				/>
			{:else}
				<Text
					text={rowText(m)}
					color={ROW_COLORS[m.role] ?? '#e8ecf2'}
					fontSize={m.role === 'assistant' ? 0.0078 : 0.0068}
					anchorX="left"
					anchorY="middle"
					position={[-WIDTH / 2 + 0.01, y, 0.002]}
					maxWidth={WIDTH - 0.02}
					clipRect={[0, -ROW_H / 2, WIDTH, ROW_H / 2]}
				/>
			{/if}
		{/each}

		<!-- the status line: a run in flight (with STOP), listening, transcribing, a note, or the talk hint -->
		{#if $vrAiBusy}
			<Text
				text={$vrAiStatus || 'Working…'}
				color="#c9bcff"
				fontSize={0.0075}
				anchorX="left"
				anchorY="middle"
				position={[-WIDTH / 2 + 0.01, statusY, 0.002]}
			/>
			<T.Mesh name="vrai-stop" position={[WIDTH / 2 - 0.035, statusY, 0]}>
				<T.PlaneGeometry args={[0.05, 0.018]} />
				<T.MeshBasicMaterial color={$vrHovered === 'ai:stop' ? '#ff4000' : '#8a2b2b'} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text text="Stop" color="#ffffff" fontSize={0.0075} anchorX="center" anchorY="middle"
				position={[WIDTH / 2 - 0.035, statusY, 0.002]} />
		{:else if $dictation.state === 'recording'}
			<T.Mesh name="vr-ai-rec-dot" position={[-WIDTH / 2 + 0.014, statusY, 0.002]}>
				<T.CircleGeometry args={[0.004, 16]} />
				<T.MeshBasicMaterial color="#ff3b30" side={THREE.DoubleSide} />
			</T.Mesh>
			<Text text="Listening… let go to send" color="#ffb4ae" fontSize={0.0075} anchorX="left" anchorY="middle"
				position={[-WIDTH / 2 + 0.024, statusY, 0.002]} />
		{:else if $dictation.state === 'transcribing'}
			<Text text="Transcribing…" color="#c9bcff" fontSize={0.0075} anchorX="left" anchorY="middle"
				position={[-WIDTH / 2 + 0.01, statusY, 0.002]} />
		{:else if $vrAiNotice}
			<Text text={$vrAiNotice} color="#ffcf70" fontSize={0.0072} anchorX="left" anchorY="middle"
				maxWidth={WIDTH - 0.02} position={[-WIDTH / 2 + 0.01, statusY, 0.002]} />
		{:else if $vrAiReady && $vrSttReady}
			<Text text={`Hold ${talkBindingLabel()} or the mic to talk`} color="#6c7480" fontSize={0.007} anchorX="left"
				anchorY="middle" position={[-WIDTH / 2 + 0.01, statusY, 0.002]} />
		{/if}

		<!-- input row: opens the VR keyboard (116); the mic beside it is a hold-to-talk button (F2) -->
		<T.Mesh name="vrai-input" position={[-MIC_W / 2, inputY, 0]}>
			<T.PlaneGeometry args={[WIDTH - 0.02 - MIC_W, 0.024]} />
			<T.MeshBasicMaterial
				color={!$vrAiReady || $vrAiBusy ? '#22262d' : $vrHovered === 'ai:input' ? '#4b3aa8' : '#2a2f38'}
				side={THREE.DoubleSide}
			/>
		</T.Mesh>
		<Text
			text={!$vrAiReady ? 'Set up AI on desktop first' : $vrAiBusy ? 'Answering…' : '＋ Ask AI…'}
			color={!$vrAiReady || $vrAiBusy ? '#6c7480' : '#c8d0da'}
			fontSize={0.0085}
			anchorX="center"
			anchorY="middle"
			position={[-MIC_W / 2, inputY, 0.002]}
		/>
		<T.Mesh name="vrai-mic" position={[WIDTH / 2 - 0.01 - MIC_W / 2 + 0.004, inputY, 0]}>
			<T.CircleGeometry args={[0.0115, 24]} />
			<T.MeshBasicMaterial color={micColor($dictation.state, $vrHovered, $vrSttReady)} side={THREE.DoubleSide} />
		</T.Mesh>
		{#if vrIconTexture('mic')}
			<T.Mesh position={[WIDTH / 2 - 0.01 - MIC_W / 2 + 0.004, inputY, 0.002]}>
				<T.PlaneGeometry args={[0.013, 0.013]} />
				<T.MeshBasicMaterial map={vrIconTexture('mic')} color={$vrSttReady ? '#ffffff' : '#7a808a'} transparent depthWrite={false} side={THREE.DoubleSide} />
			</T.Mesh>
		{/if}
	</T.Group>
{/if}
<!-- tokens-ok-end -->
