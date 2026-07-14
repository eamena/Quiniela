require("dotenv").config();
const { initDb, db } = require("../db");
const { backupSemifinalSnapshot } = require("../knockout");

initDb();

const reason = process.env.BACKUP_REASON || "manual_cli";
const result = backupSemifinalSnapshot(reason);

const stats = db
  .prepare(
    `SELECT
      COUNT(*) AS totalRows,
      COUNT(DISTINCT participant_id) AS participants
     FROM semifinal_prediction_snapshots
     WHERE snapshot_key = ?
       AND participant_id IS NOT NULL`,
  )
  .get(result.snapshotKey);

console.log("Semifinal backup created:", {
  snapshotKey: result.snapshotKey,
  copiedRows: stats?.totalRows || 0,
  participants: stats?.participants || 0,
});
