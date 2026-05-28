// pages/api/ota/upload.js
// Accepts a .zip firmware file upload and stores it temporarily.
// Returns a URL the gateway can download from.

import { IncomingForm } from "formidable";
import fs   from "fs";
import path from "path";
import os   from "os";

export const config = { api: { bodyParser: false } };

const OTA_DIR = path.join(os.tmpdir(), "vitalsync-ota-server");
fs.mkdirSync(OTA_DIR, { recursive: true });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const form = new IncomingForm({ uploadDir: OTA_DIR, keepExtensions: true, maxFileSize: 10 * 1024 * 1024 });

  form.parse(req, (err, fields, files) => {
    if (err) return res.status(500).json({ error: err.message });

    const file = files.firmware;
    if (!file) return res.status(400).json({ error: "No firmware file" });

    const uploadedPath = Array.isArray(file) ? file[0].filepath : file.filepath;
    const originalName = Array.isArray(file) ? file[0].originalFilename : file.originalFilename;

    // Move to a stable name
    const destName = `firmware_${Date.now()}_${originalName}`;
    const destPath = path.join(OTA_DIR, destName);
    fs.renameSync(uploadedPath, destPath);

    // Return a URL pointing to our download endpoint
    const url = `/api/ota/download?file=${encodeURIComponent(destName)}`;
    res.status(200).json({ url, filename: destName, size: fs.statSync(destPath).size });
  });
}