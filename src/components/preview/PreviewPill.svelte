<script>
	// 103 H11 — THE PREVIEW PILL (owner's option 2, 22 Nov: one pill, parts by job). It replaces two pills:
	// 100 C1's Cinematic switch ("Preview" + quality chevron, top right) and 46 B1's budget chip ("Quest 642 %"
	// beside the toolbar). Parts, left to right:
	//   "Preview"   always the word, never an icon, never a state suffix. Where the Cinematic view is offered a
	//               click toggles it (lit = on, aria-pressed, Shift+Z still works); elsewhere it opens the menu.
	//   devices     one part per device toggled under Judge for: its icon + percent, always printed, coloured
	//               by the verdict; a click opens Statistics ▸ Budget for that device. Too wide for its place,
	//               they fold to the worst one + "+N" (the menu lists them all).
	//   chevron     the menu (PreviewMenu.svelte). A dot on it = a Draw as mode other than the everyday look,
	//               named in its tooltip.
	// Lazy (Menu.svelte mounts it on every non-phone editor screen; phones get a toolbar item and a drawer).
	//
	// WHERE: the top right of the FREE viewport rect (beside an open sidebar, never over it: --sb-free-right),
	// on the floating-chrome tier (under windows, side panels and menus). It is the `budget` cluster of Edit
	// positions (placed = drawn where put, hidden = gone outside Edit positions, faint inside), and the
	// `top.preview` chrome button (right-click / long press: Hide this button, Customize buttons…).
	//
	// Kept from 100 C1 untouched: the switch's states (entering / leaving = busy; a fallback = disabled with
	// the reason on a press), the first-use hint, the "Not shown in Cinematic view" and step-down chips.
	import { onMount } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import Badge from '../ui/Badge.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import PreviewMenu from './PreviewMenu.svelte';
	import { isLocked, isVRMode, viewMode } from '../../stores/sceneStore';
	import { embedMode } from '$lib/playMode';
	import { safeStorage } from '$lib/safeStorage';
	import { chromeButton } from '$lib/chromeButtons.js';
	import { toolbarSlots } from '$lib/toolbarSlots.js';
	import { previewMenuAsk } from '$lib/previewPill.js';
	import { get } from 'svelte/store';
	import { cinematicState, toggleCinematic } from '$lib/cinematic/cinematicState.js';
	import { QUALITY } from '$lib/cinematic/cinematicCore.js';
	import { drawAs, drawRowOf, isUnusualRow, DRAW_AS_LABEL } from '$lib/drawAs.js';
	import { sceneCost, verdictFor, openBudget, setBudgetTarget, startBudgetMeter, TARGETS } from '$lib/budgetMeter';
	import { judgeFor, here, maybeAutoOn } from '$lib/judgeFor.js';
	import { JUDGE_LABEL, TARGET_ICON, judgeParts, collapseParts } from '$lib/judgeForCore.js';

	const hereT = here();

	// ---- Cinematic (100 C1's rules) ----
	const cineOn = $derived($cinematicState.mode === 'on');
	const cineBusy = $derived($cinematicState.mode === 'entering' || $cinematicState.mode === 'leaving');
	const cineOff = $derived(!!$cinematicState.disabled && $cinematicState.mode === 'off');
	const cine = $derived(!!$cinematicState.offered || cineOff);
	const shown = $derived($isLocked !== true && !$isVRMode && !$embedMode);
	const cineTitle = $derived(
		cineOff
			? 'Cinematic view is off for this session: ' + $cinematicState.disabled
			: $cinematicState.mode === 'entering'
				? 'Starting the Cinematic view…'
				: cineOn
					? 'Cinematic view is on: back to the standard view (Shift+Z)'
					: 'Cinematic view: bounced light and reflections, on this computer only (Shift+Z)'
	);
	// 106 S3: the drop lowers the step first, then a Reflections / Global light switch set to On (cinematicCore.stepText)
	const dropText = $derived(cineOn && $cinematicState.dropped > 0 ? $cinematicState.stepped || 'Lowered to ' + QUALITY[$cinematicState.quality].label + ' to keep it smooth' : '');

	const HINT_KEY = 'cinematic:hintSeen';
	let hint = $state(false);
	$effect(() => {
		if (!shown || !cine || cineOn) return;
		try {
			if (safeStorage.getItem(HINT_KEY) === '1') return;
			safeStorage.setItem(HINT_KEY, '1');
		} catch {
			return;
		}
		hint = true;
		const t = setTimeout(() => (hint = false), 8000);
		return () => clearTimeout(t);
	});
	$effect(() => {
		if (cineOn || menuOpen) hint = false;
	});
	let whyShown = $state(false);
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let whyTimer;
	function showWhy() {
		whyShown = true;
		clearTimeout(whyTimer);
		whyTimer = setTimeout(() => (whyShown = false), 10000);
	}
	$effect(() => {
		if (cineOff) showWhy();
		else whyShown = false;
		return () => clearTimeout(whyTimer);
	});
	function pressWord() {
		if (!cine) return void toggleMenu();
		if (cineOff) showWhy();
		else void toggleCinematic();
	}

	// ---- the devices ----
	const parts = $derived(
		judgeParts($judgeFor, hereT).map((p) => {
			const v = verdictFor($sceneCost, p.target);
			return { ...p, percent: v.percent, tier: v.tier, label: JUDGE_LABEL[p.id] + (p.id === 'this' ? ' (' + TARGETS[p.target].label + ')' : '') };
		})
	);
	/** @param {{target: any}} p */
	function openFor(p) {
		setBudgetTarget(p.target);
		openBudget();
	}
	// the once-only auto-on: the first time the scene goes over 100 % for THIS device (never Quest unless
	// this device is one)
	$effect(() => {
		if (!$sceneCost) return;
		maybeAutoOn(verdictFor($sceneCost, hereT).percent);
	});

	// ---- Draw as: the dot ----
	const row = $derived(drawRowOf($viewMode, $drawAs));
	const unusual = $derived(isUnusualRow(row));

	// ---- the collapse (row 15): measured, never a breakpoint ----
	/** @type {HTMLElement | undefined} */
	let pill = $state();
	let collapsed = $state(false);
	let fullW = 0;
	const COVER = '#hud-tr > *, #avatar-trigger, #logo-menu, .connect-pill, #controls-pill, .hud-stack > *, #touch-tools > *, #sim-controls';
	/** does a box at this rect meet other chrome, or leave the free viewport? @param {{left: number, top: number, right: number, bottom: number}} r */
	function blocked(r) {
		const css = getComputedStyle(document.documentElement);
		const freeLeft = parseFloat(css.getPropertyValue('--sb-free-left')) || 0;
		const freeRight = window.innerWidth - (parseFloat(css.getPropertyValue('--sb-free-right')) || 0);
		if (r.left < freeLeft + 4 || r.right > freeRight + 1) return true;
		for (const el of document.querySelectorAll(COVER)) {
			if (pill?.contains(el)) continue;
			const b = el.getBoundingClientRect();
			if (b.width && b.height && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) return true;
		}
		return false;
	}
	function measure() {
		if (!pill || parts.length < 2) {
			collapsed = false;
			return;
		}
		const r = pill.getBoundingClientRect();
		if (!r.width) return;
		if (!collapsed) {
			fullW = r.width;
			if (blocked(r)) collapsed = true;
		} else if (fullW) {
			const wide = { left: r.right - fullW, right: r.right, top: r.top, bottom: r.bottom };
			if (!blocked(wide)) collapsed = false;
		}
	}
	let raf = 0;
	function schedule() {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			measure();
		});
	}
	$effect(() => {
		void parts.length;
		void cine;
		collapsed = false; // re-measure from full width when the set changes
		schedule();
	});
	const folded = $derived(collapsed && parts.length > 1 ? collapseParts(parts) : null);

	// ---- the menu ----
	let menuOpen = $state(false);
	/** @type {HTMLElement | undefined} */
	let menuEl = $state();
	let menuPos = $state({ top: 0, right: 16, bottom: /** @type {number | null} */ (null) });
	function toggleMenu() {
		if (menuOpen) return void (menuOpen = false);
		const r = pill?.getBoundingClientRect();
		if (r && !r.width) {
			// hidden (Hide this button) and asked from Configure scene: open where the pill would be
			const free = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb-free-right')) || 0;
			menuPos = { top: 76, right: 16 + free, bottom: null };
		} else if (r) {
			const below = window.innerHeight - r.bottom;
			menuPos = below >= 360 || below >= r.top ? { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right), bottom: null } : { top: 0, right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 };
		}
		menuOpen = true;
	}
	$effect(() => {
		if (!menuOpen) return;
		/** @param {PointerEvent} e */
		const away = (e) => {
			const t = /** @type {Node} */ (e.target);
			if (menuEl?.contains(t) || pill?.contains(t)) return;
			menuOpen = false;
		};
		/** @param {KeyboardEvent} e */
		const esc = (e) => {
			if (e.key !== 'Escape') return;
			e.stopPropagation();
			menuOpen = false;
			document.getElementById('preview-more')?.focus();
		};
		window.addEventListener('pointerdown', away, true);
		window.addEventListener('keydown', esc, true);
		return () => {
			window.removeEventListener('pointerdown', away, true);
			window.removeEventListener('keydown', esc, true);
		};
	});
	$effect(() => {
		if (!shown) menuOpen = false;
	});
	// Configure scene ▸ View's "open Preview" row
	let asked = get(previewMenuAsk);
	$effect(() => {
		const n = $previewMenuAsk;
		if (n === asked) return;
		asked = n;
		if (!menuOpen) toggleMenu();
	});

	onMount(() => {
		const stop = startBudgetMeter();
		const slow = setInterval(schedule, 1000);
		window.addEventListener('resize', schedule);
		return () => {
			stop();
			clearInterval(slow);
			window.removeEventListener('resize', schedule);
			if (raf) cancelAnimationFrame(raf);
		};
	});

	const chevTitle = $derived(unusual ? 'Preview menu. Drawn as: ' + DRAW_AS_LABEL[row] : 'Preview menu: Cinematic view, Draw as, Quality, Judge for');
	const editing = $derived(!!$toolbarSlots.editing);
