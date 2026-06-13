require("dotenv").config();
const { initDb } = require("../db");
const { syncResultsFromApi } = require("../scoreProvider");

async function run() {
  initDb();
  const result = await syncResultsFromApi();
  console.log("Sync complete:", result);
}

run().catch((err) => {
  console.error("Sync failed:", err.message);
  process.exit(1);
});
