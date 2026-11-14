import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [viteConfig, mainEntry, appSource, vercelConfig, viteEnv] = await Promise.all([
  readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  readFile(new URL("../src/vite-env.d.ts", import.meta.url), "utf8"),
]);

test("PWA keeps offline support and prompts safely for new versions", () => {
  assert.ok(viteConfig.includes('registerType: "prompt"'));
  assert.ok(viteConfig.includes('cleanupOutdatedCaches: true'));
  assert.ok(viteConfig.includes('navigateFallback: "index.html"'));
  assert.match(mainEntry, /registerSW\(\{\s*immediate:\s*true/);
  assert.match(mainEntry, /registration\?\.update\(\)/);
  assert.ok(mainEntry.includes("mylvl:pwa-update-apply"));
  assert.ok(appSource.includes("mylvl:pwa-update-ready"));
  assert.ok(appSource.includes("A new MYLVL version is available"));
});

test("Vercel revalidates the app shell and service worker scripts", () => {
  const config = JSON.parse(vercelConfig);
  const headersBySource = new Map(config.headers.map((entry) => [entry.source, entry.headers]));
  for (const source of ["/index.html", "/sw.js", "/workbox-(.*).js", "/manifest.webmanifest"]) {
    const cacheControl = headersBySource.get(source)?.find((header) => header.key.toLowerCase() === "cache-control")?.value;
    assert.equal(cacheControl, "no-cache, max-age=0, must-revalidate", source + " must revalidate");
  }
});

test("build diagnostics include the Vercel Git commit while retaining the installable PWA", () => {
  assert.match(viteConfig, /VERCEL_GIT_COMMIT_SHA/);
  assert.match(viteConfig, /__MYLVL_BUILD_COMMIT__/);
  assert.match(viteEnv, /declare const __MYLVL_BUILD_COMMIT__: string/);
  assert.match(viteConfig, /display:\s*["']standalone["']/);
});

test("mobile OCR diagnostics expose version, platform, dimensions, parsed fields, errors, and copy without credentials", () => {
  assert.match(appSource, /Mobile OCR diagnostics/);
  assert.match(appSource, /Copy diagnostics/);
  assert.match(appSource, /sourceDimensions/);
  assert.match(appSource, /processedDimensions/);
  assert.match(appSource, /Extracted distance/);
  assert.match(appSource, /Raw OCR text/);
  assert.match(appSource, /navigator\.userAgent/);
  assert.doesNotMatch(appSource, /service_role|access_token|refresh_token/);
});

test("temporary browser OCR test route and static page are removed", async () => {
  assert.doesNotMatch(appSource, /ocr-runtime-check|OcrRuntimeCheck/);
  await assert.rejects(readFile(new URL("../public/ocr-runtime-check.html", import.meta.url), "utf8"), { code: "ENOENT" });
});
