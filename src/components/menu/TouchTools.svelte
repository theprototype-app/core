<script>
	// #20 P4: the touch-tools cluster — round Undo / Redo / Multi-select buttons beside
	// the logo, matching its 48px chrome and dropping below the Connect bar with it.
	//
	// Why these three and not more: touch has no keyboard and no right-click, so Ctrl+Z
	// and Shift-click are the two reflexes a phone user simply cannot perform. Everything
	// else already has a touch path (the long-press viewport menu, the + button).
	//
	// MULTI-SELECT is one toggle covering both gestures a modifier would have covered —
	// a tap ADDS instead of replacing, and a drag on empty space draws the marquee — so
	// there is one thing to learn and one mode to see. Scene.svelte reads
	// `multiSelectMode` in the same two places it reads `event.shiftKey`, which is what
	// keeps this from being a second selection implementation.
	import Icon from '../ui/Icon.svelte';
	import { roving } from '$lib/keyboardNav'; // 53 A3: one tab stop, arrows between the buttons
	import { touchTools, multiSelectMode, connectDocked, connectBarHeight } from '../../stores/appStore';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
	// 42 I9: the cluster is a layout region of the toolbar's record — which of these three are
	// placed here, in what order, and whether Edit positions is drawing placeholders instead
	// (Controls portals any OTHER button placed here into this row, with the same `order` numbers)
	import { toolbarSlots, slotOrder } from '$lib/toolbarSlots';
	import { SIDE_MAX } from '$lib/toolbarLayout';
	// 44 M13: the row slides with the left sidebar, like the logo beside it
	import { geometry as sidebarGeometry } from '$lib/sidebars';
	import { hudGrid } from '$lib/hudGrid';
	const ttOrder = (/** @type {string} */ id) => slotOrder($toolbarSlots.touch, id);
	const ttShown = (/** @type {string} */ id) => !$toolbarSlots.editing && ttOrder(id) != null;
	/** how many buttons the row holds (edit mode adds a "+" while there is room) */
	const ttCount = $derived(
		$toolbarSlots.touch.length + ($toolbarSlots.editing && $toolbarSlots.touch.length < SIDE_MAX ? 1 : 0)
	);

	// ---- row or column: MEASURED, not a breakpoint -----------------------------
	// A width breakpoint got this wrong on a real device — an unfolded Oppo N8 has plenty
	// of room beside the logo and still stacked. So the question is asked directly: does a
	// row of three buttons fit between the logo and whatever is next along that row?
	// Connect's own `measureDock()` decides its docking the same way, for the same reason.
	// 103 H15: the row's numbers are the HUD grid's (styles/hud.css, read through $lib/hudGrid): its buttons are
	// --hud-tile tiles --hud-gap apart, and the row starts one tile + one gap right of the logo's inset — the same
	// place the CSS below puts it. (They were a 48 px round button and a 78 px start of their own.)
	const grid = () => hudGrid();
	/** where the row starts, as the CSS places it (never the logo's measured right edge: the row claims what it
	 *  occupies, not what the logo leaves) */
	const rowLeft = () => {
		const g = grid();
		return g.inset + g.tile + g.gap;
	};
	/** breathing room, not just collision avoidance. At 420px the row cleared the notes
	 *  button by 14px — technically fitting, visually touching it, which is what the user
	 *  reported. 24px is the gap at which the two read as separate clusters. */
	const GUTTER = 24;
	/** the row's own width, from CONSTANTS and the COUNT of buttons the layout puts in it — never
	 *  from the element's own rect, or the measurement would feed the layout that produced it
	 *  (the frozen-span rule). 42 I9: the count is no longer always three. */
	const rowRight = (/** @type {number} */ n) => {
		const g = grid();
		return rowLeft() + pinnedSlide() + g.tile * n + g.gap * Math.max(0, n - 1) + GUTTER;
	};
	/** the part of the slide that moves the ROW (a pinned column) — never the stacked-only part, or deciding to
	 *  stack would move the row that decided it */
	function pinnedSlide() {
		const g = $sidebarGeometry;
		return g?.wide && g.left.shown && g.left.full ? g.left.w : 0;
	}

	let stacked = $state(false);

	/** 44 M13: how far the row slides right for the LEFT sidebar. A PINNED (full-height) column takes the corner and
	 *  the logo slides by its width (42 I2) — the row beside it used to stay at 78 px, on top of the column. An OPEN
	 *  (unpinned) column starts below the logo's row, so it only matters where the row would sit over it: stacked
	 *  below the logo, or while Edit positions draws every placeholder (the edit bar sits beside any open sidebar,
	 *  J8, and so does this row). */
	const slide = $derived.by(() => {
		const g = $sidebarGeometry;
		if (!g?.wide || !g.left.shown) return 0;
		if (g.left.full) return g.left.w;
		// the row's band is its anchor .. + one tile; the column's tab strip may tuck under its lower edge
		const { inset, tile } = grid();
		const anchor = $connectDocked ? $connectBarHeight + inset : inset;
		const overRow = g.left.top < anchor + tile - 8;
		return stacked || overRow || $toolbarSlots.editing ? g.leftX + g.left.w : 0;
	});
	/** Everything that can sit on the logo's row and must not be run into: the centred
	 *  Connect pill, and the notes / peers / profile cluster the user pointed out is just
	 *  as much of a wall as the pill.
	 *
	 *  The concrete BUTTONS, not their `.top-right-chrome` wrapper — measured, that wrapper
	 *  has HEIGHT 0 (its children are positioned inside it), so a vertical-overlap test
	 *  skipped it every time and the cluster was invisible to this measurement. */
	const NEIGHBOURS = ['.connect-pill', '#notes-toggle', '#peers-trigger', '#avatar-trigger'];

	function measure() {
		if (typeof document === 'undefined') return;
		// 44 M12b: a row the person PLACED (Edit positions) or rotated is laid out as they chose — no measuring
		const own = $toolbarSlots.clusters?.touch;
		if (own && (typeof own.x === 'number' || own.rotated)) {
			stacked = false;
			return;
		}
		const logo = document.querySelector('#logo-menu')?.getBoundingClientRect();
		if (!logo) {
			stacked = false;
			return;
		}
		// the row would occupy logo.right .. logo.right + ROW_W at the logo's own top
		const top = logo.top;
		const bottom = logo.bottom;
		let limit = window.innerWidth;
		for (const selector of NEIGHBOURS) {
			const rect = document.querySelector(selector)?.getBoundingClientRect();
			if (!rect || !rect.width || !rect.height) continue;
			// only things that VERTICALLY overlap the row can block it — a docked Connect
			// bar sits entirely above the logo and leaves the width below it free
			if (rect.bottom <= top || rect.top >= bottom) continue;
			if (rect.left > logo.right) limit = Math.min(limit, rect.left);
		}
		stacked = rowRight(ttCount) > limit;
	}

	// re-measure on the things that can change the answer: the window, and Connect
	// docking or changing height (both move the logo and the pill)
	$effect(() => {
		void $connectDocked;
		void $connectBarHeight;
		void $touchTools;
		void $toolbarSlots.editing;
		void ttCount;
		void $sidebarGeometry;
		measure();
		// one more after layout settles — the pill is centred with a transform and its
		// rect is not final on the same frame the bar's height changes
		const t = setTimeout(measure, 120);
		return () => clearTimeout(t);
	});

	// ...and on the neighbours RESIZING, which the triggers above miss entirely: the
	// Connect pill's width changes with its own state (a peer connects, the host name
	// appears, the drawer opens) without the window resizing or Connect re-docking, and
	// every one of those moves the wall this row measures itself against.
	// 44-int: decided on the NEXT frame — deciding inside the delivery restacks this row, which Connect and the
	// clusters observe, while the delivery is still running: since 44 M14 the compact pill stays on this row, so a
	// pill resize -> restack -> pending observation of the row was a "ResizeObserver loop" (ro-loop-guard K4).
	// 45 N3: ...and on the pill MOVING (a sidebar re-centres it), which no ResizeObserver sees. Connect flushes before it
	// says so, and a stacking change here re-measures Connect in turn, so both land before the frame is painted.
	$effect(() => {
		window.addEventListener('tp:connect-moved', measure);
		return () => window.removeEventListener('tp:connect-moved', measure);
	});
	$effect(() => {
		if (typeof ResizeObserver === 'undefined') return;
		let raf = 0;
		const observer = new ResizeObserver(() => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				measure();
			});
		});
		for (const selector of ['#logo-menu', ...NEIGHBOURS]) {
			const el = document.querySelector(selector);
			if (el) observer.observe(el);
		}
		return () => {
			observer.disconnect();
			if (raf) cancelAnimationFrame(raf);
		};
	});
