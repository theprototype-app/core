// 37-settings (R21) — THE INVENTORY WALK, part 2 of 4: Touch controls, Scene, Explorer.
// Every setting row driven through the real UI must write the exact 1.25.0 key + string, and each page's footer
// reset (after its question) puts every row back. Table + driver: settingsInventoryShared.cjs. Split four ways so
// each part stays well inside the runner's 8-minute cap.
// Run: APP_URL=https://theprototype.app:5364/ npm run e2e -- settings-inventory-b.test
const h = require('./helpers.cjs');
const { walk } = require('./settingsInventoryShared.cjs');

h.run(() => walk(['touch', 'scene', 'explorer'], false));
