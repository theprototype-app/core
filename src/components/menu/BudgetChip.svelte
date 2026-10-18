<script>
	// 46 B1 — THE BUDGET CHIP: a small coloured chip beside the toolbar while editing that says whether
	// this scene fits the device you mean to ship to (Quest / Phone / Desktop, picked in its menu,
	// LOCAL) — green / amber / red against the perf gate's own budgets (budgetMeter.js). A click opens
	// Statistics on its Budget section; right-click (a long press on touch) or the caret picks the
	// target.
	//
	// WHERE IT SITS is MEASURED, not a breakpoint (the touch-row lesson): beside the toolbar pill,
	// right of it, else left, else just above it — whichever spot is over open viewport (every sample
	// point hits the canvas). The pill is user-movable, so a ResizeObserver + a MutationObserver on its
	// style follow it. No free spot = no chip (an unfolded phone with a full bar): Statistics, the
	// burger menu and the object list's budget dot still reach the same numbers.
	//
	// Hidden in Play (it lives in #editor-chrome, which Play hides) and on the phone shell, whose bar
	// has no room for it — there it is the `budget` item in More (PhoneShell), placeable on the bar.
	//
	// 48 F1: a CLUSTER of Controls' Edit positions (`budget` in $lib/toolbarLayout). PLACED (dragged
	// there in Edit positions, or Move from its menu) it is drawn where Controls' layoutClusters puts
	// it (`:root.cl-budget-placed` + --cl-budget-x/y, the Connect pill's shape) and nothing is
	// measured; UNPLACED it keeps today's measured spot. HIDDEN (its "−" in Edit positions, the
	// Customize switch) it is gone outside Edit positions and faint inside it. The measured spot
	// FREEZES while a menu is open: a ContextMenu's full-screen backdrop sat over the spot, so the
	// 1 s re-check read "covered" and the chip vanished the moment its own chevron was pressed.
	import { onMount } from 'svelte';
	import Icon from '../ui/Icon.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import { phoneShell } from '$lib/ui/phoneShell.js';
	import { toolbarSlots } from '$lib/toolbarSlots.js';
	import { budgetTarget, sceneCost, TARGETS, verdictFor, startBudgetMeter, openBudget, setBudgetTarget } from '$lib/budgetMeter';
	import { TARGET_IDS, formatMetric } from '$lib/budgetMeterCore';

	const target = $derived(TARGETS[$budgetTarget] ?? TARGETS.quest);
	const verdict = $derived(verdictFor($sceneCost, $budgetTarget));
	const ready = $derived(!!$sceneCost);
	const title = $derived.by(() => {
		const lines = [`Scene budget for ${target.label}: ${verdict.percent}% of the ${verdict.worst.label.toLowerCase()} budget (${verdict.tier})`];
		for (const r of verdict.rows) lines.push(`${r.label}: ${formatMetric(r.key, r.value)} / ${formatMetric(r.key, r.limit)}`);
		lines.push('Click for Statistics ▸ Budget · right-click or ▾ to judge for another device');
		return lines.join('\n');
	});

	/** @type {HTMLElement | undefined} */
	let wrap = $state();
	let pos = $state(/** @type {{x: number, y: number} | null} */ (null));
	/** why the chip is not drawn ('' = drawn) — the suite reads it off data-room */
	let room = $state('measuring');
	let menu = $state(/** @type {{x: number, y: number} | null} */ (null));
	/** 48 F1: the person put it somewhere in Edit positions (Controls draws it there, nothing to measure) */
	const placed = $derived.by(() => {
		const c = $toolbarSlots.clusters?.budget;
		return !!c && typeof c.x === 'number' && typeof c.y === 'number' && !c.hidden;
	});

	const GAP = 8;
	/** 48 F1: in Edit positions the bar wears its round ✓ 18 px past its top-right corner — clear it */
	const EDIT_GAP = 26;
	const MARGIN = 8;

	/** is every sample point of this rect over the 3D view (nothing of the chrome under it)?
	 * @param {number} x @param {number} y @param {number} w @param {number} h */
	function overCanvas(x, y, w, h) {
		const xs = [x + 2, x + w / 2, x + w - 2];
		const ys = [y + 2, y + h / 2, y + h - 2];
		for (const px of xs)
			for (const py of ys) {
				// 48 F1: its own Edit positions outline, the grips and guide lines are edit chrome, not a wall
				const hit = document.elementsFromPoint(px, py).find((el) => !wrap?.contains(el) && !el.closest('#budget-edit, #cluster-grips, .cl-guide'));
				if (!hit || hit.tagName !== 'CANVAS') return false;
			}
		return true;
	}

	function place() {
		if (!wrap) return;
		// 48 F1: a placed chip is drawn where it was put — nothing to measure
		if (placed) {
			room = 'placed';
			return;
		}
		// 48 F1: a menu (its own chevron menu, or any other) is over the spot for a moment: keep the spot
		if (menu || document.querySelector('[role="menu"]')) return;
		const pill = document.getElementById('controls-pill');
		const p = pill?.getBoundingClientRect();
		if (!pill || !p || p.width === 0 || p.height === 0 || getComputedStyle(pill).visibility === 'hidden') {
			room = 'no-toolbar';
			pos = null;
			return;
		}
		const w = wrap.offsetWidth;
		const h = wrap.offsetHeight;
		if (!w || !h) return;
		const midY = p.top + (p.height - h) / 2;
		const gap = $toolbarSlots.editing ? EDIT_GAP : GAP;
		const spots = [
			{ x: p.right + gap, y: midY, at: 'right' },
			{ x: p.left - GAP - w, y: midY, at: 'left' },
			{ x: p.right - w, y: p.top - gap - h, at: 'above' },
			{ x: p.left, y: p.top - gap - h, at: 'above' }
		];
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		for (const s of spots) {
			if (s.x < MARGIN || s.y < MARGIN || s.x + w > vw - MARGIN || s.y + h > vh - MARGIN) continue;
			if (!overCanvas(s.x, s.y, w, h)) continue;
			pos = { x: Math.round(s.x), y: Math.round(s.y) };
			room = s.at;
			return;
		}
		pos = null;
		room = 'none';
	}

	let raf = 0;
	function schedule() {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			place();
		});
	}

	onMount(() => {
		const stop = startBudgetMeter();
		/** @type {ResizeObserver | null} */
		let ro = null;
		/** @type {MutationObserver | null} */
		let mo = null;
		/** @type {Element | null} */
		let watched = null;
		// the pill re-mounts (phone <-> desktop, a layout restore): re-attach whenever it is a new node
		const attach = () => {
			const pill = document.getElementById('controls-pill');
			if (pill === watched) return;
			ro?.disconnect();
			mo?.disconnect();
			watched = pill;
			if (!pill) return;
			ro = new ResizeObserver(schedule);
			ro.observe(pill);
			mo = new MutationObserver(schedule);
			mo.observe(pill, { attributes: true, attributeFilter: ['style', 'class'] });
		};
		attach();
		// windows, docks and toasts open over the spot without touching the pill: a slow re-check
		const slow = setInterval(() => {
			attach();
			schedule();
		}, 1000);
		window.addEventListener('resize', schedule);
		schedule();
		return () => {
			stop();
			clearInterval(slow);
			window.removeEventListener('resize', schedule);
			ro?.disconnect();
			mo?.disconnect();
			if (raf) cancelAnimationFrame(raf);
		};
	});

	// the chip's own width moves with its words (a digit more, another target): re-place
	$effect(() => {
		void verdict.percent;
		void target.short;
		// 48 F1: + placed / unplaced, and a menu closing (the frozen spot is re-checked at once)
		void placed;
		void menu;
		void $toolbarSlots.editing;
		schedule();
	});

	/** @param {MouseEvent} e */
	function openMenu(e) {
		e.preventDefault();
		e.stopPropagation();
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		menu = e.type === 'contextmenu' && e.clientX ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 };
	}

	const menuItems = $derived([
		{ section: 'Judge this scene for' },
		...TARGET_IDS.map((id) => ({
			label: TARGETS[id].label,
			checked: $budgetTarget === id,
			tooltip: id === 'quest' ? 'The budget the perf gate holds every game to' : `Starting values for a ${TARGETS[id].label.toLowerCase()}`,
			action: () => setBudgetTarget(id)
		})),
		{ section: ' ' },
		{ label: 'Open Statistics ▸ Budget', action: () => openBudget() }
	]);
