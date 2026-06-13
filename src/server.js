require("dotenv").config();

const express = require("express");
const path = require("path");
const { initDb, db } = require("./db");
const { importWorkbook } = require("./importer");
const { getStandings, getLatestMatches, getMatchTimeline } = require("./standings");
const { scorePrediction } = require("./scoring");
const { syncResultsFromApi } = require("./scoreProvider");
const { startBot } = require("./bot");
const { getKnockoutContext, upsertKnockoutPredictions } = require("./knockout");

const app = express();
const port = Number(process.env.PORT || 3000);
const excelFile = process.env.EXCEL_FILE || "Participantes Amigos Mundial 2026.xlsx";
const TEST_PARTICIPANT_NAME = "Knockout Test Participant";

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/meta", (_req, res) => {
  res.json({
    botEnabled: String(process.env.ENABLE_BOT || "true").toLowerCase() === "true",
    botCron: process.env.BOT_CRON || "*/10 * * * *",
  });
});

app.get("/api/standings", (_req, res) => {
  const includeTest = String(_req.query.includeTest || "0") === "1";
  res.json({ standings: getStandings({ includeTest }) });
});

app.get("/api/matches/latest", (req, res) => {
  const limit = Math.min(Number(req.query.limit || 80), 300);
  const daysBack = req.query.daysBack;
  res.json({ matches: getMatchTimeline(daysBack, limit) });
});

app.get("/api/participants", (_req, res) => {
  const participants = db
    .prepare("SELECT id, name, source_col AS sourceCol FROM participants ORDER BY name")
    .all();
  res.json({ participants });
});

app.get("/api/participants/:participantId/predictions", (req, res) => {
  const participantId = Number(req.params.participantId);
  if (!Number.isInteger(participantId)) {
    return res.status(400).json({ ok: false, error: "participantId must be an integer." });
  }

  const participant = db
    .prepare("SELECT id, name FROM participants WHERE id = ?")
    .get(participantId);
  if (!participant) {
    return res.status(404).json({ ok: false, error: "Participant not found." });
  }

  const rows = db
    .prepare(
      `SELECT
        m.id AS matchId,
        m.stage AS stage,
        m.home_team AS homeTeam,
        m.away_team AS awayTeam,
        p.pred_home AS predHome,
        p.pred_away AS predAway,
        r.home_score AS realHome,
        r.away_score AS realAway,
        r.status AS status
      FROM predictions p
      JOIN matches m ON m.id = p.match_id
      LEFT JOIN results r ON r.match_id = p.match_id
      WHERE p.participant_id = ?
      ORDER BY m.row_number ASC`
    )
    .all(participantId);

  const knockoutRows = db
    .prepare(
      `SELECT
        km.round_code AS stage,
        km.home_team AS homeTeam,
        km.away_team AS awayTeam,
        kp.pred_home AS predHome,
        kp.pred_away AS predAway,
        km.home_score AS realHome,
        km.away_score AS realAway,
        km.status AS status
      FROM knockout_predictions kp
      JOIN knockout_matches km ON km.id = kp.knockout_match_id
      WHERE kp.participant_id = ?
      ORDER BY datetime(km.kickoff_utc) ASC`
    )
    .all(participantId);

  let totalPoints = 0;
  let exact = 0;
  let outcomes = 0;

  const predictions = rows.map((row) => {
    const hasResult = Number.isInteger(row.realHome) && Number.isInteger(row.realAway);
    let points = null;
    let exactHit = 0;
    let outcomeHit = 0;

    if (hasResult) {
      const score = scorePrediction(row.predHome, row.predAway, row.realHome, row.realAway);
      points = score.points;
      exactHit = score.exact;
      outcomeHit = score.outcome;
      totalPoints += score.points;
      exact += score.exact;
      outcomes += score.outcome;
    }

    return {
      ...row,
      points,
      exactHit,
      outcomeHit,
    };
  });

  for (const row of knockoutRows) {
    const hasResult = Number.isInteger(row.realHome) && Number.isInteger(row.realAway);
    let points = null;
    let exactHit = 0;
    let outcomeHit = 0;
    if (hasResult) {
      const score = scorePrediction(row.predHome, row.predAway, row.realHome, row.realAway);
      points = score.points;
      exactHit = score.exact;
      outcomeHit = score.outcome;
      totalPoints += score.points;
      exact += score.exact;
      outcomes += score.outcome;
    }
    predictions.push({
      ...row,
      points,
      exactHit,
      outcomeHit,
    });
  }

  return res.json({
    participant,
    summary: {
      totalPoints,
      exact,
      outcomes,
      played: predictions.filter((p) => p.points !== null).length,
    },
    predictions,
  });
});

app.get("/api/knockout/context", (req, res) => {
  const participantIdRaw = req.query.participantId;
  const participantId = participantIdRaw === undefined ? null : Number(participantIdRaw);
  if (participantIdRaw !== undefined && !Number.isInteger(participantId)) {
    return res.status(400).json({ ok: false, error: "participantId must be an integer when provided." });
  }
  return res.json({ ok: true, ...getKnockoutContext(participantId) });
});

