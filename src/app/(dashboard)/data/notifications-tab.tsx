import Link from "next/link";
import { Panel } from "@/components/ui";
import { BlockKitPreview } from "@/components/notifications/block-kit-preview";
import { RecipientsTable } from "@/components/notifications/recipients-table";
import { SendPreviewButton } from "@/components/notifications/send-preview-button";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadNotificationsAdmin } from "@/lib/notify/admin-store";
import { renderChartPng } from "@/lib/notify/chart-image";
import { digestFor, loadNotifyContext } from "@/lib/notify/context";
import { chartLayoutsFor } from "@/lib/notify/deliver";
import { renderDigest, type ChartFileIds, type SlackBlock } from "@/lib/notify/render";
import { latestCompleteKey, periodFor, stepKey } from "@/lib/notify/schedule";
import { supabaseNotifyStore } from "@/lib/notify/store";
import { CADENCES, isCadence, isUuid, notifyMode, type Cadence } from "@/lib/notify/types";
import { appBaseUrl } from "@/lib/notify/wiring";

export interface NotificationsParams { preview?: string; cadence?: string; at?: string }

interface PreviewState {
  employeeId: string;
  name: string;
  cadence: Cadence;
  key: string;
  label: string;
  prevKey: string | null;
  nextKey: string | null;
  blocks: SlackBlock[] | null; // null = nothing to send (daily with no usage)
  images: Record<string, string>;
}

async function loadPreview(p: NotificationsParams): Promise<PreviewState | null> {
  if (!isUuid(p.preview)) return null;
  const cadence: Cadence = isCadence(p.cadence) ? p.cadence : "weekly";
  const now = new Date();
  let key = p.at ?? latestCompleteKey(cadence, now);
  let period;
  try {
    period = periodFor(cadence, key, now);
  } catch {
    key = latestCompleteKey(cadence, now);
    period = periodFor(cadence, key, now);
  }
  const ctx = await loadNotifyContext(supabaseNotifyStore(getSupabaseAdminClient()), now, appBaseUrl(), { earliest: period.buckets[0].from });
  const digest = digestFor(ctx, p.preview, period);
  const base = {
    employeeId: p.preview, name: ctx.employeesById.get(p.preview)?.fullName ?? "Unknown", cadence, key, label: period.label,
    prevKey: stepKey(cadence, key, -1, now), nextKey: stepKey(cadence, key, 1, now),
  };
  if (!digest) return { ...base, blocks: null, images: {} };
  const images: Record<string, string> = {};
  const files: ChartFileIds = {};
  for (const [section, layout] of Object.entries(chartLayoutsFor(digest)) as ["you" | "reports", Parameters<typeof renderChartPng>[0] | undefined][]) {
    if (!layout) continue;
    const id = `preview-${section}`;
    images[id] = `data:image/png;base64,${Buffer.from(await renderChartPng(layout)).toString("base64")}`;
    files[section] = id;
  }
  return { ...base, blocks: renderDigest(digest, files).blocks, images };
}

const href = (p: { employeeId: string; cadence: string; key?: string | null }) =>
  `/data?tab=notifications&preview=${p.employeeId}&cadence=${p.cadence}${p.key ? `&at=${p.key}` : ""}`;

export async function NotificationsTab({ params }: { params: NotificationsParams }) {
  const [data, preview] = await Promise.all([loadNotificationsAdmin(getSupabaseAdminClient()), loadPreview(params)]);
  const mode = notifyMode();

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Mode</p>
          <p className="my-1 text-sm font-semibold">{mode.toUpperCase()}</p>
          <p className="text-xs text-muted">
            {mode === "off" && "Nothing is sent. "}
            {mode === "preview" && `Every DM goes to ${process.env.SLACK_PREVIEW_EMAIL ?? "(SLACK_PREVIEW_EMAIL unset)"}, not the recipient. `}
            {mode === "live" && "DMs go to the recipients below. "}
            Change <code>SLACK_NOTIFY_MODE</code> in Vercel.
          </p>
        </Panel>
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Last run</p>
          {data.lastRun ? (
            <>
              <p className="my-1 text-sm font-semibold">{data.lastRun.day}</p>
              <p className="text-xs text-muted">{data.lastRun.sent} sent · {data.lastRun.skipped} skipped · {data.lastRun.failed} failed</p>
            </>
          ) : <p className="my-1 text-sm text-muted">No sends yet</p>}
        </Panel>
        <Panel>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Manager chain (Okta)</p>
          <p className="my-1 text-sm font-semibold">{data.tree.resolved} / {data.tree.active} resolved</p>
          {data.tree.unresolved.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{data.tree.unresolved.length} active people have no resolvable manager</summary>
              <p className="mt-1">They still get their own digest but don&apos;t roll up to anyone: {data.tree.unresolved.join(", ")}</p>
            </details>
          )}
        </Panel>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Panel>
          <h2 className="mb-1 text-sm font-medium">Pilot recipients · {data.recipients.length}</h2>
          <p className="mb-4 text-xs text-muted">Only people listed here get anything. Checkboxes save as you click. Reports come from the Okta manager chain.</p>
          <RecipientsTable rows={data.recipients} people={data.people} departments={data.departments} previewing={preview?.employeeId ?? null} />
        </Panel>

        <Panel>
          {!preview ? (
            <p className="text-sm text-muted">Click Preview on a recipient to see exactly what they&apos;d get.</p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Preview · {preview.name}</h2>
                <div className="inline-flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
                  {CADENCES.map((c) => (
                    <Link key={c} href={href({ employeeId: preview.employeeId, cadence: c })}
                      className={`rounded px-2.5 py-1 ${c === preview.cadence ? "bg-accent/20 text-accent" : "text-muted"}`}>{c}</Link>
                  ))}
                </div>
              </div>
              <p className="mb-3 text-xs text-muted">
                {preview.prevKey ? <Link href={href({ ...preview, key: preview.prevKey })} className="text-accent">◀</Link> : "◀"}
                <span className="mx-2 text-foreground">{preview.label}</span>
                {preview.nextKey ? <Link href={href({ ...preview, key: preview.nextKey })} className="text-accent">▶</Link> : "▶"}
                <span className="ml-2">Built from live data, exactly as the cron would send it.</span>
              </p>
              {preview.blocks ? (
                <>
                  <BlockKitPreview blocks={preview.blocks} images={preview.images} />
                  <SendPreviewButton employeeId={preview.employeeId} cadence={preview.cadence} periodKey={preview.key} />
                </>
              ) : <p className="text-sm text-muted">Nothing to send for this period: no usage by them or their reports.</p>}
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
