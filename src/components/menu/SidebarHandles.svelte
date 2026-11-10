<script lang="ts">
	// showhide-v8 (owner 2026-11-09, "Handle icons") — THE VIEWPORT SIDEBAR HANDLES ($lib/sidebarHandles): one slim
	// tab per screen edge that opens / closes that side's column. The glyph is the "Notch" (the screen edge with a
	// bump toward where the column comes from), hugging the screen edge on BOTH sides (the right one mirrored).
	//
	//   - slim to look at (12 px, 16 on hover), a bigger hit area on touch (44 px, the Properties value-field rule)
	//   - dim at rest, full opacity on hover / focus (Settings, or the menu's "Dim at rest")
	//   - never over the logo or the profile button: it sits BELOW the top chrome on its edge, measured live (the
	//     unfolded N6 drops that chrome under the Connect bar, so a fixed top would land on it), plus the offset the
	//     person dragged it to along the edge (saved per side)
	//   - a press toggles the column; a press that TRAVELS up / down moves the handle; right-click / long-press = its
	//     menu (Hide handles · Move up / down · Reset position · Dim at rest)
	//   - on a touch screen it stays while the column is open, on the column's inner edge (it is how the column
	//     closes there); with a mouse it is drawn only while the column is closed (Blender style)
	import { onMount } from 'svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { SIDES, sidebarVisible, sidebarWidth, sidebarsWide } from '$lib/sidebars';
	import {
		sidebarHandleShown,
		sidebarHandleY,
		sidebarHandlesDim,
		sidebarHandlesMode,
		setSidebarHandleY,
		resetSidebarHandleY,
		pressSidebarHandle,
		hideSidebarHandles
	} from '$lib/sidebarHandles';
	import { coarsePointer } from '$lib/deviceClass.js';
	import { bindingOf } from '$lib/shortcuts';
	import { offerUndo } from '$lib/undoToast';

	type Side = 'left' | 'right';

	/** the bottom of the top chrome (logo, touch tools, the top-right group, the profile) above each handle, px */
	let chromeBottom = $state<Record<Side, number>>({ left: 64, right: 64 });
	/** the handle's visual height (px) */
	const TAB_H = 44;
	const GAP = 8;
	const SLOP = 6;

	/** the x band a handle occupies on its edge (the column's inner edge when it is open on touch) */
	function edgeX(side: Side) {
		const open = $sidebarVisible[side];
		const w = open ? $sidebarWidth[side] : 0;
		return side === 'left' ? w : window.innerWidth - w;
	}

	/** what a handle must sit below: buttons of the top chrome within reach of its edge (not the columns' own) */
	function measure(side: Side) {
		const x0 = edgeX(side);
		const xs = side === 'left' ? [x0 + 6, x0 + 24, x0 + 48] : [x0 - 6, x0 - 24, x0 - 48];
		let b = 0;
		for (const x of xs)
			for (let y = 4; y <= 220; y += 8) {
				const el = document.elementFromPoint(x, y) as HTMLElement | null;
				const hit = el?.closest('button, a, [role=button], #avatar-trigger, .hud-cell') as HTMLElement | null;
				if (!hit || hit.closest('.sbh, .sb-strip, #inspector, [data-docked], [data-sidebar-side], .sb-empty, [data-pd-host]')) continue;
				const r = hit.getBoundingClientRect();
				if (r.top > 160) continue; // a viewport button lower down is not top chrome
				b = Math.max(b, r.bottom);
			}
		return Math.round(b || 56);
	}
	function remeasure() {
		if (!$sidebarsWide) return;
		const next = { left: measure('left'), right: measure('right') };
		if (next.left !== chromeBottom.left || next.right !== chromeBottom.right) chromeBottom = next;
	}
	// drawn only once mounted: the page is prerendered, and where a handle goes is a question for this screen
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
		remeasure();
		const t = setInterval(remeasure, 1000);
		window.addEventListener('resize', remeasure);
		return () => {
			clearInterval(t);
			window.removeEventListener('resize', remeasure);
		};
	});
	$effect(() => {
		void $sidebarVisible;
		void $sidebarWidth;
		requestAnimationFrame(remeasure);
	});

	function topOf(side: Side, dragY = 0) {
		const base = chromeBottom[side] + GAP;
		const max = Math.max(base, window.innerHeight - TAB_H - 96);
		return Math.min(max, base + $sidebarHandleY[side] + dragY);
	}

	// ---- press / drag along the edge ----
	let press: { side: Side; y0: number; id: number; base: number } | null = null;
	let moving = $state<{ side: Side; dy: number } | null>(null);
	let suppress = false;
	function onDown(e: PointerEvent, side: Side) {
		if (e.button !== 0) return;
		suppress = false;
		press = { side, y0: e.clientY, id: e.pointerId, base: $sidebarHandleY[side] };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
	}
	function onMove(e: PointerEvent) {
		if (!press || e.pointerId !== press.id) return;
		const dy = e.clientY - press.y0;
		if (!moving && Math.abs(dy) < SLOP) return;
		moving = { side: press.side, dy };
	}
	function onUp(e: PointerEvent) {
		if (!press || e.pointerId !== press.id) return;
		const p = press;
		press = null;
		if (moving) {
			const top = topOf(p.side, moving.dy);
			setSidebarHandleY(p.side, top - (chromeBottom[p.side] + GAP));
			moving = null;
			suppress = true;
		}
	}
	function onCancel() {
		press = null;
		moving = null;
	}
	function onClick(side: Side) {
		if (suppress) {
			suppress = false;
			return;
		}
		if (moveMode === side) return;
		pressSidebarHandle(side);
	}

	// ---- keyboard move mode (the menu's "Move up / down"): arrows move it, Enter / Esc end ----
	let moveMode = $state<Side | null>(null);
	function onKey(e: KeyboardEvent, side: Side) {
		if (moveMode !== side) return;
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			e.preventDefault();
			const step = e.shiftKey ? 48 : 8;
			setSidebarHandleY(side, $sidebarHandleY[side] + (e.key === 'ArrowUp' ? -step : step));
		} else if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
			e.preventDefault();
			e.stopPropagation();
			moveMode = null;
		}
	}

	// ---- the menu ----
	let menu = $state<{ x: number; y: number; side: Side } | null>(null);
	function onMenu(e: MouseEvent, side: Side) {
		e.preventDefault();
		onCancel();
		menu = { x: e.clientX, y: e.clientY, side };
	}
	function menuItems(side: Side) {
		return [
			{
				label: 'Hide handles',
				icon: 'eye-off',
				tooltip: 'Turn the sidebar handles off on this device — Settings ▸ Interface ▸ Show viewport sidebar handles brings them back',
				action: () => {
					const was = hideSidebarHandles();
					offerUndo({ id: 'sidebar-handles', text: 'Sidebar handles hidden (Settings ▸ Interface brings them back)', undo: () => sidebarHandlesMode.set(was) });
				}
			},
			{
				label: 'Move up / down',
				icon: 'move-vertical',
				tooltip: 'Drag the handle along the edge — or use the arrow keys now, Enter when done. The place is remembered for this side',
				action: () => {
					moveMode = side;
					requestAnimationFrame(() => (document.getElementById(`sidebar-handle-${side}`) as HTMLElement | null)?.focus());
				}
			},
			{
				label: 'Reset position',
				icon: 'rotate-ccw',
				tooltip: 'Back under the top buttons',
				disabled: !$sidebarHandleY[side],
				action: () => resetSidebarHandleY(side)
			},
			{
				label: 'Dim at rest',
				icon: 'sun-dim',
				checked: $sidebarHandlesDim,
				tooltip: 'Faint until you point at it or focus it',
				action: () => sidebarHandlesDim.update((v) => !v)
			}
		];
	}

	function keyOf(side: Side) {
		return bindingOf(side === 'left' ? 'panels.sidebar-left' : 'panels.sidebar-right') ?? '';
	}
	function titleOf(side: Side) {
		const open = $sidebarVisible[side];
		const key = keyOf(side);
		return `${open ? 'Hide' : 'Show'} the ${side} sidebar${key ? ' (' + key + ')' : ''} — drag up or down to move this handle; right-click or long-press for more`;
	}
