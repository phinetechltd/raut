/**
 * Asserts every colour pairing the UI relies on meets WCAG AA.
 *
 * Colour choices drift as a design evolves, and a contrast regression is
 * invisible to the person who causes it — it looks fine on their monitor. This
 * turns that into a failing check.
 *
 * Pairings live in src/lib/design-tokens.ts (CONTRAST_ASSERTIONS) so the values
 * under test are the same constants the app renders with, not a copy.
 *
 *   node scripts/check-contrast.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tokensPath = resolve(here, "../src/lib/design-tokens.ts");

/**
 * The tokens file is TypeScript, so rather than add a build step this reads the
 * assertion table out of the source. Brittle if the file is reformatted, which
 * is why it fails loudly instead of silently testing nothing.
 */
function loadAssertions() {
  const src = readFileSync(tokensPath, "utf8");

  const resolveConst = (expr) => {
    const literal = expr.match(/^"(#[0-9A-Fa-f]{6})"$/);
    if (literal) return literal[1];

    const ref = expr.match(/^(\w+)(?:\.(\w+))?(?:\[(\d+)\])?$/);
    if (!ref) return null;
    const [, obj, key, index] = ref;

    const block = src.match(
      new RegExp(`export const ${obj} = \\{([\\s\\S]*?)\\n\\} as const;`),
    );
    if (!block) return null;

    if (index) {
      const m = block[1].match(new RegExp(`\\n\\s*${index}:\\s*"(#[0-9A-Fa-f]{6})"`));
      return m ? m[1] : null;
    }
    if (key) {
      // semantic.light.text — descend one nested level
      const nested = block[1].match(
        new RegExp(`${key}:\\s*\\{([\\s\\S]*?)\\n\\s*\\},`),
      );
      return nested ? nested[1] : null;
    }
    return null;
  };

  const table = src.match(
    /CONTRAST_ASSERTIONS[\s\S]*?= \[([\s\S]*?)\n\];/,
  );
  if (!table) throw new Error("Could not find CONTRAST_ASSERTIONS in design-tokens.ts");

  const rows = [...table[1].matchAll(
    /\{ name: "([^"]+)", fg: ([^,]+), bg: ([^,]+), min: ([\d.]+) \}/g,
  )];
  if (rows.length === 0) throw new Error("CONTRAST_ASSERTIONS parsed to zero rows");

  // Resolve semantic.<mode>.<key> and status.<key> references to hex.
  const semanticBlocks = {};
  for (const mode of ["light", "dark"]) {
    const m = src.match(new RegExp(`  ${mode}: \\{([\\s\\S]*?)\\n  \\},`));
    if (m) semanticBlocks[mode] = m[1];
  }
  const statusBlock = src.match(/export const status = \{([\s\S]*?)\n\} as const;/);

  const lookup = (expr) => {
    expr = expr.trim();
    const lit = expr.match(/^"(#[0-9A-Fa-f]{6})"$/);
    if (lit) return lit[1];

    let m = expr.match(/^semantic\.(light|dark)\.(\w+)$/);
    if (m) {
      const found = semanticBlocks[m[1]]?.match(
        new RegExp(`${m[2]}:\\s*(?:"(#[0-9A-Fa-f]{6})"|(\\w+)\\[(\\d+)\\])`),
      );
      if (!found) return null;
      if (found[1]) return found[1];
      return resolveConst(`${found[2]}[${found[3]}]`);
    }

    m = expr.match(/^status\.(\w+)$/);
    if (m && statusBlock) {
      const found = statusBlock[1].match(
        new RegExp(`${m[1]}:\\s*"(#[0-9A-Fa-f]{6})"`),
      );
      return found ? found[1] : null;
    }

    return resolveConst(expr);
  };

  return rows.map(([, name, fg, bg, min]) => ({
    name,
    fg: lookup(fg),
    bg: lookup(bg),
    fgExpr: fg.trim(),
    bgExpr: bg.trim(),
    min: Number(min),
  }));
}

const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function luminance(hex) {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const assertions = loadAssertions();
let failed = 0;
let unresolved = 0;

console.log(`\nWCAG contrast — ${assertions.length} asserted pairings\n`);

for (const a of assertions) {
  if (!a.fg || !a.bg) {
    unresolved++;
    console.log(`  ? ${a.name} — could not resolve ${a.fgExpr} / ${a.bgExpr}`);
    continue;
  }
  const ratio = contrast(a.fg, a.bg);
  const ok = ratio >= a.min;
  if (!ok) failed++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${a.name.padEnd(38)} ${a.fg} on ${a.bg}  ${ratio.toFixed(2)} (min ${a.min})`,
  );
}

console.log(`\n${"─".repeat(60)}`);
console.log(`  ${assertions.length - failed - unresolved} passed, ${failed} failed, ${unresolved} unresolved`);
console.log(`${"─".repeat(60)}\n`);

if (unresolved > 0) {
  console.error("Unresolved tokens mean this check is not actually testing them.");
}
process.exit(failed === 0 && unresolved === 0 ? 0 : 1);
