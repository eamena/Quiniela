const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(process.cwd(), "data.db");
const db = new Database(dbPath);

function migrateResultsPenaltyColumnsIfNeeded() {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'results'",
    )
    .get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info(results)").all();
  if (!columns.some((c) => c.name === "pen_home")) {
    db.exec("ALTER TABLE results ADD COLUMN pen_home INTEGER");
  }
  if (!columns.some((c) => c.name === "pen_away")) {
    db.exec("ALTER TABLE results ADD COLUMN pen_away INTEGER");
  }
}

function migrateResultsTableIfNeeded() {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'results'",
    )
    .get();
  if (!table) return;

  const columns = db.prepare("PRAGMA table_info(results)").all();
  const hasKickoffUtc = columns.some((c) => c.name === "kickoff_utc");
  const homeScore = columns.find((c) => c.name === "home_score");
  const awayScore = columns.find((c) => c.name === "away_score");
  const needsNullableScores =
    homeScore?.notnull === 1 || awayScore?.notnull === 1;
  if (!needsNullableScores && hasKickoffUtc) return;

  db.exec(`
    BEGIN TRANSACTION;
    ALTER TABLE results RENAME TO results_old;
    CREATE TABLE results (
      match_id INTEGER PRIMARY KEY,
      home_score INTEGER,
      away_score INTEGER,
      status TEXT NOT NULL DEFAULT 'scheduled',
      source TEXT NOT NULL DEFAULT 'manual',
      kickoff_utc TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
    );
    INSERT INTO results (match_id, home_score, away_score, status, source, updated_at)
    SELECT match_id, home_score, away_score, status, source, updated_at
    FROM results_old;
    DROP TABLE results_old;
    COMMIT;
  `);
}

function initDb() {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      source_col INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_number INTEGER NOT NULL UNIQUE,
      stage TEXT,
      home_team_id INTEGER NOT NULL,
      home_team TEXT NOT NULL,
      away_team_id INTEGER NOT NULL,
      away_team TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL,
      match_id INTEGER NOT NULL,
      pred_home INTEGER NOT NULL,
      pred_away INTEGER NOT NULL,
      UNIQUE (participant_id, match_id),
      FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS results (
      match_id INTEGER PRIMARY KEY,
      home_score INTEGER,
      away_score INTEGER,
      pen_home INTEGER,
      pen_away INTEGER,
      status TEXT NOT NULL DEFAULT 'scheduled',
      source TEXT NOT NULL DEFAULT 'manual',
      kickoff_utc TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS knockout_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_match_id INTEGER NOT NULL UNIQUE,
      round_code TEXT NOT NULL,
      home_team TEXT,
      away_team TEXT,
      kickoff_utc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      home_score INTEGER,
      away_score INTEGER,
      source TEXT NOT NULL DEFAULT 'football-data',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knockout_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant_id INTEGER NOT NULL,
      knockout_match_id INTEGER NOT NULL,
      pred_home INTEGER NOT NULL,
      pred_away INTEGER NOT NULL,
      submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (participant_id, knockout_match_id),
      FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
      FOREIGN KEY (knockout_match_id) REFERENCES knockout_matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS round_windows (
      round_code TEXT PRIMARY KEY,
      prev_round_code TEXT,
      open_at TEXT NOT NULL,
      close_at TEXT NOT NULL,
      banner_start_at TEXT NOT NULL,
      computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS knockout_submission_locks (
      participant_id INTEGER NOT NULL,
      round_code TEXT NOT NULL,
      locked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (participant_id, round_code),
      FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
    );
  `);

  migrateResultsTableIfNeeded();
  migrateResultsPenaltyColumnsIfNeeded();
}

module.exports = { db, initDb };
