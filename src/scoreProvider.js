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

// Prepared statements cached at module level — created once, reused forever
const stmts = {
  localMatches: null,
  getResult: null,
  upsertResult: null,
  getKnockout: null,
  upsertKnockout: null,
};

function getStmts() {
  if (!stmts.localMatches) {
    stmts.localMatches = db.prepare(
      "SELECT id, home_team, away_team FROM matches",
    );
    stmts.getResult = db.prepare(
      "SELECT home_score, away_score, pen_home, pen_away, status, kickoff_utc FROM results WHERE match_id = ?",
    );
    stmts.upsertResult = db.prepare(
      `INSERT INTO results (match_id, home_score, away_score, pen_home, pen_away, status, source, kickoff_utc, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'football-data', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(match_id) DO UPDATE SET
         home_score = excluded.home_score,
         away_score = excluded.away_score,
         pen_home = excluded.pen_home,
         pen_away = excluded.pen_away,
         status = excluded.status,
         source = 'football-data',
         kickoff_utc = excluded.kickoff_utc,
         updated_at = CURRENT_TIMESTAMP`,
    );
    stmts.getKnockout = db.prepare(
      "SELECT home_team, away_team, kickoff_utc, status, home_score, away_score FROM knockout_matches WHERE api_match_id = ?",
    );
    stmts.upsertKnockout = db.prepare(
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
         updated_at = CURRENT_TIMESTAMP`,
    );
  }
  return stmts;
}

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

function pickMatchScore(score) {
  const rtHome = score?.regularTime?.home;
  const rtAway = score?.regularTime?.away;
  const ftHome = score?.fullTime?.home;
  const ftAway = score?.fullTime?.away;
  const etHome = score?.extraTime?.home;
  const etAway = score?.extraTime?.away;
  const hasPens =
    Number.isInteger(score?.penalties?.home) &&
    Number.isInteger(score?.penalties?.away);

  // For shootouts, score regular time to avoid upstream anomalies where
  // extra/full-time can arrive as 0-0 while penalties are present.
  if (hasPens && Number.isInteger(rtHome) && Number.isInteger(rtAway)) {
    return { homeScore: rtHome, awayScore: rtAway };
  }

  if (Number.isInteger(ftHome) && Number.isInteger(ftAway)) {
    return { homeScore: ftHome, awayScore: ftAway };
  }
  if (Number.isInteger(etHome) && Number.isInteger(etAway)) {
    return { homeScore: etHome, awayScore: etAway };
  }
  if (Number.isInteger(rtHome) && Number.isInteger(rtAway)) {
    return { homeScore: rtHome, awayScore: rtAway };
  }

  return { homeScore: null, awayScore: null };
}

function hasResultChanged(existing, incoming) {
  if (!existing) return true;
  return (
    existing.home_score !== incoming.homeScore ||
    existing.away_score !== incoming.awayScore ||
    existing.pen_home !== (incoming.penHome ?? null) ||
    existing.pen_away !== (incoming.penAway ?? null) ||
    existing.status !== incoming.status ||
    existing.kickoff_utc !== incoming.utcDate
  );
}

function hasKnockoutChanged(existing, incoming) {
  if (!existing) return true;
  return (
    existing.home_team !== (incoming.homeTeam || null) ||
    existing.away_team !== (incoming.awayTeam || null) ||
    existing.kickoff_utc !== incoming.utcDate ||
    existing.status !== incoming.status ||
    existing.home_score !== incoming.homeScore ||
    existing.away_score !== incoming.awayScore
  );
}

async function fetchWorldCupMatches(apiToken) {
  const response = await axios.get(
    "https://api.football-data.org/v4/competitions/WC/matches",
    {
      headers: { "X-Auth-Token": apiToken },
      timeout: 15000,
    },
  );

  const matches = response.data?.matches || [];
  return matches.map((m) => {
    const { homeScore, awayScore } = pickMatchScore(m.score);
    const penHome = Number.isInteger(m.score?.penalties?.home)
      ? m.score.penalties.home
      : null;
    const penAway = Number.isInteger(m.score?.penalties?.away)
      ? m.score.penalties.away
      : null;
    return {
      apiMatchId: m.id,
      stage: m.stage || null,
      homeTeam: m.homeTeam?.name,
      awayTeam: m.awayTeam?.name,
      homeScore,
      awayScore,
      penHome,
      penAway,
      utcDate: m.utcDate || null,
      status: normalizeStatus(m.status),
    };
  });
}

/**
 * Returns the current activity level based on today's match schedule.
 * Used by the bot to decide how frequently to poll.
 *
 * "live"     → a match is in_play or finished within the last 30 min
 * "active"   → a match kicks off within the next 2 hours or ended < 2h ago
 * "today"    → there are matches today but none imminent
 * "idle"     → no matches today
 */
function getActivityLevel() {
  const nowMs = Date.now();
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setUTCHours(23, 59, 59, 999);

  const todayMatches = db
    .prepare(
      `SELECT r.kickoff_utc AS kickoffUtc, r.status AS status
       FROM results r
       WHERE r.kickoff_utc >= ? AND r.kickoff_utc <= ?`,
    )
    .all(startOfDay.toISOString(), endOfDay.toISOString());

  if (!todayMatches.length) return "idle";

  for (const m of todayMatches) {
    if (m.status === "live") return "live";
    const kickoffMs = Date.parse(m.kickoffUtc);
    // finished within last 30 min
    if (m.status === "finished" && nowMs - kickoffMs < 120 * 60 * 1000)
      return "live";
    // kicks off within next 2 hours
    if (kickoffMs - nowMs < 2 * 60 * 60 * 1000 && kickoffMs > nowMs)
      return "active";
  }

  return "today";
}

async function syncResultsFromApi() {
  const apiToken = process.env.FOOTBALL_DATA_API_TOKEN;
  if (!apiToken) {
    return {
      synced: 0,
      matched: 0,
      skipped: true,
      reason: "Missing API token",
    };
  }

  const s = getStmts();
  const externalMatches = await fetchWorldCupMatches(apiToken);

  const byPair = new Map();
  for (const m of externalMatches) {
    const key = `${normalizeTeamName(m.homeTeam)}::${normalizeTeamName(m.awayTeam)}`;
    if (!byPair.has(key)) byPair.set(key, m);
  }

  const localMatches = s.localMatches.all();

  // Wrap all writes in a single transaction for atomicity and speed
  let matched = 0;
  let synced = 0;
  let knockoutSynced = 0;

  const tx = db.transaction(() => {
    for (const local of localMatches) {
      const key = `${normalizeTeamName(local.home_team)}::${normalizeTeamName(local.away_team)}`;
      const ext = byPair.get(key);
      if (!ext) continue;
      matched += 1;

      const existing = s.getResult.get(local.id);
      if (!hasResultChanged(existing, ext)) continue; // skip if nothing changed

      synced += s.upsertResult.run(
        local.id,
        ext.homeScore,
        ext.awayScore,
        ext.penHome ?? null,
        ext.penAway ?? null,
        ext.status,
        ext.utcDate,
      ).changes;
    }

    for (const m of externalMatches) {
      if (!ROUND_ORDER.includes(m.stage)) continue;
      if (!m.utcDate) continue;

      const existing = s.getKnockout.get(m.apiMatchId);
      if (!hasKnockoutChanged(existing, m)) continue; // skip if nothing changed

      knockoutSynced += s.upsertKnockout.run(
        m.apiMatchId,
        m.stage,
        m.homeTeam || null,
        m.awayTeam || null,
        m.utcDate,
        m.status,
        m.homeScore,
        m.awayScore,
      ).changes;
    }
  });

  tx();

  // Only recompute round windows if knockout data actually changed
  if (knockoutSynced > 0) {
    computeAndStoreRoundWindows();
  }

  return { synced, matched, knockoutSynced, skipped: false };
}

module.exports = { syncResultsFromApi, getActivityLevel };
