<script lang="ts">
	// showhide-v8 (owner 2026-11-09, "one arrow pattern in tabbed windows" + "Handle icons" (b)) — THE ONE SIDE-PANE
	// HANDLE every window with side panes uses (Node editor, Shader, Animation, UV, HUD, Explorer, Profiler, Code):
	// a slim notebook tab on the pane's edge that shows / hides that pane.
	//   - it takes NO margin: the consumer places it absolutely (on the window edge when the pane is hidden, on the
	//     pane's inner edge when it shows), so with the panes hidden the tab content is full width
	//   - a Lucide chevron that points the way the pane will go, flipped by state; a RIGHT handle may add its pane's
	//     role icon under the chevron (the hybrid: HUD keeps its cog, Properties panes show info) — no six-dot
	//   - narrow to look at (14 px), a bigger hit area (24 px with a mouse, 44 px on touch), widens a little on hover
	//   - its menu (right-click, a long press on touch): Hide / Show, and Lock sidebars for the whole window
	import Icon from './Icon.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { paneLocks, togglePaneLock } from '$lib/ui/paneLocks.js';
	import { registerPaneHandle } from '$lib/ui/paneKeys.js';

	let {
		edge,
		open,
		label,
		windowKey,
		role = '',
		id = undefined,
		onclick,
		style = '',
		extraItems = [],
		...rest
	}: {
		/** which side of the WINDOW the pane lives on */
		edge: 'left' | 'right';
		open: boolean;
		/** the pane's name ("the palette", "Properties") */
		label: string;
		/** the window's key, for its lock */
		windowKey: string;
		/** a role icon under the chevron (Lucide name) */
		role?: string;
		id?: string;
		onclick: () => void;
		style?: string;
		extraItems?: any[];
		[k: string]: any;
	} = $props();

	const locked = $derived(!!$paneLocks[windowKey]);
	// the chevron points where the pane goes: an open LEFT pane folds left, a closed one comes out rightwards
	const chevron = $derived((edge === 'left') === open ? 'chevron-left' : 'chevron-right');
	let menu = $state<{ x: number; y: number } | null>(null);
	function onMenu(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		menu = { x: e.clientX, y: e.clientY };
	}
	function press() {
		if (locked) return;
		onclick();
	}
	// uir-polish B1 (owner 2026-11-11): a COLLAPSED handle sits flush against its window's edge. Docked windows wrap their
	// content in the frame's padding, so a handle placed at the content's edge floated a few px in with a strip beside
	// it: the gap to the frame edge is measured and the closed handle shifted across it — unless an ancestor clips
	// first (WindowShell does its own placement across the gap and clips with a margin)
	const FRAME = '.tp-dock-panel, .tp-window, [data-pd-host], [data-docked]';
	let btn = $state<HTMLButtonElement | null>(null);
	let shift = $state(0);
	function measureShift() {
		const el = btn;
		if (!el || open) return void (shift = 0);
		const frame = el.closest(FRAME) as HTMLElement | null;
		if (!frame) return void (shift = 0);
		for (let p = el.parentElement; p && p !== frame; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return void (shift = 0);
		const r = el.getBoundingClientRect();
		const f = frame.getBoundingClientRect();
		const now = edge === 'left' ? r.left - shift - (f.left + frame.clientLeft) : f.left + frame.clientLeft + frame.clientWidth - (r.right - shift);
		const next = now > 0 && now <= 12 ? Math.round(edge === 'left' ? -now : now) : 0;
		if (next !== shift) shift = next;
	}
	$effect(() => {
		void open;
		void edge;
		void style;
		const raf = requestAnimationFrame(measureShift);
		window.addEventListener('resize', measureShift);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', measureShift);
		};
	});
	// B5: Ctrl+B / Ctrl+Alt+B reach this pane when its docked window has the focus or the mouse ($lib/ui/paneKeys)
	$effect(() => registerPaneHandle({ el: () => btn, edge, press }));
	const items = $derived([
		{
			label: open ? `Hide ${label}` : `Show ${label}`,
			icon: open ? (edge === 'left' ? 'panel-left-close' : 'panel-right-close') : edge === 'left' ? 'panel-left-open' : 'panel-right-open',
			disabled: locked,
			tooltip: locked ? 'The sidebars are locked — unlock them first' : open ? `Hide ${label}` : `Show ${label}`,
			action: () => onclick()
		},
		...extraItems,
		{
			label: 'Lock sidebars',
			icon: 'lock',
			checked: locked,
			tooltip: locked ? 'Unlock: the arrows show and hide the sidebars again' : 'Keep this window’s sidebars as they are: the arrows stop hiding them and a narrow window no longer folds them away',
			action: () => togglePaneLock(windowKey)
		}
	]);
