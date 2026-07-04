require("dotenv").config();
const path = require("path");
const XLSX = require("xlsx");
const { initDb, db } = require("../db");

// Each participant block in the 8avos spreadsheet is 5 columns wide:
//   col+0 = home team, col+1 = away team, col+2 = pred_home, col+3 = pred_away, col+4 = empty
const PARTICIPANT_BLOCK_SIZE = 5;

// Offset above octavos (20000) so 8avos matches never conflict with earlier bracket rows
const MATCH_ROW_OFFSET = 30000;

function toInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function import8avos(filePath) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  const workbook = XLSX.readFile(absolutePath, { cellDates: false, raw: true });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("No worksheet found in workbook.");

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
    header: 1,
    defval: null,
    raw: true,
  });

  // Row 4 (index 3, 0-based) holds participant names at the start of each block.
  // Scan all columns to handle any column-alignment variations.
  const nameRow = rows[3] || [];
  const participants = [];
  for (let col = 0; col < nameRow.length; col++) {
    const name = nameRow[col];
    if (name && String(name).trim()) {
      participants.push({ name: String(name).trim(), colIndex: col });
    }
  }

  if (!participants.length)
    throw new Error("No participants found in 8avos.xlsx.");

  // Match each participant name against existing DB participants.
  // Strategy: exact match → normalized (accent-stripped, lowercase) match → aliases.
  const NAME_ALIASES = {
    "america cortes": "acg",
  };

  const allParticipants = db
    .prepare("SELECT id, name FROM participants WHERE source_col != -999")
    .all();

  function normalizeName(n) {
    return String(n || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  const byExactName = new Map(allParticipants.map((p) => [p.name, p.id]));
  const byNormalizedName = new Map(
    allParticipants.map((p) => [normalizeName(p.name), p.id]),
  );

  const missing = [];
  for (const p of participants) {
    const exactId = byExactName.get(p.name);
    if (exactId !== undefined) {
      p.id = exactId;
    } else {
      const normalized = normalizeName(p.name);
      const aliasedNorm = NAME_ALIASES[normalized] || normalized;
      const normId = byNormalizedName.get(aliasedNorm);
      if (normId !== undefined) {
        p.id = normId;
      } else {
        missing.push(p.name);
        p.id = null;
      }
    }
  }

  if (missing.length) {
    console.warn("Warning: Participants not found in DB (skipped):", missing);
  }

  const upsertMatch = db.prepare(
    `INSERT INTO matches (row_number, stage, home_team_id, home_team, away_team_id, away_team)
     VALUES (?, 'Octavos de final', ?, ?, ?, ?)
     ON CONFLICT(row_number) DO UPDATE SET
       home_team = excluded.home_team,
       away_team = excluded.away_team`,
  );
  const getMatchByRowNumber = db.prepare(
    "SELECT id FROM matches WHERE row_number = ?",
  );

  const upsertPrediction = db.prepare(
    `INSERT INTO predictions (participant_id, match_id, pred_home, pred_away)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(participant_id, match_id) DO UPDATE SET
       pred_home = excluded.pred_home,
       pred_away = excluded.pred_away`,
  );

  let matchCount = 0;
  let predCount = 0;

  const tx = db.transaction(() => {
    let matchIndex = 0;
    // Match rows start at index 5 (row 6 in the spreadsheet)
    for (let rowIndex = 5; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!row || !row[0]) continue;

      const homeTeam = String(row[0]).trim();
      const awayTeam = row[1] ? String(row[1]).trim() : null;
      if (!homeTeam || !awayTeam) continue;

      const rowNumber = MATCH_ROW_OFFSET + matchIndex + 1;
      matchIndex++;

      upsertMatch.run(
        rowNumber,
        rowNumber * 2 - 1,
        homeTeam,
        rowNumber * 2,
        awayTeam,
      );
      const matchRow = getMatchByRowNumber.get(rowNumber);
      const matchId = matchRow.id;
      matchCount++;

      for (const p of participants) {
        if (!p.id) continue;
        const predHome = toInt(row[p.colIndex + 2]);
        const predAway = toInt(row[p.colIndex + 3]);
        if (predHome === null || predAway === null) continue;
        upsertPrediction.run(p.id, matchId, predHome, predAway);
        predCount++;
      }
    }
  });

  tx();

  return {
    participants: participants.filter((p) => p.id !== null).length,
    matches: matchCount,
    predictions: predCount,
    missing,
  };
}

initDb();
const filePath = process.env.BRACKET_FILE || "8avos.xlsx";
const result = import8avos(filePath);
console.log("Octavos de final import complete:", result);
