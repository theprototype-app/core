<script>
	// 21-D1 — ONE row renderer for a `hudKinds` field.
	//
	// The properties pane has no per-kind branch: it walks `fieldsForKind` / `styleFieldsForKind`
	// and renders each entry through this component (the `ShaderNode` dispatch-on-param.type
	// shape). A new kind is one registry entry and no UI change at all.
	import DragRow from '../ui/DragRow.svelte';
	import HudImagePicker from './HudImagePicker.svelte';
	import { openTextEditor } from '$lib/fileWindows';
	import ColorPicker, { ChromeVariant } from 'svelte-awesome-color-picker';
	import ColorWrapperRaw from '$lib/ColorWrapper.svelte';
	// The always-open inline wrapper (the Inspector uses the same one). Cast because a
	// legacy component's `export let wrapper` does not satisfy the picker's
	// `Component<Props, {}, "wrapper">` binding type — the two instances of this in the
	// Inspector are two of the errors in the svelte-check baseline, and a third would
	// have moved it.
	const ColorWrapper = /** @type {any} */ (ColorWrapperRaw);

	/** @type {{ field: any, value: any, onchange: (next: any) => void }} */
	let { field, value, onchange } = $props();

	const label = $derived(field?.label ?? field?.key ?? '');
	const isInt = $derived((field?.step ?? 1) >= 1);

	// ---- 21-E1.6: the colour field gets a PICKER -------------------------------
	// The text path stays exactly as it was, and deliberately: a value here may be a
	// THEME TOKEN name, which no native colour input can express. What was missing is any
	// way to CHOOSE a colour — the swatch was display-only, so every colour in a HUD had
	// to be typed as hex. The swatch is a button now, opening a popover with the app's own
	// picker plus a row of token chips.
	//
	// PORTALED to body (the ShaderTexturePicker precedent): this row lives in a docked
	// pane, and an ancestor with a transform or a backdrop-filter becomes the containing
	// block for `position: fixed`, which is how a popover ends up pinned to a panel
	// instead of the viewport.
	/** The tokens worth offering. A HUD colour is text, a fill or an edge, so these are
	 * the semantic ones — the full THEME_TOKENS list includes scrollbars and dropdown
	 * internals, which are not HUD colours. */
	const TOKEN_CHIPS = ['accent', 'accent-2', 'text', 'text-2', 'muted', 'surface', 'surface-2', 'border'];

	let open = $state(false);
	let swatchEl = $state(/** @type {HTMLElement|null} */ (null));
	let popEl = $state(/** @type {HTMLElement|null} */ (null));
	let at = $state(/** @type {{x: number, top: number|null, bottom: number|null}|null} */ (null));

	const text = $derived(String(value ?? ""));
	/** a literal (#hex / rgb() / a CSS keyword) is used as authored; a bare word is a
	 * token name, resolved through the theme with a fallback (HudElement's own rule) */
	const isLiteral = $derived(text.startsWith("#") || text.startsWith("rgb"));
	const swatchPaint = $derived(!text ? "" : isLiteral ? text : `var(--${text}, #888)`);
	// the picker needs a real colour. A token has no hex until the theme resolves it, so
	// it seeds from the RESOLVED value rather than from the token name.
	const seedHex = $derived(isLiteral && text.startsWith("#") ? text : resolvedHex());

	function resolvedHex() {
		if (typeof window === 'undefined') return '#f3f4f6';
		try {
			const probe = swatchEl && getComputedStyle(swatchEl).backgroundColor;
			const m = probe && probe.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
			if (!m) return "#f3f4f6";
			const hex = (/** @type {string} */ n) => Number(n).toString(16).padStart(2, "0");
			return "#" + hex(m[1]) + hex(m[2]) + hex(m[3]);
		} catch {
			return "#f3f4f6";
		}
	}

	/** svelte-awesome-color-picker v4 calls `onInput` ONCE just from MOUNTING (its
	 * updateColor runs from an $effect and the first pass always differs from its own
	 * empty snapshot). So a picker that merely APPEARED would write — which is how
	 * opening Configure Scene used to relight the scene. Every handler ignores a value
	 * equal to the one it already holds; normalised, because the picker round-trips
	 * through colord and case / a leading # / a trailing alpha pair all differ.
	 * @param {any} a @param {any} b */
	function sameHex(a, b) {
		/** @param {any} v */
		const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/^#/, '').slice(0, 6) : '');
		const left = norm(a);
		return !!left && left === norm(b);
	}

	function openPicker() {
		if (open) {
			open = false;
			return;
		}
		const box = swatchEl?.getBoundingClientRect();
		if (!box) return;
		// GROWS UPWARD by default, anchored by `bottom`: the properties pane is in a bottom
		// dock, so the room above the swatch is the empty viewport while the room below is
		// the dock itself. Anchoring by bottom also bottom-aligns it without knowing its
		// height (the ShaderTexturePicker hover card, same reasoning).
		const above = box.top - 8;
		const below = window.innerHeight - box.bottom - 8;
		at =
			above >= 300 || above >= below
				? { x: Math.min(box.left, window.innerWidth - 300), top: null, bottom: window.innerHeight - box.top + 6 }
				: { x: Math.min(box.left, window.innerWidth - 300), top: box.bottom + 6, bottom: null };
		open = true;
	}

	// closed by an outside press or Escape, both in CAPTURE phase: svelte DELEGATES
	// pointerdown/keydown and the panel chrome swallows delegated handlers, so a bubble
	// listener here would never hear either. Escape is stopped so it closes the popover
	// and NOT the editor behind it (the mesh editor's pending-cut order).
	$effect(() => {
		if (!open) return;
		/** @param {any} e */
		const onDown = (e) => {
			if (popEl?.contains(e.target) || swatchEl?.contains(e.target)) return;
			open = false;
		};
		/** @param {KeyboardEvent} e */
		const onKey = (e) => {
			if (e.key !== 'Escape') return;
			e.preventDefault();
			e.stopPropagation();
			open = false;
		};
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('keydown', onKey, true);
		return () => {
			window.removeEventListener('pointerdown', onDown, true);
			window.removeEventListener('keydown', onKey, true);
		};
	});

	/** @param {HTMLElement} node */
	function portal(node) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}
