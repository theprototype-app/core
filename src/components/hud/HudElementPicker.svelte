<script>
	// 21-D3 — the element/screen picker, to DCC standards.
	//
	// It replaces an `<input list>` + `<datalist>`, which is the wrong control for this job
	// and was reported as such: a text box whose suggestions narrow AS YOU TYPE reads as a
	// FILTER over something, not as "this node points at that button", and it shows the raw
	// id, so a field naming nothing looks exactly like a field naming a real element.
	//
	// What a DCC gives you instead, and what this is: the RESOLVED name of the thing you
	// picked, a chevron opening a grouped, searchable list, an X to clear, an explicit
	// unresolved state, and an EYEDROPPER — arm it, click the element on the artboard.
	//
	// The one constraint the old control got right is kept: a typed id that this editor
	// cannot enumerate must still work (an element a module creates, or one on a document
	// this pane is not looking at). Suggestions are a convenience, never the allowed set —
	// so "enter id manually" is one click away and free text.
	import { ChevronDown, X, Pipette } from '@lucide/svelte';
	import { onDestroy } from 'svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import {
		hudDocs,
		elementChoices,
		screenChoices,
		resolveElement,
		resolveScreen,
		hudDocOf,
		hudPickArm,
		hudPickResult,
		armHudPick
	} from '$lib/hudDocs';

	/**
	 * @type {{ value?: string, docKey?: string, mode?: 'element'|'screen',
	 *   label?: string, onpick: (next: string) => void }}
	 */
	let { value = '', docKey = 'scene', mode = 'element', label = '', onpick } = $props();

	/** @type {{x: number, y: number, items: any[]}|null} */
	let menu = $state(null);
	let manual = $state(false);
	// a token, so two armed pickers cannot consume each other's answer
	const token = 'hudpick-' + Math.random().toString(36).slice(2, 9);
	const armed = $derived($hudPickArm === token);

	// $hudDocs is the DEPENDENCY (the helpers do a plain get()) and is passed as an unused
	// argument rather than through a comma operator, which svelte-check rejects.
	// `any[]`: the two modes return different row shapes and `mode` is a prop, so nothing
	// narrows the union at the read sites below.
	/** @type {(key: string, docs: any) => any[]} */
	const listOf = (key, _docs) => (mode === 'screen' ? screenChoices(key) : elementChoices(key));
	const choices = $derived(listOf(docKey, $hudDocs));

	/** The two modes resolve to DIFFERENT shapes ({kind, screen} vs {name}), so the reads
	 *  below cast rather than narrow - `mode` is a prop and no control-flow analysis can
	 *  tie it to the branch that produced the value. @type {any} */
	const hit = $derived.by(() => {
		void $hudDocs;
		if (!value) return null;
		if (mode === 'screen') {
			const s = resolveScreen(hudDocOf(docKey), value);
			return s ? { id: s.id, name: s.name } : null;
		}
		return resolveElement(docKey, value);
	});
	const pickState = $derived(!value ? 'empty' : hit ? 'ready' : 'unresolved');
	// what a user recognises: their own label if they typed one, else kind + screen
	const shown = $derived.by(() => {
		if (!value) return label || (mode === 'screen' ? 'no screen' : 'no element');
		if (!hit) return value;
		if (mode === 'screen') return /** @type {any} */ (hit).name;
		const h = /** @type {any} */ (hit);
		return (h.label ? h.label + ' - ' : '') + h.kind;
	});
	const sub = $derived(mode === 'screen' || !hit ? '' : /** @type {any} */ (hit).screen);

	// the armed field consumes its OWN answer only, then clears the store (write-once)
	$effect(() => {
		const r = $hudPickResult;
		if (r && r.token === token) {
			hudPickResult.set(null);
			onpick?.(r.id);
		}
	});
	onDestroy(() => {
		if ($hudPickArm === token) hudPickArm.set(null);
	});

	/** @param {MouseEvent} e */
	function open(e) {
		const el = /** @type {any} */ (e.currentTarget);
		const r = el.getBoundingClientRect();
		/** @type {any[]} */
		const items = [];
		if (choices.length > 6) items.push({ label: 'Search...', icon: 'search', revealFilter: true });
		if (mode === 'screen') {
			for (const c of choices)
				items.push({ label: c.name, checked: c.id === value, action: () => onpick?.(c.id) });
		} else {
			// GROUPED BY SCREEN. An id is unique across the document but a user thinks
			// "the Start button on the Menu screen", so the screen is the heading.
			/** @type {Record<string, any[]>} */
			const byScreen = {};
			for (const c of choices) (byScreen[c.screen] ??= []).push(c);
			for (const [screen, list] of Object.entries(byScreen)) {
				items.push({ section: screen });
				for (const c of list)
					items.push({
						label: (c.label ? c.label + ' - ' : '') + c.kind,
						hint: c.id.slice(-4),
						checked: c.id === value,
						action: () => onpick?.(c.id)
					});
			}
		}
		if (!choices.length) items.push({ label: 'nothing on any screen yet', disabled: true });
		items.push({ section: '' });
		items.push({ label: 'Enter id manually...', icon: 'pencil', action: () => (manual = true) });
		menu = { x: r.left, y: r.bottom + 2, items };
	}
