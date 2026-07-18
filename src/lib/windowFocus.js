// Click-to-front for floating windows (phase 82). Every registered window
// gets a z-index inside the --z-window band (40..44, still under the hud at
// 45); pointerdown moves it to the top of the stack.

/** @type {any[]} */
const order = [];

function apply() {
	order.forEach((node, index) => {
		node.style.zIndex = String(40 + Math.min(index, 4));
	});
}

/** svelte action: use:focusStack on a floating window's root @param {any} node */
export function focusStack(node) {
	order.push(node);
	apply();
	const raise = () => {
		const index = order.indexOf(node);
		if (index >= 0 && index < order.length - 1) {
			order.splice(index, 1);
			order.push(node);
			apply();
		}
	};
	// capture phase: runs before inner handlers, dragging included
	node.addEventListener('pointerdown', raise, true);
	return {
		destroy() {
			node.removeEventListener('pointerdown', raise, true);
			const index = order.indexOf(node);
			if (index >= 0) order.splice(index, 1);
			apply();
		}
	};
}
