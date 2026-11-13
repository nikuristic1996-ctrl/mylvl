import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [viteConfig, mainEntry, appSource, vercelConfig] = await Promise.all([
  readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
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

test("temporary browser OCR test route and static page are removed", async () => {
  assert.doesNotMatch(appSource, /ocr-runtime-check|OcrRuntimeCheck/);
  await assert.rejects(readFile(new URL("../public/ocr-runtime-check.html", import.meta.url), "utf8"), { code: "ENOENT" });
});
