import assert from "node:assert/strict";
import test from "node:test";
import { parseActivityScreenshot, parseActivityScreenshotDetailed, parseLocalizedNumber, resolveTesseractApi, screenshotFileError } from "../src/screenshotOcr.ts";

test("resolves Tesseract createWorker from CommonJS interop default export", () => {
  const createWorker = async () => ({ recognize() {}, setParameters() {}, terminate() {} });
  assert.equal(resolveTesseractApi({ default: { createWorker } }).createWorker, createWorker);
});

test("resolves a direct Tesseract ESM named export", () => {
  const createWorker = async () => ({ recognize() {}, setParameters() {}, terminate() {} });
  assert.equal(resolveTesseractApi({ createWorker }).createWorker, createWorker);
});

test("resolves the Tesseract global export used by the documented browser build", () => {
  const createWorker = async () => ({ recognize() {}, setParameters() {}, terminate() {} });
  assert.equal(resolveTesseractApi({ createWorker }).createWorker, createWorker);
});

test("reports a clear error for an incompatible Tesseract module", () => {
  assert.throws(() => resolveTesseractApi({ default: {} }), /without a usable createWorker export/);
});

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
  assert.equal(parsed.pace, "6:00 min/km");
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
  assert.deepEqual(parsed.uncertain, ["type", "date", "time", "duration", "distance", "sourceApp"]);
});

test("start time is not mistaken for activity duration", () => {
  const parsed = parseActivityScreenshot("Run · Start 7:15 AM · 6,3 km");
  assert.equal(parsed.time, "07:15");
  assert.equal(parsed.duration, "");
});

