const { syncResultsFromApi, getActivityLevel } = require("./scoreProvider");
const { autoBackupSemifinalsOnWindowClose } = require("./knockout");

// Polling intervals in milliseconds
const INTERVALS = {
  live: 60 * 1000, //  60 seconds  — match in progress or just finished
  active: 3 * 60 * 1000, //   3 minutes  — match starting within 2 hours
  today: 10 * 60 * 1000, //  10 minutes  — matches later today
  idle: 60 * 60 * 1000, //  60 minutes  — no matches today
};

let currentInterval = null;
let timer = null;
let running = false;

async function tick() {
  if (running) return; // prevent overlap if a sync takes longer than the interval
  running = true;
  try {
    await syncResultsFromApi();
    const backup = autoBackupSemifinalsOnWindowClose();
    if (backup.created) {
      console.log(
        `[bot] Auto semifinal backup created (${backup.rows} rows): ${backup.snapshotKey}`,
      );
    }
  } catch (err) {
    console.error("[bot] Sync failed:", err.message);
  } finally {
    running = false;
  }
}

function scheduleNext() {
  const level = getActivityLevel();
  const interval = INTERVALS[level];

  if (interval !== currentInterval) {
    console.log(
      `[bot] Activity level: ${level} → polling every ${interval / 1000}s`,
    );
    currentInterval = interval;
  }

  clearTimeout(timer);
  timer = setTimeout(async () => {
    await tick();
    scheduleNext(); // reschedule after each run so the interval can adapt
  }, interval);
}

function startBot() {
  const enabled =
    String(process.env.ENABLE_BOT || "true").toLowerCase() === "true";
  if (!enabled) {
    console.log("[bot] Disabled via ENABLE_BOT env var.");
    return null;
  }

  console.log("[bot] Starting adaptive sync bot...");

  // If semis are already closed at startup, take one idempotent backup.
  try {
    const backup = autoBackupSemifinalsOnWindowClose();
    if (backup.created) {
      console.log(
        `[bot] Auto semifinal backup created on startup (${backup.rows} rows): ${backup.snapshotKey}`,
      );
    }
  } catch (err) {
    console.error("[bot] Semifinal auto-backup check failed:", err.message);
  }

  // Run an immediate sync on startup, then begin adaptive scheduling
  tick().then(() => scheduleNext());

  return {
    stop() {
      clearTimeout(timer);
      console.log("[bot] Stopped.");
    },
  };
}

module.exports = { startBot };
