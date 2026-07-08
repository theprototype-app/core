<script lang="ts">
	import { Modal, Select } from 'flowbite-svelte';
	import { characterModalOpen, avatarConfig, userdata, peers } from '../../stores/appStore.js';

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

	let rowClass =
		'z-10 inline-flex w-40 flex-shrink-0 items-center border border-gray-300 bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white';

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
				class="h-11 w-full cursor-pointer rounded-e-lg border border-gray-300 bg-white p-1 dark:border-gray-600 dark:bg-gray-700"
				value={$avatarConfig.body}
				on:input={(e) => update({ body: e.currentTarget.value })}
			/>
		</div>
		<div class="flex px-6 pb-3">
			<p class="{rowClass} rounded-s-lg">Hat</p>
			<Select
				class="rounded-s-none"
				items={hats}
				value={$avatarConfig.hat}
				on:change={(e) => update({ hat: e.srcElement.value })}
			/>
		</div>
		<div class="flex px-6 pb-1">
			<p class="{rowClass} rounded-s-lg">Face</p>
			<Select
				class="rounded-s-none"
				items={faces}
				value={$avatarConfig.face}
				on:change={(e) => update({ face: e.srcElement.value })}
			/>
		</div>
		<p class="px-6 pt-2 text-xs text-gray-400">
			The face photo uses your profile avatar image (Profile Settings). Changes apply for all
			connected peers immediately.
		</p>
	</div>
</Modal>
