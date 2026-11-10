<script>
	// 93 LP0 / LP4 — Configure Scene ▸ Levels: the game's ONE Levels table (names, scene or spawn point,
	// goals, order) and its keep-across-levels list. Scene data: saved with the scene, replicated with the
	// scene-settings singleton, one undo step per change (gameLevels/history.js). The Kit: Levels nodes
	// (Go to level / Next level / Finish level), portals and the agent's game_setup {levels} use this same
	// table. Its own component so the Inspector edit is one line.
	import UiButton from '../../ui/Button.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import InsToggle from '../inspector/InsToggle.svelte';
	import LoadingScreenSettings from './LoadingScreenSettings.svelte'; // 93 LP2
	import { scenePhysicsState_ } from '$lib/scenePhysics';
	import { projectManifest, manifestSceneNames } from '$lib/projectManifest';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { gameState } from '$lib/gameState';
	import { isViewer } from '$lib/objectPermissions';
	import { keepItems, slugLevelId } from '$lib/gameLevels/table.js';
	import { saveProblem } from '$lib/gameLevels/checkpoints.js'; // LP5: the save cap, measured at each checkpoint

	const table = $derived($scenePhysicsState_.levels ?? null);
	const rows = $derived(table?.list ?? []);
	const keep = $derived(keepItems(table));
	const viewer = $derived(isViewer());

	// suggestions: the project's scenes, and the objects a level can start at (Checkpoints and Portals first)
	// the manifest store is read so a newly saved scene shows up (manifestSceneNames reads it with get())
	const sceneNames = $derived($projectManifest ? manifestSceneNames() : []);
	/** @param {any} group */
	function spawnNames(group) {
		/** @type {string[]} */
		const marked = [];
		/** @type {string[]} */
		const named = [];
		group?.traverse?.((/** @type {any} */ o) => {
			if (o === group || !o.name) return;
			if (o.userData?.checkpoint || o.userData?.portal) marked.push(o.name);
			else if (o.parent === group) named.push(o.name);
		});
		return [...new Set([...marked.sort(), ...named.sort()])].slice(0, 80);
	}
	let spawnList = $state(/** @type {string[]} */ ([]));
	const varNames = $derived(Object.keys($gameState.vars ?? {}).sort());

	/** @param {any} next */
	async function commit(next) {
		const h = await import('$lib/gameLevels/history.js');
		h.commitLevels(next);
	}
	/** @param {(t: any) => void} edit */
	function edit(edit) {
		const draft = table ? JSON.parse(JSON.stringify(table)) : { list: [], keep: [], unlock: 'all' };
		edit(draft);
		commit(draft);
	}

	function addLevel() {
		const n = rows.length + 1;
		let name = 'Level ' + n;
		const taken = new Set(rows.map((/** @type {any} */ r) => r.id));
		let k = n;
		while (taken.has(slugLevelId(name))) name = 'Level ' + ++k;
		edit((t) => t.list.push({ name }));
	}
	/** @param {number} i @param {string} key @param {string} value */
	function setField(i, key, value) {
		edit((t) => {
			const v = value.trim();
			if (key === 'name' && !v) return;
			if (v) t.list[i][key] = v;
			else delete t.list[i][key];
		});
	}
	/** @param {number} i @param {number} by */
	function move(i, by) {
		edit((t) => {
			const j = i + by;
			if (j < 0 || j >= t.list.length) return;
			[t.list[i], t.list[j]] = [t.list[j], t.list[i]];
		});
	}
	/** @param {number} i */
	function remove(i) {
		edit((t) => t.list.splice(i, 1));
	}
	/** @param {string} item @param {boolean} on */
	function setKeep(item, on) {
		edit((t) => {
			t.keep = (t.keep ?? []).filter((/** @type {string} */ k) => k !== item);
			if (on) t.keep.push(item);
		});
	}
	/** @param {string} text */
	function setKeepVars(text) {
		const names = text
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		edit((t) => {
			t.keep = [...(t.keep ?? []).filter((/** @type {string} */ k) => !k.startsWith('var:')), ...names.map((n) => 'var:' + n)];
		});
	}
	const UNLOCKS = [
		{ value: 'all', label: 'Any level', title: 'Portals and the Go to level node may go to any level' },
		{ value: 'sequential', label: 'In order', title: 'A level opens once the one before it is finished with a star' }
	];
</script>

