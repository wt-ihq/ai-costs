"use client";

import { useMemo, useState } from "react";
import type { PersonRow } from "@/lib/queries/people";
import { VENDOR_LABEL } from "@/lib/types";
import { formatUsd } from "@/lib/utils";
import { cn } from "@/lib/utils";

type SortKey = "name" | "department" | "seatCost" | "overage" | "metered" | "total";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: "name", label: "Person" },
  { key: "department", label: "Department" },
  { key: "seatCost", label: "Seat", numeric: true },
  { key: "overage", label: "Overage", numeric: true },
  { key: "metered", label: "Metered", numeric: true },
  { key: "total", label: "Total", numeric: true },
];

export function PeopleTable({ rows }: { rows: PersonRow[] }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("total");
  const [asc, setAsc] = useState(false);
  const [zeroOnly, setZeroOnly] = useState(false);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (zeroOnly && !r.zeroActivity) return false;
      if (!needle) return true;
      return (
        r.name.toLowerCase().includes(needle) ||
        (r.department ?? "").toLowerCase().includes(needle)
      );
    });
    const dir = asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [rows, q, sort, asc, zeroOnly]);

  const onSort = (k: SortKey) => {
    if (k === sort) setAsc((v) => !v);
    else {
      setSort(k);
      setAsc(false);
    }
  };

  const zeroCount = rows.filter((r) => r.zeroActivity).length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search person or department…"
          className="w-64 rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          onClick={() => setZeroOnly((v) => !v)}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm transition-colors",
            zeroOnly ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:text-foreground",
          )}
        >
          Zero-activity seats ({zeroCount})
        </button>
        <span className="ml-auto text-xs text-muted">{view.length} people</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => onSort(c.key)}
                  className={cn("cursor-pointer select-none px-4 py-3 font-medium hover:text-foreground", c.numeric && "text-right")}
                >
                  {c.label}
                  {sort === c.key && <span className="ml-1">{asc ? "▲" : "▼"}</span>}
                </th>
              ))}
              <th className="px-4 py-3 font-medium">Seats</th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <tr
                key={r.employeeId}
                className={cn(
                  "border-b border-border/60 last:border-0 hover:bg-surface-2/40",
                  r.zeroActivity && "bg-pink-500/5",
                )}
              >
                <td className="px-4 py-2.5 font-medium">
                  {r.name}
                  {r.zeroActivity && (
                    <span className="ml-2 rounded bg-pink-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-pink-300">
                      idle seat
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{r.department ?? "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{formatUsd(r.seatCost)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{r.overage ? formatUsd(r.overage) : "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{r.metered ? formatUsd(r.metered) : "—"}</td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">{formatUsd(r.total)}</td>
                <td className="px-4 py-2.5 text-xs text-muted">
                  {r.seatVendors.map((v) => VENDOR_LABEL[v]).join(", ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
