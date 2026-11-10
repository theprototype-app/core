<script lang="ts">
	// 42 I2/I3 — the HEADER of each side's sidebar column ($lib/sidebars): one tab per panel docked
	// to that side (the Inspector, the Objects list, a docked Node editor / Explorer), the Full-height
	// pin at its far end, and the column's resize grip on its inner edge.
	//
	// A tab is the panel's handle (the Unity / Unreal docked-tab model): a press brings it to the
	// front, a DRAG moves the panel to the other side of the screen — the target column lights up
	// while the pointer is over that half, the drop docks it there. The header is drawn even for a
	// single tab, so the pin and the drag handle are always where the user expects them.
	//
	// 43 J4 — THE TAB IS THE PANEL'S HEADER in a sidebar (J7: a docked window shows no header of its
	// own there), so it carries what a header did: an × per tab, a menu (right-click; a long press on
	// touch — Close, Close others, Undock, Move to the other side, Move to the bottom dock:
	// $lib/sidebarMenu), and a drag that lands where it is dropped — the other side's column, the
	// bottom dock, or the viewport as a floating window — with ONE highlight for each
	// ($lib/sidebarDrop). The tabs scroll sideways like the dock strip's when they outgrow the column.
	// J6 — the Inspector's sticky-header lock (42 I1) sits here, beside Full height, on a wider screen.
	// 78-int PL14 — and its pin ("Follow the selection", #inspector-pin), since the Inspector lost its inner header.
	import { onMount, tick } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { stripScroll } from '$lib/ui/stripScroll.js';
	import { tabTouch, outsideBy } from '$lib/ui/tabTouch.js'; // panel-gestures item 7
	import { chromeButton, hiddenChromeIds, showButtonsItems } from '$lib/chromeButtons'; // panel-gestures item 5
	import { tabDropTarget, showDropTarget, canFloatPanel } from '$lib/sidebarDrop';
	import { canDockHere, addWindowItems, rebuildAfterPick } from '$lib/dockMenu';
	import { bindingOf } from '$lib/shortcuts';
	import { floatSizeOf } from '$lib/docking';
	import { sidebarTabItems, closeSidebarTab, floatSidebarTab, sidebarTabToDock } from '$lib/sidebarMenu';
	import { tearOffAt } from '$lib/windows/panelPlaces.js';
	import { stickyPanelHeads, toggleStickyHead } from '$lib/panelHeaderPrefs';
	import {
		SIDES,
		startSidebars,
		sidebarTabs,
		sidebarShown,
		sidebarFull,
		sidebarsWide,
		activateSidebarTab,
		moveSidebarTab,
		toggleSidebarFull,
		setSidebarWidth,
		defaultSidebarWidth,
		sidebarWidth,
		sidebarResizing,
		inspectorTabTitle,
		sidebarVisible,
		toggleSidebar,
		memberPlacement,
		isInspectorKey,
		MIN_W
	} from '$lib/sidebars';
	import { scaledPx } from '$lib/uiScale';
	import { inspectorKind, inspectorPinned } from '../../stores/appStore.js';
	import { DOCK_TITLES, DOCK_ICONS } from '$lib/bottomDock';

	onMount(() => startSidebars());

	type Side = 'left' | 'right';

	// showhide-v8 (owner R2): 'inspector' = the Properties tab (or a File), 'scene' = the Configure Scene tab
	function titleOf(key: string, insTitle: string) {
		if (key === 'inspector') return insTitle;
		if (key === 'scene') return 'Configure Scene';
		return DOCK_TITLES[key] ?? key;
	}
	function iconOf(key: string, kind: string) {
		if (key === 'scene') return 'sun';
		if (key === 'inspector') return kind === 'file' ? 'file-text' : 'sliders-horizontal';
		return DOCK_ICONS[key] ?? 'app-window';
	}

	// ---- the tab drag: the panel lands where it is dropped ($lib/sidebarDrop) ----
	type Target = ReturnType<typeof tabDropTarget>;
	let drag = $state<{ key: string; from: Side; x: number; y: number; target: Target } | null>(null);
	let press: { key: string; from: Side; x0: number; y0: number; id: number } | null = null;
	let suppressClick = false;
	const DRAG_SLOP = 6;

	// panel-gestures item 7 (owner, N6: "dragging across many sidebar tabs tears a tab off as a floating window
	// instead of scrolling"): a MOUSE keeps the press-drag below; touch / pen go through $lib/ui/tabTouch — a
	// sideways swipe scrolls the tabs, up / down does nothing, a still long-press LIFTS the tab and only then does
	// it travel (the same drop model), floats only once it is TEAR_PX outside the strip, and held still = the menu
	function onTabDown(e: PointerEvent, key: string, side: Side) {
		if (e.button !== 0 || e.pointerType !== 'mouse') return;
		// a drag whose tab MOVED to the other strip never gets its click, so the flag is cleared here
		suppressClick = false;
		press = { key, from: side, x0: e.clientX, y0: e.clientY, id: e.pointerId };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
	}
	/** the strip's box when a touch lifted a tab (the tear-off margin is measured from it) */
	let liftStrip: { left: number; top: number; right: number; bottom: number } | null = null;
	function touchTab(key: string, side: Side) {
		return {
			onlift: (x: number, y: number) => {
				const r = document.getElementById(`sidebar-strip-${side}`)?.getBoundingClientRect();
				liftStrip = r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
				press = { key, from: side, x0: x, y0: y, id: -1 };
			},
			onmove: (e: PointerEvent) => {
				if (!press || press.key !== key || press.id !== -1) return;
				moveTo(e, true);
			},
			ondrop: (e: PointerEvent) => {
				if (!press || press.key !== key || press.id !== -1) return;
				drop(e, true);
			},
			oncancel: () => onTabCancel(),
			onmenu: (x: number, y: number) => {
				onTabCancel();
				openTabMenu(x, y, key, side);
			}
		};
	}
	function onTabMove(e: PointerEvent) {
		if (!press || e.pointerId !== press.id) return;
		if (!drag && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) < DRAG_SLOP) return;
		moveTo(e, false);
	}
	/** a dragged tab asks the drop model where it would land; on touch the float target waits for the margin */
	function moveTo(e: PointerEvent, touch: boolean) {
		if (!press) return;
		const key = press.key;
		let target = tabDropTarget({
			x: e.clientX,
			y: e.clientY,
			key,
			from: press.from,
			canFloat: canFloatPanel(key),
			canDock: !isInspectorKey(key) && canDockHere(key),
			size: floatSizeOf(key) ?? undefined
		});
		// item 7: a finger tears a tab off only TEAR_PX outside its strip (a mouse keeps its own rule)
		if (touch && target?.kind === 'float' && (!liftStrip || !outsideBy(liftStrip, e.clientX, e.clientY))) target = null;
		showDropTarget(target, { id: 'sidebar-drop-zone' });
		drag = { key, from: press.from, x: e.clientX, y: e.clientY, target };
	}
	function onTabUp(e: PointerEvent) {
		if (!press || e.pointerId !== press.id) return;
		drop(e, false);
	}
	function drop(e: PointerEvent, touch: boolean) {
		const d = drag;
		press = null;
		drag = null;
		liftStrip = null;
		showDropTarget(null);
		if (!d) return;
		suppressClick = true; // the click that ends a drag is not a tab press
		if (!touch && tearOffAt(d.key, e)) return; // 70 W4: released outside the browser window — its own window there
		const t = d.target;
		if (!t) return;
		if (t.kind === 'side') moveSidebarTab(d.key, t.side);
		else if (t.kind === 'dock') sidebarTabToDock(d.key, t.strip ? t.strip.before : undefined);
		else floatSidebarTab(d.key, e.clientX, e.clientY);
	}
	function onTabCancel() {
		liftStrip = null;
		press = null;
		drag = null;
		showDropTarget(null);
	}

	// ---- the tab's menu ----
	let menu = $state<{ x: number; y: number; items: any[] } | null>(null);

	// ---- 44 M7: the strip's "+" — the same one-registry menu as the dock's "+" ($lib/dockMenu
	// addWindowItems): an open window is focused where it is, a closed one opens IN THIS COLUMN ----
	let addMenu = $state<{ x: number; y: number; side: Side; items: any[] } | null>(null);
	function openAdd(e: MouseEvent, side: Side) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		addMenu = { x: side === 'left' ? r.left : Math.max(8, r.right - 260), y: r.bottom + 4, side, items: addWindowItems({ target: side }) };
	}
	/** the side's shortcut, as Settings ▸ Shortcuts has it bound (rebindable) */
	function keyOfSide(side: Side) {
		return bindingOf(side === 'left' ? 'panels.sidebar-left' : 'panels.sidebar-right') ?? '';
	}
	function openTabMenu(x: number, y: number, key: string, side: Side) {
		// item 5: the strip buttons this person hid come back from here ("Show buttons ▸")
		menu = { x, y, items: [...sidebarTabItems(key, side, titleOf(key, $inspectorTabTitle)), ...showButtonsItems('sidebar', $hiddenChromeIds)] };
	}
	function onTabMenu(e: MouseEvent, key: string, side: Side) {
		e.preventDefault();
		onTabCancel();
		openTabMenu(e.clientX, e.clientY, key, side);
	}

	// ---- the strip keeps its front tab in view (it scrolls when the tabs outgrow the column) ----
	$effect(() => {
		const shown = $sidebarShown;
		tick().then(() => {
			for (const side of SIDES) {
				const key = shown[side];
				if (!key) continue;
				const box = document.querySelector(`#sidebar-strip-${side} .sb-tabs`) as HTMLElement | null;
				const tab = box?.querySelector(`[data-sidebar-tab-group="${key}"]`) as HTMLElement | null;
				if (!box || !tab) continue;
				const a = tab.offsetLeft;
				const b = a + tab.offsetWidth;
				if (a < box.scrollLeft) box.scrollLeft = Math.max(0, a - 8);
				else if (b > box.scrollLeft + box.clientWidth) box.scrollLeft = b + 8 - box.clientWidth;
			}
		});
	});

	// ---- J6: the Inspector's header lock, beside Full height ----
	/** which panel the lock acts on when a side shows the Inspector ('' = none: a file, another tab) */
	function lockPanelOf(shown: string | null, kind: string): '' | 'scene' | 'properties' {
		if (shown === 'scene') return 'scene';
		if (shown !== 'inspector') return '';
		return kind === 'file' || kind === 'scene' ? '' : 'properties';
	}
	function onTabClick(key: string) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		activateSidebarTab(key);
	}
	function onTabKey(e: KeyboardEvent, side: Side, key: string) {
		const tabs = $sidebarTabs[side];
		const i = tabs.indexOf(key);
		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault();
			const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
			activateSidebarTab(next);
			(document.querySelector(`#sidebar-strip-${side} [data-sidebar-tab="${next}"]`) as HTMLElement | null)?.focus();
		}
	}

	// ---- the column's resize grip ----
	// showhide-v8 (owner 2026-11-09): on a desktop an open column CLOSES BY ITS BORDER (Blender style) — dragging the
	// grip well past the narrowest width (COLLAPSE_PX beyond it) collapses the column on release; its handle on the
	// screen edge brings it back at the width it had. The grip shows the "will close" state while the drag is there.
	const COLLAPSE_PX = 80;
	let sizing: { side: Side; x0: number; w0: number; id: number } | null = null;
	let collapsing = $state<Side | null>(null);
	function onGripDown(e: PointerEvent, side: Side) {
		if (e.button !== 0) return;
		e.preventDefault();
		sizing = { side, x0: e.clientX, w0: $sidebarWidth[side], id: e.pointerId };
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		sidebarResizing.set(side); // 43 K1: the edge-followers stop animating for the gesture
	}
	function onGripMove(e: PointerEvent) {
		if (!sizing || e.pointerId !== sizing.id) return;
		const delta = sizing.side === 'left' ? e.clientX - sizing.x0 : sizing.x0 - e.clientX;
		const want = sizing.w0 + delta;
		collapsing = want < scaledPx(MIN_W) - COLLAPSE_PX ? sizing.side : null;
		setSidebarWidth(sizing.side, collapsing ? sizing.w0 : want, false);
	}
	function onGripUp(e: PointerEvent) {
		if (!sizing || e.pointerId !== sizing.id) return;
		const side = sizing.side;
		setSidebarWidth(side, $sidebarWidth[side], true);
		sizing = null;
		sidebarResizing.set(null);
		if (collapsing === side) toggleSidebar(side, false);
		collapsing = null;
	}
	function onGripCancel() {
		if (!sizing) return;
		setSidebarWidth(sizing.side, $sidebarWidth[sizing.side], true);
		sizing = null;
		collapsing = null;
		sidebarResizing.set(null);
	}
	/** double-click forgets the width (back to the default) */
	function onGripReset(side: Side) {
		setSidebarWidth(side, defaultSidebarWidth(), true); // 53 A1: 320 at the current UI scale
	}
