// server.js
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PUBLIC_DIR = __dirname;
const PINS_FILE = path.join(__dirname, "pins.json");

// static files (index.html, scan.ply, three.min.js, etc.)
app.use(express.static(PUBLIC_DIR));

function readPins() {
  try { return JSON.parse(fs.readFileSync(PINS_FILE, "utf8")); }
  catch { return []; }
}
function writePins(pins) {
  fs.writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2));
}

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/pins", (req, res) => {
  res.json(readPins());
});

app.post("/pins", (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [];
  const local = readPins();

  // merge by id, newest wins
  const byId = new Map(local.map(p => [p.id, p]));
  for (const p of incoming) {
    const ex = byId.get(p.id);
    if (!ex || (p.time || 0) > (ex.time || 0)) byId.set(p.id, p);
  }
  const merged = Array.from(byId.values());
  writePins(merged);
  res.json({ ok: true, count: merged.length });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on http://0.0.0.0:" + port));
