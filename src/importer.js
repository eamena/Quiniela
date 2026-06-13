const path = require("path");
const XLSX = require("xlsx");
const { db } = require("./db");

const PARTICIPANT_BLOCK_SIZE = 13;
const PARTICIPANT_START_COL_1_BASED = 9; // I

function toInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function readCell(sheet, row1Based, col1Based) {
  const row = sheet[row1Based - 1];
  if (!row) return null;
  const v = row[col1Based - 1];
  return v === undefined ? null : v;
}

function detectParticipants(sheet, maxCols) {
  const participants = [];
  for (
    let col = PARTICIPANT_START_COL_1_BASED;
    col <= maxCols;
    col += PARTICIPANT_BLOCK_SIZE
  ) {
    const name = readCell(sheet, 2, col);
    if (isText(name)) {
      participants.push({ name: String(name).trim(), startCol: col });
    }
  }
  return participants;
}

function importWorkbook(excelFilePath) {
  const absolutePath = path.isAbsolute(excelFilePath)
    ? excelFilePath
    : path.join(process.cwd(), excelFilePath);

  const workbook = XLSX.readFile(absolutePath, { cellDates: false, raw: true });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    throw new Error("No worksheet found in workbook.");
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
    header: 1,
    defval: null,
    raw: true,
  });

  const maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0);
  const participants = detectParticipants(rows, maxCols);
  if (participants.length === 0) {
    throw new Error("No participants detected in Excel file.");
  }

  const reset = db.transaction(() => {
    db.prepare("DELETE FROM predictions").run();
    db.prepare("DELETE FROM results").run();
    db.prepare("DELETE FROM matches").run();
    db.prepare("DELETE FROM participants").run();
  });
  reset();

  const insertParticipant = db.prepare(
    "INSERT INTO participants (name, source_col) VALUES (?, ?)"
  );
  const insertMatch = db.prepare(
    `INSERT INTO matches
      (row_number, stage, home_team_id, home_team, away_team_id, away_team)
      VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertPrediction = db.prepare(
    `INSERT INTO predictions
      (participant_id, match_id, pred_home, pred_away)
      VALUES (?, ?, ?, ?)`
  );

  const participantIdByStartCol = new Map();
  for (const participant of participants) {
    const result = insertParticipant.run(participant.name, participant.startCol);
    participantIdByStartCol.set(participant.startCol, result.lastInsertRowid);
  }

  let currentStage = null;
  let importedMatches = 0;
  let importedPredictions = 0;

  for (let rowNumber = 4; rowNumber <= rows.length; rowNumber++) {
    const colB = readCell(rows, rowNumber, 2);
    const colC = readCell(rows, rowNumber, 3);
    const colD = readCell(rows, rowNumber, 4);
    const colE = readCell(rows, rowNumber, 5);

    if (isText(colB) && String(colB).toLowerCase().startsWith("grupo")) {
      currentStage = String(colB).trim();
      continue;
    }

    const homeTeamId = toInt(colB);
    const awayTeamId = toInt(colD);
    const homeTeam = isText(colC) ? String(colC).trim() : null;
    const awayTeam = isText(colE) ? String(colE).trim() : null;

    if (!homeTeamId || !awayTeamId || !homeTeam || !awayTeam) {
      continue;
    }

    const matchResult = insertMatch.run(
      rowNumber,
      currentStage,
      homeTeamId,
      homeTeam,
      awayTeamId,
      awayTeam
    );
    const matchId = matchResult.lastInsertRowid;
    importedMatches += 1;

    for (const participant of participants) {
      const pId = participantIdByStartCol.get(participant.startCol);
      const predHome = toInt(readCell(rows, rowNumber, participant.startCol + 4));
      const predAway = toInt(readCell(rows, rowNumber, participant.startCol + 5));
      if (predHome === null || predAway === null) continue;
      insertPrediction.run(pId, matchId, predHome, predAway);
      importedPredictions += 1;
    }
  }

  return {
    participants: participants.length,
    matches: importedMatches,
    predictions: importedPredictions,
    sheet: firstSheet,
  };
}

module.exports = { importWorkbook };