</script>

<div class="hud-ep" data-state={pickState}>
	{#if manual}
		<!-- the escape hatch: free text, exactly what the old control was -->
		<input
			class="nodrag hud-ep-manual"
			placeholder={mode === 'screen' ? 'screen id' : 'element id'}
			{value}
			onchange={(/** @type {any} */ e) => {
				onpick?.(e.currentTarget.value.trim());
				manual = false;
			}}
			onblur={() => (manual = false)}
		/>
	{:else}
		<button type="button" class="nodrag hud-ep-field" onclick={open} title={value || 'nothing picked'}>
			<span class="hud-ep-name">{shown}</span>
			{#if sub}<span class="hud-ep-sub">{sub}</span>{/if}
			<ChevronDown size={12} aria-hidden="true" />
		</button>
		{#if mode === 'element'}
			<button
				type="button"
				class="nodrag hud-ep-icon"
				class:hud-ep-armed={armed}
				aria-pressed={armed}
				aria-label="Pick on the artboard"
				title={armed ? 'Click an element on the artboard (Esc to cancel)' : 'Pick on the artboard'}
				onclick={() => (armed ? hudPickArm.set(null) : armHudPick(token))}
			>
				<Pipette size={12} aria-hidden="true" />
			</button>
		{/if}
		{#if value}
			<button type="button" class="nodrag hud-ep-icon" aria-label="Clear" title="Clear" onclick={() => onpick?.('')}>
				<X size={12} aria-hidden="true" />
			</button>
		{/if}
	{/if}
</div>
{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="hud-element" onclose={() => (menu = null)} />
{/if}

<style>
	.hud-ep {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 2px;
	}
	.hud-ep-field {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 4px;
		border: 1px solid rgb(75 85 99 / 0.7);
		border-radius: 4px;
		background: rgb(17 24 39 / 0.6);
		padding: 2px 4px;
		font-size: 11px;
		text-align: left;
	}
	.hud-ep-field:hover {
		border-color: rgb(148 163 184 / 0.8);
	}
	.hud-ep-name {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hud-ep-sub {
		flex-shrink: 0;
		font-size: 10px;
		opacity: 0.55;
	}
	.hud-ep[data-state='empty'] .hud-ep-name {
		opacity: 0.5;
	}
	/* NOT a silent nothing: this field names something that is on no screen — a template's
	   id, a deleted element, a typo. Say so, in the colour the app already uses for
	   "waiting / not right yet". */
	.hud-ep[data-state='unresolved'] .hud-ep-field {
		border-color: #b45309;
	}
	.hud-ep[data-state='unresolved'] .hud-ep-name {
		color: #fbbf24;
	}
	.hud-ep-icon {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		border-radius: 4px;
		padding: 2px;
		opacity: 0.6;
	}
	.hud-ep-icon:hover {
		opacity: 1;
	}
	.hud-ep-armed {
		opacity: 1;
		background: rgb(56 189 248 / 0.25);
		color: #7dd3fc;
	}
	.hud-ep-manual {
		width: 100%;
	}
</style>
