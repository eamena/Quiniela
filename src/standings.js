const { db } = require("./db");
const { scorePrediction } = require("./scoring");
const { applyKnockoutScoring } = require("./knockout");

function getStandings({ includeTest = false } = {}) {
  const participants = db
    .prepare(
      "SELECT id, name, source_col AS sourceCol FROM participants ORDER BY name",
    )
    .all();

  const finishedPredictions = db
    .prepare(
      `SELECT
        p.participant_id AS participant_id,
        p.pred_home AS pred_home,
        p.pred_away AS pred_away,
        r.home_score AS real_home,
        r.away_score AS real_away
      FROM predictions p
      JOIN results r ON r.match_id = p.match_id
      WHERE r.status = 'finished'`,
    )
    .all();

  const statsByParticipant = new Map(
    participants.map((p) => [
      p.id,
      {
        participantId: p.id,
        participant: p.name,
        sourceCol: p.sourceCol,
        points: 0,
        exact: 0,
        outcomes: 0,
        played: 0,
      },
    ]),
  );

  for (const row of finishedPredictions) {
    const stats = statsByParticipant.get(row.participant_id);
    if (!stats) continue;
    const result = scorePrediction(
      row.pred_home,
      row.pred_away,
      row.real_home,
      row.real_away,
    );
    stats.points += result.points;
    stats.exact += result.exact;
    stats.outcomes += result.outcome;
    stats.played += 1;
  }

  applyKnockoutScoring(statsByParticipant);

  const rows = Array.from(statsByParticipant.values()).filter(
    (row) => includeTest || row.sourceCol !== -999,
  );

  return rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.exact !== a.exact) return b.exact - a.exact;
    return b.outcomes - a.outcomes;
  });
}

function getLatestMatches(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 200));
  return db
    .prepare(
      `SELECT * FROM (
        SELECT
          m.id,
          m.stage,
          m.home_team AS homeTeam,
          m.away_team AS awayTeam,
          r.home_score AS homeScore,
          r.away_score AS awayScore,
          r.pen_home AS penHome,
          r.pen_away AS penAway,
          r.status,
          r.source,
          r.kickoff_utc AS kickoffUtc,
          r.updated_at AS updatedAt
        FROM matches m
        LEFT JOIN results r ON r.match_id = m.id

        UNION ALL

        SELECT
          km.id * -1 AS id,
          CASE km.round_code
            WHEN 'QUARTER_FINALS' THEN 'Cuartos de final'
            WHEN 'SEMI_FINALS'    THEN 'Semifinales'
            WHEN 'FINAL'          THEN 'Final'
          END AS stage,
          km.home_team AS homeTeam,
          km.away_team AS awayTeam,
          km.home_score AS homeScore,
          km.away_score AS awayScore,
          NULL AS penHome,
          NULL AS penAway,
          km.status,
          km.source,
          km.kickoff_utc AS kickoffUtc,
          km.updated_at AS updatedAt
        FROM knockout_matches km
        WHERE km.round_code IN ('QUARTER_FINALS', 'SEMI_FINALS', 'FINAL')
      )
      ORDER BY
        CASE WHEN kickoffUtc IS NULL THEN 1 ELSE 0 END,
        datetime(kickoffUtc) ASC
      LIMIT ?`,
    )
    .all(safeLimit);
}

function getMatchTimeline(daysBack = null, limit = 80) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 80, 300));
  const rows = getLatestMatches(300);
  if (daysBack === null || daysBack === undefined || daysBack === "") {
    return rows.slice(0, safeLimit);
  }

  const parsedDaysBack = Number(daysBack);
  if (!Number.isFinite(parsedDaysBack) || parsedDaysBack < 0) {
    return rows.slice(0, safeLimit);
  }

  const safeDaysBack = Math.min(parsedDaysBack, 7);
  const cutoffMs = Date.now() - safeDaysBack * 24 * 60 * 60 * 1000;

  const filtered = rows.filter((row) => {
    if (!row.kickoffUtc) return false;
    const kickoffMs = Date.parse(row.kickoffUtc);
    return Number.isFinite(kickoffMs) && kickoffMs >= cutoffMs;
  });

  return filtered.slice(0, safeLimit);
}

module.exports = { getStandings, getLatestMatches, getMatchTimeline };
