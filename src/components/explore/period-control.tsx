"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";

/** Month picker; navigates with ?month= so the server refetches. */
export function PeriodControl({ months }: { months: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("month") ?? months[0];
  return (
    <select
      value={current}
      onChange={(e) => {
        const p = new URLSearchParams(params.toString());
        p.set("month", e.target.value);
        router.push(`${pathname}?${p.toString()}`);
      }}
      className="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
    >
      {months.map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}
