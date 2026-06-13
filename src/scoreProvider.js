const axios = require("axios");
const { db } = require("./db");
const { computeAndStoreRoundWindows, ROUND_ORDER } = require("./knockout");

const TEAM_ALIASES = {
  alemania: "germany",
  germany: "germany",
  arabiasaudita: "saudiarabia",
  saudiarabia: "saudiarabia",
  argentina: "argentina",
  australia: "australia",
  austria: "austria",
  belgica: "belgium",
  belgium: "belgium",
  bolivia: "bolivia",
  bosniah: "bosniaandherzegovina",
  bosniaherzegovina: "bosniaandherzegovina",
  bosniaandherzegovina: "bosniaandherzegovina",
  brasil: "brazil",
  brazil: "brazil",
  canada: "canada",
  chequia: "czechia",
  czechia: "czechia",
  coreasur: "southkorea",
  korearepublic: "southkorea",
  southkorea: "southkorea",
  costamarfil: "ivorycoast",
  cotedivoire: "ivorycoast",
  ivorycoast: "ivorycoast",
  croacia: "croatia",
  croatia: "croatia",
  curazao: "curacao",
  curacao: "curacao",
  ecuador: "ecuador",
  egipto: "egypt",
  egypt: "egypt",
  escocia: "scotland",
  scotland: "scotland",
  espana: "spain",
  spain: "spain",
  estadosunidos: "unitedstates",
  unitedstates: "unitedstates",
  usa: "unitedstates",
  francia: "france",
  france: "france",
  haiti: "haiti",
  honduras: "honduras",
  inglaterra: "england",
  england: "england",
  iran: "iran",
  iriran: "iran",
  irak: "iraq",
  iraq: "iraq",
  italia: "italy",
  italy: "italy",
  japon: "japan",
  japan: "japan",
  marruecos: "morocco",
  morocco: "morocco",
  mexico: "mexico",
  nzelanda: "newzealand",
  newzealand: "newzealand",
  paisesbajos: "netherlands",
  netherlands: "netherlands",
  noruega: "norway",
  norway: "norway",
  paraguay: "paraguay",
  peru: "peru",
  polonia: "poland",
  poland: "poland",
  portugal: "portugal",
  qatar: "qatar",
  caboverde: "capeverdeislands",
  capeverdeislands: "capeverdeislands",
  argelia: "algeria",
  algeria: "algeria",
  jordania: "jordan",
  jordan: "jordan",
  repcongo: "congodr",
  drcongo: "congodr",
  congodr: "congodr",
  congodemocraticrepublic: "congodr",
  senegal: "senegal",
  sudafrica: "southafrica",
  southafrica: "southafrica",
  suecia: "sweden",
  sweden: "sweden",
  suiza: "switzerland",
  switzerland: "switzerland",
  tunez: "tunisia",
  tunisia: "tunisia",
  turkia: "turkiye",
  turquia: "turkiye",
  turkey: "turkiye",
  turkiye: "turkiye",
  uzbekistan: "uzbekistan",
  uruguay: "uruguay",
};

function normalizeRawTeamName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeTeamName(name) {
  const key = normalizeRawTeamName(name);
  return TEAM_ALIASES[key] || key;
}

function normalizeStatus(status) {
  const v = String(status || "").toUpperCase();
  if (v === "FINISHED") return "finished";
  if (v === "IN_PLAY" || v === "PAUSED") return "live";
  if (v === "TIMED" || v === "SCHEDULED") return "scheduled";
  return v ? v.toLowerCase() : "scheduled";
}

async function fetchWorldCupMatches(apiToken) {
  const response = await axios.get(
    "https://api.football-data.org/v4/competitions/WC/matches",
    {
      headers: { "X-Auth-Token": apiToken },
      timeout: 15000,
    }
  );

  const matches = response.data?.matches || [];
  return matches.map((m) => ({
    apiMatchId: m.id,
    stage: m.stage || null,
    homeTeam: m.homeTeam?.name,
    awayTeam: m.awayTeam?.name,
    homeScore: Number.isInteger(m.score?.fullTime?.home) ? m.score.fullTime.home : null,
    awayScore: Number.isInteger(m.score?.fullTime?.away) ? m.score.fullTime.away : null,
    utcDate: m.utcDate || null,
    status: normalizeStatus(m.status),
  }));
}

async function syncResultsFromApi() {
  const apiToken = process.env.FOOTBALL_DATA_API_TOKEN;
  if (!apiToken) {
    return { synced: 0, matched: 0, skipped: true, reason: "Missing API token" };
  }

  const externalMatches = await fetchWorldCupMatches(apiToken);
  const byPair = new Map();

  for (const m of externalMatches) {
    const key = `${normalizeTeamName(m.homeTeam)}::${normalizeTeamName(m.awayTeam)}`;
    if (!byPair.has(key)) byPair.set(key, m);
  }

  const localMatches = db
    .prepare("SELECT id, home_team, away_team FROM matches")
    .all();

  const upsertKnockoutMatch = db.prepare(
    `INSERT INTO knockout_matches
      (api_match_id, round_code, home_team, away_team, kickoff_utc, status, home_score, away_score, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'football-data', CURRENT_TIMESTAMP)
     ON CONFLICT(api_match_id) DO UPDATE SET
       round_code = excluded.round_code,
       home_team = excluded.home_team,
       away_team = excluded.away_team,
       kickoff_utc = excluded.kickoff_utc,
       status = excluded.status,
       home_score = excluded.home_score,
       away_score = excluded.away_score,
       source = 'football-data',
       updated_at = CURRENT_TIMESTAMP`
  );

  const upsertResult = db.prepare(
    `INSERT INTO results (match_id, home_score, away_score, status, source, kickoff_utc, updated_at)
     VALUES (?, ?, ?, ?, 'football-data', ?, CURRENT_TIMESTAMP)
     ON CONFLICT(match_id) DO UPDATE SET
       home_score = excluded.home_score,
       away_score = excluded.away_score,
       status = excluded.status,
       source = 'football-data',
       kickoff_utc = excluded.kickoff_utc,
       updated_at = CURRENT_TIMESTAMP`
  );

  let matched = 0;
  let synced = 0;
  for (const local of localMatches) {
    const key = `${normalizeTeamName(local.home_team)}::${normalizeTeamName(local.away_team)}`;
    const ext = byPair.get(key);
    if (!ext) continue;
    matched += 1;
    synced += upsertResult.run(
      local.id,
      ext.homeScore,
      ext.awayScore,
      ext.status,
      ext.utcDate
    ).changes;
  }

  let knockoutSynced = 0;
  for (const m of externalMatches) {
    if (!ROUND_ORDER.includes(m.stage)) continue;
    if (!m.utcDate) continue;
    knockoutSynced += upsertKnockoutMatch.run(
      m.apiMatchId,
      m.stage,
      m.homeTeam || null,
      m.awayTeam || null,
      m.utcDate,
      m.status,
      m.homeScore,
      m.awayScore
    ).changes;
  }

  computeAndStoreRoundWindows();

  return { synced, matched, knockoutSynced, skipped: false };
}

module.exports = { syncResultsFromApi };
