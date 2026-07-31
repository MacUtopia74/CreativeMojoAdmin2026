#!/usr/bin/env node
/**
 * Copy the exact pdfjs-dist worker bundle into ``public/`` so it
 * ships with the CRA build unmodified. The worker MUST match the
 * pdfjs-dist API version at runtime (otherwise pdfjs raises
 * "Cannot read properties of undefined (reading
 * 'WorkerMessageHandler')") — so we always copy the file that
 * came out of the currently-installed ``node_modules`` tree rather
 * than checking a static copy into git.
 *
 * Idempotent: safe to run repeatedly. Called from ``postinstall``
 * and can be invoked manually via ``yarn copy-pdf-worker``.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.js");
const DEST_DIR = path.resolve(__dirname, "..", "public");
const DEST = path.join(DEST_DIR, "pdf.worker.min.js");

if (!fs.existsSync(SRC)) {
  console.error(`[copy-pdf-worker] source missing: ${SRC}`);
  // Don't fail install — a slim install for a lint/test-only image
  // shouldn't crash. The runtime error will surface only if a user
  // actually opens a contract viewer without the worker in place.
  process.exit(0);
}
fs.mkdirSync(DEST_DIR, { recursive: true });
fs.copyFileSync(SRC, DEST);
const kb = Math.round(fs.statSync(DEST).size / 1024);
console.log(`[copy-pdf-worker] copied pdf.worker.min.js (${kb} KB) → public/`);
