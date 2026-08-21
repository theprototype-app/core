<script>
	// A2 — ONE renderer for a HUD element, shared by the runtime layer and the A4 editor
	// artboard (the "shared by the node card and the properties pane" precedent).
	//
	// This sharing is the whole reason the artboard is real DOM rather than a 2D canvas: a
	// HUD element IS a DOM box, and a canvas re-implementation would drift from the runtime
	// look, which is the one thing a layout editor must not do.
	//
	// An UNKNOWN kind renders NOTHING and is not an error — the document keeps it verbatim
	// so a newer peer's element survives a round trip through our editor.
	//
	// 21-D1: every kind reads its OWN params from the element (see `hudKinds.js`). The
	// element's param is the AUTHORED value — what it shows with nothing wired — and a node
	// always wins through `runtime`. So a bar with `value: 40` previews in the editor AND is
	// the runtime fallback; it is not a second source of truth.
	import { hudImageFor, resolveHudImage, registerHudImageListener } from '$lib/hudImages';
	import { hudValues, setHudValue } from '$lib/hudDocs';
	import { parseHudRichText } from '$lib/hudRichText';
	import { moduleHudKindDef, moduleHudKinds } from '$lib/moduleHudKinds';
	import { subPressIds } from '$lib/hudKinds';
	import { drawHudMinimap, MINIMAP_REFRESH_MS } from '$lib/hudMinimap';
	// 21-F4: the DEBUG element's sources. All leaves or already-loaded singletons; a
	// component import closes no history-family cycle (nothing imports components back).
	import { get } from 'svelte/store';
	import { gameState, gameElapsed } from '$lib/gameState';
	import { currentLevel } from '$lib/levels';
	import { peerPlayModes, myPlayMode } from '$lib/gamePresence';
	import { collectibleCountsFor } from '$lib/flowRuntime';
	// 21-G4: the per-player rows. A scoreboard that disagrees between two screens is the
	// hardest thing to notice and the worst to debug, so the pill shows every peer's own
	// numbers as this peer holds them — put two screens side by side and read them off.
	import { peerVarsAll, peerVarNames } from '$lib/peerVars';
	import { userdata, peers } from '../../stores/appStore';
	import Icon from '../ui/Icon.svelte';
	import { onDestroy } from 'svelte';

	/** @type {{ element: any, runtime?: any, editor?: boolean, onpress?: (id: string) => void }} */
	let { element, runtime = null, editor = false, onpress = undefined } = $props();

	const style = $derived(element?.style ?? {});
	const kind = $derived(element?.kind ?? 'text');

	// Every var() chain ENDS IN A LITERAL. Neither the dark nor the light theme defines
	// --surface/--accent, so a token-only chain silently resolves to nothing (the
	// ToolboxWindow rule). A style value may itself be a token NAME, which is why the
	// authored value is wrapped rather than used raw.
	/** @param {any} value @param {string} fallback */
	function paint(value, fallback) {
		if (value === undefined || value === null || value === '') return fallback;
		const text = String(value);
		// a bare token name ('accent', 'surface') resolves through the theme with a literal
		// fallback; anything else (a hex, an rgb(), a keyword) is used as authored
		return /^[a-z][a-z0-9-]*$/i.test(text) && !CSS_KEYWORDS.has(text.toLowerCase())
			? `var(--${text}, ${fallback})`
			: text;
	}
	const CSS_KEYWORDS = new Set(['transparent', 'currentcolor', 'inherit', 'none', 'white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'yellow', 'orange']);

	// what the element SAYS right now. `runtime` comes from the flow graph (A3) and is
	// absent until a node drives it — in which case the authored label is the text, which
	// is also exactly what the editor artboard should show.
	const text = $derived(
		runtime?.text !== undefined && runtime?.text !== null
			? String(runtime.text)
			: String(element?.label ?? '')
	);
	// 21-D1: the AUTHORED value is the fallback for every numeric channel, so an unwired
	// bar previews at what you set rather than always reading zero.
	const value = $derived(Number(runtime?.value ?? element?.value ?? 0));
	const min = $derived(Number(runtime?.min ?? element?.min ?? 0));
	const max = $derived(Number(runtime?.max ?? element?.max ?? 1));
	const pct = $derived(max - min > 1e-9 ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0);
	// 21-E7.1: the AUTHORED rows are the fallback, exactly like every other param — one
	// row per line of `rowsText`. Before this the only way to fill a list was `setHudRows`,
	// which no editor and no module could reach, so the kind had no authoring path at all.
	const rows = $derived(
		Array.isArray(runtime?.rows) && runtime.rows.length
			? runtime.rows
			: String(element?.rowsText ?? '')
					.split('\n')
					.map((/** @type {string} */ line) => line.trim())
					.filter(Boolean)
	);
	const vertical = $derived(element?.orientation === 'vertical');

	// ---- 21-D4: the INPUT kinds -----------------------------------------------------
	// An input holds a value that the PLAYER set, which is neither authored document nor
	// derived runtime — so it lives in `hudValues`, local unless the element says shared.
	// Read order: what the player set -> what a node drives -> what the author set. The
	// player comes first on purpose: once you have moved a slider, a node's fallback
	// must not pull it back.
	const held = $derived($hudValues[element?.id]);
	const inputValue = $derived(held !== undefined ? held : (runtime?.value ?? element?.value));
	// 21-E7.2: a node feeding the OPTIONS channel replaces the authored list, so the same
	// read order as every other channel — what a node says, then what the author set. The
	// `hudinput` node's `index` read goes through the same live list, or the position it
	// reports would mean something different from what is on screen.
	const optionList = $derived(
		String(runtime?.options ?? element?.options ?? '')
			.split(',')
			.map((/** @type {string} */ o) => o.trim())
			.filter(Boolean)
	);
	const editable = $derived(!editor && element?.enabled !== false);

	/** The ONE write. In the EDITOR it is inert: dragging a slider while laying out a
	 *  menu must not set the game's difficulty. @param {any} next */
	function write(next) {
		if (!editable) return;
		setHudValue(element.id, next, { shared: !!element?.shared });
	}

	// ---- 21-D1: the image kind ------------------------------------------------------
	// A hash landing is not a store write and `hudImageFor` is a plain Map read, so a
	// $derived over it never re-runs — the listener bumps a tick used as a dependency
	// (the same fix ShaderTexturePicker needed).
	let imageTick = $state(0);
	const stopListening = registerHudImageListener(() => (imageTick += 1));
	onDestroy(stopListening);
	const hash = $derived(kind === 'image' ? String(element?.src ?? '') : '');
	const imageUrl = $derived.by(() => {
		void imageTick;
		if (!hash) return null;
		const hit = hudImageFor(hash);
		// resolve on a miss: it pulls from a peer when the bytes are not local, and the
		// retry watch notifies us when they land
		if (!hit) void resolveHudImage(hash);
		return hit;
	});

	// ---- 21-E7.3: RICH TEXT ---------------------------------------------------------
	// Parsed to RUNS and rendered with svelte text interpolation. There is no innerHTML in
	// this component and no sanitizer: a hostile string is not cleaned up, it simply never
	// matches any token and comes out as the characters that were typed.
	const richRuns = $derived(kind === 'richtext' || kind === 'scrollpanel' ? parseHudRichText(text) : []);

	// ---- 21-F4: the DEBUG element -----------------------------------------------------
	// A SAMPLER on a 500ms clock, not a $derived: half its sources are plain function
	// calls with no store signal (gameElapsed, the collectible derivation, fps), and the
	// layer is real DOM (the hudRuntime throttle rule). Expand/collapse is LOCAL $state —
	// scaffolding you peek at, nothing replicates.
	let debugOpen = $state(false);
	let debugSeeded = $state(false);
	/** @type {any} */
	let debugInfo = $state(null);
	let fpsFrames = 0;
	let fpsAt = 0;
	let fps = 0;
	$effect(() => {
		if (kind !== 'debug') return;
		if (!debugSeeded) {
			debugSeeded = true;
			debugOpen = element?.compact === false;
		}
		let raf = requestAnimationFrame(function pump(t) {
			fpsFrames++;
			if (t - fpsAt >= 1000) {
				fps = Math.round((fpsFrames * 1000) / (t - fpsAt || 1));
				fpsFrames = 0;
				fpsAt = t;
			}
			raf = requestAnimationFrame(pump);
		});
		const sample = () => {
			const g = get(gameState);
			const modes = get(peerPlayModes);
			const users = /** @type {any[]} */ (get(userdata) ?? []);
			/** @type {any} */
			const peer = get(peers);
			const myId = peer?.peer?.id ?? null;
			let counts = { total: 0, collected: 0, left: 0 };
			try {
				counts = collectibleCountsFor(String(element?.variable || 'gems'));
			} catch {}
			const rows = get(peerVarsAll);
			const varNames = peerVarNames();
			debugInfo = {
				level: get(currentLevel)?.name ?? '—',
				// 21-G4: `peerId -> "name a=1 b=2"`, resolved against the roster below
				peerVarNames: varNames,
				peerVars: rows,
				state: g.state,
				round: g.round,
				elapsed: Math.round(gameElapsed()),
				vars: { ...g.vars },
				counts,
				players: users.map((u, i) => {
					const me = u[0] === myId || (i === 0 && !myId);
					const own = rows[u[0]] ?? (me ? rows.me : null);
					return {
						id: u[0],
						name: u[1] || (i === 0 ? 'Me' : String(u[0] ?? '').slice(0, 6)),
						mode: me ? myPlayMode() : modes[u[0]] === 'playing' ? 'playing' : 'editor',
						me,
						// 21-G4: this peer's OWN numbers, as we hold them
						pvars: own
							? Object.entries(own)
									.map(([k, v]) => k + '=' + v)
									.join(' ')
							: ''
					};
				}),
				fps
			};
		};
		sample();
		const timer = setInterval(sample, 500);
		return () => {
			clearInterval(timer);
			cancelAnimationFrame(raf);
		};
	});

	// ---- 21-E7.6: the icon row / hotbar / radial ------------------------------------
	const slotCount = $derived(Math.max(1, Math.min(20, Math.round(Number(element?.max ?? element?.slots ?? 5)))));
	const filled = $derived(Math.max(0, Math.min(slotCount, Math.round(Number(runtime?.value ?? element?.value ?? 0)))));
	const hotbarLabels = $derived(
		String(element?.labels ?? '')
			.split(',')
			.map((/** @type {string} */ o) => o.trim())
	);
	// the ring: a circle stroked from its top, dash-offset by the fill fraction
	const RADIAL_R = 42;
	const RADIAL_C = 2 * Math.PI * RADIAL_R;

	// ---- 21-E7.6: the damage FLASH ---------------------------------------------------
	// Driven by the element's PULSE stamp (any HUD trigger aimed at it), and the decay is a
	// pure CSS animation restarted by an {#key} block. No rAF, no timer, no store write per
	// frame — and `prefers-reduced-motion` cannot strand it, because nothing here listens
	// for `animationend` (the documented trap); the element simply rests at opacity 0.
	const pulse = $derived(Number(runtime?.pulse ?? 0));

	// ---- 21-E7.5: the USER-SCRIPTED element ------------------------------------------
	// The script-node trust model: replicated code, run by every peer, compiled once per
	// distinct source. A THROW renders an inert chip — it must never propagate, or one bad
	// character in one element takes the whole HUD layer down with it.
	/** @type {any} */
	let codeError = $state('');
	const compiled = $derived.by(() => {
		if (kind !== 'custom') return null;
		const source = String(element?.code ?? '');
		try {
			// eslint-disable-next-line no-new-func
			return new Function('el', 'runtime', 'container', source);
		} catch (error) {
			return /** @type {any} */ ({ __error: String(/** @type {any} */ (error)?.message ?? error) });
		}
	});
	/** the div a custom or module element draws into @type {HTMLElement|null} */
	let slotEl = $state(/** @type {HTMLElement|null} */ (null));

	// HOT-APPLIES: the effect depends on the compiled fn, the element and the runtime, so
	// editing the code re-runs it with no remount — which is what makes the code editor
	// usable at all.
	$effect(() => {
		const host = slotEl;
		const fn = compiled;
		if (!host || !fn) return;
		host.replaceChildren();
		if (typeof fn !== 'function') {
			codeError = fn.__error ?? 'could not compile';
			return;
		}
		try {
			fn(element, runtime, host);
			codeError = '';
		} catch (error) {
			codeError = String(/** @type {any} */ (error)?.message ?? error);
		}
	});

	// ---- 21-E7.4: a MODULE-supplied kind ---------------------------------------------
	// `$moduleHudKinds` is the DEPENDENCY (the def lookup is a plain map read, which a
	// $derived cannot see — the non-reactive-registry family), so installing a module makes
	// its elements appear without a reload.
	const modKindOf = (/** @type {any} */ _registry, /** @type {string} */ k) => moduleHudKindDef(k);
	const modDef = $derived(modKindOf($moduleHudKinds, kind));

	/**
	 * The mount action for a module kind. `cloudMount`'s `(el) => cleanup` SHAPE, with one
	 * addition that a toolbox does not need and a HUD element does: a mount may instead
	 * return `{update, destroy}` (the svelte-action contract), and then a runtime change
	 * calls `update` rather than tearing the DOM down and rebuilding it. Without that, an
	 * element drawing a canvas would be remounted every time its runtime value moved.
	 * @param {HTMLElement} node @param {any} args {def, element, runtime}
	 */
	function hudMount(node, args) {
		/** @type {any} */
		let handle = null;
		/** @param {any} a */
		const run = (a) => {
			try {
				handle = a?.def?.mount?.(node, a.element, a.runtime) ?? null;
			} catch (error) {
				console.log('module HUD element mount failed', error);
				handle = null;
			}
		};
		const stop = () => {
			try {
				if (typeof handle === 'function') handle();
				else if (handle && typeof handle.destroy === 'function') handle.destroy();
			} catch (error) {
				console.log('module HUD element cleanup failed', error);
			}
			handle = null;
		};
		run(args);
		return {
			/** @param {any} a */
			update(a) {
				if (handle && typeof handle.update === 'function') {
					try {
						handle.update(a.element, a.runtime);
						return;
					} catch (error) {
						console.log('module HUD element update failed', error);
					}
				}
				stop();
				node.replaceChildren();
				run(a);
			},
			destroy: stop
		};
	}

	// ---- 21-E7.6: the MINIMAP --------------------------------------------------------
	// ~2Hz, the hudRuntime discipline: this is the one kind that does per-frame-shaped work,
	// and the layer is real DOM. See hudMinimap.js for why it plots rather than renders.
	let mapEl = $state(/** @type {HTMLCanvasElement|null} */ (null));
	$effect(() => {
		const canvas = mapEl;
		if (kind !== 'minimap' || !canvas) return;
		const el = element;
		const tick = () => {
			// the canvas is laid out by CSS; match its backing store to its box so the plot is
			// not stretched (and so a resized element redraws at the right scale)
			const w = Math.max(1, Math.round(canvas.clientWidth));
			const h = Math.max(1, Math.round(canvas.clientHeight));
			if (canvas.width !== w) canvas.width = w;
			if (canvas.height !== h) canvas.height = h;
			// F5: the colour rule lives in hudMinimap — a canvas cannot take a `var()` chain,
			// so the token resolution has to happen there anyway, and splitting it left the
			// self dot on a hardcoded green whenever the authored colour was a token.
			drawHudMinimap(canvas, el);
		};
		tick();
		const timer = setInterval(tick, MINIMAP_REFRESH_MS);
		return () => clearInterval(timer);
	});

	const boxStyle = $derived(
		[
			`color: ${paint(style.color, '#f3f4f6')}`,
			`background: ${paint(style.bg, 'transparent')}`,
			style.border ? `border: 1px solid ${paint(style.border, 'rgb(75 85 99 / 0.7)')}` : 'border: 0',
			`border-radius: ${Number(style.radius ?? 0)}px`,
			`padding: ${Number(style.pad ?? 0)}px`,
			`font-size: ${Number(style.size ?? 14)}px`,
			`font-weight: ${Number(style.weight ?? 400)}`,
			style.font ? `font-family: ${style.font}` : '',
			`text-align: ${style.align ?? 'left'}`,
			`opacity: ${Number(style.opacity ?? 1) * (element?.enabled === false ? 0.45 : 1)}`
		]
			.filter(Boolean)
			.join('; ')
	);
</script>

{#if kind === 'text' || kind === 'timer'}
	<div class="hud-el hud-text" class:hud-wrap={element?.wrap} style={boxStyle}>{text}</div>
{:else if kind === 'button'}
	<!-- buttons are the ONE thing that opts INTO pointer events; the layer itself is
	     pointer-events: none so the viewport keeps every click. In the editor the press is
	     swallowed, or laying out a menu would fire the game's own triggers. -->
	<button
		class="hud-el hud-button"
		style={boxStyle}
		disabled={element?.enabled === false && !editor}
		tabindex={editor ? -1 : 0}
		onclick={(e) => {
			if (editor || element?.enabled === false) return;
			e.stopPropagation();
			onpress?.(element.id);
		}}>{text}</button
	>
{:else if kind === 'bar'}
	<div class="hud-el hud-bar" style={boxStyle}>
		<div
			class="hud-bar-fill"
			class:hud-bar-fill-v={vertical}
			style="{vertical ? 'height' : 'width'}: {pct}%; background: {paint(style.color, 'var(--accent, #ef562f)')}"
		></div>
		{#if element?.showPercent}
			<span class="hud-bar-label">{Math.round(pct)}%</span>
		{:else if text}
			<span class="hud-bar-label">{text}</span>
		{/if}
	</div>
{:else if kind === 'panel'}
	<div class="hud-el hud-panel" style={boxStyle}>{text}</div>
{:else if kind === 'list'}
	<!-- a list is an element WRITTEN INTO by id, never a value that flows: the socket
	     system has no arrays, and every game needs a leaderboard -->
	<div class="hud-el hud-list" style={boxStyle}>
		{#if text}<div class="hud-list-title">{text}</div>{/if}
		{#each rows as row, i (i)}
			<div class="hud-list-row" style="height: {Number(element?.rowHeight ?? 18)}px">{String(row)}</div>
		{/each}
	</div>
{:else if kind === 'crosshair'}
	<div class="hud-el hud-crosshair" style={boxStyle} aria-hidden="true">
		{#each ['t', 'b', 'l', 'r'] as arm (arm)}
			<span
				class="hud-cross-arm hud-cross-{arm}"
				style="background: {paint(style.color, '#f3f4f6')}; --cw: {Number(element?.thickness ?? 2)}px; --cg: {Number(element?.gap ?? 4)}px"
			></span>
		{/each}
		{#if element?.dot !== false}
			<span class="hud-cross-dot" style="background: {paint(style.color, '#f3f4f6')}; width: {Number(element?.thickness ?? 2)}px; height: {Number(element?.thickness ?? 2)}px"></span>
		{/if}
	</div>
{:else if kind === 'slider'}
	<!-- like the button, an input opts INTO pointer events; the layer is pointer-events:
	     none so the viewport keeps every click it does not want. -->
	<div class="hud-el hud-input" style={boxStyle}>
		{#if element?.label}<span class="hud-in-label">{element.label}</span>{/if}
		<input
			class="hud-in-range"
			type="range"
			min={element?.min ?? 0}
			max={element?.max ?? 100}
			step={element?.step || 1}
			value={Number(inputValue ?? 0)}
			disabled={!editable}
			tabindex={editor ? -1 : 0}
			aria-label={element?.label || 'slider'}
			oninput={(/** @type {any} */ e) => write(Number(e.currentTarget.value))}
		/>
		<span class="hud-in-read">{Number(inputValue ?? 0)}</span>
	</div>
{:else if kind === 'toggle'}
	<button
		class="hud-el hud-toggle"
		class:hud-toggle-on={!!inputValue}
		style={boxStyle}
		disabled={!editable}
		tabindex={editor ? -1 : 0}
		aria-pressed={!!inputValue}
		onclick={(e) => {
			e.stopPropagation();
			write(!inputValue);
			// a toggle BOTH holds a value and fires: 'Sound: on/off' wants the value, while
			// 'toggle a HUD screen' wants the pulse, and one control can carry either
			if (editable) onpress?.(element.id);
		}}
	>
		<span class="hud-toggle-box" aria-hidden="true"></span>
		<span class="hud-in-label">{element?.label ?? ''}</span>
	</button>
{:else if kind === 'dropdown'}
	<div class="hud-el hud-input" style={boxStyle}>
		{#if element?.label}<span class="hud-in-label">{element.label}</span>{/if}
		<select
			class="hud-in-select"
			value={String(inputValue ?? '')}
			disabled={!editable}
			tabindex={editor ? -1 : 0}
			aria-label={element?.label || 'dropdown'}
			onchange={(/** @type {any} */ e) => write(e.currentTarget.value)}
		>
			{#each optionList as option (option)}
				<option value={option}>{option}</option>
			{/each}
		</select>
	</div>
{:else if kind === 'textfield'}
	<div class="hud-el hud-input" style={boxStyle}>
		{#if element?.label}<span class="hud-in-label">{element.label}</span>{/if}
		<!-- COMMITS on change/blur, never per keystroke: a shared value would otherwise
		     broadcast a message per letter, and the `text` node param kind made the same
		     call for the same reason. -->
		<input
			class="hud-in-text"
			type="text"
			value={String(inputValue ?? '')}
			placeholder={element?.placeholder ?? ''}
			maxlength={element?.maxLength ?? 64}
			disabled={!editable}
			tabindex={editor ? -1 : 0}
			aria-label={element?.label || 'text field'}
			onchange={(/** @type {any} */ e) => write(e.currentTarget.value)}
		/>
	</div>
{:else if kind === 'richtext'}
	<!-- 21-E7.3: RUNS, not HTML. Every fragment below is svelte text interpolation, so a
	     hostile string renders as characters and there is nothing to sanitize. -->
	<div class="hud-el hud-rich" style={boxStyle}>
		{#each richRuns as run, i (i)}{#if run.kind === 'br'}<br />{:else if run.kind === 'icon'}<span
					class="hud-rich-icon"
					style={run.color ? `color: ${paint(run.color, 'inherit')}` : ''}><Icon name={run.name} size={14} /></span
				>{:else}<span
					class="hud-rich-run"
					class:hud-rich-b={run.bold}
					class:hud-rich-i={run.italic}
					style={run.color ? `color: ${paint(run.color, 'inherit')}` : ''}>{run.text}</span
				>{/if}{/each}
	</div>
{:else if kind === 'scrollpanel'}
	<!-- the same runs, in a box that scrolls. `pointer-events: auto` on purpose: a panel you
	     cannot scroll is not a scroll panel, and the layer is pointer-events: none. -->
	<div class="hud-el hud-scroll" style={boxStyle}>
		{#if element?.title}<div class="hud-list-title">{element.title}</div>{/if}
		<div class="hud-scroll-body">
			{#each richRuns as run, i (i)}{#if run.kind === 'br'}<br />{:else if run.kind === 'icon'}<span
						class="hud-rich-icon"
						style={run.color ? `color: ${paint(run.color, 'inherit')}` : ''}><Icon name={run.name} size={14} /></span
					>{:else}<span
						class="hud-rich-run"
						class:hud-rich-b={run.bold}
						class:hud-rich-i={run.italic}
						style={run.color ? `color: ${paint(run.color, 'inherit')}` : ''}>{run.text}</span
					>{/if}{/each}
		</div>
	</div>
{:else if kind === 'minimap'}
	<!-- 21-E7.6: a top-down PLOT (see hudMinimap.js for why that, not a render target) -->
	<div class="hud-el hud-map" style={boxStyle}>
		<canvas class="hud-map-canvas" bind:this={mapEl}></canvas>
	</div>
{:else if kind === 'debug'}
	<!-- 21-F4: the builder's readout. The pill opts INTO pointer events (the button rule)
	     only to expand/collapse — a LOCAL flip; in the editor it stays as authored. -->
	<button
		class="hud-el hud-debug"
		style={boxStyle}
		tabindex={editor ? -1 : 0}
		aria-expanded={debugOpen}
		onclick={(e) => {
			if (editor) return;
			e.stopPropagation();
			debugOpen = !debugOpen;
		}}
	>
		{#if debugInfo}
			<span class="hud-debug-head"
				>{debugInfo.state} · r{debugInfo.round} · {debugInfo.elapsed}s · {debugInfo.counts.left}/{debugInfo.counts.total} left · {debugInfo.fps}fps</span
			>
			{#if debugOpen}
				<!-- 21-G1: "scene", not "level" — the store keeps its name, the label follows
				     the vocabulary the rest of the app now uses -->
				<span class="hud-debug-row">scene: {debugInfo.level}</span>
				<span class="hud-debug-row"
					>vars: {Object.keys(debugInfo.vars).length
						? Object.entries(debugInfo.vars)
								.map(([k, v]) => k + '=' + v)
								.join(' ')
						: '—'}</span
				>
				<!-- 21-G4: which names are PER PLAYER at all. The values sit on each player's
				     own row below, where they can be read against the person who owns them. -->
				<span class="hud-debug-row"
					>player vars: {debugInfo.peerVarNames.length ? debugInfo.peerVarNames.join(', ') : '—'}</span
				>
				<span class="hud-debug-row"
					>collectibles ({String(element?.variable || 'gems')}): {debugInfo.counts.collected} collected, {debugInfo.counts.left} left of {debugInfo.counts.total}</span
				>
				{#each debugInfo.players as p (p.id ?? p.name)}
					<span class="hud-debug-row"
						>{p.me ? '● ' : '○ '}{p.name}<span class="hud-debug-chip" class:hud-debug-playing={p.mode === 'playing'}>{p.mode}</span
						>{#if p.pvars}<span class="hud-debug-chip">{p.pvars}</span>{/if}</span
					>
				{/each}
			{/if}
		{:else}
			<span class="hud-debug-head">debug</span>
		{/if}
	</button>
{:else if kind === 'iconrow'}
	<!-- hearts / ammo / keys: N repeats of one glyph off a number -->
	<div class="hud-el hud-iconrow" style={boxStyle}>
		{#each Array(slotCount) as _, i (i)}
			{#if i < filled || element?.empty !== false}
				<span class="hud-icon-slot" class:hud-icon-empty={i >= filled}
					><Icon name={String(element?.icon ?? 'heart')} size={Number(style.size ?? 18)} /></span
				>
			{/if}
		{/each}
	</div>
{:else if kind === 'progressradial'}
	<!-- a stroked circle, offset by the fill fraction. An <svg> is a REPLACED element, so it
	     takes explicit width/height or it sits at its 300x150 intrinsic box. -->
	<div class="hud-el hud-radial" style={boxStyle}>
		<svg class="hud-radial-svg" viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
			<circle
				cx="50"
				cy="50"
				r={RADIAL_R}
				fill="none"
				stroke={paint(style.bg, 'rgb(17 24 39 / 0.55)')}
				stroke-width={Number(element?.thickness ?? 6)}
			/>
			<circle
				cx="50"
				cy="50"
				r={RADIAL_R}
				fill="none"
				stroke={paint(style.color, 'var(--accent, #ef562f)')}
				stroke-width={Number(element?.thickness ?? 6)}
				stroke-linecap="round"
				stroke-dasharray={RADIAL_C}
				stroke-dashoffset={RADIAL_C * (1 - pct / 100)}
				transform={element?.clockwise === false ? 'rotate(-90 50 50) scale(1 -1) translate(0 -100)' : 'rotate(-90 50 50)'}
			/>
		</svg>
		{#if element?.showPercent !== false}<span class="hud-radial-label">{Math.round(pct)}%</span>{/if}
	</div>
{:else if kind === 'hotbar'}
	<div class="hud-el hud-hotbar" style={boxStyle}>
		{#each Array(Math.max(1, Math.min(12, Math.round(Number(element?.slots ?? 6))))) as _, i (i)}
			<div class="hud-hot-slot" class:hud-hot-on={i === filled}>
				{#if element?.numbers !== false}<span class="hud-hot-num">{i + 1}</span>{/if}
				<span class="hud-hot-label">{hotbarLabels[i] ?? ''}</span>
			</div>
		{/each}
	</div>
{:else if kind === 'damageflash'}
	<!-- the {#key} is the mechanism: a new pulse stamp REMOUNTS the inner div, which restarts
	     its CSS animation. That is the whole decay — no rAF, no timer, no per-frame store. -->
	<div class="hud-el hud-flash" aria-hidden="true">
		{#key pulse}
			{#if pulse > 0}
				<div
					class="hud-flash-run"
					style="background: {paint(style.bg, '#ef4444')}; --hud-flash-peak: {Number(style.opacity ?? 0.45)}; --hud-flash-fade: {Math.max(0.05, Number(element?.fade ?? 0.45))}s"
				></div>
			{/if}
		{/key}
	</div>
{:else if kind === 'keyhint'}
	<div class="hud-el hud-keyhint" style={boxStyle}>
		<kbd class="hud-kbd">{element?.keyName ?? ''}</kbd>
		<span class="hud-in-label">{text}</span>
	</div>
{:else if kind === 'tabs'}
	<!-- 21-E7.6: its VALUE is the selected INDEX. Deliberately NOT a screen switch: a screen
	     is per-peer visibility with its own model (showWhile, the menu input mode), while this
	     is a number another node reads with HUD Input (read: index) and switches on. -->
	<div class="hud-el hud-tabs" style={boxStyle} role="tablist">
		{#each optionList as option, i (option + i)}
			<button
				class="hud-tab"
				class:hud-tab-on={Math.round(Number(inputValue ?? 0)) === i}
				role="tab"
				aria-selected={Math.round(Number(inputValue ?? 0)) === i}
				disabled={!editable}
				tabindex={editor ? -1 : 0}
				onclick={(e) => {
					e.stopPropagation();
					write(i);
				}}>{option}</button
			>
		{/each}
	</div>
{:else if kind === 'confirm'}
	<!-- its OWN id never fires; the two buttons fire `<id>-yes` / `<id>-no`, derived from the
	     registry's `subPress` so a HUD Button node binds to exactly what the summary says. -->
	<div class="hud-el hud-confirm" style={boxStyle}>
		<span class="hud-confirm-q">{text}</span>
		<span class="hud-confirm-row">
			{#each subPressIds(kind) as sub (sub)}
				<button
					class="hud-button hud-confirm-btn"
					class:hud-confirm-yes={sub === 'yes'}
					data-hud-sub={element.id + '-' + sub}
					disabled={!editable}
					tabindex={editor ? -1 : 0}
					onclick={(e) => {
						if (!editable) return;
						e.stopPropagation();
						onpress?.(element.id + '-' + sub);
					}}>{element?.[sub] ?? sub}</button
				>
			{/each}
		</span>
	</div>
{:else if kind === 'custom'}
	<!-- 21-E7.5: the user's own render function draws into this div. A compile or run error
	     renders an inert chip and NOTHING propagates — one bad character must not take the
	     layer down. -->
	<div class="hud-el hud-custom" style={boxStyle}>
		<div class="hud-custom-slot" bind:this={slotEl}></div>
		{#if codeError}<span class="hud-code-error" title={codeError}>code error</span>{/if}
	</div>
{:else if modDef}
	<!-- 21-E7.4: a MODULE's own kind. Same `(el) => cleanup` shape a toolbox mount uses, so
	     a module writes plain DOM and inherits the layer, the 9-grid, the document, undo and
	     all four save paths. With the module gone this branch is not reached and the element
	     is preserved-and-skipped, exactly as a peer without the module sees it. -->
	<div class="hud-el hud-modkind" style={boxStyle} data-hud-module={modDef.moduleId}>
		<div class="hud-custom-slot" use:hudMount={{ def: modDef, element, runtime }}></div>
	</div>
{:else if kind === 'image'}
	<!-- the src is an Explorer content HASH resolved to an object URL, never an embedded
	     dataURL: a document replicates WHOLE on every edit, so an inline image would
	     re-send the bytes on every slider nudge -->
	<div class="hud-el hud-image" style={boxStyle}>
		{#if imageUrl}
			<img src={imageUrl} alt={element?.label ?? ''} style="object-fit: {element?.fit ?? 'contain'}" />
		{:else if hash}
			<span class="hud-image-wait">waiting for peer…</span>
		{:else if editor}
			<span class="hud-image-wait">pick an image</span>
		{/if}
	</div>
{/if}

<style>
	/* ---- 21-E7.3 rich text -------------------------------------------------------- */
	.hud-rich {
		display: block;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.hud-rich-b {
		font-weight: 700;
	}
	.hud-rich-i {
		font-style: italic;
	}
	.hud-rich-icon {
		display: inline-flex;
		vertical-align: -0.15em;
	}
	.hud-scroll {
		display: flex;
		flex-direction: column;
		/* a panel you cannot scroll is not a scroll panel; the LAYER stays none */
		pointer-events: auto;
	}
	.hud-scroll-body {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	/* ---- 21-F4 the debug pill ------------------------------------------------------ */
	.hud-debug {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		font-family: ui-monospace, monospace;
		text-align: left;
		cursor: pointer;
		/* the button rule: the layer is pointer-events none, the pill opts in */
		pointer-events: auto;
		overflow: hidden;
	}
	.hud-debug-head {
		white-space: nowrap;
	}
	.hud-debug-row {
		white-space: nowrap;
		opacity: 0.85;
	}
	.hud-debug-chip {
		margin-left: 6px;
		padding: 0 4px;
		border-radius: 4px;
		background: rgb(75 85 99 / 0.5);
		font-size: 0.85em;
	}
	.hud-debug-playing {
		background: rgb(34 197 94 / 0.35);
	}
	/* ---- 21-E7.6 the game pack ---------------------------------------------------- */
	.hud-map {
		padding: 0;
		overflow: hidden;
	}
	.hud-map-canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	.hud-iconrow {
		display: flex;
		align-items: center;
		gap: 0.15em;
	}
	.hud-icon-slot {
		display: inline-flex;
	}
	.hud-icon-empty {
		opacity: 0.25;
	}
	.hud-radial {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.hud-radial-svg {
		position: absolute;
		inset: 0;
	}
	.hud-radial-label {
		position: relative;
		font-variant-numeric: tabular-nums;
	}
	.hud-hotbar {
		display: flex;
		align-items: stretch;
		gap: 3px;
	}
	.hud-hot-slot {
		position: relative;
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		border: 1px solid rgb(148 163 184 / 0.35);
		border-radius: 4px;
		background: rgb(0 0 0 / 0.25);
		overflow: hidden;
	}
	.hud-hot-on {
		border-color: var(--accent, #ef562f);
		background: rgb(255 255 255 / 0.12);
	}
	.hud-hot-num {
		position: absolute;
		top: 1px;
		left: 2px;
		font-size: 0.7em;
		opacity: 0.6;
	}
	.hud-hot-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 0 2px;
	}
	.hud-flash {
		padding: 0;
		background: transparent;
		border: 0;
	}
	.hud-flash-run {
		width: 100%;
		height: 100%;
		opacity: 0;
		/* the decay, and all of it. Nothing listens for animationend, so
		   prefers-reduced-motion cannot leave this stuck on (the documented trap) — it
		   simply rests at the final keyframe. */
		animation: hud-flash var(--hud-flash-fade, 0.45s) ease-out 1 both;
	}
	@keyframes hud-flash {
		0% {
			opacity: var(--hud-flash-peak, 0.45);
		}
		100% {
			opacity: 0;
		}
	}
	/* ---- 21-E7.6 the menu pack ---------------------------------------------------- */
	.hud-keyhint {
		display: flex;
		align-items: center;
		gap: 0.4em;
	}
	.hud-kbd {
		flex-shrink: 0;
		border: 1px solid currentColor;
		border-bottom-width: 2px;
		border-radius: 3px;
		padding: 0 0.35em;
		font-family: ui-monospace, monospace;
		font-size: 0.9em;
		line-height: 1.4;
		opacity: 0.9;
	}
	.hud-tabs {
		display: flex;
		align-items: stretch;
		gap: 2px;
		pointer-events: auto;
	}
	.hud-tab {
		min-width: 0;
		flex: 1;
		cursor: pointer;
		overflow: hidden;
		border-radius: 3px;
		background: rgb(0 0 0 / 0.2);
		color: inherit;
		font: inherit;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hud-tab-on {
		background: var(--accent, #38bdf8);
		color: #0b1220;
	}
	.hud-tab:disabled {
		cursor: not-allowed;
	}
	.hud-confirm {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		gap: 5px;
	}
	.hud-confirm-q {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hud-confirm-row {
		display: flex;
		gap: 5px;
	}
	.hud-confirm-btn {
		flex: 1;
		border: 1px solid rgb(148 163 184 / 0.45);
		border-radius: 4px;
		background: rgb(0 0 0 / 0.25);
		padding: 1px 4px;
	}
	.hud-confirm-yes {
		border-color: var(--accent, #ef562f);
	}
	/* ---- 21-E7.4 / E7.5 the hosted kinds ------------------------------------------ */
	.hud-custom,
	.hud-modkind {
		position: relative;
		display: flex;
		align-items: stretch;
	}
	.hud-custom-slot {
		min-width: 0;
		flex: 1;
		overflow: hidden;
	}
	.hud-code-error {
		position: absolute;
		right: 2px;
		bottom: 1px;
		border-radius: 3px;
		background: rgb(127 29 29 / 0.85);
		padding: 0 4px;
		font-size: 9px;
		color: #fecaca;
	}
	.hud-input {
		display: flex;
		align-items: center;
		gap: 6px;
		pointer-events: auto;
	}
	.hud-in-label {
		flex-shrink: 0;
		white-space: nowrap;
	}
	.hud-in-range {
		min-width: 0;
		flex: 1;
		accent-color: var(--accent, #38bdf8);
	}
	.hud-in-read {
		flex-shrink: 0;
		min-width: 2.5em;
		text-align: right;
		font-variant-numeric: tabular-nums;
		opacity: 0.8;
	}
	.hud-in-select,
	.hud-in-text {
		min-width: 0;
		flex: 1;
		border: 0;
		border-radius: 3px;
		background: rgb(0 0 0 / 0.25);
		color: inherit;
		font: inherit;
		padding: 1px 4px;
	}
	.hud-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		pointer-events: auto;
	}
	.hud-toggle-box {
		flex-shrink: 0;
		width: 1.1em;
		height: 1.1em;
		border: 1px solid currentColor;
		border-radius: 3px;
		opacity: 0.7;
	}
	.hud-toggle-on .hud-toggle-box {
		background: var(--accent, #38bdf8);
		border-color: var(--accent, #38bdf8);
		opacity: 1;
	}
	.hud-el {
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		overflow: hidden;
		line-height: 1.25;
	}
	.hud-text,
	.hud-panel {
		display: flex;
		align-items: center;
		white-space: pre;
	}
	.hud-wrap {
		white-space: pre-wrap;
	}
	.hud-button {
		cursor: pointer;
		pointer-events: auto;
		font: inherit;
	}
	.hud-button:disabled {
		cursor: not-allowed;
	}
	.hud-bar {
		position: relative;
		display: flex;
		align-items: center;
		overflow: hidden;
	}
	.hud-bar-fill {
		position: absolute;
		inset: 0 auto 0 0;
		height: 100%;
		transition: width 120ms linear;
	}
	/* a vertical bar fills from the BOTTOM, which is what a health bar means */
	.hud-bar-fill-v {
		inset: auto 0 0 0;
		width: 100%;
		transition: height 120ms linear;
	}
	.hud-bar-label {
		position: relative;
		width: 100%;
		padding: 0 6px;
		text-align: inherit;
	}
	.hud-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.hud-list-title {
		opacity: 0.7;
		font-size: 0.85em;
	}
	.hud-list-row {
		display: flex;
		align-items: center;
		white-space: nowrap;
		text-overflow: ellipsis;
		overflow: hidden;
	}
	.hud-crosshair {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	/* four arms leaving a configurable GAP at the centre — the reticle every shooter has */
	.hud-cross-arm {
		position: absolute;
	}
	.hud-cross-t,
	.hud-cross-b {
		left: 50%;
		width: var(--cw);
		height: calc(50% - var(--cg));
		transform: translateX(-50%);
	}
	.hud-cross-t {
		top: 0;
	}
	.hud-cross-b {
		bottom: 0;
	}
	.hud-cross-l,
	.hud-cross-r {
		top: 50%;
		height: var(--cw);
		width: calc(50% - var(--cg));
		transform: translateY(-50%);
	}
	.hud-cross-l {
		left: 0;
	}
	.hud-cross-r {
		right: 0;
	}
	.hud-cross-dot {
		border-radius: 999px;
	}
	.hud-image {
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.hud-image img {
		width: 100%;
		height: 100%;
		max-width: 100%;
		max-height: 100%;
	}
	.hud-image-wait {
		opacity: 0.5;
		font-size: 0.8em;
	}
</style>
