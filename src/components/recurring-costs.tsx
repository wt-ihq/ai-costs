"use client";

import { useState, useTransition } from "react";
import { saveRecurringCost, endRecurringCost, deleteRecurringCost, type RecurringCostInput } from "@/app/(dashboard)/imports/actions";
import { formatUsd } from "@/lib/utils";

export interface RecurringCostRow {
  id: string;
  tool: string;
  color: string;
  department: string | null;
  kind: "monthly" | "contract";
  amount: number;
  currency: string;
  fxRate: number;
  startMonth: string; // YYYY-MM
  endMonth: string | null; // YYYY-MM
  monthlyUsd: number;
}

type Kind = "monthly" | "contract";
type Currency = "USD" | "GBP" | "EUR";

const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", GBP: "£", EUR: "€" };
const FX_FALLBACK: Record<Exclude<Currency, "USD">, number> = { GBP: 1.27, EUR: 1.17 };

function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOL[currency as Currency] ?? `${currency} `;
  return `${symbol}${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function termsFor(row: RecurringCostRow): string {
  const amountStr = formatAmount(row.amount, row.currency);
  if (row.kind === "monthly") {
    return `${amountStr}/mo from ${row.startMonth}${row.endMonth ? ` until ${row.endMonth}` : ""}`;
  }
  return `${amountStr} · ${row.startMonth} → ${row.endMonth}`;
}

export function RecurringCosts({ entries, departments }: { entries: RecurringCostRow[]; departments: string[] }) {
  const initialMonth = new Date().toISOString().slice(0, 7);
  const toolNames = [...new Set(entries.map((e) => e.tool))].sort();

  const prefillRate = (tool: string, currency: Currency): number => {
    if (currency === "USD") return 1;
    const matches = entries.filter((e) => e.tool.toLowerCase() === tool.trim().toLowerCase() && e.currency === currency);
    if (matches.length) {
      const latest = matches.reduce((a, b) => (b.startMonth > a.startMonth ? b : a));
      return latest.fxRate;
    }
    return FX_FALLBACK[currency];
  };

  const [tool, setTool] = useState("");
  const [department, setDepartment] = useState("");
  const [kind, setKind] = useState<Kind>("monthly");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [rate, setRate] = useState("1");
  const [startMonth, setStartMonth] = useState(initialMonth);
  const [endMonth, setEndMonth] = useState("");

  const [endInputs, setEndInputs] = useState<Record<string, string>>({});

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onToolBlur = () => {
    if (currency !== "USD") setRate(String(prefillRate(tool, currency)));
  };

  const onCurrency = (c: Currency) => {
    setCurrency(c);
    setRate(c === "USD" ? "1" : String(prefillRate(tool, c)));
  };

  const run = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      setSaved(null);
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });

  const resetForm = () => {
    setTool("");
    setDepartment("");
    setKind("monthly");
    setAmount("");
    setCurrency("USD");
    setRate("1");
    setStartMonth(initialMonth);
    setEndMonth("");
  };

  const hasInput = tool.trim() !== "" && startMonth !== "" && amount.trim() !== "" && (kind === "monthly" || endMonth !== "");

  const onSave = () =>
    run(async () => {
      const input: RecurringCostInput = {
        tool,
        department: department.trim() || null,
        kind,
        amount: Number(amount) || 0,
        currency,
        fxRate: Number(rate) || 1,
        startMonth,
        endMonth: endMonth || null,
      };
      const { written } = await saveRecurringCost(input);
      setSaved(`Saved ${tool} — ${written} facts written.`);
      resetForm();
    });

  const onEnd = (row: RecurringCostRow) =>
    run(async () => {
      const em = endInputs[row.id] ?? initialMonth;
      const { written } = await endRecurringCost(row.id, em);
      setSaved(`Ended ${row.tool} at ${em} — ${written} facts written.`);
    });

  const onRemove = (row: RecurringCostRow) =>
    run(async () => {
      const { written } = await deleteRecurringCost(row.id);
      setSaved(`Removed ${row.tool} — ${written} facts written.`);
    });

  return (
    <div className="space-y-3">
      <datalist id="recurring-tool-names">
        {toolNames.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <datalist id="recurring-departments">
        {departments.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Tool
          <input
            type="text"
            list="recurring-tool-names"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            onBlur={onToolBlur}
            placeholder="e.g. Midjourney"
            className="w-40 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
        </label>
        <label className="flex items-center gap-2 text-muted">
          Department
          <input
            type="text"
            list="recurring-departments"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
            placeholder="Unattributed"
            className="w-40 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setKind("monthly")}
            className={`rounded-md border px-2 py-1 ${kind === "monthly" ? "border-accent bg-accent/15 text-accent" : "border-border text-muted"}`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setKind("contract")}
            className={`rounded-md border px-2 py-1 ${kind === "contract" ? "border-accent bg-accent/15 text-accent" : "border-border text-muted"}`}
          >
            Contract
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Amount
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-24 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
        </label>
        <label className="flex items-center gap-2 text-muted">
          Currency
          <select
            value={currency}
            onChange={(e) => onCurrency(e.target.value as Currency)}
            className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          >
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
            <option value="EUR">EUR</option>
          </select>
        </label>
        {currency !== "USD" && (
          <label className="flex items-center gap-2 text-muted">
            {currency} → $ rate
            <input
              type="number"
              min="0"
              step="0.0001"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className="w-20 rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
            />
          </label>
        )}
        <label className="flex items-center gap-2 text-muted">
          Start month
          {/* Default is the client's local date; the server-rendered value can differ by a day. */}
          <input
            type="month"
            value={startMonth}
            onChange={(e) => setStartMonth(e.target.value)}
            suppressHydrationWarning
            className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
        </label>
        <label className="flex items-center gap-2 text-muted">
          End month {kind === "monthly" && "(optional)"}
          <input
            type="month"
            value={endMonth}
            onChange={(e) => setEndMonth(e.target.value)}
            className="rounded-md border border-border bg-surface-2 px-2 py-1 text-foreground outline-none focus:border-accent"
          />
        </label>
        <button
          onClick={onSave}
          disabled={pending || !hasInput}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-accent disabled:opacity-40"
        >
          {pending ? "Saving…" : "Add entry"}
        </button>
      </div>

      {error && (
        <p className="rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300">Failed: {error}</p>
      )}
      {saved && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{saved}</p>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">Department</th>
                <th className="px-3 py-2 font-medium">Terms</th>
                <th className="px-3 py-2 text-right font-medium">$/mo equiv.</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => {
                const active = row.kind === "monthly" && row.endMonth === null;
                return (
                  <tr key={row.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 font-medium">
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                        {row.tool}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted">{row.department ?? "Unattributed"}</td>
                    <td className="px-3 py-2 text-muted">{termsFor(row)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatUsd(row.monthlyUsd)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {active && (
                          <>
                            <input
                              type="month"
                              value={endInputs[row.id] ?? initialMonth}
                              onChange={(e) => setEndInputs((prev) => ({ ...prev, [row.id]: e.target.value }))}
                              className="w-28 rounded-md border border-border bg-surface-2 px-1.5 py-1 text-xs text-foreground outline-none focus:border-accent"
                            />
                            <button onClick={() => onEnd(row)} disabled={pending} className="text-xs text-accent hover:underline disabled:opacity-40">
                              end
                            </button>
                          </>
                        )}
                        <button onClick={() => onRemove(row)} disabled={pending} className="text-xs text-pink-300 hover:underline disabled:opacity-40">
                          remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
