<script>
	// Roadmap 67 P1/P3/P4/P5 — THE AGENT PANELS on a person's screen: one floating tool window per panel an
	// agent opened for them (agentPanels.js holds them; agentPanelCore.js validated every spec). Mounted by
	// App.svelte only while a panel is up, so a session without agent panels loads none of this.
	//
	// The window is the module-toolbox shell (ui/ToolboxWindow: header drag, the width grip, focus stacking,
	// the ≤640px bottom sheet a swipe closes); the controls are the kit's (Slider, Toggle, ThemedSelect,
	// Button, the tp-field inputs). Text is TEXT: nothing here renders HTML from a spec.
	//
	// The header says whose panel it is ("Panel by Claude on deck-pc"). The owner can Share it with the
	// editors; anyone holding a copy can Save it as a .tppanel in the Explorer; Close closes this copy (the
	// owner's close closes the panel for the agent). A panel whose agent is gone stays up READ-ONLY with
	// "Waiting for <agent>" until that agent — or one declaring the same tool — takes it back.
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import Icon from '../ui/Icon.svelte';
	import Slider from '../ui/Slider.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Button from '../ui/Button.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import {
		agentPanels,
		changeControl,
		pressControl,
		closeAgentPanel,
		closeAllAgentPanels,
		shareAgentPanel,
		saveAgentPanel,
		canUse,
		isOwner,
		focusedPanel
	} from '$lib/agentPanels.js';
	import { ownershipLabel } from '$lib/agentPanelCore.js';
	import { isLocked } from '../../stores/sceneStore';

	/** which tab each panel shows @type {Record<string, string>} */
	let tabOf = $state({});
	/** a window's DOM-safe id prefix @param {string} key */
	const domId = (key) => 'ap-' + key.replace(/[^A-Za-z0-9_-]/g, '_');
	/** @param {any} c */
	const fmt = (c) => (/** @type {number} */ v) => {
		const digits = c.step && c.step < 1 ? Math.min(4, Math.max(0, Math.ceil(-Math.log10(c.step)))) : 0;
		return Number(v).toFixed(digits) + (c.unit ? ' ' + c.unit : '');
	};
	const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

	/** a sprite-sheet preview steps through its frames (a still first frame with reduced motion) @param {HTMLElement} node @param {any} c */
	function frames(node, c) {
		let frame = 0;
		/** @type {any} */
		let timer = null;
		const paint = (/** @type {any} */ cc) => {
			const f = cc?.frames;
			if (!f) {
				node.style.backgroundImage = '';
				return;
			}
			const total = f.cols * f.rows;
			const i = frame % total;
			const x = f.cols > 1 ? ((i % f.cols) / (f.cols - 1)) * 100 : 0;
			const y = f.rows > 1 ? (Math.floor(i / f.cols) / (f.rows - 1)) * 100 : 0;
			node.style.backgroundImage = cc.src ? 'url("' + cc.src + '")' : '';
			node.style.backgroundSize = f.cols * 100 + '% ' + f.rows * 100 + '%';
			node.style.backgroundPosition = x + '% ' + y + '%';
		};
		const start = (/** @type {any} */ cc) => {
			clearInterval(timer);
			paint(cc);
			if (cc?.frames && !reduced) timer = setInterval(() => {
				frame++;
				paint(cc);
			}, 1000 / cc.frames.fps);
		};
		start(c);
		return {
			update: (/** @type {any} */ next) => start(next),
			destroy: () => clearInterval(timer)
		};
	}
</script>

