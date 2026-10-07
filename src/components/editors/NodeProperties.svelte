<script lang="ts">
	// 36 (flow-revamp 200-202, G1): the selected node's PROPERTIES in the Flow ⓘ panel, for every
	// node type — spec params, a Script's input values, a Behaviour's params, the spec defaults.
	// The decision (which keys, what kind, wired or not) is `nodeProps.propertyRows`, a pure leaf;
	// this file only draws it and writes ONE change per commit:
	//   - a data row: setNodeData({key: value}) + one 'flownodes' undo entry (replicates, hashes and
	//     undoes like any node edit — the card's own widget writes the same key)
	//   - a behaviour row: the knob path — setParamLiteral rewrites ONE literal in the source
	// A row whose key has a wire into it shows the live value instead of the control: the wire
	// overrides the property (resolveInputs), so editing it would change nothing visible.
	import { flowEdges, flowValues, activeGraphId } from '../../stores/flowStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { recordFlowNodesEntry } from '$lib/flowGraphs';
	import { propertyRows, coerceProp, propPatch, type PropRow } from '$lib/nodeProps';
	import { analyze, setParamLiteral } from '$lib/behaviours/analyze.js';

	let { node }: { node: any } = $props();

	const behaviourModel = $derived(node?.type === 'behaviour' ? analyze(String(node.data?.code ?? '')) : null);
	const rows: PropRow[] = $derived(
		propertyRows(node, findNodeSpec(node?.type), $flowEdges as any[], { behaviour: behaviourModel })
	);
	const groups = $derived.by(() => {
		const out: { name: string; rows: PropRow[] }[] = [];
		for (const row of rows) {
			let g = out.find((x) => x.name === row.group);
			if (!g) out.push((g = { name: row.group, rows: [] }));
			g.rows.push(row);
		}
		return out;
	});

	/** the wire's source for a wired row → its live value */
	function wiredValue(key: string) {
		const e = ($flowEdges as any[]).find((x) => x.target === node.id && x.targetHandle === key);
		const v = e ? ($flowValues as any)[e.source] : undefined;
		if (v === undefined || v === null) return '…';
		if (typeof v === 'number') return (+v).toFixed(2);
		// 37 (R6): an UNNAMED wire from a handle-map source reads its `__default` (the Switcher's index)
		if (typeof v === 'object' && v.__handles) return String((e.sourceHandle ? v.__handles[e.sourceHandle] : v.__default) ?? '…');
		return String(v);
	}

	function commit(row: PropRow, raw: any) {
		const value = coerceProp(row, raw);
		if (value === undefined) return;
		const graphId = $activeGraphId; // the panel edits the ACTIVE graph's selected node
		if (row.source === 'behaviour') {
			const before = String(node.data?.code ?? '');
			const r = setParamLiteral(before, row.key, value);
			if (!r.changed) return;
			setNodeData(node.id, { code: r.source }, graphId);
			recordFlowNodesEntry({ op: 'data', graphId, items: [{ id: node.id, before: { code: before }, after: { code: r.source } }] });
			return;
		}
		const patch = propPatch(node, row, value);
		if (!patch) return;
		const before: Record<string, any> = {};
		for (const k of Object.keys(patch)) before[k] = node.data?.[k];
		if (JSON.stringify(before) === JSON.stringify(patch)) return;
		setNodeData(node.id, patch, graphId);
		recordFlowNodesEntry({ op: 'data', graphId, items: [{ id: node.id, before, after: patch }] });
	}
	const id = (row: PropRow) => 'flow-prop-' + row.key;
</script>

{#if rows.length}
	<div id="flow-node-props" class="flex flex-col gap-1.5">
		{#each groups as group (group.name)}
			{#if group.name}<p class="ui-section-label mt-1">{group.name}</p>{/if}
			{#each group.rows as row (row.key)}
				<label class="flex flex-col gap-0.5" title={row.doc ?? row.key}>
					<span class="flex items-center justify-between gap-2">
						<span class="truncate">{row.label}</span>
						{#if row.wired}
							<span class="wired-value font-mono text-[11px] text-primary-300" data-prop-wired={row.key} title="Driven by the wired input">◈ {wiredValue(row.key)}</span>
						{:else if row.kind === 'toggle'}
							<input id={id(row)} type="checkbox" checked={!!row.value} onchange={(e) => commit(row, e.currentTarget.checked)} />
						{:else if row.kind === 'color'}
							<input id={id(row)} type="color" value={row.value ?? '#ffffff'} onchange={(e) => commit(row, e.currentTarget.value)} />
						{:else if row.kind === 'number' || row.kind === 'range'}
							<input id={id(row)} class="ui-input w-20" type="number" min={row.min} max={row.max} step={row.step ?? 'any'}
								value={row.value ?? 0} onchange={(e) => commit(row, e.currentTarget.value)} />
						{/if}
					</span>
					{#if !row.wired}
						{#if row.kind === 'range' && typeof row.min === 'number' && typeof row.max === 'number'}
							<input class="w-full" type="range" min={row.min} max={row.max} step={row.step ?? 0.01} value={row.value ?? row.min}
								aria-label={row.label} onchange={(e) => commit(row, +e.currentTarget.value)} />
						{:else if row.kind === 'select'}
							<select id={id(row)} class="ui-input" value={row.value ?? row.options?.[0]} onchange={(e) => commit(row, e.currentTarget.value)}>
								{#each row.options ?? [] as option (option)}<option value={option}>{option}</option>{/each}
							</select>
						{:else if row.kind === 'text' || row.kind === 'code'}
							<input id={id(row)} class="ui-input" value={row.value ?? ''} placeholder={row.placeholder} maxlength={row.maxLength}
								onchange={(e) => commit(row, e.currentTarget.value)} />
						{:else if row.kind === 'vector3'}
							<input id={id(row)} class="ui-input font-mono" value={(row.value ?? [0, 0, 0]).join(', ')}
								onchange={(e) => commit(row, e.currentTarget.value)} />
						{/if}
					{/if}
					{#if row.doc}<span class="text-[10px] leading-snug text-gray-400">{row.doc}</span>{/if}
				</label>
			{/each}
		{/each}
	</div>
{:else}
	<p class="text-gray-400">This node has no properties to edit.</p>
{/if}