test("duration labels support hours and minutes as well as minute totals", () => {
  assert.equal(parseActivityScreenshot("Running · Duration 1:03").duration, "63");
  assert.equal(parseActivityScreenshot("Running · Elapsed Time 1:03").duration, "63");
  assert.equal(parseActivityScreenshot("Running · Moving Time 43:20").duration, "43");
  assert.equal(parseActivityScreenshot("Running · Duration 63 min").duration, "63");
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

test("Garmin German screen separates elapsed and moving time, average and max heart rate", () => {
  const parsed = parseActivityScreenshotDetailed([
    "Garmin", "Laufen", "Distanz", "6,30 km", "Verstrichene Zeit", "1:03:27",
    "Bewegungszeit", "1:02:10", "Durchschnittspace", "5:35 min/km", "Bestes Tempo", "4:08 min/km",
    "Durchschnittliche Herzfrequenz", "146 bpm", "Höchste Herzfrequenz", "181 bpm",
    "Höhenmeter", "120 m", "Kalorien", "1’234 kcal", "Aktivitätsdatum 13.11.2026", "Startzeit 07:10",
  ].join("\n"));
  assert.equal(parsed.languageEstimate, "German");
  assert.equal(parsed.draft.type, "Running");
  assert.equal(parsed.draft.distance, "6.3");
  assert.equal(parsed.draft.duration, "63");
  assert.equal(parsed.draft.pace, "5:35 min/km");
  assert.equal(parsed.draft.heartRate, "146");
  assert.equal(parsed.draft.elevation, "120");
  assert.equal(parsed.draft.calories, "1234");
  assert.equal(parsed.draft.date, "2026-11-13");
  assert.equal(parsed.draft.time, "07:10");
  assert.ok(parsed.warnings.some((warning) => warning.includes("Moving time and elapsed time")));
});

test("Strava English chooses labeled total distance and elapsed duration over goal and moving values", () => {
  const parsed = parseActivityScreenshotDetailed([
    "Strava Run", "Activity date 2026-11-13", "Start time 6:42 AM", "Distance 10.03 km",
    "Goal 10.00 km", "Moving Time 50:15", "Elapsed Time 52:40", "Average Pace 5:01 /km",
    "Best Pace 3:45 /km", "Average Heart Rate 151 bpm", "Max Heart Rate 182 bpm",
    "Elevation Gain 72 m", "Calories 602 kcal",
  ].join("\n"));
  assert.equal(parsed.languageEstimate, "English");
  assert.equal(parsed.draft.distance, "10.03");
  assert.equal(parsed.draft.duration, "53");
  assert.equal(parsed.draft.pace, "5:01 min/km");
  assert.equal(parsed.draft.heartRate, "151");
  assert.equal(parsed.draft.elevation, "72");
  assert.equal(parsed.draft.date, "2026-11-13");
  assert.equal(parsed.draft.time, "06:42");
});

test("Runna mixed German and English converts miles but retains min-per-mile pace", () => {
  const parsed = parseActivityScreenshotDetailed("Runna · Running · Distanz 3.9 mi · Zeit 36:20 · Average Pace 9:19 min/mi · Avg HR 155 bpm · Calories 380 kcal · Elevation Gain 125 ft");
  assert.equal(parsed.languageEstimate, "Mixed German and English");
  assert.equal(parsed.draft.distance, "6.276");
  assert.equal(parsed.draft.duration, "36");
  assert.equal(parsed.draft.pace, "9:19 min/mi");
  assert.equal(parsed.draft.heartRate, "155");
  assert.equal(parsed.draft.elevation, "38");
});

test("Garmin German treadmill OCR tolerates metric labels after their values", () => {
  const raw = "15:59 m BN Ree & Laufbandtraining : Übersicht Statistiken Intervalle Diagramme A A] 12. Nov. @ 19:04 a W 1 Do. Tempo - Tempo 2-1-1 (6k # Notizen hinzufügen 6,34 km Distanz 157 bpm @ 7:17 /km @ @ Herzfrequenz @ Pace 45:31 544 Gesamtzeit Gesamtkalorien L&I Foto Teilen Evaluierung Pace (Hoch Aerob) Hauptnutzen Normal Befinden Mäßig Empfundene 3/10 Anstrengung";
  const parsed = parseActivityScreenshotDetailed(raw);
  assert.equal(parsed.draft.type, "Running");
  assert.equal(parsed.draft.distance, "6.34");
  assert.equal(parsed.draft.pace, "7:17 min/km");
  assert.equal(parsed.draft.duration, "46");
  assert.equal(parsed.draft.time, "19:04");
  assert.equal(parsed.draft.heartRate, "157");
  assert.equal(parsed.draft.calories, "544");
  assert.equal(parsed.draft.date, "");
  assert.ok(parsed.draft.uncertain.includes("calories"));
});

test("meters are converted to kilometers, while elevation meters are not mistaken for distance", () => {
  assert.equal(parseActivityScreenshot("Walking · Distance 4200 m").distance, "4.2");
  const parsed = parseActivityScreenshotDetailed("Running\nDistance 5 km\nDistance 7 km\nElevation Gain 300 m");
  assert.equal(parsed.draft.distance, "");
  assert.ok(parsed.draft.uncertain.includes("distance"));
  assert.ok(parsed.warnings.some((warning) => warning.includes("distance was left blank")));
  assert.equal(parsed.draft.elevation, "300");
});

test("screenshot capture date is not substituted for the labeled activity date", () => {
  const parsed = parseActivityScreenshotDetailed("Screenshot captured 2026-11-12\nActivity date 2026-11-11\nStart 08:10\nDuration 42 min\nDistance 6 km");
  assert.equal(parsed.draft.date, "2026-11-11");
});

test("unlabeled ambiguous metrics remain blank and impossible values are rejected", () => {
  const ambiguous = parseActivityScreenshotDetailed("Garmin Running 6 km 7 km 1:03:00 150 bpm");
  assert.equal(ambiguous.draft.distance, "");
  assert.equal(ambiguous.draft.duration, "");
  assert.equal(ambiguous.draft.heartRate, "");
  const invalid = parseActivityScreenshot("Garmin Running Distance 0 km Duration 25:00:00 Average Heart Rate 260 bpm");
  assert.equal(invalid.distance, "");
  assert.equal(invalid.duration, "");
  assert.equal(invalid.heartRate, "");
});