</script>

{#each SIDES as side (side)}
	{#if mounted && $sidebarHandleShown[side]}
		{@const open = $sidebarVisible[side]}
		{@const top = topOf(side, moving?.side === side ? moving.dy : 0)}
		<button
			type="button"
			id="sidebar-handle-{side}"
			class="sbh tp-ui"
			class:sbh-left={side === 'left'}
			class:sbh-right={side === 'right'}
			class:sbh-dim={$sidebarHandlesDim}
			class:sbh-touch={$coarsePointer}
			class:sbh-moving={moving?.side === side || moveMode === side}
			class:sbh-open={open}
			data-side={side}
			aria-pressed={open}
			aria-label="{open ? 'Hide' : 'Show'} the {side} sidebar"
			title={titleOf(side)}
			style="top: {top}px; {side === 'left' ? `left: ${open ? $sidebarWidth.left : 0}px` : `right: ${open ? $sidebarWidth.right : 0}px`}"
			onpointerdown={(e) => onDown(e, side)}
			onpointermove={onMove}
			onpointerup={onUp}
			onpointercancel={onCancel}
			onlostpointercapture={onCancel}
			oncontextmenu={(e) => onMenu(e, side)}
			onclick={() => onClick(side)}
			onkeydown={(e) => onKey(e, side)}
			onblur={() => moveMode === side && (moveMode = null)}
		>
			<span class="sbh-tab" aria-hidden="true">
				<!-- the Notch (handle-icons g3), drawn for the LEFT edge; the right handle mirrors it -->
				<svg viewBox="0 0 24 48" width="12" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"
					><path d="M8 4v13l7 7-7 7v13" /></svg
				>
			</span>
		</button>
	{/if}
{/each}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.side)} sizeKey="sidebarhandle" onclose={() => (menu = null)} />
{/if}

