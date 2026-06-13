const cron = require("node-cron");
const { syncResultsFromApi } = require("./scoreProvider");

function startBot() {
  const enabled = String(process.env.ENABLE_BOT || "true").toLowerCase() === "true";
  if (!enabled) return null;

  const schedule = process.env.BOT_CRON || "*/10 * * * *";
  const task = cron.schedule(schedule, async () => {
    try {
      await syncResultsFromApi();
    } catch (err) {
      console.error("Bot sync failed:", err.message);
    }
  });
  task.start();
  return task;
}

module.exports = { startBot };