</script>

<button
	type="button"
	{id}
	class="tp-pane-handle"
	class:ph-left={edge === 'left'}
	class:ph-right={edge === 'right'}
	class:ph-open={open}
	class:ph-locked={locked}
	class:ph-role={!!role}
	aria-expanded={open}
	aria-label={locked ? `${label} — the sidebars are locked` : open ? `Hide ${label}` : `Show ${label}`}
	title={locked ? `The sidebars are locked — right-click to unlock` : `${open ? 'Hide' : 'Show'} ${label} — right-click for more`}
	style={shift && !open ? `${style}; translate: ${shift}px 0` : style}
	data-ph-shift={shift && !open ? shift : undefined}
	bind:this={btn}
	onclick={press}
	oncontextmenu={onMenu}
	{...rest}
>
	<span class="ph-tab" aria-hidden="true">
		<Icon name={locked ? 'lock' : chevron} size={16} strokeWidth={2.5} />
		{#if role && !locked}<Icon name={role} size={16} />{/if}
	</span>
</button>
{#if menu}
	<ContextMenu x={menu.x} y={menu.y} {items} sizeKey="panehandle" onclose={() => (menu = null)} />
{/if}

<style>
	/* the BUTTON is the hit area (transparent, wider than what is drawn); the TAB is the slim notebook tab. The
	   consumer positions the button absolutely: left: 0 / right: 0 against the edge the tab hangs from */
	.tp-pane-handle {
		position: absolute;
		z-index: 25;
		display: flex;
		align-items: center;
		width: 24px;
		height: 56px;
		padding: 0;
		margin: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}
	.ph-role {
		height: 68px;
	}
	/* a left pane: the tab hangs to the RIGHT of its edge (into the content), and the reverse */
	.ph-left {
		justify-content: flex-start;
	}
	.ph-right {
		justify-content: flex-end;
	}
	@media (pointer: coarse) {
		.tp-pane-handle {
			width: 44px;
		}
	}
	.ph-tab {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		width: 14px;
		height: 100%;
		overflow: hidden;
		color: var(--text-2);
		background: var(--surface-2);
		box-shadow: inset 0 0 0 1px var(--border);
		transition:
			width 0.12s ease,
			color 0.12s ease,
			background-color 0.12s ease;
	}
	.ph-left .ph-tab {
		border-radius: 0 6px 6px 0;
	}
	.ph-right .ph-tab {
		border-radius: 6px 0 0 6px;
	}
	.tp-pane-handle:hover .ph-tab,
	.tp-pane-handle:focus-visible .ph-tab {
		width: 18px;
		color: var(--text);
		background: var(--surface-hover);
	}
	.tp-pane-handle:focus-visible {
		outline: none;
	}
	.tp-pane-handle:focus-visible .ph-tab {
		box-shadow: 0 0 0 2px var(--focus-ring);
	}
	.ph-locked .ph-tab {
		color: var(--text-2);
		opacity: 0.8;
	}
	@media (prefers-reduced-motion: reduce) {
		.ph-tab {
			transition: none;
		}
	}
</style>