{#each $agentPanels as p, index (p.key)}
	{@const usable = canUse(p)}
	{@const owner = isOwner(p)}
	{@const tabs = p.spec.tabs}
	{@const tab = tabs.find((/** @type {any} */ t) => t.id === tabOf[p.key]) ?? tabs[0]}
	{@const base = domId(p.key)}
	{#if !$isLocked}
		<ToolboxWindow
			id={base}
			title={p.spec.title}
			label={p.spec.title + ' — ' + ownershipLabel(p)}
			key={'agentPanel:' + (p.spec.toolId || p.spec.title)}
			width={p.spec.size.w}
			minW={240}
			defaultRect={{ right: 16 + index * 24, top: 90 + index * 24 }}
			onclose={() => closeAgentPanel(p.key)}
		>
			{#snippet actions()}
				{#if owner && p.live}
					<button
						class="tbx-hbtn ap-share"
						title={p.shared ? 'Stop sharing with editors' : 'Share with editors'}
						aria-label={p.shared ? 'Stop sharing ' + p.spec.title + ' with editors' : 'Share ' + p.spec.title + ' with editors'}
						aria-pressed={p.shared}
						onclick={() => shareAgentPanel(p.key, !p.shared)}><Icon name="users" size={16} aria-hidden="true" /></button
					>
				{/if}
				<button class="tbx-hbtn ap-save" title="Save as .tppanel" aria-label={'Save ' + p.spec.title + ' as a .tppanel file'} onclick={() => saveAgentPanel(p.key)}
					><Icon name="save" size={16} aria-hidden="true" /></button
				>
				<button class="tbx-hbtn ap-close" title="Close" aria-label={'Close ' + p.spec.title} onclick={() => closeAgentPanel(p.key)}
					><Icon name="x" size={16} aria-hidden="true" /></button
				>
			{/snippet}
			{#snippet status()}
				<span class="ap-owner" data-agent-panel-owner>{ownershipLabel(p)}</span>
				{#if !p.live}
					<span class="ap-wait" role="status">{p.error ? p.error : 'Waiting for ' + (p.waiting || p.agentName) + '…'}</span>
				{:else if p.shared}
					<span class="ap-shared">Shared with editors</span>
				{/if}
				<button class="ap-closeall" onclick={closeAllAgentPanels}>Close all agent panels</button>
			{/snippet}
			<div
				class="ap-body"
				data-agent-panel={p.key}
				data-live={p.live ? '1' : '0'}
				onpointerdown={() => focusedPanel.set(p.key)}
				role="presentation"
			>
				{#if tabs.length > 1}
					<div class="ap-tabs" role="tablist" aria-label={p.spec.title + ' tabs'}>
						{#each tabs as t (t.id)}
							<button
								role="tab"
								id={base + '-tab-' + t.id}
								aria-selected={t.id === tab.id}
								aria-controls={base + '-pane'}
								tabindex={t.id === tab.id ? 0 : -1}
								class="ap-tab"
								class:ap-tab-on={t.id === tab.id}
								onclick={() => (tabOf = { ...tabOf, [p.key]: t.id })}>{t.title}</button
							>
						{/each}
					</div>
				{/if}
				<div id={base + '-pane'} role={tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 1 ? base + '-tab-' + tab.id : undefined}>
					{#each tab.sections as s, si (si)}
						<section class="ap-section" aria-label={s.title || undefined}>
							{#if s.title}<h3 class="ap-section-title">{s.title}</h3>{/if}
							{#each s.controls as c (c.id)}
								{@const cid = base + '-' + c.id}
								{@const off = !usable || c.disabled}
								{@const helpId = c.help ? cid + '-help' : undefined}
								<div class="ap-row ap-{c.type}" data-control={c.id}>
									{#if c.type === 'slider'}
										<label class="ap-label" for={cid}>{c.label}</label>
										<Slider
											id={cid}
											value={p.values[c.id]}
											min={c.min}
											max={c.max}
											step={c.step}
											label={c.label}
											disabled={off}
											width="100%"
											format={fmt(c)}
											aria-describedby={helpId}
											onchange={(/** @type {number} */ v) => changeControl(p.key, c.id, v)}
										/>
									{:else if c.type === 'number'}
										<label class="ap-label" for={cid}>{c.label}</label>
										<input
											id={cid}
											class="tp-field ap-input"
											type="number"
											min={c.min}
											max={c.max}
											step={c.step ?? 'any'}
											value={p.values[c.id]}
											disabled={off}
											aria-describedby={helpId}
											oninput={(e) => {
												const n = parseFloat(e.currentTarget.value);
												if (Number.isFinite(n)) changeControl(p.key, c.id, n);
											}}
										/>
									{:else if c.type === 'select'}
										<span class="ap-label" id={cid + '-l'}>{c.label}</span>
										<ThemedSelect
											id={cid}
											title={c.label}
											items={c.options.map((/** @type {any} */ o) => ({ value: o.value, name: o.label }))}
											value={p.values[c.id]}
											disabled={off}
											clip={false}
											onchange={(/** @type {any} */ v) => changeControl(p.key, c.id, v)}
										/>
									{:else if c.type === 'toggle'}
										<span class="ap-label" id={cid + '-l'}>{c.label}</span>
										<Toggle id={cid} checked={!!p.values[c.id]} labelledby={cid + '-l'} describedby={helpId} disabled={off} onchange={(/** @type {boolean} */ v) => changeControl(p.key, c.id, v)} />
									{:else if c.type === 'colour'}
										<label class="ap-label" for={cid}>{c.label}</label>
										<input id={cid} class="ap-colour" type="color" value={p.values[c.id]} disabled={off} aria-describedby={helpId} oninput={(e) => changeControl(p.key, c.id, e.currentTarget.value)} />
									{:else if c.type === 'text'}
										<label class="ap-label" for={cid}>{c.label}</label>
										<input
											id={cid}
											class="tp-field ap-input"
											type="text"
											autocomplete="off"
											maxlength={c.maxLength}
											placeholder={c.placeholder}
											value={p.values[c.id]}
											disabled={off}
											aria-describedby={helpId}
											oninput={(e) => changeControl(p.key, c.id, e.currentTarget.value)}
										/>
									{:else if c.type === 'textarea'}
										<label class="ap-label" for={cid}>{c.label}</label>
										<textarea
											id={cid}
											class="tp-field ap-textarea"
											rows={c.rows}
											maxlength={c.maxLength}
											placeholder={c.placeholder}
											value={p.values[c.id]}
											disabled={off}
											aria-describedby={helpId}
											oninput={(e) => changeControl(p.key, c.id, e.currentTarget.value)}
										></textarea>
									{:else if c.type === 'button'}
										<Button id={cid} variant={c.variant === 'primary' ? 'primary' : 'secondary'} size="sm" full disabled={off} aria-describedby={helpId} onclick={() => pressControl(p.key, c.id)}>{c.label}</Button>
									{:else if c.type === 'image'}
										{#if c.label}<span class="ap-label">{c.label}</span>{/if}
										{#if c.src}
											{#if c.frames}
												<div class="ap-sheet" class:ap-pixel={c.pixelated} role="img" aria-label={c.alt} use:frames={c}></div>
											{:else}
												<img class="ap-image" class:ap-pixel={c.pixelated} src={c.src} alt={c.alt} />
											{/if}
										{:else}
											<div class="ap-image-empty" role="img" aria-label={c.alt || 'no image yet'}>No image yet</div>
										{/if}
									{:else if c.type === 'files'}
										{#if c.label}<span class="ap-label">{c.label}</span>{/if}
										<ul class="ap-files">
											{#each c.items as f, fi (fi)}
												<li><Icon name="file-text" size={16} aria-hidden="true" /> {f.name}</li>
											{/each}
										</ul>
									{:else if c.type === 'progress'}
										<span class="ap-label" id={cid + '-l'}>{c.label}</span>
										<div
											class="ap-progress"
											role="progressbar"
											aria-labelledby={cid + '-l'}
											aria-valuemin={c.value === null ? undefined : 0}
											aria-valuemax={c.value === null ? undefined : 100}
											aria-valuenow={c.value === null ? undefined : Math.round(c.value * 100)}
											aria-valuetext={c.text || undefined}
										>
											<div class="ap-progress-bar" class:ap-indeterminate={c.value === null} style:width={c.value === null ? '40%' : Math.round(c.value * 100) + '%'}></div>
										</div>
										{#if c.text}<span class="ap-help">{c.text}</span>{/if}
									{:else if c.type === 'status'}
										<p class="ap-status ap-tone-{c.tone}" role="status">{#if c.label}<strong>{c.label}: </strong>{/if}{c.text}</p>
									{:else if c.type === 'table'}
										<table class="ap-table">
											{#if c.label}<caption>{c.label}</caption>{/if}
											<thead><tr>{#each c.columns as h, hi (hi)}<th scope="col">{h}</th>{/each}</tr></thead>
											<tbody>
												{#each c.rows as r, ri (ri)}<tr>{#each r as cell, ci (ci)}<td>{cell}</td>{/each}</tr>{/each}
											</tbody>
										</table>
									{/if}
									{#if c.help}<span class="ap-help" id={helpId}>{c.help}</span>{/if}
								</div>
							{/each}
						</section>
					{/each}
				</div>
			</div>
		</ToolboxWindow>
	{/if}
{/each}

<style>
	/* the toolbox body is an auto-fill grid of 36px cells: a panel's form spans all of it */
	.ap-body {
		grid-column: 1 / -1;
		display: flex;
		width: 100%;
		min-width: 0;
		flex-direction: column;
		gap: 8px;
		user-select: text;
	}
	.ap-tabs {
		display: flex;
		gap: 2px;
		border-bottom: 1px solid var(--border);
	}
	.ap-tab {
		padding: 4px 8px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
	}
	.ap-tab-on {
		border-bottom-color: var(--accent);
		color: var(--text);
	}
	.ap-section {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.ap-section-title {
		margin: 0;
		font-size: var(--fs-section);
		font-weight: 600;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.ap-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.ap-toggle {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}
	.ap-label {
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.ap-help {
		font-size: var(--fs-section);
		color: var(--text-muted);
	}
	.ap-input,
	.ap-textarea {
		width: 100%;
		box-sizing: border-box;
	}
	.ap-colour {
		width: 48px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		background: transparent;
	}
	.ap-image,
	.ap-sheet {
		display: block;
		width: 100%;
		max-height: 240px;
		object-fit: contain;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		background: var(--surface-2);
	}
	.ap-sheet {
		aspect-ratio: 1;
		max-width: 240px;
		background-repeat: no-repeat;
	}
	.ap-pixel {
		image-rendering: pixelated;
	}
	.ap-image-empty {
		padding: 16px;
		border: 1px dashed var(--border);
		border-radius: var(--radius-input);
		color: var(--text-muted);
		text-align: center;
		font-size: var(--fs-desc);
	}
	.ap-files {
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--fs-desc);
	}
	.ap-files li {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.ap-progress {
		height: 6px;
		overflow: hidden;
		border-radius: 3px;
		background: var(--surface-2);
	}
	.ap-progress-bar {
		height: 100%;
		background: var(--accent);
	}
	.ap-indeterminate {
		animation: ap-slide 1.2s ease-in-out infinite;
	}
	@keyframes ap-slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ap-indeterminate {
			animation: none;
		}
	}
	.ap-status {
		margin: 0;
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.ap-tone-ok {
		color: var(--accent-text);
	}
	.ap-tone-warn,
	.ap-tone-error {
		color: var(--warn-text);
	}
	.ap-table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-desc);
	}
	.ap-table caption {
		text-align: left;
		color: var(--text-2);
	}
	.ap-table th,
	.ap-table td {
		padding: 2px 4px;
		border-bottom: 1px solid var(--border);
		text-align: left;
	}
	.ap-owner {
		color: var(--text-muted);
	}
	.ap-wait {
		color: var(--warn-text);
	}
	.ap-shared {
		color: var(--accent-text);
	}
	.ap-closeall {
		margin-left: auto;
		padding: 0 2px;
		border: 0;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--accent-text);
		font: inherit;
		cursor: pointer;
	}
	.ap-closeall:hover {
		background: var(--surface-hover);
	}
</style>
