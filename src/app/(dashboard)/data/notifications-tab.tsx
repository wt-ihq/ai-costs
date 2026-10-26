import Link from "next/link";
import { Panel } from "@/components/ui";
import { BlockKitPreview } from "@/components/notifications/block-kit-preview";
import { CompanyRecipients } from "@/components/notifications/company-recipients";
import { DigestsTable } from "@/components/notifications/digests-table";
import { ReminderRecipients } from "@/components/notifications/reminder-recipients";
import { FixedCostsPanel } from "@/components/notifications/fixed-costs-panel";
import { ModePanel } from "@/components/notifications/mode-panel";
import { LiveTestPanel } from "@/components/notifications/live-test-panel";
import { RecipientsTable } from "@/components/notifications/recipients-table";
import { ReportingLines } from "@/components/notifications/reporting-lines";
import { PreviewPicker } from "@/components/notifications/preview-picker";
import { SendTestControls } from "@/components/notifications/send-test-controls";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadNotificationsAdmin, OPEN_RATE_DAYS } from "@/lib/notify/admin-store";
import { renderChartPng, renderWelcomeBannerPng } from "@/lib/notify/chart-image";
import type { ChartLayout } from "@/lib/notify/chart";
import { companyDigestFor, digestFor, loadNotifyContext, teamDigestFor } from "@/lib/notify/context";
import { fixedCostsFor, fixedCostsForTeam, type FixedCostChoice } from "@/lib/notify/fixed-costs";
import { chartLayoutsFor, chartLayoutsForCompany, chartLayoutsForTeam, loadDashboardAccess } from "@/lib/notify/deliver";
import { parseAdminEmails } from "@/lib/dashboard-access";
import { isCompanyDigest, isTeamDigest } from "@/lib/notify/digest";
import { renderCompanyDigest, renderDigest, renderTeamDigest, type SlackBlock } from "@/lib/notify/render";
import { defaultPreviewKey, periodFor, stepKey } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { previewHref, type TestSubject } from "@/lib/notify/subject";
import { activeDepartments, CADENCES, isActiveEmployee, isCadence, isUuid, type Cadence } from "@/lib/notify/types";
import { appBaseUrl } from "@/lib/notify/wiring";
import { firstName } from "@/lib/notify/intro";

export interface NotificationsParams { preview?: string; team?: string; company?: string; cadence?: string; at?: string }

interface PreviewState {
  subject: TestSubject;
  name: string; // the person's name, the department, or "Company report"
  subjectActive: boolean; // false for a leaver (or an unknown person): they can't be sent a test themself
  cadence: Cadence;
  key: string;
  label: string;
  fixedCosts: FixedCostChoice | null; // which setting the digest was built with, and why; null = the company report (its own section)
  links: boolean; // a person's preview: whether they get the dashboard button and links (team/company: shown as people with access get it)
  intro: boolean; // a person who hasn't had a live message: their first one opens with the intro, shown here too
  prevKey: string | null;
  nextKey: string | null;
  blocks: SlackBlock[] | null; // null = nothing to send (daily with no usage)
  images: Record<string, string>;
}

