/**
 * Fails if any source file contains mojibake.
 *
 * Editing these files with PowerShell's Get-Content/Set-Content re-reads
 * already-UTF-8 bytes as Latin-1 and writes them back as UTF-8, so every
 * non-ASCII character gains a prefix byte. It is invisible in a diff review and
 * only shows up on screen — the customer list shipped reading "CUS-0011 Â·
 * Nairobi" before this check existed.
 *
 * Scans the whole repo, not just the platform, because the same tooling touches
 * the Flutter sources.
 *
 *   node scripts/check-encoding.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIRS = new Set([
  "node_modules", "build", ".dart_tool", ".next", ".git", ".gradle",
  "screenshots", "brand", "ios", "windows", "linux", "macos", "web",
]);

const EXTS = new Set([".ts", ".tsx", ".dart", ".md", ".css", ".json", ".yaml", ".yml"]);

/**
 * Sequences that are valid UTF-8 but only occur in practice as the result of a
 * double encoding. Plain "Â" and "Ã" would false-positive on real French or
 * Portuguese text, so each entry is a full mangled glyph.
 */
const MOJIBAKE = [
  ["Â·", "· (middle dot)"],
  ["â€”", "— (em dash)"],
  ["â€“", "– (en dash)"],
  ["â€™", "' (apostrophe)"],
  ["â€œ", '" (open quote)'],
  ["â€¦", "… (ellipsis)"],
  ["Ã—", "× (multiply)"],
  ["â†", "← (arrow)"],
  ["âœ“", "✓ (check)"],
  ["âœ—", "✗ (cross)"],
  ["âš", "⚠ (warning)"],
  ["Â°", "° (degree)"],
];

const findings = [];
let scanned = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      walk(full);
      continue;
    }
    if (!EXTS.has(extname(entry))) continue;

    scanned++;
    const bytes = readFileSync(full);

    // The opposite failure: a file saved as Windows-1252 ("ANSI"). Its em
    // dashes and middle dots become single bytes that are not UTF-8 at all,
    // and `next build` refuses the file outright ("stream did not contain
    // valid UTF-8") — a deploy blocker that only surfaces at build time.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      const bad = bytes.findIndex((b, i) => b >= 0x80 && !isUtf8Lead(bytes, i));
      const line = bytes.subarray(0, Math.max(bad, 0)).toString("latin1").split("\n").length;
      findings.push({ file: relative(ROOT, full), line, seq: "<invalid UTF-8>", meaning: "a UTF-8 file (was saved as ANSI / Windows-1252)" });
      continue;
    }

    const text = bytes.toString("utf8");
    for (const [seq, meaning] of MOJIBAKE) {
      if (!text.includes(seq)) continue;
      const line = text.slice(0, text.indexOf(seq)).split("\n").length;
      findings.push({ file: relative(ROOT, full), line, seq, meaning });
    }
  }
}

/** True when the byte at `i` is a valid UTF-8 lead or continuation byte in context. */
function isUtf8Lead(bytes, i) {
  const b = bytes[i];
  if (b >= 0xc2 && b <= 0xf4) return true; // lead byte
  if (b >= 0x80 && b <= 0xbf) {
    // continuation: valid only if a lead byte precedes it within 3 bytes
    for (let k = 1; k <= 3 && i - k >= 0; k++) {
      const p = bytes[i - k];
      if (p >= 0xc2 && p <= 0xf4) return true;
      if (p < 0x80) return false;
    }
  }
  return false;
}

walk(ROOT);

console.log(`\nEncoding check — ${scanned} source files\n`);

if (findings.length === 0) {
  console.log("  ✓ no mojibake found\n");
  process.exit(0);
}

for (const f of findings) {
  console.log(`  ✗ ${f.file}:${f.line}  "${f.seq}" should be ${f.meaning}`);
}
console.log(
  `\n  ${findings.length} occurrence(s). Repair by reading as UTF-8 and writing as UTF-8` +
    `\n  (Python, or PowerShell with an explicit -Encoding utf8NoBOM on BOTH read and write).\n`,
);
process.exit(1);
