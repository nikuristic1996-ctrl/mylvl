import assert from "node:assert/strict";
import test from "node:test";
import { parseActivityScreenshot, parseLocalizedNumber, screenshotFileError } from "../src/screenshotOcr.ts";

test("parses German activity labels and decimal comma without inventing missing values", () => {
  const parsed = parseActivityScreenshot("Strava · Laufen · Distanz 6,3 km · Dauer 01:03:00 · 13.11.2026 · Durchschnittstempo 6:00/km");
  assert.equal(parsed.type, "Running");
  assert.equal(parsed.distance, "6.3");
  assert.equal(parsed.duration, "63");
  assert.equal(parsed.date, "2026-11-13");
  assert.equal(parsed.sourceApp, "Strava");
  assert.equal(parsed.time, "");
  assert.equal(parsed.heartRate, "");
  assert.equal(parsed.calories, "");
  assert.ok(parsed.uncertain.includes("duration") === false);
});

test("parses English values with decimal point, 12-hour start time and common stats", () => {
  const parsed = parseActivityScreenshot("Garmin Running Distance 6.3 km Start 7:15 AM Duration 1:03:00 Avg Pace 6:00 /km Average Heart Rate 145 bpm Calories 430 kcal");
  assert.equal(parsed.type, "Running");
  assert.equal(parsed.distance, "6.3");
  assert.equal(parsed.time, "07:15");
  assert.equal(parsed.duration, "63");
  assert.equal(parsed.heartRate, "145");
  assert.equal(parsed.calories, "430");
  assert.equal(parsed.pace, "6:00");
});

test("flags unknown or missing fields rather than supplying demo values", () => {
  const parsed = parseActivityScreenshot("Your workout is complete");
  assert.equal(parsed.type, "Other");
  assert.equal(parsed.date, "");
  assert.equal(parsed.time, "");
  assert.equal(parsed.duration, "");
  assert.equal(parsed.distance, "");
  assert.equal(parsed.calories, "");
  assert.equal(parseLocalizedNumber(""), undefined);
  assert.deepEqual(parsed.uncertain, ["type", "date", "duration", "distance", "sourceApp"]);
});

test("start time is not mistaken for activity duration", () => {
  const parsed = parseActivityScreenshot("Run · Start 7:15 AM · 6,3 km");
  assert.equal(parsed.time, "07:15");
  assert.equal(parsed.duration, "");
});

test("normalizes common thousands and decimal separator combinations", () => {
  assert.equal(parseActivityScreenshot("Running Distance 6,3 km Calories 1.234 kcal Duration 60 min").calories, "1234");
  assert.equal(parseActivityScreenshot("Running Distance 6.3 km Calories 1,234 kcal Duration 60 min").calories, "1234");
});

test("upload validation accepts supported images and rejects unsupported files or oversized screenshots", () => {
  assert.equal(screenshotFileError({ type: "image/png", size: 1024 }), null);
  assert.equal(screenshotFileError({ type: "image/jpeg", size: 1024 }), null);
  assert.equal(screenshotFileError({ type: "image/webp", size: 1024 }), null);
  assert.match(screenshotFileError({ type: "image/heic", size: 1024 }), /PNG, JPG, JPEG or WEBP/);
  assert.match(screenshotFileError({ type: "image/png", size: 15 * 1024 * 1024 + 1 }), /15 MB/);
});

test("manual corrections accept comma and dot decimals", () => {
  assert.equal(parseLocalizedNumber("6,3"), 6.3);
  assert.equal(parseLocalizedNumber("6.3"), 6.3);
  assert.equal(parseLocalizedNumber("1.234,5"), 1234.5);
  assert.equal(parseLocalizedNumber("1,234.5"), 1234.5);
});

