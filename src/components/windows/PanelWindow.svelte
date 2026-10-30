<script lang="ts">
	// 70 W2-W4 — A POP-OUT WINDOW's whole content, mounted on the popup's <body> by
	// $lib/windows/panelHost (one svelte root per popup = svelte's event delegation lives there).
	//
	// THE TAB RULES (owner, roadmap 70 W3), all read from the layout model:
	//   - ONE panel and a panel window: no tab strip. The header shows the panel's name and that
	//     name IS the tab — drag it to move the panel, right-click for Dock back / Move to…, it
	//     looks grabbable on hover;
	//   - a second tab (dropped on the header, or the header's "+") makes the strip appear and the
	//     title becomes the first tab; back to one tab, the strip collapses again;
	//   - a popped-out DOCK always shows its tabs; Settings ▸ "Always show tab strip in windows"
	//     shows them for one panel too.
	// W4: tabs (and the lone title) drag between windows with HTML5 drag and drop — the marker type
	// `application/x-tp-panel` travels in the DataTransfer, the key in $lib/windows/panelPlaces'
	// `panelDrag` (one realm). While anything is dragged, every window's header is a drop zone; the
	// main window shows its own (PanelDropZones). Dropped nowhere — outside every window — a tab
	// tears off into a new window there.
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import PoppedPanel from './PoppedPanel.svelte';
	import { showsStrip, windowById } from '$lib/windows/panelLayout.js';
	import { panelDrag, PANEL_DRAG_TYPE } from '$lib/windows/panelPlaces.js';
	import { panelTitles } from '$lib/windows/panelRegistry.js';

	let { winId, api }: { winId: string; api: any } = $props();

	// svelte-ignore state_referenced_locally
	const layout = api.layout;
	// svelte-ignore state_referenced_locally
	const alwaysStrip = api.alwaysStrip;
	/** a tab's name, live (the Inspector's follows what it shows) */
	const titleOf = (key: string): string => $panelTitles[key] ?? api.titleOf(key);

	const win = $derived(windowById($layout, winId));
	const strip = $derived(showsStrip(win, $alwaysStrip));
	const dragging = $derived(!!$panelDrag);

	let headEl: HTMLElement | null = $state(null);
	let menu: { x: number; y: number; items: any[] } | null = $state(null);
	/** the drop caret: the tab index a drop would land at (null: no drop over this header) */
	let dropAt: number | null = $state(null);

	/** this popup's own window (a tear-off opens from it: the drag's activation is here) */
	const ownWin = () => headEl?.ownerDocument?.defaultView ?? null;

	function moveRows(key: string) {
		const title = api.titleOf(key);
		const others = api.windows().filter((w: any) => w.id !== winId);
		const rows: any[] = [
			{ label: 'Bottom dock', icon: 'panel-bottom', tooltip: `Put ${title} back in the app, as a tab of the bottom dock`, action: () => api.dropToMain(key, 'bottom') },
			{ label: 'Left sidebar', icon: 'panel-left', tooltip: `Put ${title} back in the app, in the left sidebar`, action: () => api.dropToMain(key, 'left') },
			{ label: 'Right sidebar', icon: 'panel-right', tooltip: `Put ${title} back in the app, in the right sidebar`, action: () => api.dropToMain(key, 'right') }
		];
		for (const w of others) rows.push({ label: w.title, icon: 'app-window', tooltip: `Move ${title} into the "${w.title}" window`, action: () => api.moveTo(key, w.id) });
		if ((win?.panels.length ?? 0) > 1) rows.push({ label: 'New window', icon: 'external-link', tooltip: `${title} in a window of its own`, action: () => api.popOut(key, { via: ownWin() }) });
		return rows;
	}

	/** the tab / title menu (W3: Dock back / Move to…) @param {MouseEvent} e @param {string} key */
	function tabMenu(e: MouseEvent, key: string) {
		e.preventDefault();
		const title = api.titleOf(key);
		const entry = api.entryOf(key);
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{ label: 'Dock back', icon: 'undo-2', tooltip: `Put ${title} back in the app, where it was`, action: () => api.dockBack(key) },
				{ label: 'Move to', icon: 'move', tooltip: `Move ${title} to a dock, a sidebar or another window`, children: moveRows(key) },
				...(strip && (win?.panels.length ?? 0) > 1 ? [{ label: 'Dock back all tabs', icon: 'panel-bottom', tooltip: 'Every tab of this window goes back into the app', action: () => api.dockWindowBack(winId) }] : []),
				{ label: 'Always show tab strip in windows', checked: get(alwaysStrip), keepOpen: true, tooltip: 'Show the tab strip even when a window holds one panel', action: () => alwaysStrip.update((v: boolean) => !v) },
				{ label: 'Close', icon: 'x', tooltip: `Close ${title}`, action: () => entry?.close() }
			]
		};
	}

	/** the header's "+": every other poppable panel, added here as a tab (it moves: one place) */
	function addMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const rows = api.addable(winId).map((key: string) => ({
			label: api.titleOf(key),
			icon: api.iconOf(key),
			tooltip: `Add ${api.titleOf(key)} to this window as a tab (it moves here from wherever it is)`,
			action: () => api.moveTo(key, winId)
		}));
		menu = { x: r.left, y: r.bottom + 2, items: rows.length ? rows : [{ label: 'Every panel is already here', disabled: true, tooltip: 'Nothing else can be added' }] };
	}

	// ------------------------------------------------------------------ drag and drop (W4)
	function onDragStart(e: DragEvent, key: string) {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData(PANEL_DRAG_TYPE, key);
		e.dataTransfer.setData('text/plain', api.titleOf(key));
		e.dataTransfer.effectAllowed = 'move';
		panelDrag.set({ key, from: winId });
	}

	function onDragEnd(e: DragEvent, key: string) {
		const st = get(panelDrag);
		panelDrag.set(null);
		dropAt = null;
		// a drop target cleared the drag already; Esc / a drop back on this window lands inside it
		if (!st || st.key !== key) return;
		const w = ownWin();
		if (!w || e.screenX === 0 && e.screenY === 0) return;
		const inside = e.screenX >= w.screenX && e.screenX <= w.screenX + w.outerWidth && e.screenY >= w.screenY && e.screenY <= w.screenY + w.outerHeight;
		if (inside) return;
		// dropped outside every window: tear off into a new window there (a lone panel just stays)
		if ((win?.panels.length ?? 0) > 1) api.popOut(key, { via: w, rect: { left: e.screenX - 60, top: e.screenY - 16, width: w.outerWidth, height: w.outerHeight } });
	}

	const isPanelDrag = (e: DragEvent) => !!e.dataTransfer?.types?.includes(PANEL_DRAG_TYPE) && !!get(panelDrag);

	function onDragOver(e: DragEvent) {
		if (!isPanelDrag(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		const tabs = [...(headEl?.querySelectorAll('[data-pw-tab]') ?? [])];
		let at = tabs.length;
		for (let i = 0; i < tabs.length; i++) {
			const r = tabs[i].getBoundingClientRect();
			if (e.clientX < r.left + r.width / 2) {
				at = i;
				break;
			}
		}
		dropAt = at;
	}

	function onDrop(e: DragEvent) {
		const st = get(panelDrag);
		if (!isPanelDrag(e) || !st) return;
		e.preventDefault();
		const at = dropAt;
		dropAt = null;
		panelDrag.set(null);
		api.moveTo(st.key, winId, at ?? undefined);
	}
</script>

{#if win}
	<div class="pw-root tp-ui" data-pop-window={winId} data-tabs={strip ? 'strip' : 'title'}>
		<div
			bind:this={headEl}
			class="pw-head"
			class:pw-drop={dragging}
			class:pw-drop-over={dropAt !== null}
			role="toolbar"
			tabindex="-1"
			aria-label="Window tabs"
			ondragover={onDragOver}
			ondragleave={(e) => {
				if (!headEl?.contains(e.relatedTarget as Node)) dropAt = null;
			}}
			ondrop={onDrop}
		>
			{#if strip}
				<div class="pw-tabs" role="tablist" aria-label="Panels in this window">
					{#each win.panels as key, i (key)}
						{#if dropAt === i}<span class="pw-caret" aria-hidden="true"></span>{/if}
						<span class="pw-tab" class:pw-active={key === win.active}>
							<button
								class="pw-tab-btn"
								data-pw-tab={key}
								role="tab"
								aria-selected={key === win.active}
								draggable="true"
								title={`${titleOf(key)} — drag to move it, right-click for more`}
								onclick={() => api.activate(key)}
								oncontextmenu={(e) => tabMenu(e, key)}
								ondragstart={(e) => onDragStart(e, key)}
								ondragend={(e) => onDragEnd(e, key)}
								><Icon name={api.iconOf(key)} size={16} aria-hidden="true" /><span class="pw-tab-label">{titleOf(key)}</span></button
							>
							<button
								class="pw-tab-x"
								aria-label={`Dock ${titleOf(key)} back into the app`}
								title="Dock back into the app"
								onclick={() => api.dockBack(key)}><Icon name="x" size={16} aria-hidden="true" /></button
							>
						</span>
					{/each}
					{#if dropAt === win.panels.length}<span class="pw-caret" aria-hidden="true"></span>{/if}
				</div>
			{:else}
				{@const key = win.panels[0]}
				<div class="pw-tabs" role="tablist" aria-label="Panel in this window">
					<button
						class="pw-title"
						data-pw-tab={key}
						role="tab"
						aria-selected="true"
						draggable="true"
						title={`${titleOf(key)} — drag to move it, right-click to dock it back or move it`}
						oncontextmenu={(e) => tabMenu(e, key)}
						ondragstart={(e) => onDragStart(e, key)}
						ondragend={(e) => onDragEnd(e, key)}
						><span class="pw-grip" aria-hidden="true"><Icon name="grip-vertical" size={16} /></span><Icon name={api.iconOf(key)} size={16} aria-hidden="true" /><span
							class="pw-title-label">{titleOf(key)}</span
						></button
					>
				</div>
				{#if dropAt !== null}<span class="pw-hint">Drop to add as a tab</span>{/if}
			{/if}
			<span class="pw-fill"></span>
			<button class="pw-btn" id="pw-add" aria-label="Add a panel to this window" title="Add a panel to this window as a tab" onclick={addMenu}><Icon name="plus" size={16} aria-hidden="true" /></button>
			{#if strip}
				<button class="pw-btn" id="pw-dock-all" aria-label="Dock every tab back" title="Put every tab of this window back into the app" onclick={() => api.dockWindowBack(winId)}><Icon name="panel-bottom" size={16} aria-hidden="true" /></button>
			{:else}
				<button class="pw-btn" id="pw-dock-back" aria-label="Dock back" title="Close this window and put the panel back in the app, where it was" onclick={() => api.dockBack(win.panels[0])}><Icon name="panel-bottom" size={16} aria-hidden="true" /></button>
			{/if}
		</div>
		<div class="pw-body">
			{#each win.panels as key (key)}
				<PoppedPanel {key} active={key === win.active} {api} />
			{/each}
		</div>
	</div>
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}

<style>
	.pw-root {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--surface-1);
		color: var(--text);
	}
	.pw-head {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 34px;
		padding: 2px 6px;
		border-bottom: 1px solid var(--border);
		background: var(--surface-2, var(--surface-1));
		user-select: none;
	}
	/* W4: every window that can take the tab shows it while anything is dragged */
	.pw-head.pw-drop {
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
	}
	.pw-head.pw-drop-over {
		box-shadow: inset 0 0 0 2px var(--accent);
		background: color-mix(in srgb, var(--accent) 12%, var(--surface-1));
	}
	.pw-tabs {
		display: flex;
		align-items: stretch;
		gap: 2px;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.pw-tab {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 0 4px 0 0;
		border-radius: 6px;
		font-size: 12px;
		color: var(--text-2, var(--text));
		white-space: nowrap;
	}
	.pw-tab-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 4px 4px 10px;
		cursor: grab;
	}
	.pw-tab:hover {
		background: color-mix(in srgb, var(--text) 8%, transparent);
	}
	.pw-tab.pw-active {
		background: var(--surface-1);
		color: var(--text);
		box-shadow: 0 0 0 1px var(--border);
	}
	.pw-tab-x {
		display: inline-flex;
		padding: 2px;
		border-radius: 4px;
		opacity: 0.6;
	}
	.pw-tab-x:hover {
		opacity: 1;
		background: color-mix(in srgb, var(--text) 12%, transparent);
	}
	.pw-caret {
		width: 3px;
		border-radius: 2px;
		background: var(--accent);
	}
	/* W3: a lone panel's name IS its tab — it looks grabbable on hover */
	.pw-title {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px 4px 4px;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 600;
		cursor: grab;
	}
	.pw-title:hover {
		background: color-mix(in srgb, var(--text) 8%, transparent);
	}
	.pw-grip {
		display: inline-flex;
		opacity: 0;
		transition: opacity 120ms ease-out;
	}
	.pw-title:hover .pw-grip,
	.pw-title:focus-visible .pw-grip {
		opacity: 0.7;
	}
	.pw-tab-btn:active,
	.pw-title:active {
		cursor: grabbing;
	}
	.pw-hint {
		font-size: 11px;
		color: var(--accent);
	}
	.pw-fill {
		flex: 1;
	}
	.pw-btn {
		display: inline-flex;
		padding: 5px;
		border-radius: 6px;
		color: var(--text-2, var(--text));
	}
	.pw-btn:hover {
		background: color-mix(in srgb, var(--text) 10%, transparent);
		color: var(--text);
	}
	.pw-body {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
	}
</style>
