export type Granularity = "day" | "week" | "month" | "quarter" | "year" | "all";

export interface Period {
  granularity: Granularity;
  anchor: string;       // "2026-06-17" | "2026-W25" | "2026-06" | "2026-Q2" | "2026" | "all"
  from: string;         // "YYYY-MM-DD" inclusive
  toExclusive: string;  // "YYYY-MM-DD" exclusive
  label: string;        // "17 Jun 2026" | "15–21 Jun 2026" | "June 2026" | "Q2 2026" | "2026" | "All time"
  isCurrent: boolean;
}

export interface Bucket {
  key: string;
  label: string;
  from: string;
  toExclusive: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const DAY_MS = 86_400_000;

/** Bars shown on the Day view's trend: the selected day plus 13 before it. */
export const DAY_TREND_WINDOW = 14;

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, "0");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const parseIso = (d: string) => new Date(`${d}T00:00:00Z`);
const shiftDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const today = (now: Date) => now.toISOString().slice(0, 10);

/** Monday of the ISO week containing `d`. ISO weeks run Mon–Sun. */
function mondayOf(d: string): string {
  const dow = parseIso(d).getUTCDay(); // 0 = Sunday
  return shiftDays(d, -((dow + 6) % 7));
}

/**
 * ISO-8601 week anchor ("2026-W25") for a Monday. The ISO year is the year of
 * that week's Thursday, which is why W01 can start in December of the year
 * before (2026-W01 begins Mon 29 Dec 2025).
 */
function isoWeekAnchor(monday: string): string {
  const thursday = parseIso(shiftDays(monday, 3));
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1;
  return `${year}-W${pad2(week)}`;
}

/** Monday starting ISO week `w` of ISO year `y`. 4 January is always in W01. */
function mondayOfIsoWeek(y: number, w: number): string {
  return shiftDays(mondayOf(iso(y, 0, 4)), (w - 1) * 7);
}

