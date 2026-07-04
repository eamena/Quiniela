const { db } = require("./src/db");

// Find a participant with both stages
const participantsWithBoth = db
  .prepare(
    `
  SELECT 
    p.participant_id,
    COUNT(DISTINCT m.stage) as stage_count
  FROM predictions p
  JOIN matches m ON m.id = p.match_id
  WHERE m.stage IN ('Octavos de final', '16avos de final')
  GROUP BY p.participant_id
  HAVING stage_count = 2
  LIMIT 1
`,
  )
  .all();

if (!participantsWithBoth.length) {
  console.log("No participant with both stages");
  process.exit(0);
}

const pid = participantsWithBoth[0].participant_id;
console.log("Testing with participant ID:", pid);
console.log("");

const rows = db
  .prepare(
    `
  SELECT
    m.stage,
    m.home_team,
    m.away_team
  FROM predictions p
  JOIN matches m ON m.id = p.match_id
  WHERE p.participant_id = ?
  ORDER BY
    CASE 
      WHEN m.stage = 'Octavos de final' THEN 0
      WHEN m.stage = '16avos de final' THEN 1
      ELSE 2
    END ASC,
    m.row_number ASC
  LIMIT 10
`,
  )
  .all(pid);

console.log("Order returned:");
rows.forEach((r, i) => {
  console.log(`${i + 1}. ${r.stage} - ${r.home_team} vs ${r.away_team}`);
});