</script>

{#if shown}
	<div
		bind:this={pill}
		id="preview-pill"
		class="pp tp-ui"
		role="group"
		aria-label="Preview"
		data-mode={$cinematicState.mode}
		data-quality={$cinematicState.quality}
		data-collapsed={folded ? '1' : undefined}
		data-editing={editing ? '1' : undefined}
		use:chromeButton={'top.preview'}
	>
		{#if cine}
			<span id="cinematic-switch" class="pp-contents">
				<button
					id="cinematic-toggle"
					type="button"
					class="pp-part pp-word"
					aria-pressed={cineOn}
					aria-busy={cineBusy}
					aria-disabled={cineOff}
					aria-describedby={cineOff ? 'cinematic-why' : undefined}
					data-why={cineOff ? $cinematicState.disabled : undefined}
					disabled={cineBusy}
					title={cineTitle}
					aria-label={cineOn ? 'Preview: Cinematic view on' : 'Preview: Cinematic view off'}
					onclick={pressWord}>Preview</button
				>
			</span>
		{:else}
			<button id="preview-word" type="button" class="pp-part pp-word" aria-haspopup="true" aria-expanded={menuOpen} title="Preview: how this device draws the scene" onclick={pressWord}>Preview</button>
		{/if}
		{#if folded}
			{@const p = parts[folded.worst]}
			<button type="button" class="pp-part pp-dev" id={'preview-dev-' + p.id} data-tier={p.tier} title={`${p.label}: ${p.percent}% of the budget. Open Statistics ▸ Budget. ${folded.more} more in the menu`} aria-label={`${p.label} budget ${p.percent} percent, ${p.tier}. Open Statistics.`} onclick={() => openFor(p)}>
				<Icon name={TARGET_ICON[p.target]} size={16} aria-hidden="true" /><span class="pp-pct">{p.percent}%</span><span class="pp-more" id="preview-dev-more">+{folded.more}</span>
			</button>
		{:else}
			{#each parts as p (p.id)}
				<button type="button" class="pp-part pp-dev" id={'preview-dev-' + p.id} data-tier={p.tier} title={`${p.label}: ${p.percent}% of the budget (${p.tier}). Open Statistics ▸ Budget`} aria-label={`${p.label} budget ${p.percent} percent, ${p.tier}. Open Statistics.`} onclick={() => openFor(p)}>
					<Icon name={TARGET_ICON[p.target]} size={16} aria-hidden="true" /><span class="pp-pct">{$sceneCost ? p.percent + '%' : '…'}</span>
				</button>
			{/each}
		{/if}
		<button id="preview-more" type="button" class="pp-part pp-chev" aria-haspopup="true" aria-expanded={menuOpen} aria-label={chevTitle} title={chevTitle} data-unusual={unusual ? row : undefined} onclick={toggleMenu}>
			<Icon name="chevron-down" size={16} aria-hidden="true" />
			{#if unusual}<span class="pp-dot" id="preview-draw-dot" aria-hidden="true"></span>{/if}
		</button>
		<div class="pp-below">
			{#if hint}
				<p id="cinematic-hint" class="pp-first hud-glass" role="status">New: Preview shows bounced light and reflections, on this computer only (Shift+Z)</p>
			{/if}
			{#if cineOff}
				<p id="cinematic-why" class="pp-first hud-glass" role="status" hidden={!whyShown}>Cinematic view is off for this session: {$cinematicState.disabled} Reload the page to try again.</p>
			{/if}
			{#if cineOn && $cinematicState.notShown}
				<div id="cinematic-not-shown"><Badge tone="warn" text={$cinematicState.notShown} /></div>
			{/if}
			{#if dropText}
				<div id="cinematic-dropped"><Badge tone="warn" text={dropText} /></div>
			{/if}
		</div>
	</div>
	{#if menuOpen}
		<div bind:this={menuEl} use:minimalScroll id="preview-menu" class="pp-menu tp-ui" style:top={menuPos.bottom === null ? menuPos.top + 'px' : 'auto'} style:bottom={menuPos.bottom === null ? 'auto' : menuPos.bottom + 'px'} style:right={menuPos.right + 'px'}>
			<PreviewMenu judge {cine} onclose={() => (menuOpen = false)} />
		</div>
	{/if}
{/if}

<style>
	.pp {
		position: fixed;
		/* the old Cinematic switch's band, inside the FREE viewport rect: beside an open right column, never on it */
		top: calc(var(--connect-bottom, 0px) + 68px);
		right: calc(16px + var(--sb-free-right, 0px));
		z-index: var(--z-chrome);
		display: flex;
		align-items: stretch;
		border-radius: var(--radius-pill);
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
		font-size: 12px;
		line-height: 1;
		user-select: none;
		white-space: nowrap;
	}
	/* Edit positions: PLACED — drawn where Controls' layoutClusters put it */
	:global(:root.cl-budget-placed) .pp {
		left: var(--cl-budget-x);
		top: var(--cl-budget-y);
		right: auto;
	}
	:global(:root:not(.hud-edit-on).cl-budget-hidden) .pp {
		display: none !important;
	}
	:global(:root.hud-edit-on.cl-budget-hidden) .pp {
		opacity: 0.35;
	}
	.pp-contents {
		display: contents;
	}
	.pp-part {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 32px;
		padding: 0 10px;
		color: inherit;
	}
	.pp-part:first-child,
	.pp-contents:first-child > .pp-part {
		border-radius: var(--radius-pill) 0 0 var(--radius-pill);
	}
	.pp-part + .pp-part,
	.pp-contents + .pp-part {
		border-left: 1px solid var(--border);
	}
	.pp-word {
		font-weight: 600;
	}
	.pp-word[aria-pressed='true'] {
		background: var(--accent);
		color: var(--on-accent);
	}
	.pp-part:hover:not(:disabled):not([aria-disabled='true']):not([aria-pressed='true']) {
		background: var(--surface-hover);
	}
	.pp-word[aria-pressed='true']:hover:not(:disabled) {
		filter: brightness(1.08);
	}
	.pp-word:disabled,
	.pp-word[aria-disabled='true'] {
		opacity: 0.7;
	}
	.pp-word[aria-disabled='true'] {
		cursor: not-allowed;
	}
	.pp-part:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
		outline-offset: calc(-1 * var(--focus-ring-width));
	}
	.pp-pct {
		font-variant-numeric: tabular-nums;
		color: var(--text-2);
	}
	.pp-dev[data-tier='amber'] .pp-pct {
		color: var(--ink-warn);
	}
	.pp-dev[data-tier='red'] .pp-pct {
		color: var(--ink-bad);
	}
	.pp-more {
		color: var(--text-muted);
		font-weight: 600;
	}
	.pp-chev {
		position: relative;
		width: 32px;
		padding: 0;
		justify-content: center;
		border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
	}
	.pp-dot {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 7px;
		height: 7px;
		border-radius: 9999px;
		background: var(--accent);
		box-shadow: 0 0 0 1.5px var(--surface-1);
	}
	.pp-below {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 6px;
		width: max-content;
		max-width: min(420px, calc(100vw - 32px));
		white-space: normal;
		pointer-events: none;
	}
	.pp-below > * {
		pointer-events: auto;
	}
	.pp-first {
		margin: 0;
		padding: 4px 10px;
		border-radius: var(--radius-window);
		font-size: var(--fs-desc);
		color: var(--text-2);
		max-width: 280px;
		text-align: right;
	}
	.pp-menu {
		position: fixed;
		z-index: var(--z-popover);
		width: 280px;
		max-height: calc(100dvh - 16px);
		overflow-y: auto;
		padding: 8px;
		border-radius: var(--radius-card);
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		box-shadow: var(--shadow-window);
	}
	@media (pointer: coarse) {
		.pp-part {
			min-height: 44px;
		}
		.pp-chev {
			width: 44px;
		}
	}
	@media (prefers-reduced-motion: no-preference) {
		.pp-word[aria-busy='true'] {
			animation: pp-pulse 1s ease-in-out infinite;
		}
	}
	@keyframes pp-pulse {
		50% {
			opacity: 0.6;
		}
	}
</style>
