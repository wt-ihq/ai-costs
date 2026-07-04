/**
 * Dashboard-wide loading state. Pages are force-dynamic and page the whole
 * facts window from Supabase server-side, so navigation needs feedback.
 */
export default function DashboardLoading() {
  return (
    <div className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted" role="status">
      <span className="size-4 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />
      Loading…
    </div>
  );
}