</script>

{#if $sidebarsWide}
	{#each SIDES as side (side)}
		{#if $sidebarVisible[side]}
			{@const lockPanel = lockPanelOf($sidebarShown[side], $inspectorKind)}
			<div
				id="sidebar-strip-{side}"
				class="sb-strip tp-ui"
				class:sb-full={$sidebarFull[side]}
				data-side={side}
				style="top: var(--sb-{side}-top); width: var(--sb-{side}-w); {side === 'left' ? 'left: var(--sb-left-x, 0px)' : 'right: 0px'}"
			>
				<div class="sb-tabs tp-noscrollbar" role="tablist" aria-label="{side === 'left' ? 'Left' : 'Right'} sidebar" use:stripScroll>
					{#each $sidebarTabs[side] as key (key)}
						{@const title = titleOf(key, $inspectorTabTitle)}
						<span class="sb-tab-group" class:on={$sidebarShown[side] === key} class:dragging={drag?.key === key} data-sidebar-tab-group={key}>
							<button
								class="sb-tab"
								class:on={$sidebarShown[side] === key}
								role="tab"
								aria-selected={$sidebarShown[side] === key}
								tabindex={$sidebarShown[side] === key ? 0 : -1}
								data-sidebar-tab={key}
								title="{title} — drag to move it (the other side, the bottom dock, or out into a floating window); right-click for more"
								use:tabTouch={touchTab(key, side)}
								onpointerdown={(e) => onTabDown(e, key, side)}
								onpointermove={onTabMove}
								onpointerup={onTabUp}
								onpointercancel={onTabCancel}
								oncontextmenu={(e) => onTabMenu(e, key, side)}
								onclick={() => onTabClick(key)}
								onkeydown={(e) => onTabKey(e, side, key)}
							>
								<Icon name={iconOf(key, $inspectorKind)} size={16} aria-hidden="true" />
								<span class="sb-tab-label">{title}</span>
							</button>
							<button
								class="sb-tab-x"
								tabindex="-1"
								data-sidebar-tab-close={key}
								title="Close {title}"
								aria-label="Close {title}"
								onclick={() => closeSidebarTab(key)}><Icon name="x" size={16} aria-hidden="true" /></button
							>
						</span>
					{/each}
				</div>
				<button
					type="button"
					id="sidebar-add-{side}"
					class="sb-pin sb-add"
					aria-label="Add a window to the {side} sidebar"
					title="Add a window to this sidebar — Ctrl-click or Shift-click to pick several"
					onclick={(e) => openAdd(e, side)}
				>
					<Icon name="plus" size={16} aria-hidden="true" />
				</button>
				{#if lockPanel}
					<!-- 78-int PL14: the Inspector's pin ("Follow the selection") moved here from its inner header -->
					<button
						type="button"
						id="inspector-pin"
						class="sb-pin sb-follow"
						use:chromeButton={'sidebar.pin'}
						class:on={$inspectorPinned}
						aria-pressed={$inspectorPinned}
						aria-label={$inspectorPinned ? 'Stop following the selection' : 'Follow the selection'}
						title={$inspectorPinned
							? 'Following the selection: this panel stays open and shows what you select. Click to stop'
							: 'Follow the selection: keep this panel open and show what you select'}
						onclick={() => inspectorPinned.update((v) => !v)}
					>
						<Icon name={$inspectorPinned ? 'pin' : 'pin-off'} size={16} aria-hidden="true" />
					</button>
					{@const sticky = $stickyPanelHeads[lockPanel] !== false}
					{@const panelName = lockPanel === 'scene' ? 'Configure Scene' : 'Properties'}
					<button
						type="button"
						id="inspector-sticky-head"
						class="sb-pin sb-lock ins-sticky-btn"
						use:chromeButton={'sidebar.lock'}
						aria-pressed={sticky}
						aria-label={sticky ? `Let the ${panelName} header scroll away` : `Keep the ${panelName} header on top`}
						title={sticky
							? 'Header stays on top — click to let it scroll away with the properties'
							: 'Header scrolls away — click to keep it on top while you scroll'}
						onclick={() => toggleStickyHead(lockPanel)}
					>
						<Icon name={sticky ? 'lock' : 'lock-open'} size={16} aria-hidden="true" />
					</button>
				{/if}
				<button
					id="sidebar-full-{side}"
					class="sb-pin"
					use:chromeButton={'sidebar.full'}
					class:on={$sidebarFull[side]}
					aria-pressed={$sidebarFull[side]}
					aria-label="Full height"
					title={$sidebarFull[side]
						? 'Full height is on — this sidebar runs from the top edge to the bottom edge. Click to fit it under the top buttons again'
						: 'Full height — run this sidebar from the top edge to the bottom edge (the corner buttons move inward, the dock gets narrower)'}
					onclick={() => toggleSidebarFull(side)}
				>
					<Icon name="unfold-vertical" size={16} aria-hidden="true" />
				</button>
				<!-- dock-fixes (owner 2026-11-08, "sidebars must ALWAYS be hideable with a button"): the hide button is
				     on every column, with tabs or without — pinned outside the scrolling tabs like the "+" (the tabs
				     scroll sideways when they outgrow the column, so it costs no tab its place) -->
				<button
					type="button"
					id="sidebar-hide-{side}"
					class="sb-pin"
					use:chromeButton={'sidebar.toggle'}
					aria-label="Hide the {side} sidebar"
					title="Hide this sidebar — its tabs stay open{keyOfSide(side) ? ' (' + keyOfSide(side) + ' brings it back)' : ''}"
					onclick={() => toggleSidebar(side, false)}
				>
					<Icon name={side === 'left' ? 'panel-left-close' : 'panel-right-close'} size={16} aria-hidden="true" />
				</button>
			</div>
			{#if !$sidebarTabs[side].length}
				<!-- 44 M7: an EMPTY column stays open (VS Code / Blender style): one quiet centred line -->
				<div id="sidebar-empty-{side}" class="sb-empty tp-ui" data-side={side} style={memberPlacement(side)}>
					<p>Press + or drag a tab here</p>
				</div>
			{/if}
			<!-- the column's width belongs to the SIDE: one grip on its inner edge resizes every tab -->
			<div
				id="sidebar-grip-{side}"
				class="sb-grip resize-cue"
				class:sb-grip-collapse={collapsing === side}
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize the {side} sidebar"
				title="Drag to resize · drag far in to close the sidebar · double-click to reset"
				style="top: var(--sb-{side}-top); bottom: var(--sb-{side}-bottom); {side === 'left'
					? 'left: calc(var(--sb-left-x, 0px) + var(--sb-left-w) - 3px)'
					: 'right: calc(var(--sb-right-w) - 3px)'}"
				onpointerdown={(e) => onGripDown(e, side)}
				onpointermove={onGripMove}
				onpointerup={onGripUp}
				onpointercancel={onGripCancel}
				onlostpointercapture={onGripCancel}
				ondblclick={() => onGripReset(side)}
			></div>
		{/if}
	{/each}

	{#if drag}
		<!-- the drop highlight is $lib/sidebarDrop's (one painter for every target); the ghost follows the pointer -->
		<div class="sb-ghost tp-ui" style="left: {drag.x + 12}px; top: {drag.y + 8}px">
			<Icon name={iconOf(drag.key, $inspectorKind)} size={16} aria-hidden="true" />
			{titleOf(drag.key, $inspectorTabTitle)}
			{#if !drag.target}<span class="sb-ghost-hint">{isInspectorKey(drag.key) ? 'Drop on a side' : 'Stays here'}</span>{/if}
		</div>
	{/if}
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="sidebartab" onclose={() => (menu = null)} />
{/if}
{#if addMenu}
	<ContextMenu
		x={addMenu.x}
		y={addMenu.y}
		items={addMenu.items}
		sizeKey="sidebaradd"
		onclose={() => (addMenu = null)}
		onpicked={() => rebuildAfterPick(() => addMenu && (addMenu = { ...addMenu, items: addWindowItems({ target: addMenu.side }) }))}
	/>
{/if}

<style>
	.sb-strip {
		position: fixed;
		z-index: calc(var(--z-dock) - 1);
		height: var(--sb-strip-h, 30px);
		display: flex;
		align-items: stretch;
		gap: 2px;
		padding: 0 4px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-bottom: 0;
		box-sizing: border-box;
	}
	.sb-strip[data-side='right'] {
		border-right: 0;
		border-top-left-radius: var(--radius-window);
	}
	.sb-strip[data-side='left'] {
		border-left: 0;
		border-top-right-radius: var(--radius-window);
	}
	.sb-strip.sb-full {
		border-radius: 0;
		border-top: 0;
	}
	:global(:root.connect-docked) .sb-strip {
		z-index: calc(var(--z-chrome-top) + 1);
	}
	/* 43 J4: the tabs keep their width and the row SCROLLS sideways (wheel, swipe; the edge with more
	   behind it fades — stripScroll), the dock strip's model, instead of squeezing every name away */
	.sb-tabs {
		display: flex;
		align-items: stretch;
		gap: 2px;
		min-width: 0;
		flex: 1 1 auto;
		overflow-x: auto;
		overflow-y: hidden;
	}
	/* dock-fixes: with the hide button on every column (owner) a 320 px column holds two tabs + four pinned buttons
	   only if the tabs give a little: each SHRINKS to 72 px (label ellipsis, the full name in its tooltip) before the
	   row scrolls — two tabs always fit whole, a third scrolls (J4). Without it the front tab scrolled the other
	   one out past the strip's edge, where a press missed it (sidebar-tabs §3). */
	.sb-tab-group {
		display: inline-flex;
		align-items: stretch;
		flex: 0 1 auto;
		min-width: 72px;
		max-width: 200px;
		margin-top: 3px;
		border-radius: var(--radius-input) var(--radius-input) 0 0;
		color: var(--text-muted);
	}
	.sb-tab-group:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	.sb-tab-group.on {
		color: var(--text);
		background: var(--surface-2);
		box-shadow: inset 0 2px 0 var(--accent);
	}
	.sb-tab-group.dragging {
		opacity: 0.5;
	}
	/* item 7: the long-pressed tab is lifted (it now follows the finger) */
	.sb-tab-group :global(.sb-tab.tab-lifted) {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.sb-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		flex: 0 1 auto;
		padding: 0 2px 0 10px;
		color: inherit;
		font-size: var(--fs-desc);
		cursor: grab;
		/* item 7: a finger swipes the strip (tabTouch sets pan-x inline); a mouse drags as before */
		touch-action: pan-x;
		user-select: none;
		white-space: nowrap;
	}
	.sb-tab-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.sb-tab-x {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		margin: 3px 3px 3px 0;
		border-radius: var(--radius-input);
		color: var(--text-faint);
	}
	.sb-tab-x:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	/* 44 M7: the empty column's body — the column's own surface, one centred line */
	.sb-empty {
		z-index: calc(var(--z-dock) - 1);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		background: var(--surface-1);
		border-left: 1px solid var(--border);
		color: var(--text-faint);
		font-size: var(--fs-desc);
		text-align: center;
		user-select: none;
		box-sizing: border-box;
	}
	.sb-empty[data-side='left'] {
		border-left: 0;
		border-right: 1px solid var(--border);
	}
	:global(:root.connect-docked) .sb-empty {
		z-index: calc(var(--z-chrome-top) + 1);
	}
	.sb-ghost-hint {
		margin-left: 4px;
		color: var(--text-faint);
	}
	.sb-pin {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		margin: 3px 0;
		border-radius: var(--radius-input);
		color: var(--text-muted);
	}
	.sb-pin:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	/* 44 M7: the "+" is pinned outside the scrolling tabs (the dock strip's rule: always reachable) and
	   narrow, so two tabs still fit beside it in a 320 px column */
	.sb-add {
		width: 24px;
	}
	.sb-pin.on {
		color: var(--accent-text);
		background: var(--accent-soft);
	}
	/* 43 K2: above the column's own panel (the Inspector sits on --z-side-panel) — the grip straddles the
	   column's inner edge, and its inner half used to be UNDER the panel, so a finger there pressed the
	   panel instead of the grip; wider under a finger */
	.sb-grip {
		position: fixed;
		z-index: calc(var(--z-side-panel) + 1);
		width: 6px;
		cursor: ew-resize;
		touch-action: none;
	}
	/* showhide-v8: a drag far enough in closes the column on release — the edge says so while it is there */
	.sb-grip-collapse {
		background: var(--accent);
		opacity: 0.6;
		cursor: w-resize;
	}
	/* under a DOCKED Connect bar the column's panel rides --z-chrome-top + 1 (ui.css), so the grip does too */
	:global(:root.connect-docked) .sb-grip {
		z-index: calc(var(--z-chrome-top) + 2);
	}
	@media (pointer: coarse) {
		.sb-grip {
			width: 14px;
		}
		#sidebar-grip-left {
			margin-left: -4px;
		}
		#sidebar-grip-right {
			margin-right: -4px;
		}
	}
	.sb-ghost {
		position: fixed;
		z-index: var(--z-portal);
		pointer-events: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		border-radius: var(--radius-input);
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		box-shadow: var(--shadow-window);
		font-size: var(--fs-desc);
		color: var(--text);
	}
</style>
