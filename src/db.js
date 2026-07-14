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

    CREATE TABLE IF NOT EXISTS knockout_prediction_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      participant_id INTEGER NOT NULL,
      knockout_match_id INTEGER NOT NULL,
      pred_home INTEGER,
      pred_away INTEGER,
      submitted_at TEXT,
      round_code TEXT,
      home_team TEXT,
      away_team TEXT,
      backup_reason TEXT NOT NULL DEFAULT 'trigger',
      backed_up_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS semifinal_prediction_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_key TEXT NOT NULL,
      snapshot_reason TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      participant_id INTEGER,
      participant_name TEXT,
      knockout_match_id INTEGER,
      home_team TEXT,
      away_team TEXT,
      pred_home INTEGER,
      pred_away INTEGER,
      submitted_at TEXT,
      locked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_backup_round_time
      ON knockout_prediction_backups (round_code, backed_up_at);

    CREATE INDEX IF NOT EXISTS idx_semis_snapshot_key
      ON semifinal_prediction_snapshots (snapshot_key);

    CREATE TRIGGER IF NOT EXISTS trg_backup_semis_prediction_insert
    AFTER INSERT ON knockout_predictions
    WHEN (SELECT round_code FROM knockout_matches WHERE id = NEW.knockout_match_id) = 'SEMI_FINALS'
    BEGIN
      INSERT INTO knockout_prediction_backups (
        action,
        participant_id,
        knockout_match_id,
        pred_home,
        pred_away,
        submitted_at,
        round_code,
        home_team,
        away_team,
        backup_reason,
        backed_up_at
      )
      VALUES (
        'insert',
        NEW.participant_id,
        NEW.knockout_match_id,
        NEW.pred_home,
        NEW.pred_away,
        NEW.submitted_at,
        (SELECT round_code FROM knockout_matches WHERE id = NEW.knockout_match_id),
        (SELECT home_team FROM knockout_matches WHERE id = NEW.knockout_match_id),
        (SELECT away_team FROM knockout_matches WHERE id = NEW.knockout_match_id),
        'trigger',
        CURRENT_TIMESTAMP
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_backup_semis_prediction_update
    AFTER UPDATE ON knockout_predictions
    WHEN (SELECT round_code FROM knockout_matches WHERE id = NEW.knockout_match_id) = 'SEMI_FINALS'
    BEGIN
      INSERT INTO knockout_prediction_backups (
        action,
        participant_id,
        knockout_match_id,
        pred_home,
        pred_away,
        submitted_at,
        round_code,
        home_team,
        away_team,
        backup_reason,
        backed_up_at
      )
      VALUES (
        'update_before',
        OLD.participant_id,
        OLD.knockout_match_id,
        OLD.pred_home,
        OLD.pred_away,
        OLD.submitted_at,
        (SELECT round_code FROM knockout_matches WHERE id = OLD.knockout_match_id),
        (SELECT home_team FROM knockout_matches WHERE id = OLD.knockout_match_id),
        (SELECT away_team FROM knockout_matches WHERE id = OLD.knockout_match_id),
        'trigger',
        CURRENT_TIMESTAMP
      );

      INSERT INTO knockout_prediction_backups (
        action,
        participant_id,
        knockout_match_id,
        pred_home,
        pred_away,
        submitted_at,
        round_code,
        home_team,
        away_team,
        backup_reason,
        backed_up_at
      )
      VALUES (
        'update_after',
        NEW.participant_id,
        NEW.knockout_match_id,
        NEW.pred_home,
        NEW.pred_away,
        NEW.submitted_at,
        (SELECT round_code FROM knockout_matches WHERE id = NEW.knockout_match_id),
        (SELECT home_team FROM knockout_matches WHERE id = NEW.knockout_match_id),
        (SELECT away_team FROM knockout_matches WHERE id = NEW.knockout_match_id),
        'trigger',
        CURRENT_TIMESTAMP
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_backup_semis_prediction_delete
    BEFORE DELETE ON knockout_predictions
    WHEN (SELECT round_code FROM knockout_matches WHERE id = OLD.knockout_match_id) = 'SEMI_FINALS'
    BEGIN
      INSERT INTO knockout_prediction_backups (
        action,
        participant_id,
        knockout_match_id,
        pred_home,
        pred_away,
        submitted_at,
        round_code,
        home_team,
        away_team,
        backup_reason,
        backed_up_at
      )
      VALUES (
        'delete',
        OLD.participant_id,
        OLD.knockout_match_id,
        OLD.pred_home,
        OLD.pred_away,
        OLD.submitted_at,
        (SELECT round_code FROM knockout_matches WHERE id = OLD.knockout_match_id),
        (SELECT home_team FROM knockout_matches WHERE id = OLD.knockout_match_id),
        (SELECT away_team FROM knockout_matches WHERE id = OLD.knockout_match_id),
        'trigger',
        CURRENT_TIMESTAMP
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_backup_semis_lock_insert
    AFTER INSERT ON knockout_submission_locks
    WHEN NEW.round_code = 'SEMI_FINALS'
    BEGIN
      INSERT INTO semifinal_prediction_snapshots (
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
        'lock:' || NEW.participant_id || ':' || strftime('%Y%m%d%H%M%S', 'now'),
        'lock_insert',
        CURRENT_TIMESTAMP,
        kp.participant_id,
        p.name,
        kp.knockout_match_id,
        km.home_team,
        km.away_team,
        kp.pred_home,
        kp.pred_away,
        kp.submitted_at,
        NEW.locked_at
      FROM knockout_predictions kp
      JOIN knockout_matches km ON km.id = kp.knockout_match_id
      LEFT JOIN participants p ON p.id = kp.participant_id
      WHERE kp.participant_id = NEW.participant_id
        AND km.round_code = 'SEMI_FINALS';
    END;
  `);

  migrateResultsTableIfNeeded();
  migrateResultsPenaltyColumnsIfNeeded();
}

module.exports = { db, initDb };
