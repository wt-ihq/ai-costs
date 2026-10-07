import Link from "next/link";
import { Panel } from "@/components/ui";
import { BlockKitPreview } from "@/components/notifications/block-kit-preview";
import { FixedCostsPanel } from "@/components/notifications/fixed-costs-panel";
import { RecipientsTable } from "@/components/notifications/recipients-table";
import { PreviewPicker } from "@/components/notifications/preview-picker";
import { SendTestControls } from "@/components/notifications/send-test-controls";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadNotificationsAdmin } from "@/lib/notify/admin-store";
import { renderChartPng } from "@/lib/notify/chart-image";
import type { ChartLayout } from "@/lib/notify/chart";
import { digestFor, loadNotifyContext, teamDigestFor } from "@/lib/notify/context";
import { fixedCostsFor, fixedCostsForTeam, type FixedCostChoice } from "@/lib/notify/fixed-costs";
import { chartLayoutsFor, chartLayoutsForTeam } from "@/lib/notify/deliver";
import { isTeamDigest } from "@/lib/notify/digest";
import { renderDigest, renderTeamDigest, type SlackBlock } from "@/lib/notify/render";
import { defaultPreviewKey, periodFor, stepKey } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { previewHref, type TestSubject } from "@/lib/notify/subject";
import { activeDepartments, CADENCES, isActiveEmployee, isCadence, isUuid, notifyMode, type Cadence } from "@/lib/notify/types";
import { appBaseUrl } from "@/lib/notify/wiring";

export interface NotificationsParams { preview?: string; team?: string; cadence?: string; at?: string }

interface PreviewState {
  subject: TestSubject;
  name: string; // the person's name, or the department
  subjectActive: boolean; // false for a leaver (or an unknown person): they can't be sent a test themself
  cadence: Cadence;
  key: string;
  label: string;
  fixedCosts: FixedCostChoice; // which setting the digest was built with, and why
  prevKey: string | null;
  nextKey: string | null;
  blocks: SlackBlock[] | null; // null = nothing to send (daily with no usage)
  images: Record<string, string>;
}

/** A person (?preview=<uuid>) or a team (?team=<department>, ignored unless it is a real department). */
async function loadPreview(p: NotificationsParams): Promise<PreviewState | null> {
  const personId = isUuid(p.preview) ? p.preview : null;
  if (!personId && !p.team) return null;
  const cadence: Cadence = isCadence(p.cadence) ? p.cadence : "weekly";
  const now = new Date();
  let key = p.at ?? defaultPreviewKey(cadence, now);
  let period;
  try {
    period = periodFor(cadence, key, now);
  } catch {
    key = defaultPreviewKey(cadence, now);
    period = periodFor(cadence, key, now);
  }
  const ctx = await loadNotifyContext(supabaseNotifyStore(getSupabaseAdminClient()), now, appBaseUrl(), { earliest: period.buckets[0].from });
  let subject: TestSubject;
  if (personId) subject = { kind: "person", employeeId: personId };
  else if (p.team && activeDepartments(ctx.employees).includes(p.team)) subject = { kind: "team", department: p.team };
  else return null;

  const digest = subject.kind === "person" ? digestFor(ctx, subject.employeeId, period) : teamDigestFor(ctx, subject.department, period);
  const person = subject.kind === "person" ? ctx.employeesById.get(subject.employeeId) : undefined;
  const base = {
    subject, cadence, key, label: period.label,
    name: subject.kind === "person" ? (person?.fullName ?? "Unknown") : subject.department,
    subjectActive: subject.kind === "team" || (person !== undefined && isActiveEmployee(person)),
    fixedCosts:
      subject.kind === "person"
        ? fixedCostsFor(ctx.fixedCosts, { id: subject.employeeId, department: person?.department ?? null })
        : fixedCostsForTeam(ctx.fixedCosts, subject.department),
    prevKey: stepKey(cadence, key, -1, now), nextKey: stepKey(cadence, key, 1, now),
  };
  if (!digest) return { ...base, blocks: null, images: {} };
  const layouts: Record<string, ChartLayout | undefined> = isTeamDigest(digest) ? chartLayoutsForTeam(digest) : chartLayoutsFor(digest);
  const images: Record<string, string> = {};
  const files: Record<string, string> = {};
  for (const [section, layout] of Object.entries(layouts)) {
    if (!layout) continue;
    try {
      const id = `preview-${section}`;
      images[id] = `data:image/png;base64,${Buffer.from(await renderChartPng(layout)).toString("base64")}`;
      files[section] = id;
    } catch {
      // Best-effort, like the cron: the section renders without its chart.
    }
  }
  return { ...base, blocks: (isTeamDigest(digest) ? renderTeamDigest(digest, files) : renderDigest(digest, files)).blocks, images };
}

