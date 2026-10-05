<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrSettingsPanelOpen, vrMenuHand, vrPassthrough } from '../../stores/sceneStore'
	import { vrHovered, vrSettingsGroup, controllerIndexFor } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'
	import { vrIconTexture } from '$lib/vr/icons.js'
	import {
		VR_PANEL_TABS,
		vrSettingsPage,
		vrSettingsCursor,
		vrSettingsVersion,
		vrRemapPending,
		settingsPanelRows,
		vrSettingRow,
		settingValueText,
		actionLabel
	} from '$lib/vr/settingsSchema.js'
	import { bindingOf, controlName, actionInfo } from '$lib/vr/bindings.js'

	// VR Settings panel (187; 36-vr rebuilt it): EVERY VR setting in the headset, page by page — the same
	// rows, names, icons and order as the radial's Settings rings and desktop Settings ▸ VR (one table,
	// vr/settingsSchema.js) — plus the Buttons page, the in-headset remap table (plan 55). Pointer: the
	// other hand's ray hovers, the trigger presses. Stick: up/down walks the rows, left/right changes a
	// choice (or the page, on the tab strip), a stick press presses (frame.js). Control meshes are named
	// `vrsettings-<action>` for the raycast; grabbable (window id `settingspanel`).

	const { renderer } = useThrelte()

	const WIDTH = 0.3
	const ROW_H = 0.027
	const TAB_H = 0.03
	const PAD = 0.008

	let group: any = $state(null)
	$effect(() => {
		vrSettingsGroup.set($vrSettingsPanelOpen ? group : null)
	})
	/** T1 (36-onboard): the panel's stable tour id */
	function tourTag(ref: any) {
		if (ref) ref.userData.tour = 'vr-panel:settings'
	}

	type Row = { action: string; kind: string; rowId?: string; label: string }
	// every value shown re-derives when any VR setting changes ($vrSettingsVersion)
	/** `_v` is a dependency only: the rows re-derive when any VR setting changes */
	function rowsFor(page: string, _v: number): Row[] {
		return settingsPanelRows(page)
	}
	let rows = $derived<Row[]>(rowsFor($vrSettingsPage, $vrSettingsVersion))
	let body = $derived(rows.filter((r) => r.kind !== 'tabs' && r.kind !== 'nav'))
	let panelH = $derived(0.034 + TAB_H + body.length * ROW_H + 0.044 + 0.022)
	let cursorAction = $derived(rows[Math.min($vrSettingsCursor, rows.length - 1)]?.action ?? '')
	let pageLabel = $derived(VR_PANEL_TABS.find((t) => t.id === $vrSettingsPage)?.label ?? '')

	function valueOf(row: Row, _v: number, _pending: any): string {
		if (row.kind === 'binding' || row.kind === 'locked') {
			const pending = $vrRemapPending
			if (pending && pending.action === row.rowId)
				return 'Taken by ' + actionLabel(pending.other) + ' — press to swap'
			const b = bindingOf(row.rowId ?? '')
			return controlName(b.hand, b.control)
		}
		const r = row.rowId ? vrSettingRow(row.rowId) : null
		return r && r.kind !== 'action' ? settingValueText(r) : ''
	}
	function iconOf(row: Row): string | null {
		if (row.kind === 'binding' || row.kind === 'locked') return null
		return (row.rowId && vrSettingRow(row.rowId)?.icon) || null
	}
	function noteOf(action: string, _v: number): string {
		const row = rows.find((r) => r.action === action)
		if (!row?.rowId) return ''
		if (row.kind === 'binding' || row.kind === 'locked') return actionInfo(row.rowId)?.doc ?? ''
		return vrSettingRow(row.rowId)?.note ?? ''
	}
	function isOn(row: Row, _v: number): boolean {
		const r = row.rowId ? vrSettingRow(row.rowId) : null
		return r?.kind === 'toggle' ? !!r.get?.() : false
	}
	function rowColor(row: Row, hovered: string | null, cursor: string, _p: any): string {
		const name = row.action
		if (!name) return '#1d2129' // a locked row
		if (hovered && (hovered === name || hovered.startsWith(name + ':'))) return '#ff4000'
		if ($vrRemapPending && $vrRemapPending.action === row.rowId) return '#7a5410'
		if (cursor === name) return '#3b4452'
		return '#2a2f38'
	}
	function rowY(i: number) {
		return panelH / 2 - 0.034 - TAB_H - ROW_H * (i + 0.5)
	}
	const help = $derived(noteOf($vrHovered && rows.some((r) => r.action === $vrHovered) ? $vrHovered : cursorAction, $vrSettingsVersion))

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.2, 0)

	useTask(() => {
		if (!group || !$vrSettingsPanelOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194: by handedness, reorder-safe
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'settingspanel', pose)
	})
