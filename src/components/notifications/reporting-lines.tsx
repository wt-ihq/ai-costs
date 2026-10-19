"use client";

import { useState, useTransition } from "react";
import { addCompanyRecipients, addRecipients } from "@/app/(dashboard)/data/notifications-actions";
import { branchIds, managersIn, type OrgNode, type OrgTree } from "@/lib/notify/org-tree";
import { CADENCES, type Cadence } from "@/lib/notify/types";
import { CADENCE_LABEL } from "./recipients-table";

type List = "personal" | "company";

interface RowProps {
  node: OrgNode;
  depth: number;
  open: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  toggleOpen: (id: string) => void;
  select: (ids: string[], on?: boolean) => void;
}

/** One person, their counts and current cadences, and (for a manager) their reports beneath. */
function Row({ node, depth, open, selected, toggleOpen, select }: RowProps) {
  const isOpen = open.has(node.id);
  const hasKids = node.children.length > 0;
  const senior = node.children.some((c) => c.children.length > 0);
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 py-1.5" style={{ paddingLeft: depth * 20 }}>
        {hasKids ? (
          <button
            onClick={() => toggleOpen(node.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}'s reports`}
            className="w-5 text-muted hover:text-foreground"
          >{isOpen ? "▾" : "▸"}</button>
        ) : <span className="w-5" />}
        <input
          type="checkbox" checked={selected.has(node.id)} onChange={(e) => select([node.id], e.target.checked)}
          aria-label={`Select ${node.name}`}
        />
        <span className="font-medium">{node.name}</span>
        <span className="text-xs text-muted">{node.team ?? "No team"}</span>
        {hasKids && <span className="text-xs text-muted">· {node.directCount} direct{node.totalCount > node.directCount ? ` · ${node.totalCount} below` : ""}</span>}
        {node.personal.length > 0 && (
          <span className="rounded bg-accent/15 px-1.5 text-[10px] text-accent">{node.personal.map((c) => CADENCE_LABEL[c]).join(" · ")}</span>
        )}
        {node.company.length > 0 && (
          <span className="rounded bg-violet-500/15 px-1.5 text-[10px] text-violet-300">Company: {node.company.map((c) => CADENCE_LABEL[c]).join(" · ")}</span>
        )}
        {hasKids && (
          <span className="ml-auto flex gap-3 text-xs">
            <button onClick={() => select(branchIds(node))} className="text-accent hover:underline">+ their reports</button>
            {senior && <button onClick={() => select(managersIn(node))} className="text-accent hover:underline">+ managers below</button>}
          </span>
        )}
      </div>
      {hasKids && isOpen && (
        <ul>{node.children.map((c) => <Row key={c.id} node={c} depth={depth + 1} open={open} selected={selected} toggleOpen={toggleOpen} select={select} />)}</ul>
      )}
    </li>
  );
}

/**
 * The Okta reporting lines as a tree, to pick digest recipients by structure: anyone, a manager's
 * whole branch, the managers in it, all managers, or the senior leaders. Adding never removes a
 * cadence someone already has; removing stays in the recipient table.
 */
export function ReportingLines({ org }: { org: OrgTree }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(() => new Set(org.roots.map((r) => r.id)));
  const [cadences, setCadences] = useState<Cadence[]>(["weekly", "monthly"]);
  const [list, setList] = useState<List>("personal");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const select = (ids: string[], on = true) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const toggleOpen = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rowProps = { open, selected, toggleOpen, select };
  const allIds = (nodes: OrgNode[]): string[] => nodes.flatMap((n) => [n.id, ...allIds(n.children)]);

  const onAdd = () =>
    start(async () => {
      setMessage(null);
      try {
        const ids = [...selected];
        const { added } = list === "personal" ? await addRecipients(ids, cadences) : await addCompanyRecipients(ids, cadences);
        setMessage({ ok: true, text: `Added ${ids.length} ${ids.length === 1 ? "person" : "people"} to the ${list === "personal" ? "personal digest" : "company report"} (${added} new subscriptions).` });
        setSelected(new Set());
      } catch (err) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => select(org.managerIds)} className="rounded-md border border-border bg-surface-2 px-2.5 py-1 hover:border-accent">All managers ({org.managerIds.length})</button>
        <button onClick={() => select(org.seniorIds)} className="rounded-md border border-border bg-surface-2 px-2.5 py-1 hover:border-accent">Senior leaders ({org.seniorIds.length})</button>
        <button onClick={() => setSelected(new Set())} disabled={selected.size === 0} className="rounded-md px-2.5 py-1 text-muted hover:text-foreground disabled:opacity-40">Clear</button>
        <span className="ml-auto flex gap-3 text-muted">
          <button onClick={() => setOpen(new Set(allIds(org.roots)))} className="hover:text-foreground">Expand all</button>
          <button onClick={() => setOpen(new Set())} className="hover:text-foreground">Collapse all</button>
        </span>
      </div>

      <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-border px-3 text-sm">
        <ul>{org.roots.map((r) => <Row key={r.id} node={r} depth={0} {...rowProps} />)}</ul>
        {org.noManager.length > 0 && (
          <details className="py-2">
            <summary className="cursor-pointer text-xs text-muted">No manager in Okta ({org.noManager.length})</summary>
            <ul className="mt-1">{org.noManager.map((n) => <Row key={n.id} node={n} depth={0} {...rowProps} />)}</ul>
          </details>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs">
        <span className="font-medium text-foreground">{selected.size} selected</span>
        <label className="flex items-center gap-1.5 text-muted">
          Add to
          <select value={list} onChange={(e) => setList(e.target.value as List)} className="rounded-md border border-border bg-surface px-2 py-1 text-foreground outline-none focus:border-accent">
            <option value="personal">Personal digest</option>
            <option value="company">Company report</option>
          </select>
        </label>
        {CADENCES.map((c) => (
          <label key={c} className="flex items-center gap-1 text-muted">
            <input type="checkbox" checked={cadences.includes(c)} onChange={(e) => setCadences((d) => (e.target.checked ? [...d, c] : d.filter((x) => x !== c)))} />
            {CADENCE_LABEL[c]}
          </label>
        ))}
        <button
          onClick={onAdd} disabled={pending || selected.size === 0 || cadences.length === 0}
          className="ml-auto rounded-md border border-accent bg-accent/15 px-3 py-1 text-accent disabled:opacity-40"
        >{pending ? "Adding…" : "Add"}</button>
      </div>
      {message && (
        <p className={message.ok
          ? "rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
          : "rounded-md border border-pink-500/30 bg-pink-500/10 px-3 py-2 text-sm text-pink-300"}
        >{message.ok ? message.text : `Failed: ${message.text}`}</p>
      )}
    </div>
  );
}
