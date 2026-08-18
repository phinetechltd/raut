/**
 * Confirms the console serves and references the supplied Raut artwork.
 *
 * Guards against the failure mode where the brand files are deleted or moved
 * and the UI silently renders a broken image — a 200 on the page says nothing
 * about whether the logo actually resolved.
 *
 *   node scripts/check-brand.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3200";
const PASSWORD = "Raut@2026";

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sessionCookie(email) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const jar = res.headers.getSetCookie?.() ?? [];
  return jar.find((c) => c.startsWith("raut_session="))?.split(";")[0] ?? null;
}

async function main() {
  console.log(`\nRaut brand asset check → ${BASE}\n`);

  console.log("Assets served");
  for (const path of [
    "/brand/raut-icon.png",
    "/brand/raut-logo-tagline.png",
    "/icon.png",
  ]) {
    const res = await fetch(`${BASE}${path}`);
    const buf = await res.arrayBuffer();
    const type = res.headers.get("content-type") ?? "";
    // PNG magic number — proves it is a real image, not an HTML error page
    // served with a 200.
    const sig = new Uint8Array(buf.slice(0, 8));
    const isPng =
      sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47;
    check(
      path,
      res.status === 200 && type.startsWith("image/") && isPng,
      `${res.status}, ${(buf.byteLength / 1024).toFixed(0)}kb, ${type}`,
    );
  }

  console.log("\nReferenced by the UI");
  const loginHtml = await (await fetch(`${BASE}/login`)).text();
  check(
    "login hero uses the tagline lockup",
    loginHtml.includes("raut-logo-tagline"),
  );
  check("favicon declared", /rel="icon"/.test(loginHtml));

  const cookie = await sessionCookie("admin@zamarsolutions.co.ke");
  check("tenant admin signs in", !!cookie);

  const appHtml = await (await fetch(`${BASE}/app`, {
    headers: { Cookie: cookie },
    redirect: "manual",
  })).text();
  check("console sidebar uses the Raut mark", appHtml.includes("raut-icon"));
  check(
    "console shows the product name",
    appHtml.includes("One Platform. Every Mile."),
  );
  check(
    "tenant name preserved, not overwritten by the rebrand",
    appHtml.includes("Zamar Solutions"),
  );

  console.log(`\n${"─".repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`${"─".repeat(52)}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Brand check crashed:", error);
  process.exit(1);
});
