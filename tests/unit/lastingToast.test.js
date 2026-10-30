import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { showToast, showLastingToast, toastStore, notifications, notificationActions } from '../../src/stores/appStore.js';

// fix-live F-2 + F-5: a decision toast whose buttons survive in the notification history
describe('lasting toasts', () => {
	beforeEach(() => {
		toastStore.set([]);
		notifications.set([]);
		notificationActions.set({});
	});
	it('showToast(…, {keep}) keeps working buttons on the history entry (the role offer)', () => {
		let accepted = 0;
		showToast('You have been offered the ADMIN role by AB12C. Accept?', [{ label: 'Accept', action: () => accepted++ }], { keep: true });
		const entry = get(notifications).at(-1);
		const acts = get(notificationActions)[entry.id];
		expect(acts?.map((a) => a.label)).toEqual(['Accept']);
		acts[0].action();
		expect(accepted).toBe(1);
		expect(get(notificationActions)[entry.id]).toBeUndefined(); // answered: the buttons go
	});
	it('pressing the TOAST button also clears the history buttons', () => {
		let n = 0;
		const id = showLastingToast('X joined automatically', [{ label: 'Remove', action: () => n++ }]);
		const card = /** @type {any} */ (get(toastStore).at(-1));
		card.actions[0].action();
		expect(n).toBe(1);
		expect(get(notificationActions)[id]).toBeUndefined();
	});
	it('a plain action toast (no keep) is unchanged: history text only', () => {
		showToast('Undo?', [{ label: 'Undo', action: () => {} }]);
		expect(Object.keys(get(notificationActions))).toEqual([]);
		expect(get(notifications).at(-1).kind).toBe('action');
	});
});
