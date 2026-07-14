require("dotenv").config();
const path = require("path");
const XLSX = require("xlsx");
const { initDb, db } = require("../db");

const PARTICIPANT_BLOCK_SIZE = 13;
const PARTICIPANT_START_COL_1_BASED = 9; // I

const NAME_ALIASES = {
  "america cortes": "acg",
};

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function toInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function readCell(rows, row1Based, col1Based) {
  const row = rows[row1Based - 1];
  if (!row) return null;
  const value = row[col1Based - 1];
  return value === undefined ? null : value;
}

function detectParticipants(rows, maxCols) {
  const participants = [];
  for (
    let col = PARTICIPANT_START_COL_1_BASED;
    col <= maxCols;
    col += PARTICIPANT_BLOCK_SIZE
  ) {
    const name = readCell(rows, 2, col);
    if (typeof name === "string" && name.trim()) {
      participants.push({
        name: name.trim(),
        startCol: col,
        participantId: null,
      });
    }
  }
  return participants;
}

function matchParticipants(participants) {
  const allParticipants = db
    .prepare("SELECT id, name FROM participants WHERE source_col != -999")
    .all();

  const byExactName = new Map(allParticipants.map((p) => [p.name, p.id]));
  const byNormalizedName = new Map(
    allParticipants.map((p) => [normalizeName(p.name), p.id]),
  );

  const missing = [];
  for (const p of participants) {
    const exactId = byExactName.get(p.name);
    if (exactId !== undefined) {
      p.participantId = exactId;
      continue;
    }

    const normalized = normalizeName(p.name);
    const aliasedNorm = NAME_ALIASES[normalized] || normalized;
    const normalizedId = byNormalizedName.get(aliasedNorm);
    if (normalizedId !== undefined) {
      p.participantId = normalizedId;
      continue;
    }

    missing.push(p.name);
  }

  return missing;
}

function findRoundStartRow(rows, labelRegex) {
  for (let i = 0; i < rows.length; i += 1) {
    const stage = String(rows[i]?.[1] || "").trim();
    if (labelRegex.test(stage)) {
      return i + 2; // first match row is next line after label
    }
  }
  return null;
}

function importCuartos(filePath) {
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

  const maxCols = rows.reduce((acc, row) => Math.max(acc, row.length), 0);
  const participants = detectParticipants(rows, maxCols);
  if (!participants.length) {
    throw new Error("No participants detected in workbook.");
  }

  const missing = matchParticipants(participants);

  const qfMatches = db
    .prepare(
      `SELECT id
       FROM knockout_matches
       WHERE round_code = 'QUARTER_FINALS'
       ORDER BY datetime(kickoff_utc) ASC, id ASC`,
    )
    .all();

  if (!qfMatches.length) {
    throw new Error(
      "No QUARTER_FINALS matches were found in knockout_matches.",
    );
  }

  const startRow = findRoundStartRow(rows, /^cuartos\s+de\s+final$/i);
  if (!startRow) {
    throw new Error("Could not find 'Cuartos de final' section in workbook.");
  }

  const qfRowNumbers = Array.from(
    { length: qfMatches.length },
    (_, idx) => startRow + idx,
  );

  const upsertPrediction = db.prepare(
    `INSERT INTO knockout_predictions
      (participant_id, knockout_match_id, pred_home, pred_away, submitted_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(participant_id, knockout_match_id) DO UPDATE SET
       pred_home = excluded.pred_home,
       pred_away = excluded.pred_away,
       submitted_at = CURRENT_TIMESTAMP`,
  );

  let saved = 0;
  let participantsSaved = 0;

  const tx = db.transaction(() => {
    for (const p of participants) {
      if (!p.participantId) continue;
      let participantHadValues = false;

      for (let i = 0; i < qfMatches.length; i += 1) {
        const rowNumber = qfRowNumbers[i];
        const predHome = toInt(readCell(rows, rowNumber, p.startCol + 4));
        const predAway = toInt(readCell(rows, rowNumber, p.startCol + 5));

        if (predHome === null || predAway === null) continue;

        upsertPrediction.run(
          p.participantId,
          qfMatches[i].id,
          predHome,
          predAway,
        );
        participantHadValues = true;
        saved += 1;
      }

      if (participantHadValues) {
        participantsSaved += 1;
      }
    }
  });

  tx();

  return {
    sheet: firstSheet,
    participantsDetected: participants.length,
    participantsMapped: participants.filter((p) => p.participantId).length,
    participantsSaved,
    knockoutMatches: qfMatches.length,
    savedRows: saved,
    missingParticipants: missing,
  };
}

initDb();

const filePath =
  process.env.BRACKET_FILE ||
  process.env.EXCEL_FILE ||
  "Participantes Amigos Mundial 2026.xlsx";

const result = importCuartos(filePath);
console.log("Cuartos import complete:", result);
