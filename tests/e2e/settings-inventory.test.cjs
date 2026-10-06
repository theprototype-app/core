// 37-settings (R21) — THE INVENTORY WALK, part 1: General (Interface, Controls, Input, Touch controls) + Scene.
// Every setting row driven through the real UI must write the exact 1.25.0 key + string, and each page's footer
// reset (after its question) puts every row back. Table + driver: settingsInventoryShared.cjs; part 2 is
// settings-inventory-b. Run: APP_URL=https://theprototype.app:5364/ npm run e2e -- settings-inventory.test
const h = require('./helpers.cjs');
const { walk } = require('./settingsInventoryShared.cjs');

h.run(() => walk(['interface', 'controls', 'input', 'touch', 'scene'], false));
