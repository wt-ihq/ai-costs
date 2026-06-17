export type Granularity = "month" | "quarter" | "year" | "all";

export interface Period {
  granularity: Granularity;
  anchor: string;       // "2026-06" | "2026-Q2" | "2026" | "all"
  from: string;         // "YYYY-MM-DD" inclusive
  toExclusive: string;  // "YYYY-MM-DD" exclusive
  label: string;        // "June 2026" | "Q2 2026" | "2026" | "All time"
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

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const pad2 = (n: number) => String(n).padStart(2, "0");

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

export function parsePeriod(param: string | undefined, now: Date): Period {
  let m: RegExpMatchArray | null;
  if (param && (m = param.match(/^(\d{4})-(\d{2})$/))) {
    const month = Number(m[2]) - 1;
    if (month >= 0 && month <= 11) return resolveMonth(Number(m[1]), month, now);
  } else if (param && (m = param.match(/^(\d{4})-Q([1-4])$/))) {
    return resolveQuarter(Number(m[1]), Number(m[2]), now);
  } else if (param && (m = param.match(/^(\d{4})$/))) {
    return resolveYear(Number(m[1]), now);
  }
  return resolveMonth(now.getUTCFullYear(), now.getUTCMonth(), now);
}

export function currentPeriod(g: Granularity, now: Date): Period {
  const y = now.getUTCFullYear();
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

  if (p.granularity === "month") {
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
  return p.from.slice(0, 7) > earliest; // don't step entirely before the first data month
}