</script>

{#if field.kind === 'number'}
	<DragRow
		{label}
		value={Number(value ?? 0)}
		step={field.step ?? 1}
		decimals={isInt ? 0 : 2}
		min={field.min ?? -Infinity}
		max={field.max ?? Infinity}
		title={field.hint ?? ''}
		onchange={(/** @type {number} */ v) => onchange(isInt ? Math.round(v) : v)}
	/>
{:else if field.kind === 'toggle'}
	<label class="hud-field" title={field.hint ?? ''}>
		<span>{label}</span>
		<span class="hud-field-ctl">
			<input type="checkbox" checked={!!value} onchange={(/** @type {any} */ e) => onchange(e.currentTarget.checked)} />
		</span>
	</label>
{:else if field.kind === 'select'}
	<label class="hud-field" title={field.hint ?? ''}>
		<span>{label}</span>
		<select class="hud-input" value={String(value ?? field.options?.[0] ?? '')} onchange={(/** @type {any} */ e) => onchange(e.currentTarget.value)}>
			{#each field.options ?? [] as option (option)}<option value={option}>{option}</option>{/each}
		</select>
	</label>
{:else if field.kind === 'color'}
	<!-- a colour may be a THEME TOKEN name or a literal, so the TEXT path stays: a native
	     colour input cannot express `accent`, and tokens are the point (they follow the
	     user's theme, with a literal fallback so a custom theme cannot unpaint them).
	     21-E1.6 adds the missing half — the swatch OPENS a picker.
	     A <div>, not a <label>: a <button> inside a label activates the label's own
	     control as well, which is the nested-interactive trap the image row already
	     documents one branch down. -->
	<div class="hud-field" title={field.hint ?? 'A #hex, an rgb(), or a theme token name like accent'}>
		<span>{label}</span>
		<span class="hud-field-ctl">
			<button
				class="hud-swatch hud-swatch-btn"
				class:hud-swatch-empty={!text}
				data-hud-swatch={field.key}
				aria-label="Pick a colour for {label}"
				aria-expanded={open}
				title="Pick a colour, or a theme token"
				style="background: {swatchPaint}"
				bind:this={swatchEl}
				onclick={openPicker}
			></button>
			<input
				class="hud-input"
				placeholder="#f3f4f6 or accent"
				value={text}
				onchange={(/** @type {any} */ e) => onchange(e.currentTarget.value)}
			/>
		</span>
	</div>
{#if open && at}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="hud-cp"
		data-hud-colorpicker={field.key}
		use:portal
		bind:this={popEl}
		style:left="{at.x}px"
		style:top={at.top === null ? null : at.top + 'px'}
		style:bottom={at.bottom === null ? null : at.bottom + 'px'}
	>
		<ColorPicker
			isAlpha={false}
			isTextInput={true}
			textInputModes={['hex', 'rgb', 'hsv']}
			isDialog={false}
			components={{ ...ChromeVariant, wrapper: ColorWrapper }}
			isOpen={true}
			sliderDirection="horizontal"
			--picker-indicator-size="18px"
			--cp-bg-color="#1f2937"
			--cp-border-color="#353f4e"
			--picker-height="70px"
			--picker-width="50px"
			--slider-width="10px"
			hex={seedHex}
			onInput={(/** @type {any} */ c) => {
				// compared against what the picker was SEEDED with, not against the authored
				// text: the mount echo always reports the seed, and where the authored value is
				// a TOKEN the two are different strings — so comparing with the text would let
				// merely OPENING the picker replace `accent` with its resolved hex.
				if (sameHex(c.hex, seedHex)) return; // the mount echo, not an edit
				onchange(c.hex);
			}}
		/>
		<p class="hud-cp-head">Theme tokens</p>
		<div class="hud-cp-chips">
			{#each TOKEN_CHIPS as token (token)}
				<button
					class="hud-cp-chip"
					class:hud-cp-chip-on={text === token}
					data-hud-token={token}
					title={token}
					aria-label="Use the {token} theme token"
					style="background: var(--{token}, #888)"
					onclick={() => onchange(token)}
				></button>
			{/each}
		</div>
		<p class="hud-cp-note">
			A token follows the viewer's theme; a literal is the same colour for everyone.
		</p>
		<div class="hud-cp-foot">
			<button class="hud-cp-cmd" onclick={() => onchange('')}>clear</button>
			<button class="hud-cp-cmd" onclick={() => (open = false)}>done</button>
		</div>
	</div>
{/if}
{:else if field.kind === 'list'}
	<!-- 21-E7.1/E7.3: THE MISSING BRANCH. `hudKinds` has declared a 'list' field kind since
	     21-D1 and nothing rendered it, so it fell through to the single-line text input at the
	     bottom - which cannot hold a newline, which is the entire point of the kind. One
	     textarea serves both consumers: for a `list` element each LINE is a row, and for rich
	     text a line is a line break.

	     Commits on CHANGE (blur / Ctrl+Enter), never per keystroke: the whole document
	     replicates on every edit, so a keystroke-per-message here is the same mistake the
	     `text` node param kind already declined. -->
	<div class="hud-field">
		<span>{label}</span>
	</div>
	<div class="hud-field hud-field-wide">
		<textarea
			class="hud-input hud-area"
			data-hud-list={field.key}
			rows="4"
			placeholder={field.placeholder ?? ''}
			title={field.hint ?? ''}
			value={String(value ?? '')}
			onchange={(/** @type {any} */ e) => onchange(e.currentTarget.value)}
			onkeydown={(/** @type {any} */ e) => {
				// Ctrl/Cmd+Enter commits without leaving the field, and Escape gives the field
				// back so the editor's own keys work again. Both stopped, or the artboard's
				// CAPTURE-phase keydown reads them as element commands.
				if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					e.stopPropagation();
					onchange(e.currentTarget.value);
					return;
				}
				if (e.key === 'Escape') e.currentTarget.blur();
				e.stopPropagation();
			}}
		></textarea>
	</div>
{:else if field.kind === 'code'}
	<!-- 21-E7.5: the code lives in the SHARED text-editor window (`fileWindows`), which is
	     already where both the Explorer's text files and the custom-node definition editor
	     go. Picked over the NodeDesigner shape deliberately: that one is a whole modal with
	     a param designer around it, while this is one string with a save callback - so the
	     lighter seam is the one that already exists, and it brings CodeMirror with it. -->
	<div class="hud-field" title={field.hint ?? ''}>
		<span>{label}</span>
		<span class="hud-field-ctl">
			<button
				class="hud-cp-cmd"
				data-hud-code={field.key}
				onclick={() =>
					openTextEditor({
						title: 'HUD element code',
						code: String(value ?? ''),
						onSave: (/** @type {string} */ next) => onchange(next)
					})}>Edit code…</button
			>
			<span class="hud-code-len">{String(value ?? '').length} chars</span>
		</span>
	</div>
{:else if field.kind === 'image'}
	<!-- a <span> caption, not a <label>: HudImagePicker owns a <label> of its own around
	     its file input, and nesting labels double-fires the click -->
	<div class="hud-field">
		<span>{label}</span>
	</div>
	<div class="hud-field hud-field-wide">
		<HudImagePicker hash={String(value ?? '')} onpick={(/** @type {string} */ next) => onchange(next)} />
	</div>
{:else}
	<!-- 'text' and anything unknown: a plain field, committed on change -->
	<label class="hud-field" title={field.hint ?? ''}>
		<span>{label}</span>
		<input
			class="hud-input"
			placeholder={field.placeholder ?? ''}
			value={String(value ?? '')}
			onchange={(/** @type {any} */ e) => onchange(e.currentTarget.value)}
		/>
	</label>
{/if}

<style>
	.hud-field {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.hud-field > span:first-child {
		width: 4.2rem;
		flex-shrink: 0;
		opacity: 0.7;
	}
	.hud-field-wide {
		padding-left: 4.6rem;
	}
	.hud-field-ctl {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 0.3rem;
	}
	.hud-input {
		min-width: 0;
		flex: 1;
		border-radius: 0.2rem;
		background: rgb(17 24 39 / 0.6);
		padding: 0.1rem 0.3rem;
		font-size: 11px;
	}
	.hud-area {
		width: 100%;
		resize: vertical;
		font-family: ui-monospace, monospace;
		line-height: 1.35;
	}
	.hud-code-len {
		flex-shrink: 0;
		font-size: 10px;
		opacity: 0.5;
	}
	.hud-swatch {
		height: 12px;
		width: 12px;
		flex-shrink: 0;
		border: 1px solid rgb(75 85 99 / 0.8);
		border-radius: 2px;
	}
	/* 21-E1.6: the swatch is the picker's opener now, so it is always there — a colour
	   field with nothing set is exactly when you need it most. */
	.hud-swatch-btn {
		cursor: pointer;
		padding: 0;
	}
	.hud-swatch-btn:hover {
		border-color: var(--accent, #ef562f);
	}
	.hud-swatch-empty {
		border-style: dashed;
		background-image: linear-gradient(135deg, transparent 45%, rgb(148 163 184 / 0.7) 45% 55%, transparent 55%);
	}
	/* portaled to body, so it clears the dock and any transformed ancestor */
	.hud-cp {
		position: fixed;
		z-index: var(--z-menu, 1300);
		display: flex;
		width: 232px;
		flex-direction: column;
		gap: 4px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 7px;
		background: var(--surface, #1f2937);
		padding: 7px 7px 6px;
		box-shadow: 0 12px 30px rgb(0 0 0 / 0.55);
	}
	.hud-cp-head {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.6;
	}
	.hud-cp-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.hud-cp-chip {
		height: 18px;
		width: 18px;
		border: 1px solid rgb(75 85 99 / 0.8);
		border-radius: 3px;
	}
	.hud-cp-chip:hover,
	.hud-cp-chip-on {
		border-color: var(--accent, #ef562f);
	}
	.hud-cp-note {
		font-size: 10px;
		line-height: 1.3;
		opacity: 0.55;
	}
	.hud-cp-foot {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
	}
	.hud-cp-cmd {
		border-radius: 3px;
		background: rgb(55 65 81 / 0.6);
		padding: 1px 7px;
		font-size: 11px;
	}
	.hud-cp-cmd:hover {
		background: rgb(75 85 99 / 0.85);
	}
</style>