/** A failed preview must not take down the tab: recipients and sends still render. */
async function safePreview(p: NotificationsParams): Promise<PreviewState | { error: string } | null> {
  try {
    return await loadPreview(p);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const FIXED_SOURCE: Record<FixedCostChoice["source"], string> = { person: "their own setting", team: "team setting", default: "the default" };

export async function NotificationsTab({ params }: { params: NotificationsParams }) {
  const [data, preview] = await Promise.all([loadNotificationsAdmin(getSupabaseAdminClient()), safePreview(params)]);
  const mode = notifyMode();
  // What the picker shows as open: the loaded subject, else whatever the URL asked for (a failed preview still has one).
  const current: TestSubject | null =
    preview && !("error" in preview) ? preview.subject
    : isUuid(params.preview) ? { kind: "person", employeeId: params.preview }
    : params.team && data.departments.includes(params.team) ? { kind: "team", department: params.team }
    : null;
  const cadence: Cadence = isCadence(params.cadence) ? params.cadence : "weekly";
  const previewKey = current ? (current.kind === "person" ? current.employeeId : `team:${current.department}`) : "none";
  const currentPersonLabel =
    current?.kind === "person" ? (data.activePeople.find((p) => p.id === current.employeeId)?.label ?? (preview && !("error" in preview) ? preview.name : null)) : null;

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Mode</p>
          <p className="my-1 text-sm font-semibold">{mode.toUpperCase()}</p>
          <p className="text-xs text-muted">
            {mode === "off" && "Scheduled sends are off. "}
            {mode === "preview" && `Every DM goes to ${process.env.SLACK_PREVIEW_EMAIL ?? "(SLACK_PREVIEW_EMAIL unset)"}, not the recipient. `}
            {mode === "live" && "DMs go to the recipients below. "}
            Change <code>SLACK_NOTIFY_MODE</code> in Vercel.
          </p>
        </Panel>
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Last run</p>
          {data.lastRun ? (
            <>
              <p className="my-1 text-sm font-semibold">{data.lastRun.day} · {data.lastRun.mode.toUpperCase()} run</p>
              <p className="text-xs text-muted">
                {data.lastRun.cadences.join(", ")}: {data.lastRun.sent} sent · {data.lastRun.skipped} skipped · {data.lastRun.failed} failed
                {data.lastRun.plusPreview > 0 && ` + ${data.lastRun.plusPreview} preview`}
              </p>
            </>
          ) : <p className="my-1 text-sm text-muted">No sends yet</p>}
        </Panel>
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Manager chain (Okta)</p>
          <p className="my-1 text-sm font-semibold">{data.tree.resolved} / {data.tree.active} resolved</p>
          {data.tree.unresolved.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{data.tree.unresolved.length} active people have no resolvable manager or are in a manager loop</summary>
              <p className="mt-1">They still get their own digest but don&apos;t roll up to anyone: {data.tree.unresolved.join(", ")}</p>
            </details>
          )}
        </Panel>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Pilot recipients · {data.recipients.length}</h2>
          <p className="mb-4 text-xs text-muted">Only people listed here get anything. Checkboxes save as you click. Reports come from the Okta manager chain.</p>
          <RecipientsTable rows={data.recipients} people={data.people} departments={data.departments} previewing={isUuid(params.preview) ? params.preview : null} />
          <div className="mt-6 border-t border-border pt-4">
            <h2 className="mb-1 text-sm font-medium">Fixed costs</h2>
            <p className="mb-3 text-xs text-muted">
              Whether digests count seats &amp; subscriptions. Daily and weekly digests get each day&apos;s share; monthly recaps the full amount.
              A person&apos;s setting (in the table above) beats their team&apos;s, which beats the default.
            </p>
            <FixedCostsPanel settings={data.fixedCosts} departments={data.departments} />
          </div>
        </Panel>

        <Panel>
          <PreviewPicker
            key={previewKey}
            people={data.activePeople} departments={data.departments} cadence={cadence}
            current={current} currentPersonLabel={currentPersonLabel}
          />
          {!preview ? (
            <p className="text-sm text-muted">Pick a person or a team above, or click Preview on a recipient, to see exactly what they&apos;d get.</p>
          ) : "error" in preview ? (
            <p className="text-sm text-pink-300">Preview failed: {preview.error}</p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Preview · {preview.name}{preview.subject.kind === "team" && " (team)"}</h2>
                <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
                  {CADENCES.map((c) => (
                    <Link key={c} href={previewHref(preview.subject, c)}
                      className={`rounded px-2.5 py-1 ${c === preview.cadence ? "bg-accent/20 text-accent" : "text-muted"}`}>{c}</Link>
                  ))}
                </div>
              </div>
              <p className="mb-3 text-xs text-muted">
                {preview.prevKey ? <Link href={previewHref(preview.subject, preview.cadence, preview.prevKey)} className="text-accent">◀</Link> : "◀"}
                <span className="mx-2 text-foreground">{preview.label}</span>
                {preview.nextKey ? <Link href={previewHref(preview.subject, preview.cadence, preview.nextKey)} className="text-accent">▶</Link> : "▶"}
                <span className="ml-2">
                  {preview.subject.kind === "team"
                    ? "Built from live data. Team digests are for previews and tests only; they are never scheduled."
                    : "Built from live data, exactly as the cron would send it."}
                </span>
              </p>
              <p className="mb-3 text-xs text-muted">
                Seats &amp; subscriptions: <span className="text-foreground">{preview.fixedCosts.include ? "included" : "excluded"}</span>{" "}
                ({FIXED_SOURCE[preview.fixedCosts.source]})
              </p>
              {preview.blocks ? (
                <>
                  {/* Above the preview: a two-chart digest is long, and below it the controls were off-screen. */}
                  <SendTestControls
                    key={`${previewKey}-${preview.cadence}-${preview.key}`}
                    subject={preview.subject} subjectName={preview.name} subjectActive={preview.subjectActive} cadence={preview.cadence} periodKey={preview.key}
                    people={data.activePeople}
                  />
                  <BlockKitPreview blocks={preview.blocks} images={preview.images} />
                </>
              ) : (
                <p className="text-sm text-muted">
                  Nothing to send for this period: no usage by {preview.subject.kind === "team" ? "this team" : "them or their reports"}.
                </p>
              )}
            </>
          )}
        </Panel>
      </div>

      <Panel>
        <h2 className="mb-1 text-sm font-medium">Recent sends</h2>
        <p className="mb-4 text-xs text-muted">Last 50 log entries. Failed sends retry on the next run while the period is still due (up to 3 attempts).</p>
        {data.sends.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  {["When", "Person", "Cadence", "Period", "Mode", "Status", "Detail"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.sends.map((s, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 text-xs text-muted">{s.at.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-3 py-2">{s.name}</td>
                    <td className="px-3 py-2">{s.cadence}</td>
                    <td className="px-3 py-2 text-xs">{s.periodKey}</td>
                    <td className="px-3 py-2 text-xs">{s.mode}</td>
                    <td className={`px-3 py-2 text-xs ${s.status === "failed" ? "text-pink-300" : s.status === "sent" ? "text-emerald-400" : "text-muted"}`}>{s.status}</td>
                    <td className="px-3 py-2 text-xs text-muted">{s.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