/** A person (?preview=<uuid>), a team (?team=<department>, ignored unless it is a real department) or the company report (?company=1). */
async function loadPreview(p: NotificationsParams): Promise<PreviewState | null> {
  const personId = isUuid(p.preview) ? p.preview : null;
  const wantsCompany = p.company === "1";
  if (!personId && !p.team && !wantsCompany) return null;
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
  const store = supabaseNotifyStore(getSupabaseAdminClient());
  const [ctx, canOpenDashboard] = await Promise.all([
    loadNotifyContext(store, now, appBaseUrl(), { earliest: period.buckets[0].from }),
    loadDashboardAccess(store, parseAdminEmails(process.env.ADMIN_EMAILS), console.error),
  ]);
  let subject: TestSubject;
  if (personId) subject = { kind: "person", employeeId: personId };
  else if (p.team && activeDepartments(ctx.employees).includes(p.team)) subject = { kind: "team", department: p.team };
  else if (wantsCompany) subject = { kind: "company" };
  else return null;

  const digest =
    subject.kind === "person" ? digestFor(ctx, subject.employeeId, period)
    : subject.kind === "team" ? teamDigestFor(ctx, subject.department, period)
    : companyDigestFor(ctx, period);
  const person = subject.kind === "person" ? ctx.employeesById.get(subject.employeeId) : undefined;
  const base = {
    subject, cadence, key, label: period.label,
    name: subject.kind === "person" ? (person?.fullName ?? "Unknown") : subject.kind === "team" ? subject.department : "Company report",
    subjectActive: subject.kind !== "person" || (person !== undefined && isActiveEmployee(person)),
    fixedCosts:
      subject.kind === "person" ? fixedCostsFor(ctx.fixedCosts, { id: subject.employeeId, department: person?.department ?? null })
      : subject.kind === "team" ? fixedCostsForTeam(ctx.fixedCosts, subject.department)
      : null,
    prevKey: stepKey(cadence, key, -1, now), nextKey: stepKey(cadence, key, 1, now),
    links: subject.kind !== "person" || (person !== undefined && canOpenDashboard(person.email)),
    intro: false,
  };
  // A person's first live message opens with the intro: show it as they'd get it, with their cadences.
  let intro: { name: string | null; cadences: Cadence[] } | undefined;
  if (subject.kind === "person" && person) {
    const [hadLive, subs] = await Promise.all([store.everLive([person.id]), store.subscriptions([...CADENCES])]);
    if (!hadLive.has(person.id)) {
      const mine = subs.filter((s) => s.employeeId === person.id).map((s) => s.cadence);
      intro = { name: firstName(person.fullName), cadences: mine.length ? mine : [cadence] };
      base.intro = true;
    }
  }
  if (!digest) return { ...base, blocks: null, images: {} };
  const layouts: Record<string, ChartLayout | undefined> = isCompanyDigest(digest)
    ? chartLayoutsForCompany(digest)
    : isTeamDigest(digest) ? chartLayoutsForTeam(digest) : chartLayoutsFor(digest);
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
  if (intro) {
    try {
      images["preview-banner"] = `data:image/png;base64,${Buffer.from(await renderWelcomeBannerPng()).toString("base64")}`;
      files.banner = "preview-banner";
    } catch {
      // Best-effort, like the cron: the intro shows without its banner.
    }
  }
  const opts = { links: base.links, intro };
  const rendered = isCompanyDigest(digest)
    ? renderCompanyDigest(digest, files, opts)
    : isTeamDigest(digest) ? renderTeamDigest(digest, files, opts) : renderDigest(digest, files, opts);
  return { ...base, blocks: rendered.blocks, images };
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
  const mode = data.mode;
  // What the picker shows as open: the loaded subject, else whatever the URL asked for (a failed preview still has one).
  const current: TestSubject | null =
    preview && !("error" in preview) ? preview.subject
    : isUuid(params.preview) ? { kind: "person", employeeId: params.preview }
    : params.team && data.departments.includes(params.team) ? { kind: "team", department: params.team }
    : params.company === "1" ? { kind: "company" }
    : null;
  const cadence: Cadence = isCadence(params.cadence) ? params.cadence : "weekly";
  const previewKey = !current ? "none" : current.kind === "person" ? current.employeeId : current.kind === "team" ? `team:${current.department}` : "company";
  const currentPersonLabel =
    current?.kind === "person" ? (data.activePeople.find((p) => p.id === current.employeeId)?.label ?? (preview && !("error" in preview) ? preview.name : null)) : null;

  return (
    <div className="grid gap-4">
      <Panel>
        <DigestsTable rows={data.digests} mode={mode} />
      </Panel>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Panel>
          <ModePanel
            mode={mode} modeSource={data.modeSource} previewEmail={process.env.SLACK_PREVIEW_EMAIL ?? null}
            pilotCount={data.recipients.filter((r) => !r.left).length} companyCount={data.companyRecipients.filter((r) => !r.left).length}
            monthlyFrom={data.monthlyFrom}
          />
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
        <Panel>
          <LiveTestPanel people={data.recipients.filter((r) => !r.left).map((r) => ({ employeeId: r.employeeId, name: r.name, cadences: r.cadences }))} />
        </Panel>
      </div>

      <Panel>
        <h2 className="mb-1 text-sm font-medium">Reporting lines</h2>
        <p className="mb-4 text-xs text-muted">
          The Okta manager chain. Tick people, a manager&rsquo;s whole branch, or the managers in it, then add them to a list.
          Adding never removes a cadence someone already has; remove people in the recipient table below.
        </p>
        <ReportingLines org={data.orgTree} />
      </Panel>

      <div className="grid items-start gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Pilot recipients · {data.recipients.length}</h2>
          <p className="mb-4 text-xs text-muted">Only people listed here get a personal digest (the company report has its own list below). Checkboxes save as you click. Reports come from the Okta manager chain.</p>
          <RecipientsTable rows={data.recipients} people={data.people} departments={data.departments} previewing={isUuid(params.preview) ? params.preview : null} mode={mode} />
          <div className="mt-6 border-t border-border pt-4">
            <h2 className="mb-1 text-sm font-medium">Fixed costs</h2>
            <p className="mb-3 text-xs text-muted">
              Whether digests count seats &amp; subscriptions. Daily and weekly digests get each day&apos;s share; monthly recaps the full amount.
              A person&apos;s setting (in the table above) beats their team&apos;s, which beats the default.
            </p>
            <FixedCostsPanel settings={data.fixedCosts} departments={data.departments} />
          </div>
          <div className="mt-6 border-t border-border pt-4">
            <h2 className="mb-1 text-sm font-medium">Company report · {data.companyRecipients.length}</h2>
            <p className="mb-3 text-xs text-muted">
              A separate Slack message with the whole company&apos;s AI spend: usage by team and person, then seats &amp; subscriptions.
              Same schedule as personal digests; someone on both lists gets both.
            </p>
            <CompanyRecipients rows={data.companyRecipients} people={data.companyPeople} />
          </div>
          <div className="mt-6 border-t border-border pt-4">
            <h2 className="mb-1 text-sm font-medium">Update reminders · {data.reminderRecipients.length}</h2>
            <p className="mb-3 text-xs text-muted">
              A Slack message on Mondays at 09:30 listing what&apos;s left before the weekly summaries can go (Claude Team paste, ChatGPT credits, failed syncs),
              and on the month&apos;s last working day at 15:00 a reminder to paste Claude Team spend before its table resets.
            </p>
            <ReminderRecipients rows={data.reminderRecipients} people={data.reminderPeople} />
          </div>
        </Panel>

        <Panel>
          <PreviewPicker
            key={previewKey}
            people={data.activePeople} departments={data.departments} cadence={cadence}
            current={current} currentPersonLabel={currentPersonLabel}
          />
          {!preview ? (
            <p className="text-sm text-muted">Pick a person, a team or the company report above, or click Preview on a recipient, to see exactly what they&apos;d get.</p>
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
                    : preview.subject.kind === "company"
                      ? "Built from live data, exactly as the cron would send it to every company report recipient."
                      : "Built from live data, exactly as the cron would send it."}
                </span>
              </p>
              <p className="mb-3 text-xs text-muted">
                {preview.fixedCosts ? (
                  <>
                    Seats &amp; subscriptions: <span className="text-foreground">{preview.fixedCosts.include ? "included" : "excluded"}</span>{" "}
                    ({FIXED_SOURCE[preview.fixedCosts.source]})
                  </>
                ) : (
                  <>Seats &amp; subscriptions: <span className="text-foreground">their own section</span> (the company report always shows them apart from usage)</>
                )}
                <br />
                Dashboard button &amp; links:{" "}
                {preview.subject.kind !== "person" ? (
                  <><span className="text-foreground">shown</span> (people without dashboard access get it without them)</>
                ) : preview.links ? (
                  <span className="text-foreground">shown</span>
                ) : (
                  <><span className="text-foreground">hidden</span> ({preview.name} can&apos;t open the dashboard; see the Access tab)</>
                )}
                {preview.subject.kind === "person" && (
                  <>
                    <br />
                    First-message intro:{" "}
                    {preview.intro
                      ? <><span className="text-foreground">included</span> (they haven&apos;t had a live message yet, so their first one opens with it)</>
                      : <span className="text-foreground">not included</span>}
                  </>
                )}
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
                  Nothing to send for this period: no usage by {preview.subject.kind === "team" ? "this team" : preview.subject.kind === "company" ? "anyone in the company" : "them or their reports"}.
                </p>
              )}
            </>
          )}
        </Panel>
      </div>

      <Panel>
        <h2 className="mb-1 text-sm font-medium">Recent sends</h2>
        <p className="mb-1 text-xs text-muted">Last 50 log entries. Failed sends retry on the next run while the period is still due (up to 3 attempts).</p>
        <p className="mb-4 text-xs text-muted">
          Opened from Slack ({OPEN_RATE_DAYS} days):{" "}
          <span className="text-foreground">
            {data.opens.sent === 0 ? "no live digests with the button yet" : `${data.opens.opened} of ${data.opens.sent} live messages with the button, personal and company (${Math.round((data.opens.opened / data.opens.sent) * 100)}%)`}
          </span>
          {" "}— counted when someone clicks a digest&apos;s Open in dashboard button, which only people with dashboard access get. Test sends aren&apos;t tracked.
        </p>
        {data.sends.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  {["When", "Person", "Report", "Cadence", "Period", "Mode", "Status", "Opened", "Detail"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.sends.map((s, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 text-xs text-muted">{s.at.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-3 py-2">{s.name}</td>
                    <td className="px-3 py-2 text-xs">{s.report === "company" ? "Company" : s.report === "reminder" ? "Reminder" : "Personal"}</td>
                    <td className="px-3 py-2">{s.cadence}</td>
                    <td className="px-3 py-2 text-xs">{s.periodKey}</td>
                    <td className="px-3 py-2 text-xs">{s.mode}</td>
                    <td className={`px-3 py-2 text-xs ${s.status === "failed" ? "text-pink-300" : s.status === "sent" ? "text-emerald-400" : "text-muted"}`}>{s.status}</td>
                    <td className="px-3 py-2 text-xs text-muted">{s.openedAt ? s.openedAt.slice(0, 16).replace("T", " ") : ""}</td>
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
