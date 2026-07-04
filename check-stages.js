const { db } = require("./src/db");

const rows = db
  .prepare(
    "SELECT DISTINCT stage FROM matches WHERE stage NOT LIKE 'Grupo%' ORDER BY stage",
  )
  .all();
rows.forEach((r) => console.log("Stage: [" + r.stage + "]"));
