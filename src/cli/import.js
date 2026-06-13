require("dotenv").config();
const { initDb } = require("../db");
const { importWorkbook } = require("../importer");

const excelFile = process.env.EXCEL_FILE || "Participantes Amigos Mundial 2026.xlsx";
initDb();
const result = importWorkbook(excelFile);
console.log("Import complete:", result);
