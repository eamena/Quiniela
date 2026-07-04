const { db } = require("./src/db");

// Use participant 1 as a test
const rows = db
  .prepare(
    `
  SELECT
    m.stage,
    COUNT(*) as cnt
  FROM predictions p
  JOIN matches m ON m.id = p.match_id
  WHERE p.participant_id = 1
  GROUP BY m.stage
  ORDER BY
    CASE 
      WHEN m.stage = 'Octavos de final' THEN 0
      WHEN m.stage = '16avos de final' THEN 1
      ELSE 2
    END ASC
`,
  )
  .all();

rows.forEach((r) => console.log("Stage:", r.stage, "- Count:", r.cnt));
