const { db } = require("./db");
const { scorePrediction } = require("./scoring");

const ROUND_ORDER = [
  "LAST_32",
  "LAST_16",
  "QUARTER_FINALS",
  "SEMI_FINALS",
  "FINAL",
];

function backupSemifinalSnapshot(reason = "manual") {
  const snapshotKey = `${reason}:${Date.now()}`;
  const insert = db.prepare(
    `INSERT INTO semifinal_prediction_snapshots (
      snapshot_key,
      snapshot_reason,
      captured_at,
      participant_id,
      participant_name,
      knockout_match_id,
      home_team,
      away_team,
      pred_home,
      pred_away,
      submitted_at,
      locked_at
    )
    SELECT
      ?,
      ?,
      CURRENT_TIMESTAMP,
      kp.participant_id,
      p.name,
      kp.knockout_match_id,
      km.home_team,
      km.away_team,
      kp.pred_home,
      kp.pred_away,
      kp.submitted_at,
      ksl.locked_at
    FROM knockout_predictions kp
    JOIN knockout_matches km ON km.id = kp.knockout_match_id
    LEFT JOIN participants p ON p.id = kp.participant_id
    LEFT JOIN knockout_submission_locks ksl
      ON ksl.participant_id = kp.participant_id
     AND ksl.round_code = 'SEMI_FINALS'
    WHERE km.round_code = 'SEMI_FINALS'`,
  );

  const metaInsert = db.prepare(
    `INSERT INTO semifinal_prediction_snapshots (
      snapshot_key,
      snapshot_reason,
      captured_at,
      participant_id,
      participant_name,
      knockout_match_id,
      home_team,
      away_team,
      pred_home,
      pred_away,
      submitted_at,
      locked_at
    )
    VALUES (?, ?, CURRENT_TIMESTAMP, NULL, '__meta__', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
  );

  const tx = db.transaction(() => {
    const result = insert.run(snapshotKey, reason);
    if ((result.changes || 0) === 0) {
      metaInsert.run(snapshotKey, `${reason}:empty`);
    }
    return result.changes || 0;
  });

  const rows = tx();
  return { snapshotKey, rows };
}

function autoBackupSemifinalsOnWindowClose(nowMs = Date.now()) {
  const window = db
    .prepare(
      `SELECT
        round_code AS roundCode,
        close_at AS closeAt
       FROM round_windows
       WHERE round_code = 'SEMI_FINALS'`,
    )
    .get();

  if (!window?.closeAt) {
    return { created: false, reason: "missing_window" };
  }

  const closeMs = Date.parse(window.closeAt);
  if (!Number.isFinite(closeMs)) {
    return { created: false, reason: "invalid_close_at" };
  }

  if (nowMs < closeMs) {
    return { created: false, reason: "window_open" };
  }

  const backupReason = `auto_close:${window.closeAt}`;
  const existing = db
    .prepare(
      `SELECT id
       FROM semifinal_prediction_snapshots
       WHERE snapshot_reason = ?
          OR snapshot_reason = ?
       LIMIT 1`,
    )
    .get(backupReason, `${backupReason}:empty`);

  if (existing) {
    return { created: false, reason: "already_backed_up" };
  }

  const snapshot = backupSemifinalSnapshot(backupReason);
  return {
    created: true,
    reason: backupReason,
    snapshotKey: snapshot.snapshotKey,
    rows: snapshot.rows,
  };
}

function toIsoDate(date) {
  return new Date(date).toISOString();
}

function computeWindowState(window, nowMs) {
  const openMs = Date.parse(window.openAt);
  const closeMs = Date.parse(window.closeAt);
  const bannerStartMs = Date.parse(window.bannerStartAt);
  const isOpen = nowMs >= openMs && nowMs < closeMs;
  const isUpcoming = nowMs < openMs;
  const showBanner = nowMs >= bannerStartMs && nowMs < closeMs;
  return {
    ...window,
    isOpen,
    isUpcoming,
    isClosed: nowMs >= closeMs,
    showBanner,
  };
}

function getRoundWindows() {
  return db
    .prepare(
      `SELECT
        round_code AS roundCode,
        prev_round_code AS prevRoundCode,
        open_at AS openAt,
        close_at AS closeAt,
        banner_start_at AS bannerStartAt
      FROM round_windows
      ORDER BY CASE round_code
        WHEN 'LAST_32' THEN 1
        WHEN 'LAST_16' THEN 2
        WHEN 'QUARTER_FINALS' THEN 3
        WHEN 'SEMI_FINALS' THEN 4
        WHEN 'FINAL' THEN 5
        ELSE 999 END`,
    )
    .all();
}

function getRoundMatches(roundCode) {
  return db
    .prepare(
      `SELECT
        id,
        round_code AS roundCode,
        home_team AS homeTeam,
        away_team AS awayTeam,
        kickoff_utc AS kickoffUtc,
        status,
        home_score AS homeScore,
        away_score AS awayScore
      FROM knockout_matches
      WHERE round_code = ?
      ORDER BY datetime(kickoff_utc) ASC`,
    )
    .all(roundCode);
}

function getParticipantKnockoutPredictions(participantId, roundCode) {
  return db
    .prepare(
      `SELECT
        kp.knockout_match_id AS matchId,
        kp.pred_home AS predHome,
        kp.pred_away AS predAway
      FROM knockout_predictions kp
      JOIN knockout_matches km ON km.id = kp.knockout_match_id
      WHERE kp.participant_id = ? AND km.round_code = ?`,
    )
    .all(participantId, roundCode);
}

function getSubmissionLock(participantId, roundCode) {
  return db
    .prepare(
      `SELECT
        participant_id AS participantId,
        round_code AS roundCode,
        locked_at AS lockedAt
      FROM knockout_submission_locks
      WHERE participant_id = ? AND round_code = ?`,
    )
    .get(participantId, roundCode);
}

function isTestParticipant(participantId) {
  const participant = db
    .prepare(
      `SELECT source_col AS sourceCol
       FROM participants
       WHERE id = ?`,
    )
    .get(participantId);
  return participant?.sourceCol === -999;
}

function getKnockoutContext(participantId) {
  const nowMs = Date.now();
  const testParticipant = participantId
    ? isTestParticipant(participantId)
    : false;
  const windows = getRoundWindows().map((w) => computeWindowState(w, nowMs));
  const openWindow = windows.find((w) => w.isOpen);
  const upcomingWindow = windows.find((w) => w.isUpcoming);
  const focusRound =
    openWindow?.roundCode ||
    upcomingWindow?.roundCode ||
    windows[0]?.roundCode ||
    null;
  const matches = focusRound ? getRoundMatches(focusRound) : [];
  const predictions =
    participantId && focusRound
      ? getParticipantKnockoutPredictions(participantId, focusRound)
      : [];
  const lock =
    participantId && focusRound
      ? getSubmissionLock(participantId, focusRound)
      : null;
  const bannerWindow = windows.find((w) => w.showBanner);

  return {
    windows,
    focusRound,
    openRound: openWindow?.roundCode || null,
    canEdit: Boolean(
      (testParticipant ||
        (openWindow && openWindow.roundCode === focusRound)) &&
      !lock,
    ),
    hasSubmitted: Boolean(lock),
    lockedAt: lock?.lockedAt || null,
    isTestParticipant: testParticipant,
    banner: bannerWindow
      ? {
          roundCode: bannerWindow.roundCode,
          opensAt: bannerWindow.openAt,
          closesAt: bannerWindow.closeAt,
          isOpen: bannerWindow.isOpen,
        }
      : null,
    matches,
    predictions,
  };
}

function upsertKnockoutPredictions(participantId, roundCode, predictions) {
  const testParticipant = isTestParticipant(participantId);
  const window = db
    .prepare(
      `SELECT
        round_code AS roundCode,
        open_at AS openAt,
        close_at AS closeAt
      FROM round_windows
      WHERE round_code = ?`,
    )
    .get(roundCode);
  if (!window) {
    throw new Error("Round window is not available yet.");
  }

  const nowMs = Date.now();
  const openMs = Date.parse(window.openAt);
  const closeMs = Date.parse(window.closeAt);
  if (!testParticipant && !(nowMs >= openMs && nowMs < closeMs)) {
    throw new Error("Prediction window for this round is closed.");
  }

  const existingLock = getSubmissionLock(participantId, roundCode);
  if (existingLock) {
    throw new Error("You already submitted this round and cannot change it.");
  }

  const allowedMatches = db
    .prepare(
      testParticipant
        ? `SELECT id
           FROM knockout_matches
           WHERE round_code = ?`
        : `SELECT id
           FROM knockout_matches
           WHERE round_code = ?
             AND home_team IS NOT NULL
             AND away_team IS NOT NULL
             AND home_team != 'TBD'
             AND away_team != 'TBD'`,
    )
    .all(roundCode)
    .map((m) => m.id);
  const allowedSet = new Set(allowedMatches);
  if (!allowedMatches.length) {
    throw new Error("There are no editable matches in this round yet.");
  }

  const receivedByMatch = new Map();
  for (const item of predictions) {
    if (
      !Number.isInteger(item.matchId) ||
      !Number.isInteger(item.predHome) ||
      !Number.isInteger(item.predAway) ||
      item.predHome < 0 ||
      item.predAway < 0
    ) {
      throw new Error(
        "Each prediction must include non-negative integer values.",
      );
    }
    if (!allowedSet.has(item.matchId)) {
      throw new Error(
        "Prediction includes a match outside the editable round.",
      );
    }
    if (receivedByMatch.has(item.matchId)) {
      throw new Error(
        "Duplicate predictions were provided for the same match.",
      );
    }
    receivedByMatch.set(item.matchId, item);
  }

  if (receivedByMatch.size !== allowedMatches.length) {
    throw new Error(
      "You must enter a score prediction for every match in this round.",
    );
  }

  const upsert = db.prepare(
    `INSERT INTO knockout_predictions (participant_id, knockout_match_id, pred_home, pred_away, submitted_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(participant_id, knockout_match_id) DO UPDATE SET
       pred_home = excluded.pred_home,
       pred_away = excluded.pred_away,
       submitted_at = CURRENT_TIMESTAMP`,
  );
  const lockInsert = db.prepare(
    `INSERT INTO knockout_submission_locks (participant_id, round_code, locked_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`,
  );

  let saved = 0;
  const tx = db.transaction(() => {
    if (roundCode === "SEMI_FINALS") {
      backupSemifinalSnapshot(`pre_submit:p${participantId}`);
    }

    for (const item of receivedByMatch.values()) {
      saved += upsert.run(
        participantId,
        item.matchId,
        item.predHome,
        item.predAway,
      ).changes;
    }
    lockInsert.run(participantId, roundCode);

    if (roundCode === "SEMI_FINALS") {
      backupSemifinalSnapshot(`post_submit:p${participantId}`);
    }
  });
  tx();
  return { saved };
}

function getKnockoutScoringRows() {
  return db
    .prepare(
      `SELECT
        kp.participant_id AS participant_id,
        kp.pred_home AS pred_home,
        kp.pred_away AS pred_away,
        km.home_score AS real_home,
        km.away_score AS real_away
      FROM knockout_predictions kp
      JOIN knockout_matches km ON km.id = kp.knockout_match_id
      WHERE km.status = 'finished'
        AND km.home_score IS NOT NULL
        AND km.away_score IS NOT NULL`,
    )
    .all();
}

function applyKnockoutScoring(statsByParticipant) {
  const rows = getKnockoutScoringRows();
  for (const row of rows) {
    const stats = statsByParticipant.get(row.participant_id);
    if (!stats) continue;
    const s = scorePrediction(
      row.pred_home,
      row.pred_away,
      row.real_home,
      row.real_away,
    );
    stats.points += s.points;
    stats.exact += s.exact;
    stats.outcomes += s.outcome;
    stats.played += 1;
  }
}

function computeAndStoreRoundWindows() {
  const getFirstKickoff = db.prepare(
    `SELECT kickoff_utc AS kickoffUtc
     FROM knockout_matches
     WHERE round_code = ?
     ORDER BY datetime(kickoff_utc) ASC
     LIMIT 1`,
  );
  const getLastKickoff = db.prepare(
    `SELECT kickoff_utc AS kickoffUtc
     FROM knockout_matches
     WHERE round_code = ?
     ORDER BY datetime(kickoff_utc) DESC
     LIMIT 1`,
  );

  const getLastGroupKickoff = db.prepare(
    `SELECT kickoff_utc AS kickoffUtc
     FROM results r
     JOIN matches m ON m.id = r.match_id
     WHERE m.stage LIKE 'Grupo %'
       AND r.kickoff_utc IS NOT NULL
     ORDER BY datetime(r.kickoff_utc) DESC
     LIMIT 1`,
  );

  const upsert = db.prepare(
    `INSERT INTO round_windows (round_code, prev_round_code, open_at, close_at, banner_start_at, computed_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(round_code) DO UPDATE SET
       prev_round_code = excluded.prev_round_code,
       open_at = excluded.open_at,
       close_at = excluded.close_at,
       banner_start_at = excluded.banner_start_at,
       computed_at = CURRENT_TIMESTAMP`,
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < ROUND_ORDER.length; i += 1) {
      const round = ROUND_ORDER[i];
      const prevRound = i === 0 ? null : ROUND_ORDER[i - 1];
      const first = getFirstKickoff.get(round);
      if (!first?.kickoffUtc) continue;

      let prevLastKickoffUtc = null;
      if (prevRound) {
        prevLastKickoffUtc = getLastKickoff.get(prevRound)?.kickoffUtc || null;
      } else {
        prevLastKickoffUtc = getLastGroupKickoff.get()?.kickoffUtc || null;
      }
      if (!prevLastKickoffUtc) continue;

      const openAt = toIsoDate(
        Date.parse(prevLastKickoffUtc) + 2 * 60 * 60 * 1000,
      );
      const closeAt = toIsoDate(first.kickoffUtc);
      if (Date.parse(openAt) >= Date.parse(closeAt)) continue;
      const bannerStartAt = toIsoDate(Date.parse(openAt) - 24 * 60 * 60 * 1000);
      upsert.run(round, prevRound, openAt, closeAt, bannerStartAt);
    }
  });
  tx();
}

module.exports = {
  ROUND_ORDER,
  autoBackupSemifinalsOnWindowClose,
  backupSemifinalSnapshot,
  getKnockoutContext,
  upsertKnockoutPredictions,
  applyKnockoutScoring,
  computeAndStoreRoundWindows,
};