</script>

{#if !$phoneShell}
	<div
		bind:this={wrap}
		id="budget-chip-wrap"
		class="tp-ui hud-glass budget-chip"
		class:bc-hidden={(!pos && !placed) || !ready}
		data-tier={verdict.tier}
		data-target={$budgetTarget}
		data-room={room}
		style:left={pos ? pos.x + 'px' : '0px'}
		style:top={pos ? pos.y + 'px' : '0px'}
	>
		<button id="budget-chip" type="button" class="bc-main" {title} aria-label={'Scene budget for ' + target.label + ': ' + verdict.percent + ' percent, ' + verdict.tier + '. Open Statistics.'} onclick={() => openBudget()} oncontextmenu={openMenu}>
			<span class="budget-dot" data-tier={verdict.tier} aria-hidden="true"></span>
			<span class="bc-target">{target.short}</span>
			<span id="budget-chip-percent" class="bc-pct">{verdict.percent}%</span>
		</button>
		<button id="budget-chip-target" type="button" class="bc-caret" title="Judge for another device" aria-label="Judge for another device" aria-haspopup="menu" onclick={openMenu} oncontextmenu={openMenu}>
			<Icon name="chevron-down" size={16} aria-hidden="true" />
		</button>
	</div>
{/if}
{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menuItems} sizeKey="budget" onclose={() => (menu = null)} />
{/if}

<style>
	.budget-chip {
		position: fixed;
		z-index: var(--z-chrome);
		display: inline-flex;
		align-items: center;
		height: 30px;
		padding: 0 2px 0 0;
		border-radius: 9999px;
		font-size: var(--fs-desc);
		white-space: nowrap;
	}
	/* 48 F1: PLACED in Edit positions — drawn where Controls' layoutClusters put it (also while a drag carries it);
	   !important beats the measured inline left / top */
	:global(:root.cl-budget-placed) .budget-chip {
		left: var(--cl-budget-x) !important;
		top: var(--cl-budget-y) !important;
	}
	/* 48 F1: hidden — gone outside Edit positions, a faint placeholder inside it (its menu / "+" shows it again) */
	:global(:root:not(.hud-edit-on).cl-budget-hidden) .budget-chip {
		display: none;
	}
	:global(:root.hud-edit-on.cl-budget-hidden) .budget-chip {
		opacity: 0.35;
	}
	/* measured while invisible (it needs a size to be placed); never a hit target until placed */
	.bc-hidden {
		visibility: hidden;
		pointer-events: none;
	}
	.bc-main,
	.bc-caret {
		display: inline-flex;
		align-items: center;
		height: 100%;
		border: 0;
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.bc-main {
		gap: 6px;
		padding: 0 6px 0 10px;
		border-radius: 9999px 0 0 9999px;
	}
	.bc-caret {
		padding: 0 6px 0 2px;
		border-radius: 0 9999px 9999px 0;
	}
	.bc-main:hover,
	.bc-caret:hover {
		color: var(--text);
		background: var(--surface-2);
	}
	.bc-main:focus-visible,
	.bc-caret:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}
	.bc-target {
		font-weight: 600;
		color: var(--text);
	}
	.bc-pct {
		font-variant-numeric: tabular-nums;
		/* 4 digits + % reserved, so "99%" -> "100%" does not move the caret under the pointer */
		min-width: 4.5ch;
		text-align: right;
	}
	.budget-chip[data-tier='amber'] .bc-pct {
		color: var(--ink-warn);
	}
	.budget-chip[data-tier='red'] .bc-pct {
		color: var(--ink-bad);
	}
	@media (pointer: coarse) {
		.budget-chip {
			height: 44px;
		}
	}
</style>