<style>
	/* the BUTTON is the hit area (transparent); the TAB inside is what is drawn, against the edge */
	.sbh {
		position: fixed;
		z-index: var(--z-dock);
		width: 20px;
		height: 44px;
		padding: 0;
		margin: 0;
		border: 0;
		background: transparent;
		display: flex;
		align-items: center;
		cursor: pointer;
		touch-action: none;
		-webkit-tap-highlight-color: transparent;
	}
	.sbh-left {
		justify-content: flex-start;
	}
	.sbh-right {
		justify-content: flex-end;
	}
	/* touch: the slim tab keeps a 44 px square to press (the Properties value-field rule) */
	.sbh-touch {
		width: 44px;
		height: 56px;
	}
	.sbh-tab {
		width: 12px;
		height: 44px;
		display: grid;
		place-items: center;
		color: var(--text-2);
		background: var(--surface-2);
		box-shadow:
			0 0 0 1px var(--border),
			var(--shadow-knob);
		transition:
			width 0.12s ease,
			opacity 0.12s ease,
			color 0.12s ease;
		overflow: hidden;
	}
	.sbh-left .sbh-tab {
		border-radius: 0 7px 7px 0;
		justify-items: start;
	}
	.sbh-right .sbh-tab {
		border-radius: 7px 0 0 7px;
		justify-items: end;
	}
	/* the glyph hugs the SCREEN edge on both sides: the left one is drawn for the left edge, the right one mirrored */
	.sbh-left .sbh-tab svg {
		margin-left: -2px;
	}
	.sbh-right .sbh-tab svg {
		margin-right: -2px;
		transform: scaleX(-1);
	}
	/* an open column (touch): the bump points back into the column */
	.sbh-open.sbh-left .sbh-tab svg {
		transform: scaleX(-1);
	}
	.sbh-open.sbh-right .sbh-tab svg {
		transform: none;
	}
	.sbh-dim .sbh-tab {
		opacity: 0.55;
	}
	.sbh:hover .sbh-tab,
	.sbh:focus-visible .sbh-tab,
	.sbh-moving .sbh-tab {
		opacity: 1;
		width: 16px;
		color: var(--text);
		background: var(--surface-3);
	}
	.sbh:active .sbh-tab,
	.sbh[aria-pressed='true']:hover .sbh-tab {
		color: var(--accent-text, var(--text));
	}
	.sbh:focus-visible {
		outline: none;
	}
	.sbh:focus-visible .sbh-tab {
		box-shadow:
			0 0 0 2px var(--focus-ring, var(--accent)),
			var(--shadow-knob);
	}
	.sbh-moving .sbh-tab {
		box-shadow:
			0 0 0 2px var(--accent),
			var(--shadow-knob);
	}
	@media (prefers-reduced-motion: reduce) {
		.sbh-tab {
			transition: none;
		}
	}
</style>
