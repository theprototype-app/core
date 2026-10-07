// 37-settings (R21) — THE INVENTORY WALK, part 4 of 4: AI, Connection, then Node types and the cross-category reset checks (a reset
// leaves other pages alone; Cancel resets nothing).
// Every setting row driven through the real UI must write the exact 1.25.0 key + string, and each page's footer
// reset (after its question) puts every row back. Table + driver: settingsInventoryShared.cjs. Split four ways so
// each part stays well inside the runner's 8-minute cap.
// Run: APP_URL=https://theprototype.app:5364/ npm run e2e -- settings-inventory-d.test
const h = require('./helpers.cjs');
const { walk } = require('./settingsInventoryShared.cjs');

h.run(() => walk(['ai', 'connection'], true));
