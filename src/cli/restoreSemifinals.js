require("dotenv").config();
const { initDb, db } = require("../db");

initDb();

const snapshotKeyArg = process.env.SNAPSHOT_KEY || null;

function getLatestSnapshotKey() {
  const row = db
    .prepare(
      `SELECT snapshot_key AS snapshotKey
       FROM semifinal_prediction_snapshots
       WHERE participant_id IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get();
  return row?.snapshotKey || null;
}

const snapshotKey = snapshotKeyArg || getLatestSnapshotKey();
if (!snapshotKey) {
  throw new Error("No semifinal snapshot found to restore.");
}

const rows = db
  .prepare(
    `SELECT
      participant_id AS participantId,
      knockout_match_id AS knockoutMatchId,
      pred_home AS predHome,
      pred_away AS predAway,
      locked_at AS lockedAt
     FROM semifinal_prediction_snapshots
     WHERE snapshot_key = ?
       AND participant_id IS NOT NULL
       AND knockout_match_id IS NOT NULL`,
  )
  .all(snapshotKey);

if (!rows.length) {
  throw new Error(`Snapshot ${snapshotKey} has no semifinal prediction rows.`);
}

const upsertPrediction = db.prepare(
  `INSERT INTO knockout_predictions (participant_id, knockout_match_id, pred_home, pred_away, submitted_at)
   VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
   ON CONFLICT(participant_id, knockout_match_id) DO UPDATE SET
     pred_home = excluded.pred_home,
     pred_away = excluded.pred_away,
     submitted_at = CURRENT_TIMESTAMP`,
);

const upsertLock = db.prepare(
  `INSERT INTO knockout_submission_locks (participant_id, round_code, locked_at)
   VALUES (?, 'SEMI_FINALS', COALESCE(?, CURRENT_TIMESTAMP))
   ON CONFLICT(participant_id, round_code) DO UPDATE SET
     locked_at = COALESCE(excluded.locked_at, knockout_submission_locks.locked_at)`,
);

let restoredPredictions = 0;
let restoredLocks = 0;
const participantLockMap = new Map();

const tx = db.transaction(() => {
  for (const row of rows) {
    restoredPredictions += upsertPrediction.run(
      row.participantId,
      row.knockoutMatchId,
      row.predHome,
      row.predAway,
    ).changes;

    if (!participantLockMap.has(row.participantId)) {
      participantLockMap.set(row.participantId, row.lockedAt || null);
    }
  }

  for (const [participantId, lockedAt] of participantLockMap.entries()) {
    restoredLocks += upsertLock.run(participantId, lockedAt).changes;
  }
});

tx();

console.log("Semifinal restore complete:", {
  snapshotKey,
  rowsInSnapshot: rows.length,
  restoredPredictions,
  restoredLocks,
});
