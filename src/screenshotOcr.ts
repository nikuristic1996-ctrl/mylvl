export type ScreenshotDraft = {
  type: "Walking" | "Running" | "Strength" | "Bodyweight" | "Yoga" | "Pilates" | "Cycling" | "Swimming" | "Other";
  date: string; time: string; duration: string; distance: string; pace: string;
  heartRate: string; calories: string; elevation: string; steps: string;
  sourceApp: string; notes: string; uncertain: string[];
  cadence?: string; cadenceUnit?: "steps/min" | "strides/min"; movingDurationMinutes?: string;
};

export type ScreenshotParseReport = {
  draft: ScreenshotDraft;
  fieldConfidence: Record<string, number | null>;
  fieldSources: Record<string, string>;
  warnings: string[];
  languageEstimate: "German" | "English" | "Mixed German and English" | "Unclear";
};

export type ImageDimensions = { width: number; height: number };
export type ScreenshotOcrDiagnostics = {
  sourceDimensions: ImageDimensions;
  processedDimensions: ImageDimensions;
  preprocessing: string;
};

const numberToken = "(\\d{1,3}(?:[ .,'’]\\d{3})*(?:[,.]\\d+)?|\\d+(?:[,.]\\d+)?)";
export const parseLocalizedNumber = (raw: string) => {
  if (!raw.trim()) return undefined;
  const compact = raw.replace(/[ '’]/g, "");
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimal = Math.max(comma, dot);
    return Number(compact.slice(0, decimal).replace(/[.,]/g, "") + "." + compact.slice(decimal + 1));
  }
  if (comma >= 0) return Number(compact.replace(/,(?=\d{3}(?:\D|$))/g, "").replace(",", "."));
  if (dot >= 0 && /\.\d{3}(?:\D|$)/.test(compact)) return Number(compact.replace(/\./g, ""));
  return Number(compact);
};

const labels = {
  distance: /\b(?:total\s+distance|distance|distanz|strecke|gesamtstrecke)\b/i,
  duration: /\b(?:verstrichene\s+zeit|elapsed\s+time|elapsed|total\s+time|moving\s+time|bewegungszeit|active\s+time|duration|dauer|gesamtzeit|zeit)\b/i,
  pace: /\b(?:average\s+pace|avg\.?\s*pace|durchschnitts?pace|durchschnitts?tempo|pace|tempo)\b/i,
  heartRate: /\b(?:average\s+heart\s*rate|avg\.?\s*(?:heart\s*rate|hr)|durchschnittliche?\s*(?:herzfrequenz|puls)|herzfrequenz|heart\s*rate|puls)\b/i,
  calories: /\b(?:calories|kcal|kalorien|energie|gesamtkalorien|gesamtenergie)\b/i,
  elevation: /\b(?:elevation\s+gain|elevation|ascent|höhenmeter|anstieg|hm)\b/i,
  steps: /\b(?:steps|schritte)\b/i,
  date: /\b(?:activity\s+date|workout\s+date|trainingstag|aktivitätsdatum|datum|date)\b/i,
  time: /\b(?:start(?:ed)?(?:\s*time)?|startzeit|began|begin(?:n)?|time\s+of\s+day|uhrzeit)\b/i,
};

function normalizeScreenshotOcrLines(text: string) {
  const metricLabels = "(?:activity\\s+date|workout\\s+date|trainingstag|aktivitätsdatum|date|datum|start(?:ed)?(?:\\s*time)?|startzeit|began|begin(?:n)?|time\\s+of\\s+day|uhrzeit|total\\s+distance|distance|distanz|strecke|gesamtstrecke|verstrichene\\s+zeit|elapsed\\s+time|elapsed|total\\s+time|moving\\s+time|bewegungszeit|active\\s+time|duration|dauer|gesamtzeit|average\\s+pace|avg\\.?\\s*pace|durchschnitts?pace|durchschnitts?tempo|best\\s+pace|fastest\\s+pace|bestes\\s+tempo|pace|tempo|average\\s+heart\\s*rate|avg\\.?\\s*(?:heart\\s*rate|hr)|durchschnittliche?\\s*(?:herzfrequenz|puls)|max(?:imum)?\\.?\\s*(?:heart\\s*rate|hr|herzfrequenz|puls)|höchst(?:e|er)?\\s*(?:herzfrequenz|puls)|herzfrequenz|heart\\s*rate|puls|calories|kcal|kalorien|energie|gesamtkalorien|gesamtenergie|elevation\\s+gain|elevation|ascent|höhenmeter|anstieg|hm|steps|schritte|average\\s+cadence|avg\\.?\\s*cadence|step\\s+rate|cadence|schrittfrequenz|trittfrequenz)";
  const protectedPhrases = /(?:average|avg\.?|best|fastest)\s+(?:pace|heart\s*rate|hr)|max(?:imum)?\.?\s+(?:heart\s*rate|hr)|best(?:es|e)?\s+tempo|höchst(?:e|er)?\s+(?:herzfrequenz|puls)|durchschnittliche?\s+(?:pace|herzfrequenz|puls)|verstrichene\s+zeit|elapsed\s+time|moving\s+time|total\s+time|activity\s+date|workout\s+date|elevation\s+gain|start\s+time|time\s+of\s+day/gi;
  return text.replace(/\r/g, "\n").replace(protectedPhrases, (phrase) => phrase.replace(/\s+/g, "\u0001"))
    .replace(new RegExp("\\s+(?=" + metricLabels + "\\b)", "gi"), "\n").replace(/\u0001/g, " ").split(/\n|[·•|;]/)
    .map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function safeDate(year: number, month: number, day: number) {
  if (year < 2000 || year > new Date().getFullYear() + 1 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? String(year) + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0") : "";
}

function hasYearlessActivityDate(line: string) {
  return /\b\d{1,2}\s*[./-]?\s*(?:jan(?:uar|uary)?|feb(?:ruar|ruary)?|märz|mär|mar(?:ch)?|apr(?:il)?|may|mai|jun(?:i|e)?|jul(?:i|y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|dez(?:ember)?|dec(?:ember)?)\.?\b/i.test(line)
    || /\b(?:date|datum)\s*[:·-]?\s*\d{1,2}[./]\d{1,2}\b/i.test(line);
}

function dateOnLine(line: string): string {
  const iso = line.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return safeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const european = line.match(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/);
  if (european) return safeDate(Number(european[3]), Number(european[2]), Number(european[1]));
  const months: Record<string, number> = {
    jan: 1, januar: 1, january: 1, feb: 2, februar: 2, february: 2, mar: 3, mär: 3, märz: 3, march: 3,
    apr: 4, april: 4, may: 5, mai: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, okt: 10, oktober: 10, october: 10,
    nov: 11, november: 11, dec: 12, dez: 12, dezember: 12, december: 12,
  };
  const named = line.match(/\b(\d{1,2})\s+([a-zä]{3,9})\.?,?\s+(20\d{2})\b|\b([a-zä]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (!named) return "";
  const day = Number(named[1] || named[5]);
  const month = months[(named[2] || named[4]).toLocaleLowerCase()];
  const year = Number(named[3] || named[6]);
  return month ? safeDate(year, month, day) : "";
}

type Candidate<T> = { value: T; source: string; rank: number };
function afterLabelCandidates<T>(
  lines: string[], label: RegExp, valuePattern: RegExp,
  parse: (match: RegExpMatchArray, line: string) => T | undefined,
  rankFor: (line: string) => number = () => 0, exclude?: RegExp,
): Candidate<T>[] {
  const found: Candidate<T>[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const labelMatch = label.exec(line);
    if (!labelMatch) continue;
    const labelIndex = labelMatch.index || 0;
    const from = labelIndex + labelMatch[0].length;
    const labelContext = line.slice(Math.max(0, labelIndex - 14), from);
    if (exclude?.test(labelContext)) continue;
    let tail = line.slice(from);
    let nextLabel = tail.length;
    for (const nextPattern of Object.values(labels)) {
      const nextMatch = nextPattern.exec(tail);
      if (nextMatch && nextMatch.index !== undefined && nextMatch.index > 0) nextLabel = Math.min(nextLabel, nextMatch.index);
    }
    tail = tail.slice(0, nextLabel);
    let match = tail.match(valuePattern);
    if (!match && lines[index + 1] && !Object.values(labels).some((nextLabel) => nextLabel.test(lines[index + 1]))) {
      tail = lines[index + 1];
      match = tail.match(valuePattern);
    }
    if (!match) continue;
    const value = parse(match, line);
    if (value !== undefined) found.push({ value, source: line, rank: rankFor(line) });
  }
  return found;
}

function chooseCandidate<T>(items: Candidate<T>[]) {
  if (!items.length) return { value: undefined as T | undefined, source: "", ambiguous: false, confidence: null as number | null };
  const bestRank = Math.min(...items.map((item) => item.rank));
  const best = items.filter((item) => item.rank === bestRank);
  const unique = new Map(best.map((item) => [JSON.stringify(item.value), item]));
  if (unique.size !== 1) return { value: undefined as T | undefined, source: "", ambiguous: true, confidence: 25 };
  const item = [...unique.values()][0];
  return { value: item.value, source: item.source, ambiguous: false, confidence: 92 };
}

function durationMinutes(raw: string, source: string) {
  const clock = raw.trim().match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (clock) {
    const first = Number(clock[1]), minute = Number(clock[2]), second = Number(clock[3] || 0);
    const likelyHoursMinutes = clock[3] === undefined
      && first <= 23
      && /\b(?:duration|dauer|elapsed|verstrichene|total\s+time|gesamtzeit)\b/i.test(source);
    const total = clock[3] !== undefined ? first * 60 + minute + second / 60
      : likelyHoursMinutes ? first * 60 + minute : first + minute / 60;
    return total > 0 && total <= 1440 ? String(Math.round(total)) : undefined;
  }
  const minuteMatch = raw.match(/^(\d+(?:[,.]\d+)?)\s*(?:min(?:ute)?s?|m)$/i);
  if (!minuteMatch) return undefined;
  const total = parseLocalizedNumber(minuteMatch[1]);
  return total !== undefined && total > 0 && total <= 1440 ? String(Math.round(total)) : undefined;
}

function parseTime(raw: string) {
  const match = raw.match(/\b(\d{1,2}):([0-5]\d)\s*(am|pm)?\b/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]), meridiem = match[3]?.toLowerCase();
  if (hour > 23 || (meridiem && (hour > 12 || hour === 0))) return undefined;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

function languageEstimate(text: string): ScreenshotParseReport["languageEstimate"] {
  const german = (text.match(/\b(?:distanz|strecke|dauer|zeit|verstrichen|bewegungszeit|durchschnitt|herzfrequenz|höhenmeter|kalorien|laufen|radfahren|schwimmen)\b/gi) || []).length;
  const english = (text.match(/\b(?:distance|duration|elapsed|moving|average|pace|heart|rate|elevation|calories|running|cycling|swimming|workout)\b/gi) || []).length;
  if (german && english) return "Mixed German and English";
  if (german) return "German";
  if (english) return "English";
  return "Unclear";
}

export function parseActivityScreenshotDetailed(text: string): ScreenshotParseReport {
  const lines = normalizeScreenshotOcrLines(text), clean = lines.join(" "), lower = clean.toLocaleLowerCase();
  const warnings: string[] = [], fieldConfidence: Record<string, number | null> = {}, fieldSources: Record<string, string> = {};
  const typeMatch = lower.match(/\b(?:trail\s+running|running|run|laufbandtraining|laufbandlauf|lauf(?:en)?|jogging|treadmill(?:\s+running|\s+workout)?|walking|walk|gehen|spaziergang|hiking|wandern|cycling|bike|radfahren|fahrrad|swimming|swim|schwimmen|strength|krafttraining|weight\s+training|yoga|pilates|bodyweight|calisthenics|körpergewicht)\b/);
  const typeText = typeMatch?.[0] || "";
  const type = /running|trail|^run$|lauf|jogging|treadmill/.test(typeText) ? "Running"
    : /walking|^walk$|gehen|spaziergang|hiking|wandern/.test(typeText) ? "Walking"
      : /cycling|bike|radfahren|fahrrad/.test(typeText) ? "Cycling"
        : /swimming|^swim$|schwimmen/.test(typeText) ? "Swimming"
          : /strength|krafttraining|weight/.test(typeText) ? "Strength"
            : /yoga/.test(typeText) ? "Yoga" : /pilates/.test(typeText) ? "Pilates"
              : /bodyweight|calisthenics|körpergewicht/.test(typeText) ? "Bodyweight" : "Other";
  fieldConfidence.type = type === "Other" ? null : 90;
  fieldSources.type = typeMatch?.[0] || "";
  const sourceApp = /\bgarmin\b/i.test(clean) ? "Garmin" : /\bstrava\b/i.test(clean) ? "Strava"
    : /\brunna\b/i.test(clean) ? "Runna" : /apple\s*(?:fitness|health)|fitness/i.test(clean) ? "Apple Fitness / Health" : "Unknown";
  fieldConfidence.sourceApp = sourceApp === "Unknown" ? null : 95;
  fieldSources.sourceApp = sourceApp === "Unknown" ? "" : sourceApp;

  const distancePattern = new RegExp("^\\s*" + numberToken + "\\s*(km|kilometers?|kilometres?|kilometer|kilometre|mi|miles?|m)\\b", "i");
  const distanceAnywhere = new RegExp(numberToken + "\\s*(km|kilometers?|kilometres?|kilometer|kilometre|mi|miles?|m)\\b", "gi");
  const distanceValue = (match: RegExpMatchArray) => {
    const value = parseLocalizedNumber(match[1]);
    if (value === undefined || value <= 0) return undefined;
    const unit = match[2].toLowerCase(), km = unit === "m" ? value / 1000 : /^(mi|mile)/.test(unit) ? value * 1.609344 : value;
    return km <= 1000 ? String(Math.round(km * 1000) / 1000) : undefined;
  };
  const distanceCandidates = afterLabelCandidates(lines, labels.distance, distancePattern, (match) => {
    return distanceValue(match);
  }, (line) => /\b(?:total\s+distance|gesamtstrecke)\b/i.test(line) ? 0 : 1,
  /\b(?:elevation|höhenmeter|ascent|anstieg|gain|pace|tempo|best|goal|target)\b/i);
  let distancePick = chooseCandidate(distanceCandidates);
  if (!distanceCandidates.length) {
    for (let index = 1; index < lines.length; index += 1) {
      if (!labels.distance.test(lines[index])) continue;
      const previousLine = lines[index - 1];
      const matches = [...previousLine.matchAll(distanceAnywhere)];
      const lastMatch = matches.at(-1);
      if (!lastMatch || /:(?:\s*)$/.test(previousLine.slice(0, lastMatch.index))) continue;
      const value = distanceValue(lastMatch);
      if (value) distanceCandidates.push({ value, source: previousLine + " → " + lines[index], rank: 0 });
    }
    distancePick = chooseCandidate(distanceCandidates);
  }
  if (!distanceCandidates.length) {
    const unlabelled: Candidate<string>[] = [];
    for (const line of lines) {
      if (/\b(?:elevation|höhenmeter|ascent|anstieg|gain|best|goal|target)\b/i.test(line)) continue;
      for (const match of line.matchAll(distanceAnywhere)) {
        if (/:(?:\s*)$/.test(line.slice(0, match.index))) continue;
        const value = parseLocalizedNumber(match[1]);
        if (value === undefined || value <= 0) continue;
        const unit = match[2].toLowerCase(), km = unit === "m" ? value / 1000 : /^(mi|mile)/.test(unit) ? value * 1.609344 : value;
        if (km <= 1000) unlabelled.push({ value: String(Math.round(km * 1000) / 1000), source: line, rank: 0 });
      }
    }
    distancePick = chooseCandidate(unlabelled);
    if (distancePick.value) distancePick.confidence = 58;
  }
  const distance = distancePick.value || "";
  if (distancePick.ambiguous) warnings.push("Multiple equally labelled distances were found; distance was left blank.");
  fieldConfidence.distance = distancePick.confidence; fieldSources.distance = distancePick.source;

  const durationPattern = /^\s*(\d{1,3}:[0-5]\d(?::[0-5]\d)?|\d+(?:[,.]\d+)?\s*(?:min(?:ute)?s?|m))\b/i;
  const durationCandidates = afterLabelCandidates(lines, labels.duration, durationPattern, (match, source) => durationMinutes(match[1], source),
    (line) => /\b(?:elapsed\s+time|verstrichene\s+zeit|total\s+time|gesamtzeit|duration|dauer)\b/i.test(line) ? 0
      : /\b(?:moving\s+time|bewegungszeit|active\s+time)\b/i.test(line) ? 2 : 1,
    /\b(?:pace|tempo|start(?:ed)?(?:\s*time)?|startzeit|best|fastest)\b/i);
  for (let index = 0; index < lines.length; index += 1) {
    if (!labels.duration.test(lines[index])) continue;
    const hasFollowingValue = durationCandidates.some((candidate) => candidate.source === lines[index]);
    if (hasFollowingValue) continue;
    for (let previous = index - 1; previous >= Math.max(0, index - 2); previous -= 1) {
      const clockMatches = [...lines[previous].matchAll(/\b(\d{1,3}:[0-5]\d(?::[0-5]\d)?)\b/g)];
      const lastClock = clockMatches.at(-1);
      if (!lastClock) continue;
      const value = durationMinutes(lastClock[1], lines[index]);
      if (value) durationCandidates.push({ value, source: lines[previous] + " → " + lines[index], rank: 0 });
      break;
    }
  }
  const durationPick = chooseCandidate(durationCandidates), duration = durationPick.value || "";
  if (durationCandidates.some((item) => /\b(?:moving\s+time|bewegungszeit)\b/i.test(item.source))
    && durationCandidates.some((item) => /\b(?:elapsed|verstrichene|total\s+time)\b/i.test(item.source))) {
    warnings.push("Moving time and elapsed time both appear; elapsed or total time is selected for review.");
  }
  if (durationPick.ambiguous) warnings.push("More than one equally labelled duration was found; duration was left blank.");
  fieldConfidence.duration = durationPick.confidence; fieldSources.duration = durationPick.source;

  const dateCandidates: Candidate<string>[] = [];
  for (const line of lines) {
    const value = dateOnLine(line);
    if (!value) continue;
    if (labels.date.test(line)) dateCandidates.push({ value, source: line, rank: 0 });
    else if (!/\b(?:screenshot|captured|created|downloaded|uploaded|printed|exported)\b/i.test(line)) dateCandidates.push({ value, source: line, rank: 1 });
  }
  const datePick = chooseCandidate(dateCandidates), date = datePick.value || "";
  fieldConfidence.date = datePick.confidence; fieldSources.date = datePick.source;
  if (datePick.ambiguous) warnings.push("Multiple possible activity dates were found; date was left blank.");
  if (!date && lines.some(hasYearlessActivityDate)) warnings.push("A date appears without a year; enter the year manually rather than guessing it.");

  const timeCandidates = afterLabelCandidates(lines, labels.time, /^\s*(\d{1,2}:[0-5]\d\s*(?:am|pm)?)/i, (match) => parseTime(match[1]));
  const dateAndStartTime = clean.match(/\b\d{1,2}\s*[./]?\s*(?:jan(?:uar|uary)?|feb(?:ruar|ruary)?|märz|mär|mar(?:ch)?|apr(?:il)?|may|mai|jun(?:i|e)?|jul(?:i|y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|dez(?:ember)?|dec(?:ember)?)\.?\s*[@,·-]?\s*(\d{1,2}:[0-5]\d)\b/i);
  if (dateAndStartTime) timeCandidates.push({ value: parseTime(dateAndStartTime[1]) || "", source: dateAndStartTime[0], rank: 0 });
  const timePick = chooseCandidate(timeCandidates), time = timePick.value || "";
  fieldConfidence.time = timePick.confidence; fieldSources.time = timePick.source;
  if (timePick.ambiguous) warnings.push("Multiple possible start times were found; start time was left blank.");

  const paceCandidates = afterLabelCandidates(lines, labels.pace, /^\s*(\d{1,2}:[0-5]\d)\s*(?:min\s*)?(\/\s*(?:km|mi|mile)|per\s+(?:km|mile))?/i,
    (match, line) => {
      if (/\b(?:best(?:es|e)?|fastest|maximum|max\.?)\s*(?:pace|tempo)\b/i.test(line)) return undefined;
      const unit = match[2] ? (match[2].toLowerCase().includes("mi") ? "min/mi" : "min/km") : "";
      const [minute, second] = match[1].split(":").map(Number);
      return minute > 0 && second < 60 ? minute + ":" + String(second).padStart(2, "0") + (unit ? " " + unit : "") : undefined;
    }, (line) => /\b(?:average|avg|durchschnitt)\b/i.test(line) ? 0 : 1,
    /\b(?:best(?:es|e)?|fastest|maximum|max\.?)\s*(?:pace|tempo)\b/i);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const paceContext = lines.slice(Math.max(0, index - 1), index + 1).join(" ");
    if (/\b(?:best(?:es|e)?|fastest|maximum|max\.?)\s*(?:pace|tempo)\b/i.test(paceContext)) continue;
    for (const match of line.matchAll(/\b(\d{1,2}):([0-5]\d)\s*(?:min\s*)?(\/\s*(km|mi|mile)|per\s+(km|mi|mile))\b/gi)) {
      const unit = (match[4] || match[5]).toLowerCase().startsWith("mi") ? "min/mi" : "min/km";
      paceCandidates.push({ value: match[1] + ":" + match[2] + " " + unit, source: line, rank: -1 });
    }
  }
  const pacePick = chooseCandidate(paceCandidates), pace = pacePick.value || "";
  if (pace && !/min\/(?:km|mi)$/.test(pace)) pacePick.confidence = 55;
  fieldConfidence.pace = pacePick.confidence; fieldSources.pace = pacePick.source;
  if (pacePick.ambiguous) warnings.push("Average pace is ambiguous; pace was left blank.");
  if (pace && pacePick.confidence === 55) warnings.push("Pace unit is missing; select min/km or min/mi before saving.");

  const hrCandidates = afterLabelCandidates(lines, labels.heartRate, /^\s*(\d{2,3})\s*(?:bpm|beats?\s*\/\s*min|schl(?:äge)?\s*\/\s*min)?/i,
    (match, line) => {
      if (/\b(?:max(?:imum)?|höchst(?:e|er)?|spitze)\s*(?:heart\s*rate|hr|herzfrequenz|puls)\b/i.test(line)) return undefined;
      const value = Number(match[1]); return value >= 30 && value <= 240 ? String(value) : undefined;
    }, (line) => /\b(?:average|avg|durchschnitt)\b/i.test(line) ? 0 : 1,
    /\b(?:max(?:imum)?|höchst(?:e|er)?|spitze)\s*(?:heart\s*rate|hr|herzfrequenz|puls)\b/i);
  for (let index = 0; index < lines.length; index += 1) {
    if (!labels.heartRate.test(lines[index]) || /\b(?:max(?:imum)?|höchst(?:e|er)?|spitze)\b/i.test(lines[index])) continue;
    for (let previous = index - 1; previous >= Math.max(0, index - 2); previous -= 1) {
      const bpm = lines[previous].match(/\b(\d{2,3})\s*(?:bpm|beats?\s*\/\s*min|schl(?:äge)?\s*\/\s*min)\b/i);
      if (!bpm) continue;
      const value = Number(bpm[1]);
      if (value >= 30 && value <= 240) hrCandidates.push({ value: String(value), source: lines[previous] + " → " + lines[index], rank: 0 });
      break;
    }
  }
  const hrPick = chooseCandidate(hrCandidates), heartRate = hrPick.value || "";
  fieldConfidence.heartRate = hrPick.confidence; fieldSources.heartRate = hrPick.source;

  const caloriesPick = chooseCandidate(afterLabelCandidates(lines, labels.calories, new RegExp("^\\s*" + numberToken, "i"),
    (match) => { const value = parseLocalizedNumber(match[1]); return value !== undefined && value > 0 && value <= 20000 ? String(Math.round(value)) : undefined; },
    () => 0, /\b(?:elevation|höhenmeter|pace|tempo|heart\s*rate|herzfrequenz)\b/i));
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\b(?:calories|kcal|kalorien|energie|gesamtkalorien|gesamtenergie)\b/i.test(lines[index])) continue;
    if (caloriesPick.value) break;
    for (let previous = index - 1; previous >= Math.max(0, index - 2); previous -= 1) {
      const numbers = [...lines[previous].matchAll(/\b(\d{2,5})\b/g)];
      const lastNumber = numbers.at(-1);
      if (!lastNumber) continue;
      const value = Number(lastNumber[1]);
      if (value > 0 && value <= 20000) {
        caloriesPick.value = String(value);
        caloriesPick.source = lines[previous] + " → " + lines[index];
        caloriesPick.confidence = 55;
      }
      break;
    }
  }
  const calories = caloriesPick.value || "";
  fieldConfidence.calories = caloriesPick.confidence; fieldSources.calories = caloriesPick.source;
  const elevationPick = chooseCandidate(afterLabelCandidates(lines, labels.elevation, new RegExp("^\\s*" + numberToken + "\\s*(m|meter|ft|feet)?", "i"),
    (match) => {
      const value = parseLocalizedNumber(match[1]), unit = match[2]?.toLowerCase();
      const meters = unit === "ft" || unit === "feet" ? (value || 0) * 0.3048 : value;
      return meters !== undefined && meters >= 0 && meters <= 100000 ? String(Math.round(meters)) : undefined;
    }));
  const elevation = elevationPick.value || "";
  fieldConfidence.elevation = elevationPick.confidence; fieldSources.elevation = elevationPick.source;
  const parseStepCount = (raw: string) => {
    const compact = raw.trim().replace(/[ '’]/g, "");
    if (!compact) return undefined;
    // Step totals are whole counts. A three-digit group after a comma or dot is
    // a thousands separator here (1,234 steps), never a decimal fraction.
    const grouped = compact.match(/^\d{1,3}(?:[.,]\d{3})+$/);
    const value = grouped ? Number(compact.replace(/[.,]/g, "")) : parseLocalizedNumber(compact);
    return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 200000
      ? String(Math.round(value)) : undefined;
  };
  const stepValuePattern = new RegExp("^\\s*" + numberToken + "(?=\\s|$)", "i");
  const stepCandidates = afterLabelCandidates(lines, labels.steps, stepValuePattern,
    (match) => parseStepCount(match[1]));
  // Some apps place the value before its label, or OCR puts the label on the
  // next line. Keep this context-bound so cadence and unrelated numbers do not
  // become a step total.
  for (let index = 0; index < lines.length; index += 1) {
    if (!labels.steps.test(lines[index])) continue;
    const existing = stepCandidates.some((candidate) => candidate.source === lines[index]);
    if (existing) continue;
    for (let previous = index; previous >= Math.max(0, index - 1); previous -= 1) {
      const match = lines[previous].match(new RegExp(numberToken + "\\s*(?:steps|schritte)\\b", "i"));
      const priorLineValue = previous < index ? lines[previous].match(new RegExp("^\\s*" + numberToken + "\\s*$", "i")) : null;
      const raw = match?.[1] || priorLineValue?.[1];
      const value = raw ? parseStepCount(raw) : undefined;
      if (value !== undefined) {
        stepCandidates.push({ value, source: lines[previous] + (previous < index ? " → " + lines[index] : ""), rank: 0 });
        break;
      }
    }
  }
  const stepsPick = chooseCandidate(stepCandidates);
  const steps = stepsPick.value || "";
  fieldConfidence.steps = stepsPick.confidence; fieldSources.steps = stepsPick.source;
  const cadenceLine = lines.find((line) => /\b(?:average\s+cadence|avg\.?\s*cadence|cadence|step\s+rate|steps?\s*\/\s*min|spm|schrittfrequenz|trittfrequenz)\b/i.test(line));
  const cadenceMatch = cadenceLine?.match(/\b(\d{2,3}(?:[,.]\d+)?)\s*(steps?\s*\/\s*min|steps?\s*per\s*min|spm|strides?\s*\/\s*min|strides?\s*per\s*min|stride\s*rate|schritte?\s*\/\s*min|schritte?\s*pro\s*min|schrittfrequenz|trittfrequenz)?\b/i);
  const cadenceValue = cadenceMatch ? parseLocalizedNumber(cadenceMatch[1]) : undefined;
  const cadenceUnit = cadenceMatch && cadenceValue !== undefined
    ? /stride|trittfrequenz/i.test(cadenceMatch[2] || "") ? "strides/min" as const
      : /steps?|spm|schrittfrequenz/i.test(cadenceMatch[2] || "") ? "steps/min" as const : undefined
    : undefined;
  const cadence = cadenceValue !== undefined && cadenceValue > 0 && cadenceValue <= 300 && cadenceUnit ? String(cadenceValue) : "";
  const movingCandidate = durationCandidates.filter((candidate) => /\b(?:moving\s+time|bewegungszeit|active\s+time)\b/i.test(candidate.source))
    .sort((a, b) => a.rank - b.rank)[0];
  const movingDurationMinutes = movingCandidate?.value || "";

  const uncertain = [
    ...(type === "Other" ? ["type"] : []), ...(!date || datePick.ambiguous ? ["date"] : []),
    ...(!time || timePick.ambiguous ? ["time"] : []), ...(!duration || durationPick.ambiguous ? ["duration"] : []),
    ...(!distance || distancePick.ambiguous || (distancePick.confidence !== null && distancePick.confidence < 60) ? ["distance"] : []), ...(pacePick.ambiguous || (pacePick.confidence !== null && pacePick.confidence < 60) ? ["pace"] : []),
    ...(hrPick.ambiguous || (hrPick.confidence !== null && hrPick.confidence < 60) ? ["heartRate"] : []),
    ...(caloriesPick.confidence !== null && caloriesPick.confidence < 60 ? ["calories"] : []),
    ...(sourceApp === "Unknown" ? ["sourceApp"] : []),
  ];
  if (type === "Other") warnings.push("Activity type was not recognized; choose it manually.");
  if (!date) warnings.push("Activity date was not reliably recognized; enter it manually.");
  if (!time) warnings.push("Start time was not reliably recognized; enter it manually.");
  if (!duration) warnings.push("Duration was not reliably recognized; enter it manually.");
  if (!distance && ["Running", "Cycling", "Swimming"].includes(type)) warnings.push("Distance was not reliably recognized; enter it manually.");
  if (!steps && type === "Running") warnings.push("No measured step total was recognized; a clearly labeled estimate is available when distance and pace are valid.");
  return {
    draft: { type, date, time, duration, distance, pace, heartRate, calories, elevation, steps, sourceApp, notes: "", uncertain, cadence, cadenceUnit, movingDurationMinutes },
    fieldConfidence, fieldSources, warnings, languageEstimate: languageEstimate(clean),
  };
}

export function parseActivityScreenshot(text: string): ScreenshotDraft {
  return parseActivityScreenshotDetailed(text).draft;
}

export function screenshotFileError(file: Pick<File, "type" | "size">): string | null {
  if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(file.type)) return "Choose a PNG, JPG, JPEG or WEBP image.";
  if (file.size > 15 * 1024 * 1024) return "This image is larger than 15 MB. Choose a smaller screenshot.";
  return null;
}

type OcrResult = { data: { text: string; confidence?: number } };
type TesseractApi = {
  createWorker: (languages: string[], oem: number, options: Record<string, unknown>) => Promise<TesseractWorker>;
};
type TesseractWorker = {
  recognize: (image: File | HTMLCanvasElement) => Promise<OcrResult>;
  setParameters: (parameters: Record<string, string | number>) => Promise<void>;
  terminate: () => Promise<void>;
};

export function resolveTesseractApi(imported: unknown): TesseractApi {
  const candidates: unknown[] = [imported];
  if (imported && typeof imported === "object") {
    const outerDefault = (imported as { default?: unknown }).default;
    candidates.push(outerDefault);
    if (outerDefault && typeof outerDefault === "object") {
      candidates.push((outerDefault as { default?: unknown }).default);
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object"
      && typeof (candidate as { createWorker?: unknown }).createWorker === "function") {
      return candidate as TesseractApi;
    }
  }
  const exports = imported && typeof imported === "object" ? Object.keys(imported).join(", ") : typeof imported;
  throw new Error("Tesseract.js 6.0.1 loaded without a usable createWorker export. Module exports: " + exports);
}

export function calculatePreprocessDimensions(width: number, height: number): ImageDimensions {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("The screenshot has invalid image dimensions.");
  }
  const maxEdge = Math.max(width, height), pixels = width * height;
  const maxDimension = 3000, maxPixels = 3_600_000;
  let scale = 1;
  if (maxEdge > maxDimension || pixels > maxPixels) {
    scale = Math.min(maxDimension / maxEdge, Math.sqrt(maxPixels / pixels));
  } else if (maxEdge < 1500) {
    scale = Math.min(1.6, 1600 / maxEdge, Math.sqrt(maxPixels / pixels));
  }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function decodeScreenshot(image: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      // Explicitly honor EXIF orientation so portrait phone images stay upright.
      return await createImageBitmap(image, { imageOrientation: "from-image" });
    } catch {
      try { return await createImageBitmap(image); } catch { /* use the browser image decoder below */ }
    }
  }
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    return element;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function preprocessScreenshot(image: File): Promise<{
  canvas: HTMLCanvasElement;
  diagnostics: ScreenshotOcrDiagnostics;
}> {
  const decoded = await decodeScreenshot(image);
  try {
    const sourceDimensions = { width: decoded.width, height: decoded.height };
    const processedDimensions = calculatePreprocessDimensions(decoded.width, decoded.height);
    const canvas = document.createElement("canvas");
    canvas.width = processedDimensions.width;
    canvas.height = processedDimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas image processing is unavailable.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded, 0, 0, canvas.width, canvas.height);
    return { canvas, diagnostics: { sourceDimensions, processedDimensions, preprocessing: "EXIF-aware decode; bounded resize; color preserved" } };
  } finally {
    if ("close" in decoded && typeof decoded.close === "function") decoded.close();
  }
}

function createContrastScreenshot(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas contrast processing is unavailable.");
  context.filter = "grayscale(1) contrast(1.2)";
  context.drawImage(source, 0, 0);
  context.filter = "none";
  return canvas;
}

function needsContrastPass(result: OcrResult) {
  const text = result.data.text;
  const draft = parseActivityScreenshotDetailed(text).draft;
  return (result.data.confidence ?? 0) < 75
    || !draft.distance
    || (/(?:steps|schritte)/i.test(text) && !draft.steps)
    || (/(?:\bdate\b|\bdatum\b)/i.test(text) && !draft.date);
}

function resultScore(result: OcrResult) {
  const draft = parseActivityScreenshotDetailed(result.data.text).draft;
  const populated = [draft.time, draft.duration, draft.pace, draft.heartRate, draft.calories].filter(Boolean).length;
  const critical = Number(Boolean(draft.date)) * 12 + Number(Boolean(draft.distance)) * 12 + Number(Boolean(draft.steps)) * 10;
  return (result.data.confidence || 0) + populated * 2 + critical;
}

export async function recognizeScreenshot(image: File, onProgress: (status: string, progress: number, diagnostics?: ScreenshotOcrDiagnostics) => void): Promise<{
  draft: ScreenshotDraft; confidence: number; rawText: string; languages: string; report: ScreenshotParseReport; diagnostics: ScreenshotOcrDiagnostics;
}> {
  onProgress("Preparing screenshot", 0);
  const prepared = await preprocessScreenshot(image);
  onProgress("Loading OCR engine", 0, prepared.diagnostics);
  const importModule = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;
  const imported = await importModule("https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js");
  const tesseract = resolveTesseractApi(imported);
  onProgress("Starting OCR worker", 0, prepared.diagnostics);
  const worker = await tesseract.createWorker(["eng", "deu"], 1, {
    workerPath: "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js",
    corePath: "https://cdn.jsdelivr.net/npm/tesseract.js-core@v6.0.0",
    langPath: "https://tessdata.projectnaptha.com/4.0.0",
    logger: (event: { status?: string; progress?: number }) => onProgress(event.status || "Reading text", event.progress || 0),
  });
  let contrastCanvas: HTMLCanvasElement | null = null;
  let finalDiagnostics = prepared.diagnostics;
  try {
    onProgress("Recognizing screenshot", 0, prepared.diagnostics);
    await worker.setParameters({ tessedit_pageseg_mode: 6 });
    const first = await worker.recognize(prepared.canvas);
    let selected = first;
    if (needsContrastPass(first)) {
      finalDiagnostics = {
        ...prepared.diagnostics,
        preprocessing: prepared.diagnostics.preprocessing + "; grayscale/contrast comparison enabled",
      };
      onProgress("Checking contrast-assisted recognition", 0.5, finalDiagnostics);
      try {
        contrastCanvas = createContrastScreenshot(prepared.canvas);
        await worker.setParameters({ tessedit_pageseg_mode: 11 });
        const alternate = await worker.recognize(contrastCanvas);
        if (resultScore(alternate) > resultScore(first)) selected = alternate;
      } catch {
        finalDiagnostics = { ...finalDiagnostics, preprocessing: finalDiagnostics.preprocessing + "; comparison unavailable; color-preserved result retained" };
        onProgress("Using the color-preserved OCR result", 1, finalDiagnostics);
      }
    }
    const report = parseActivityScreenshotDetailed(selected.data.text);
    return { draft: report.draft, confidence: selected.data.confidence || 0, rawText: selected.data.text,
      languages: "English (eng) + German (deu)", report, diagnostics: finalDiagnostics };
  } finally {
    await worker.terminate();
    prepared.canvas.width = 0;
    prepared.canvas.height = 0;
    if (contrastCanvas) { contrastCanvas.width = 0; contrastCanvas.height = 0; }
  }
}

export async function fingerprintScreenshot(file: File, userId: string, canonical: string): Promise<string> {
  void file;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId + "|" + canonical));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