app.get("/api/debug/knockout-records", (req, res) => {
  const participantIdRaw = req.query.participantId;
  const participantId = participantIdRaw === undefined ? null : Number(participantIdRaw);
  if (!Number.isInteger(participantId)) {
    return res.status(400).json({ ok: false, error: "participantId must be an integer." });
  }

  const participant = db
    .prepare("SELECT id, name FROM participants WHERE id = ?")
    .get(participantId);
  if (!participant) {
    return res.status(404).json({ ok: false, error: "Participant not found." });
  }

  const locks = db
    .prepare(
      `SELECT round_code AS roundCode, locked_at AS lockedAt
       FROM knockout_submission_locks
       WHERE participant_id = ?
       ORDER BY datetime(locked_at) DESC`
    )
    .all(participantId);

  const predictions = db
    .prepare(
      `SELECT
        kp.participant_id AS participantId,
        km.round_code AS roundCode,
        km.id AS matchId,
        km.home_team AS homeTeam,
        km.away_team AS awayTeam,
        kp.pred_home AS predHome,
        kp.pred_away AS predAway,
        kp.submitted_at AS submittedAt
       FROM knockout_predictions kp
       JOIN knockout_matches km ON km.id = kp.knockout_match_id
       WHERE kp.participant_id = ?
       ORDER BY km.round_code, datetime(km.kickoff_utc) ASC`
    )
    .all(participantId);

  return res.json({ ok: true, participant, locks, predictions });
});

app.post("/api/knockout/predictions", (req, res) => {
  const { participantId, roundCode, predictions } = req.body || {};
  if (!Number.isInteger(participantId)) {
    return res.status(400).json({ ok: false, error: "participantId must be an integer." });
  }
  if (typeof roundCode !== "string" || roundCode.trim() === "") {
    return res.status(400).json({ ok: false, error: "roundCode is required." });
  }
  if (!Array.isArray(predictions) || predictions.length === 0) {
    return res.status(400).json({ ok: false, error: "predictions must be a non-empty array." });
  }
  const participant = db.prepare("SELECT id FROM participants WHERE id = ?").get(participantId);
  if (!participant) {
    return res.status(404).json({ ok: false, error: "Participant not found." });
  }

  try {
    const summary = upsertKnockoutPredictions(participantId, roundCode, predictions);
    return res.json({ ok: true, summary });
  } catch (err) {
    const message = String(err.message || "");
    if (message.includes("closed") || message.includes("already submitted")) {
      return res.status(403).json({ ok: false, error: err.message });
    }
    return res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/import", (_req, res) => {
  try {
    const summary = importWorkbook(excelFile);
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/scores/sync", async (_req, res) => {
  try {
    const summary = await syncResultsFromApi();
    res.json({ ok: true, summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/results/manual", (req, res) => {
  const { matchId, homeScore, awayScore, status = "finished" } = req.body || {};
  if (!Number.isInteger(matchId) || !Number.isInteger(homeScore) || !Number.isInteger(awayScore)) {
    return res.status(400).json({ ok: false, error: "matchId, homeScore, awayScore must be integers." });
  }

  const exists = db.prepare("SELECT id FROM matches WHERE id = ?").get(matchId);
  if (!exists) {
    return res.status(404).json({ ok: false, error: "Match not found." });
  }

  db.prepare(
    `INSERT INTO results (match_id, home_score, away_score, status, source, updated_at)
     VALUES (?, ?, ?, ?, 'manual', CURRENT_TIMESTAMP)
     ON CONFLICT(match_id) DO UPDATE SET
       home_score = excluded.home_score,
       away_score = excluded.away_score,
       status = excluded.status,
       source = 'manual',
       updated_at = CURRENT_TIMESTAMP`
  ).run(matchId, homeScore, awayScore, status);

  return   res.json({ ok: true });
});

app.get("/test-participant", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

function boot() {
  initDb();
  db.prepare("INSERT OR IGNORE INTO participants (name, source_col) VALUES (?, ?)")
    .run(TEST_PARTICIPANT_NAME, -999);

  const autoImport = String(process.env.ENABLE_AUTO_IMPORT || "true").toLowerCase() === "true";
  if (autoImport) {
    try {
      const existingMatches = db.prepare("SELECT COUNT(*) AS count FROM matches").get().count;
      if (existingMatches === 0) {
        const summary = importWorkbook(excelFile);
        console.log("Imported workbook:", summary);
      } else {
        console.log("Skipped auto-import: existing data found.");
      }
    } catch (err) {
      console.error("Import failed:", err.message);
    }
  }

  startBot();
  app.listen(port, () => {
    console.log(`Prediction pool app running at http://localhost:${port}`);
  });
}

boot();
