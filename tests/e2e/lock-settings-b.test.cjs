// 38 R1 — the settings lock, part B (Explorer … About + the 390x844 pass). The suite is
// lock-settings.test.cjs; this file only selects its second half so each half stays well
// under the runner's 8-minute cap.
process.env.LOCK_SETTINGS_PART = 'b';
require('./lock-settings.test.cjs');
