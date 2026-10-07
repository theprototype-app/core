// 37-settings (R21) — THE INVENTORY WALK, part 1 of 4: Interface, Controls, Input.
// Every setting row driven through the real UI must write the exact 1.25.0 key + string, and each page's footer
// reset (after its question) puts every row back. Table + driver: settingsInventoryShared.cjs. Split four ways so
// each part stays well inside the runner's 8-minute cap.
// Run: APP_URL=https://theprototype.app:5364/ npm run e2e -- settings-inventory.test
const h = require('./helpers.cjs');
const { walk } = require('./settingsInventoryShared.cjs');

h.run(() => walk(['interface', 'controls', 'input'], false));