<div id="levels-section" class="flex flex-col gap-2" data-keywords="levels level table portal checkpoint progress keep score inventory health next stage world campaign">
	<p class="text-[length:var(--fs-desc)] text-text-muted">
		The game's levels, in play order. A level is a scene, or a spot in this scene (an object to start at). The
		Go to level, Next level and Finish level nodes, portals and checkpoints all use this one list.
	</p>
	{#if rows.length}
		<ol class="flex flex-col gap-2" aria-label="Levels">
			{#each rows as row, i (row.id)}
				<li class="levels-row flex flex-col gap-1 rounded border border-border p-2" data-level-id={row.id}>
					<div class="flex items-center gap-1">
						<span class="w-5 shrink-0 text-xs text-text-muted" aria-hidden="true">{i + 1}</span>
						<input
							class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
							aria-label={'Level ' + (i + 1) + ' name'}
							value={row.name}
							disabled={viewer}
							onchange={(e) => setField(i, 'name', e.currentTarget.value)}
						/>
						<UiButton variant="icon" size="sm" icon="chevron-up" label={'Move ' + row.name + ' up'} disabled={viewer || i === 0} onclick={() => move(i, -1)} />
						<UiButton variant="icon" size="sm" icon="chevron-down" label={'Move ' + row.name + ' down'} disabled={viewer || i === rows.length - 1} onclick={() => move(i, 1)} />
						<UiButton variant="icon" size="sm" icon="trash-2" label={'Remove ' + row.name} disabled={viewer} onclick={() => remove(i)} />
					</div>
					<label class="flex items-center gap-1 text-xs text-text-muted">
						<span class="w-12 shrink-0">Scene</span>
						<input
							class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
							list="levels-scene-names"
							placeholder="this scene"
							value={row.scene ?? ''}
							disabled={viewer}
							onchange={(e) => setField(i, 'scene', e.currentTarget.value)}
						/>
					</label>
					<label class="flex items-center gap-1 text-xs text-text-muted">
						<span class="w-12 shrink-0">Start at</span>
						<input
							class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
							list="levels-spawn-names"
							placeholder="the spawn point"
							value={row.spawn ?? ''}
							disabled={viewer}
							onfocus={() => (spawnList = spawnNames($objectsGroup))}
							onchange={(e) => setField(i, 'spawn', e.currentTarget.value)}
						/>
					</label>
					<label class="flex items-center gap-1 text-xs text-text-muted">
						<span class="w-12 shrink-0">Goal</span>
						<input
							class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
							placeholder="optional"
							value={row.goal ?? ''}
							disabled={viewer}
							onchange={(e) => setField(i, 'goal', e.currentTarget.value)}
						/>
					</label>
				</li>
			{/each}
		</ol>
		<datalist id="levels-scene-names">
			{#each sceneNames as name (name)}<option value={name}></option>{/each}
		</datalist>
		<datalist id="levels-spawn-names">
			{#each spawnList as name (name)}<option value={name}></option>{/each}
		</datalist>
	{/if}
	<div class="flex flex-wrap gap-2">
		<UiButton id="levels-add" variant="outline" size="sm" icon="plus" disabled={viewer} onclick={addLevel}>Add level</UiButton>
		{#if rows.length}
			<UiButton id="levels-clear" variant="ghost" size="sm" disabled={viewer} onclick={() => commit(null)}>Remove the table</UiButton>
		{/if}
	</div>
	{#if rows.length}
		<div class="flex flex-col gap-1">
			<span class="text-xs text-text-muted" id="levels-unlock-label">Players may go to</span>
			<Segmented id="levels-unlock" labelledby="levels-unlock-label" full options={UNLOCKS} value={table?.unlock ?? 'all'} disabled={viewer} onchange={(v) => edit((t) => (t.unlock = v))} />
		</div>
		<fieldset class="flex flex-col gap-1" aria-describedby="levels-keep-help">
			<legend class="text-xs font-semibold">Keep across levels</legend>
			<p id="levels-keep-help" class="text-[length:var(--fs-badge)] italic text-text-muted">
				What a player carries through portals and keeps at checkpoints. New game resets it. With nothing
				ticked, the whole game state carries (as before).
			</p>
			<InsToggle id="levels-keep-score" checked={keep.score} disabled={viewer} onchange={(e) => setKeep('score', e.currentTarget.checked)}>Score</InsToggle>
			<InsToggle id="levels-keep-inventory" checked={keep.inventory} disabled={viewer} onchange={(e) => setKeep('inventory', e.currentTarget.checked)}>Inventory</InsToggle>
			<InsToggle id="levels-keep-health" checked={keep.health} disabled={viewer} onchange={(e) => setKeep('health', e.currentTarget.checked)}>Health</InsToggle>
			<label class="flex items-center gap-1 text-xs text-text-muted">
				<span class="w-24 shrink-0">Named variables</span>
				<input
					id="levels-keep-vars"
					class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
					placeholder={varNames.length ? varNames.slice(0, 3).join(', ') : 'e.g. coins, keys'}
					value={keep.vars.join(', ')}
					disabled={viewer}
					onchange={(e) => setKeepVars(e.currentTarget.value)}
				/>
			</label>
			{#if $saveProblem}
				<p id="levels-save-problem" role="alert" class="text-xs text-warn-text">In an exported game: {$saveProblem}</p>
			{/if}
		</fieldset>
		<LoadingScreenSettings value={table?.loading ?? null} disabled={viewer} onchange={(next) => edit((t) => (next ? (t.loading = next) : delete t.loading))} />
	{/if}
</div>