</script>

<svelte:window onresize={measure} />

<!-- 43 J12: the row is a layout region on every device — shown while Touch tools is on, and ALWAYS
     while Edit positions runs (a mouse user arranges it too; Controls turns Touch tools on when the
     edit changed this row, so what was arranged stays). An empty row draws nothing (hud.css). -->
{#if $touchTools || $toolbarSlots.editing}
	<!-- The logo's own top is published as a CUSTOM PROPERTY rather than written straight
	     to `top`, because the stacked layout needs to place itself BELOW that anchor. The
	     first version set `top` directly, which overrode the stacked position and put the
	     cluster back on top of the logo whenever Connect docked — both landed at the same
	     top and the same inset. -->
	<div
		id="touch-tools"
		data-key-scope="keep"
		class="touch-tools"
		class:tt-stacked={stacked}
		style="--tt-anchor: {$connectDocked ? `calc(${$connectBarHeight}px + var(--hud-inset))` : 'var(--hud-inset)'}; --tt-slide: {slide}px"
		role="toolbar"
		aria-label="Touch tools"
		use:roving={{ item: $toolbarSlots.editing ? ':not(*)' : '.tt-btn', axis: 'both' }}
	>
		{#if ttShown('undo')}
		<button
			id="touch-undo"
			class="tt-btn"
			style:order={ttOrder('undo')}
			disabled={!$canUndo}
			title="Undo"
			aria-label="Undo"
			onclick={() => undo()}
		>
			<Icon name="undo-2" size={20} aria-hidden="true" />
		</button>
		{/if}
		{#if ttShown('redo')}
		<button
			id="touch-redo"
			class="tt-btn"
			style:order={ttOrder('redo')}
			disabled={!$canRedo}
			title="Redo"
			aria-label="Redo"
			onclick={() => redo()}
		>
			<Icon name="redo-2" size={20} aria-hidden="true" />
		</button>
		{/if}
		{#if ttShown('multiselect')}
		<button
			id="touch-multiselect"
			class="tt-btn"
			class:tt-on={$multiSelectMode}
			style:order={ttOrder('multiselect')}
			aria-pressed={$multiSelectMode}
			title={$multiSelectMode
				? 'Multi-select on — a tap adds to the selection, a drag on empty space boxes'
				: 'Multi-select — tap to add objects, drag empty space to box-select'}
			aria-label="Multi-select"
			onclick={() => multiSelectMode.update((v) => !v)}
		>
			<Icon name="box-select" size={20} aria-hidden="true" />
		</button>
		{/if}
	</div>
{/if}

<style>
	/* Beside the logo when there is room: same top, one 48px button's width clear of it.
	   Fixed, never absolute — an absolute element off an edge grows the document and drags
	   the centred Connect pill sideways. */
	/* 103 H15: on the HUD grid — the logo's row (its top), one tile + one gap right of the logo's inset */
	.touch-tools {
		position: fixed;
		top: var(--tt-anchor, var(--hud-inset));
		left: calc(var(--hud-inset) + var(--hud-tile) + var(--hud-gap) + var(--tt-slide, 0px));
		/* 45 N3: no slide — the row moves with a sidebar in one frame, like the logo beside it */
		z-index: var(--z-hud);
		display: flex;
		flex-direction: row;
		gap: var(--hud-gap);
	}
	/* No room for a row beside the logo: stack VERTICALLY BELOW it instead of over it.
	   Driven by the MEASUREMENT above, not a breakpoint — a width guess stacked on an
	   unfolded phone that had plenty of room. 56px = the logo's 48px plus its 8px gutter.

	   The left inset aligns these buttons' CENTRES with the bottom-left HUD cluster, which
	   is 44px wide at a 16px inset while these are 48px: 16 + (44 - 48) / 2 = 14px. Using
	   the same 20px the logo uses left them looking 6px out. */
	/* 103 H15: stacked, the column is the LEFT EDGE of the grid: under the logo at the logo's own inset, tiles of the
	   same size as the logo and the corner stack below (was 14 px, centred against 44 px buttons from 48 px ones) */
	.touch-tools.tt-stacked {
		top: calc(var(--tt-anchor, var(--hud-inset)) + var(--hud-tile) + var(--hud-gap));
		left: calc(var(--hud-inset) + var(--tt-slide, 0px));
		flex-direction: column;
	}
	/* 44 M12b / 45 N2: the row as a CLUSTER (Controls' layoutClusters sets the root classes and the px). HERE, not in
	   hud.css: that file is a LAYERED import, and the rules above are unlayered, so there they lost to `left / top /
	   display / flex-direction` above whatever their specificity — the row never moved under its grip (the user:
	   "I cannot drag its position properly, but other clusters can be moved"), never rotated and never hid. */
	:global(:root.cl-touch-rotated) #touch-tools {
		flex-direction: column;
	}
	:global(:root.cl-touch-placed) #touch-tools {
		left: var(--cl-touch-x);
		top: var(--cl-touch-y);
	}
	/* hidden: gone outside Edit positions, a faint placeholder inside it (its menu shows it again) */
	:global(:root:not(.hud-edit-on).cl-touch-hidden) #touch-tools {
		display: none;
	}
	:global(:root.hud-edit-on.cl-touch-hidden) #touch-tools {
		opacity: 0.35;
	}
	/* 42 I9: GLOBAL — Controls portals placeholders and other roster buttons into this row, and a
	   scoped class would never match them */
	/* 103 H15 row 2: a TILE of the grid — the shape and size of the logo above and Add / AI below (--hud-tile square,
	   --hud-radius corners, the HUD glass), never a round button of its own size */
	:global(.tt-btn) {
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		height: var(--hud-tile);
		width: var(--hud-tile);
		border-radius: var(--hud-radius);
		border: 1px solid var(--border);
		background: var(--hud-glass);
		color: var(--text);
		box-shadow: var(--hud-shadow);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		transition: background-color 0.12s, color 0.12s;
	}
	:global(.tt-btn:hover:not(:disabled)) {
		background: color-mix(in srgb, var(--surface-1) 96%, var(--text));
	}
	:global(.tt-btn:disabled) {
		opacity: 0.4;
	}
	/* the armed toggle owns its fill from the shell, never from a Tailwind utility —
	   a scoped style beats every utility, which is how the mesh toolbox lost its
	   armed colour in the dark theme */
	:global(.tt-on) {
		background: var(--accent-fill);
		border-color: var(--accent-fill);
		color: var(--on-accent);
	}

	/* No width media query on purpose: the stack is decided by MEASUREMENT (see the script).
	   A 560px breakpoint stacked on an unfolded Oppo N8 that had room to spare, which is
	   the whole reason the decision moved out of CSS. */
</style>
