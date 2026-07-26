<script lang="ts">
	import { Modal, Checkbox } from 'flowbite-svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { characterModalOpen, avatarConfig, userdata, peers } from '../../stores/appStore.js';
	import { FACE_SHAPES, resolveAvatar } from '$lib/avatarModel';

	// resolve so shape/showLabel have defaults even for older stored configs
	$: cfg = resolveAvatar($avatarConfig);

	// Edits the local player's avatar config; every change persists and
	// replicates immediately through the existing userdata message.

	const hats = [
		{ value: 'none', name: 'None' },
		{ value: 'cap', name: 'Cap' },
		{ value: 'tophat', name: 'Top hat' },
		{ value: 'crown', name: 'Crown' }
	];
	const faces = [
		{ value: 'label', name: 'Name label only' },
		{ value: 'image', name: 'My avatar photo' }
	];

	// w-32 on tight/folded screens so the dropdown value isn't squeezed to one letter,
	// widening to w-40 once there's room
	let rowClass =
		'z-10 inline-flex w-32 sm:w-40 flex-shrink-0 items-center border border-gray-300 bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white';

	function update(partial: any) {
		const next = { ...$avatarConfig, ...partial };
		$avatarConfig = next;
		localStorage.setItem('avatarConfig', JSON.stringify(next));
		// update our own userdata row and broadcast
		$userdata.forEach((element) => {
			if (element[0] === $peers.peer.id) element[5] = next;
		});
		$userdata = $userdata;
		$peers.send({ type: 'userdata', userdata: $userdata });
	}
</script>

<Modal title="" bind:open={$characterModalOpen} outsideclose size="sm">
	<center><b>Customize Character</b></center>

	<div class="modal-content p-4">
		<div class="flex px-6 pb-3">
			<p class="{rowClass} rounded-s-lg">Body color</p>
			<input
				type="color"
				class="h-11 min-w-0 flex-1 cursor-pointer rounded-e-lg border border-gray-300 bg-white p-1 dark:border-gray-600 dark:bg-gray-700"
				value={$avatarConfig.body}
				on:input={(e) => update({ body: e.currentTarget.value })}
			/>
		</div>
		<div class="flex px-6 pb-3">
			<p class="{rowClass} rounded-s-lg">Hat</p>
			<ThemedSelect
				class="char-select min-w-0 flex-1"
				items={hats}
				value={$avatarConfig.hat}
				onchange={(v) => update({ hat: v })}
			/>
		</div>
		<div class="flex px-6 pb-3">
			<p class="{rowClass} rounded-s-lg">Head shape</p>
			<ThemedSelect
				class="char-select min-w-0 flex-1"
				items={FACE_SHAPES}
				value={cfg.shape}
				onchange={(v) => update({ shape: v })}
			/>
		</div>
		<div class="flex px-6 pb-1">
			<p class="{rowClass} rounded-s-lg">Face</p>
			<ThemedSelect
				class="char-select min-w-0 flex-1"
				items={faces}
				value={cfg.face}
				onchange={(v) => update({ face: v })}
			/>
		</div>
		<div class="flex items-center gap-2 px-6 pt-3">
			<Checkbox checked={cfg.showLabel} on:change={(e) => update({ showLabel: (e.target as HTMLInputElement).checked })}
				>Show name label</Checkbox
			>
		</div>
		<p class="px-6 pt-2 text-xs text-gray-400">
			The face photo uses your profile avatar image (Profile Settings). Changes apply for all
			connected peers immediately.
		</p>
	</div>
</Modal>

<style>
	/* The dropdowns sit beside a fixed-height label box (rounded-s-lg). Square the
	   control's left corners and let it fill the row height so it seams with the label
	   exactly like the Body color input — no short, top-floating select. */
	:global(.char-select .ts-btn) {
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
		height: 100%;
	}
</style>