</script>

{#if $vrSettingsPanelOpen}
	<T.Group bind:ref={group} name="vr-settings-panel" oncreate={tourTag}>
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.94} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={'Settings · ' + pageLabel}
			color="#e8ecf2"
			fontSize={0.012}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2, panelH / 2 - 0.017, 0.002]}
		/>
		<!-- the page tabs (stick: left/right on this strip) -->
		{#each VR_PANEL_TABS as tab, i (tab.id)}
			{@const tw = WIDTH / VR_PANEL_TABS.length}
			{@const tx = -WIDTH / 2 + tw * (i + 0.5)}
			{@const ty = panelH / 2 - 0.034 - TAB_H / 2}
			{@const act = 'vrset:page:' + tab.id}
			<T.Mesh name={`vrsettings-${act}`} position={[tx, ty, 0]}>
				<T.PlaneGeometry args={[tw - 0.003, TAB_H - 0.004]} />
				<T.MeshBasicMaterial
					color={$vrHovered === act ? '#ff4000' : tab.id === $vrSettingsPage ? '#2f81f7' : cursorAction === 'tabs' ? '#3b4452' : '#232831'}
					transparent
					opacity={0.95}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			{#if vrIconTexture(tab.icon)}
				<T.Mesh position={[tx, ty + 0.005, 0.002]}>
					<T.PlaneGeometry args={[0.012, 0.012]} />
					<T.MeshBasicMaterial map={vrIconTexture(tab.icon)} transparent depthWrite={false} side={THREE.DoubleSide} />
				</T.Mesh>
			{/if}
			<Text text={tab.label} color="#e8ecf2" fontSize={0.0056} anchorX="center" anchorY="middle" position={[tx, ty - 0.008, 0.002]} />
		{/each}
		<!-- the rows -->
		{#each body as row, i (row.action + row.label)}
			{@const y = rowY(i)}
			{@const settingRow = row.rowId ? vrSettingRow(row.rowId) : null}
			<T.Mesh name={row.action ? `vrsettings-${row.action}${settingRow?.kind === 'range' ? ':+' : ''}` : 'vrsettings-locked'} position={[0, y, 0]}>
				<T.PlaneGeometry args={[WIDTH, ROW_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(row, $vrHovered, cursorAction, $vrRemapPending)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			{#if iconOf(row) && vrIconTexture(iconOf(row))}
				<T.Mesh position={[-WIDTH / 2 + PAD + 0.006, y, 0.002]}>
					<T.PlaneGeometry args={[0.012, 0.012]} />
					<T.MeshBasicMaterial map={vrIconTexture(iconOf(row))} color="#cfd6df" transparent depthWrite={false} side={THREE.DoubleSide} />
				</T.Mesh>
			{/if}
			<Text
				text={row.label}
				color={row.action ? '#e8ecf2' : '#8a93a0'}
				fontSize={0.0088}
				anchorX="left"
				anchorY="middle"
				position={[-WIDTH / 2 + PAD + 0.016, y, 0.002]}
			/>
			{#if settingRow?.kind === 'toggle'}
				<!-- a switch, not "[x]" text -->
				<T.Mesh position={[WIDTH / 2 - PAD - 0.012, y, 0.002]}>
					<T.PlaneGeometry args={[0.024, 0.012]} />
					<T.MeshBasicMaterial color={isOn(row, $vrSettingsVersion) ? '#2f81f7' : '#4a5260'} side={THREE.DoubleSide} />
				</T.Mesh>
				<T.Mesh position={[WIDTH / 2 - PAD - 0.012 + (isOn(row, $vrSettingsVersion) ? 0.006 : -0.006), y, 0.003]}>
					<T.CircleGeometry args={[0.0048, 20]} />
					<T.MeshBasicMaterial color="#ffffff" side={THREE.DoubleSide} />
				</T.Mesh>
			{:else if settingRow?.kind === 'range'}
				<T.Mesh name={`vrsettings-${row.action}:-`} position={[WIDTH / 2 - PAD - 0.058, y, 0.001]}>
					<T.PlaneGeometry args={[0.018, ROW_H - 0.008]} />
					<T.MeshBasicMaterial color={$vrHovered === row.action + ':-' ? '#ff4000' : '#4a5260'} side={THREE.DoubleSide} />
				</T.Mesh>
				<Text text="−" color="#ffffff" fontSize={0.011} anchorX="center" anchorY="middle" position={[WIDTH / 2 - PAD - 0.058, y, 0.003]} />
				<Text text={valueOf(row, $vrSettingsVersion, $vrRemapPending)} color="#e8ecf2" fontSize={0.0082} anchorX="center" anchorY="middle" position={[WIDTH / 2 - PAD - 0.032, y, 0.002]} />
				<T.Mesh position={[WIDTH / 2 - PAD - 0.007, y, 0.001]}>
					<T.PlaneGeometry args={[0.018, ROW_H - 0.008]} />
					<T.MeshBasicMaterial color={$vrHovered === row.action + ':+' ? '#ff4000' : '#4a5260'} side={THREE.DoubleSide} />
				</T.Mesh>
				<Text text="+" color="#ffffff" fontSize={0.011} anchorX="center" anchorY="middle" position={[WIDTH / 2 - PAD - 0.007, y, 0.003]} />
			{:else}
				<Text
					text={valueOf(row, $vrSettingsVersion, $vrRemapPending)}
					color={$vrRemapPending && $vrRemapPending.action === row.rowId ? '#ffd27a' : '#9fb3c8'}
					fontSize={0.0082}
					maxWidth={WIDTH * 0.55}
					textAlign="right"
					anchorX="right"
					anchorY="middle"
					position={[WIDTH / 2 - PAD, y, 0.002]}
				/>
			{/if}
		{/each}
		<!-- what the hovered / cursored row does (readable help, one line) -->
		<Text
			text={help}
			color="#aab4c0"
			fontSize={0.0068}
			maxWidth={WIDTH}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2, -panelH / 2 + 0.044, 0.002]}
		/>
		{#if $vrPassthrough && $vrSettingsPage === 'display'}
			<Text text={'(restart VR to apply passthrough)'} color="#8a93a0" fontSize={0.006} anchorX="right" anchorY="middle" position={[WIDTH / 2, -panelH / 2 + 0.044, 0.002]} />
		{/if}
		<!-- footer: back to the radial's Settings ring · close -->
		{#each [['vrset:back', 'Back to menu', -WIDTH / 4, 'arrow-left'], ['vrset:close', 'Close', WIDTH / 4, 'x']] as [act, label, x, icon] (act)}
			<T.Mesh name={`vrsettings-${act}`} position={[Number(x), -panelH / 2 + 0.017, 0]}>
				<T.PlaneGeometry args={[WIDTH / 2 - 0.006, 0.024]} />
				<T.MeshBasicMaterial
					color={$vrHovered === act ? '#ff4000' : cursorAction === act ? '#3b4452' : act === 'vrset:close' ? '#5a2a2a' : '#2a2f38'}
					transparent
					opacity={0.95}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			{#if vrIconTexture(String(icon))}
				<T.Mesh position={[Number(x) - 0.03, -panelH / 2 + 0.017, 0.002]}>
					<T.PlaneGeometry args={[0.011, 0.011]} />
					<T.MeshBasicMaterial map={vrIconTexture(String(icon))} transparent depthWrite={false} side={THREE.DoubleSide} />
				</T.Mesh>
			{/if}
			<Text text={String(label)} color="#e8ecf2" fontSize={0.0085} anchorX="center" anchorY="middle" position={[Number(x) + 0.006, -panelH / 2 + 0.017, 0.002]} />
		{/each}
	</T.Group>
{/if}
