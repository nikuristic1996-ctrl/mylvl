export type ScreenshotDraft = {
  type: "Walking" | "Running" | "Strength" | "Bodyweight" | "Yoga" | "Pilates" | "Cycling" | "Swimming" | "Other";
  date: string;
  time: string;
  duration: string;
  distance: string;
  pace: string;
  heartRate: string;
  calories: string;
  steps: string;
  sourceApp: string;
  notes: string;
  uncertain: string[];
};

const numberToken = String.raw`(\d{1,3}(?:[ .,'’]\d{3})*(?:[,.]\d+)?)`;
export const parseLocalizedNumber = (raw: string) => {
  if (!raw.trim()) return undefined;
  const compact = raw.replace(/[ '’]/g, "");
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = Math.max(comma, dot);
    return Number(`${compact.slice(0, decimal).replace(/[.,]/g, "")}.${compact.slice(decimal + 1)}`);
  }
  if (comma >= 0) return Number(compact.replace(/,(?=\d{3}(?:\D|$))/g, "" ).replace(",", "."));
  if (dot >= 0 && /\.\d{3}(?:\D|$)/.test(compact)) return Number(compact.replace(/\./g, ""));
  return Number(compact);
};

function firstMatch(text: string, expressions: RegExp[]): RegExpMatchArray | null {
  for (const expression of expressions) {
    const match = text.match(expression);
    if (match) return match;
  }
  return null;
}

function parseDate(text: string): string {
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const european = text.match(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/);
  if (european) return `${european[3]}-${european[2].padStart(2, "0")}-${european[1].padStart(2, "0")}`;
  return "";
}

function parseDuration(text: string): string {
  const labeled = firstMatch(text, [
    /(?:duration|elapsed|total time|moving time|active time|dauer|zeit)\s*[:\-]?\s*(\d{1,2}:\d{2}(?::\d{2})?)/i,
    /(\d{1,2}:\d{2}:\d{2})\s*(?:duration|elapsed|dauer|gesamtzeit)/i,
  ]);
  if (!labeled) return "";
  const parts = labeled[1].split(":").map(Number);
  const minutes = parts.length === 3 ? parts[0] * 60 + parts[1] + parts[2] / 60 : parts[0] + parts[1] / 60;
  return minutes > 0 ? String(Math.round(minutes)) : "";
}

export function parseActivityScreenshot(text: string): ScreenshotDraft {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  const type = /\b(run|running|lauf|laufen|jogging)\b/.test(lower) ? "Running"
    : /\b(walk|walking|gehen|spaziergang)\b/.test(lower) ? "Walking"
      : /\b(cycling|bike|radfahren|fahrrad)\b/.test(lower) ? "Cycling"
        : /\b(swim|swimming|schwimmen)\b/.test(lower) ? "Swimming"
          : /\b(strength|krafttraining|weight training)\b/.test(lower) ? "Strength"
            : /\b(yoga)\b/.test(lower) ? "Yoga"
              : /\b(pilates)\b/.test(lower) ? "Pilates"
                : /\b(bodyweight|calisthenics|körpergewicht)\b/.test(lower) ? "Bodyweight" : "Other";
  const sourceApp = /garmin/i.test(clean) ? "Garmin"
    : /strava/i.test(clean) ? "Strava"
      : /runna/i.test(clean) ? "Runna"
        : /apple\s*(fitness|health)|fitness/i.test(clean) ? "Apple Fitness / Health" : "Unknown";
  const distanceMatch = firstMatch(clean, [
    new RegExp(String.raw`(?:distance|distanz|strecke)\s*[:\-]?\s*${numberToken}\s*(km|kilometers?|kilometer|mi|miles?)`, "i"),
    new RegExp(String.raw`\b${numberToken}\s*(km|kilometers?|kilometer|mi|miles?)\b`, "i"),
  ]);
  let distance = "";
  if (distanceMatch) {
    const value = parseLocalizedNumber(distanceMatch[1]);
    if (value !== undefined) {
      const km = /^(mi|mile|miles)$/i.test(distanceMatch[2]) ? value * 1.609344 : value;
      if (Number.isFinite(km) && km > 0 && km <= 1000) distance = String(Math.round(km * 1000) / 1000);
    }
  }
  const date = parseDate(clean);
  const timeMatch = firstMatch(clean, [
    /(?:start(?:ed)?(?:\s*time)?|startzeit|began|time of day|uhrzeit)\s*[:\-]?\s*(\d{1,2}:\d{2})(?:\s*(am|pm))?/i,
    /\b(\d{1,2}:\d{2})\s*(am|pm)\b/i,
  ]);
  let time = timeMatch?.[1] ?? "";
  if (time && timeMatch?.[2]) {
    const [hour, minute] = time.split(":").map(Number);
    const converted = timeMatch[2].toLowerCase() === "pm" && hour < 12 ? hour + 12
      : timeMatch[2].toLowerCase() === "am" && hour === 12 ? 0 : hour;
    time = `${String(converted).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const duration = parseDuration(clean);
  const paceMatch = firstMatch(clean, [
    /(?:avg(?:erage)?\s*pace|pace|durchschnittstempo|tempo)\s*[:\-]?\s*(\d{1,2}:[0-5]\d)\s*(?:\/\s*km|min\s*\/\s*km)?/i,
  ]);
  const hrMatch = firstMatch(clean, [/(?:avg(?:erage)?\s*(?:heart\s*rate|hr)|heart\s*rate|puls|herzfrequenz)\s*[:\-]?\s*(\d{2,3})\s*(?:bpm|schl\s*\/\s*min)?/i]);
  const calorieMatch = firstMatch(clean, [new RegExp(String.raw`(?:calories|kcal|kalorien)\s*[:\-]?\s*${numberToken}`, "i"), new RegExp(String.raw`${numberToken}\s*(?:kcal|calories|kalorien)\b`, "i")]);
  const stepsMatch = firstMatch(clean, [new RegExp(String.raw`(?:steps|schritte)\s*[:\-]?\s*${numberToken}`, "i")]);
  const caloriesValue = calorieMatch ? parseLocalizedNumber(calorieMatch[1]) : undefined;
  const stepsValue = stepsMatch ? parseLocalizedNumber(stepsMatch[1]) : undefined;
  const uncertain = [
    ...(type === "Other" ? ["type"] : []),
    ...(!date ? ["date"] : []),
    ...(!duration ? ["duration"] : []),
    ...(!distance ? ["distance"] : []),
    ...(sourceApp === "Unknown" ? ["sourceApp"] : []),
  ];
  return {
    type,
    date,
    time,
    duration,
    distance,
    pace: paceMatch?.[1] ?? "",
    heartRate: hrMatch?.[1] ?? "",
    calories: caloriesValue !== undefined && Number.isFinite(caloriesValue) ? String(Math.round(caloriesValue)) : "",
    steps: stepsValue !== undefined && Number.isFinite(stepsValue) ? String(Math.round(stepsValue)) : "",
    sourceApp,
    notes: "",
    uncertain,
  };
}

export function screenshotFileError(file: Pick<File, "type" | "size">): string | null {
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type)) {
    return "Choose a PNG, JPG, JPEG or WEBP image.";
  }
  if (file.size > 15 * 1024 * 1024) return "This image is larger than 15 MB. Choose a smaller screenshot.";
  return null;
}

type TesseractWorker = {
  recognize: (image: File, options?: { logger?: (event: { status?: string; progress?: number }) => void }) => Promise<{ data: { text: string; confidence?: number } }>;
  terminate: () => Promise<void>;
};

export async function recognizeScreenshot(
  image: File,
  onProgress: (status: string, progress: number) => void,
): Promise<{ draft: ScreenshotDraft; confidence: number }> {
  const importModule = new Function("url", "return import(url)") as (url: string) => Promise<{ createWorker: (languages: string, oem: number, options: Record<string, unknown>) => Promise<TesseractWorker> }>;
  const tesseract = await importModule("https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js");
  const worker = await tesseract.createWorker("eng+deu", 1, {
    logger: (event: { status?: string; progress?: number }) => onProgress(event.status ?? "Reading text", event.progress ?? 0),
  });
  try {
    const result = await worker.recognize(image);
    return { draft: parseActivityScreenshot(result.data.text), confidence: result.data.confidence ?? 0 };
  } finally {
    await worker.terminate();
  }
}

export async function fingerprintScreenshot(file: File, userId: string, canonical: string): Promise<string> {
  // Canonical activity details (including local date/time) make repeated uploads,
  // including screenshots from different apps, share the database idempotency key.
  void file;
  const sourceKeyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}|${canonical}`));
  return Array.from(new Uint8Array(sourceKeyHash), (value) => value.toString(16).padStart(2, "0")).join("");
}