/** "17 Jun 2026" — the form used in week ranges and day labels. */
const longDay = (d: string) => {
  const t = parseIso(d);
  return `${t.getUTCDate()} ${SHORT[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
};

/**
 * Week range label, tightened to what actually differs: "15–21 Jun 2026"
 * inside one month, "31 Aug – 6 Sep 2026" across two, and both years spelled
 * out when the week straddles New Year.
 */
function weekLabel(monday: string): string {
  const a = parseIso(monday);
  const b = parseIso(shiftDays(monday, 6));
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${longDay(monday)} – ${longDay(shiftDays(monday, 6))}`;
  if (a.getUTCMonth() !== b.getUTCMonth()) {
    return `${a.getUTCDate()} ${SHORT[a.getUTCMonth()]} – ${b.getUTCDate()} ${SHORT[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  }
  return `${a.getUTCDate()}–${b.getUTCDate()} ${SHORT[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
}

function resolveWeek(monday: string, now: Date): Period {
  const toExclusive = shiftDays(monday, 7);
  const t = today(now);
  return {
    granularity: "week",
    anchor: isoWeekAnchor(monday),
    from: monday,
    toExclusive,
    label: weekLabel(monday),
    isCurrent: monday <= t && t < toExclusive,
  };
}

function resolveDay(day: string, now: Date): Period {
  return {
    granularity: "day",
    anchor: day,
    from: day,
    toExclusive: shiftDays(day, 1),
    label: longDay(day),
    isCurrent: day === today(now),
  };
}

function resolveMonth(y: number, m: number, now: Date): Period {
  return {
    granularity: "month",
    anchor: `${y}-${pad2(m + 1)}`,
    from: iso(y, m, 1),
    toExclusive: iso(y, m + 1, 1),
    label: `${MONTHS[m]} ${y}`,
    isCurrent: y === now.getUTCFullYear() && m === now.getUTCMonth(),
  };
}

function resolveQuarter(y: number, q: number, now: Date): Period {
  const startM = (q - 1) * 3;
  const nowQ = Math.floor(now.getUTCMonth() / 3) + 1;
  return {
    granularity: "quarter",
    anchor: `${y}-Q${q}`,
    from: iso(y, startM, 1),
    toExclusive: iso(y, startM + 3, 1),
    label: `Q${q} ${y}`,
    isCurrent: y === now.getUTCFullYear() && q === nowQ,
  };
}

function resolveYear(y: number, now: Date): Period {
  return {
    granularity: "year",
    anchor: `${y}`,
    from: iso(y, 0, 1),
    toExclusive: iso(y + 1, 0, 1),
    label: `${y}`,
    isCurrent: y === now.getUTCFullYear(),
  };
}

export function parsePeriod(param: string | undefined, now: Date, fallback: Exclude<Granularity, "all"> = "month"): Period {
  let m: RegExpMatchArray | null;
  if (param && (m = param.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    // Round-trip guard: Date accepts 2026-02-30 and rolls it into March.
    const day = iso(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (day === param) return resolveDay(day, now);
  } else if (param && (m = param.match(/^(\d{4})-W(\d{2})$/))) {
    const week = Number(m[2]);
    if (week >= 1 && week <= 53) {
      const monday = mondayOfIsoWeek(Number(m[1]), week);
      // A 53rd week in a 52-week ISO year resolves into the next year — reject
      // rather than silently showing a different week than the URL asked for.
      if (isoWeekAnchor(monday) === param) return resolveWeek(monday, now);
    }
  } else if (param && (m = param.match(/^(\d{4})-(\d{2})$/))) {
    const month = Number(m[2]) - 1;
    if (month >= 0 && month <= 11) return resolveMonth(Number(m[1]), month, now);
  } else if (param && (m = param.match(/^(\d{4})-Q([1-4])$/))) {
    return resolveQuarter(Number(m[1]), Number(m[2]), now);
  } else if (param && (m = param.match(/^(\d{4})$/))) {
    return resolveYear(Number(m[1]), now);
  }
  return currentPeriod(fallback, now);
}

export function currentPeriod(g: Granularity, now: Date): Period {
  const y = now.getUTCFullYear();
  if (g === "day") return resolveDay(today(now), now);
  if (g === "week") return resolveWeek(mondayOf(today(now)), now);
  if (g === "month") return resolveMonth(y, now.getUTCMonth(), now);
  if (g === "quarter") return resolveQuarter(y, Math.floor(now.getUTCMonth() / 3) + 1, now);
  return resolveYear(y, now);
}

/**
 * All-time period: spans the full data range. `from` comes from `earliest`
 * (the first month with data) so the trend doesn't enumerate empty months; no
 * stepping (from === earliest → canStepBack false; isCurrent → canStepForward false).
 */
export function allTimePeriod(earliest: string, now: Date): Period {
  return {
    granularity: "all",
    anchor: "all",
    from: `${earliest}-01`,
    toExclusive: iso(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    label: "All time",
    isCurrent: true,
  };
}

export function stepPeriod(p: Period, dir: -1 | 1, now: Date): Period {
  if (p.granularity === "day") return resolveDay(shiftDays(p.from, dir), now);
  if (p.granularity === "week") return resolveWeek(shiftDays(p.from, dir * 7), now);
  const y = Number(p.from.slice(0, 4));
  const m = Number(p.from.slice(5, 7)) - 1; // 0-indexed start month
  if (p.granularity === "month") {
    const d = new Date(Date.UTC(y, m + dir, 1));
    return resolveMonth(d.getUTCFullYear(), d.getUTCMonth(), now);
  }
  if (p.granularity === "quarter") {
    const d = new Date(Date.UTC(y, m + dir * 3, 1));
    return resolveQuarter(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) + 1, now);
  }
  return resolveYear(y + dir, now);
}

export function enumerateBuckets(p: Period): Bucket[] {
  const out: Bucket[] = [];
  const startMs = Date.parse(`${p.from}T00:00:00Z`);
  const endMs = Date.parse(`${p.toExclusive}T00:00:00Z`);

  if (p.granularity === "day") {
    // A single day is one bucket — a chart of one bar says nothing. Look back
    // 13 days so the day is read in context; the caller highlights the last
    // bar, and every other panel still shows the selected day alone.
    const first = shiftDays(p.from, -(DAY_TREND_WINDOW - 1));
    for (let i = 0; i < DAY_TREND_WINDOW; i++) {
      const from = shiftDays(first, i);
      const d = parseIso(from);
      out.push({ key: from, label: `${d.getUTCDate()} ${SHORT[d.getUTCMonth()]}`, from, toExclusive: shiftDays(from, 1) });
    }
  } else if (p.granularity === "week") {
    for (let t = startMs; t < endMs; t += DAY_MS) {
      const key = new Date(t).toISOString().slice(0, 10);
      const d = new Date(t);
      out.push({ key, label: `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`, from: key, toExclusive: shiftDays(key, 1) });
    }
  } else if (p.granularity === "month") {
    for (let t = startMs; t < endMs; t += DAY_MS) {
      const key = new Date(t).toISOString().slice(0, 10);
      out.push({ key, label: String(new Date(t).getUTCDate()), from: key, toExclusive: new Date(t + DAY_MS).toISOString().slice(0, 10) });
    }
  } else if (p.granularity === "quarter") {
    for (let t = startMs; t < endMs; t += 7 * DAY_MS) {
      const from = new Date(t).toISOString().slice(0, 10);
      const next = Math.min(t + 7 * DAY_MS, endMs);
      const d = new Date(t);
      out.push({ key: from, label: `${SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`, from, toExclusive: new Date(next).toISOString().slice(0, 10) });
    }
  } else if (p.granularity === "all") {
    // monthly buckets across the whole data span; year-aware labels ("May 25")
    let y = Number(p.from.slice(0, 4));
    let mo = Number(p.from.slice(5, 7)) - 1;
    for (let from = iso(y, mo, 1); from < p.toExclusive; from = iso(y, mo, 1)) {
      out.push({ key: `${y}-${pad2(mo + 1)}`, label: `${SHORT[mo]} ${String(y).slice(2)}`, from, toExclusive: iso(y, mo + 1, 1) });
      if (++mo > 11) { mo = 0; y++; }
    }
  } else {
    const y = Number(p.from.slice(0, 4));
    for (let mo = 0; mo < 12; mo++) {
      out.push({ key: `${y}-${pad2(mo + 1)}`, label: SHORT[mo], from: iso(y, mo, 1), toExclusive: iso(y, mo + 1, 1) });
    }
  }
  return out;
}

export function canStepForward(p: Period): boolean {
  return !p.isCurrent; // the current period is the latest; no future data
}

export function canStepBack(p: Period, earliest: string): boolean {
  // Day precision: a month/quarter/year always starts on the 1st, so this
  // matches the old month-precision compare for them, while letting a day or
  // week step around inside the earliest month with data.
  return p.from > `${earliest}-01`;
}

/**
 * The trend bucket to pick out, if any. Only the Day view has one: its chart
 * shows the trailing fortnight, so the selected day is the last bucket.
 */
export function highlightBucketLabel(p: Period): string | undefined {
  if (p.granularity !== "day") return undefined;
  const buckets = enumerateBuckets(p);
  return buckets[buckets.length - 1].label;
}
