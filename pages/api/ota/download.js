// pages/api/ota/download.js
// Serves the uploaded firmware zip file so the gateway can download it.

import fs   from "fs";
import path from "path";
import os   from "os";

const OTA_DIR = path.join(os.tmpdir(), "vitalsync-ota-server");

export default function handler(req, res) {
  const { file } = req.query;
  if (!file || file.includes("..")) return res.status(400).end();

  const filePath = path.join(OTA_DIR, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
  fs.createReadStream(filePath).pipe(res);
}