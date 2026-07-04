"use client";

/**
 * Dashboard-wide error boundary. Every page here is force-dynamic and reads
 * Supabase server-side, so a transient DB/API error needs a retry affordance
 * rather than Next's bare production error page.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-surface p-8 text-center">
      <div>
        <h2 className="text-base font-semibold">Something went wrong loading this page</h2>
        <p className="mt-1 max-w-md text-sm text-muted">
          {error.message || "An unexpected error occurred."}
          {error.digest && <span className="mt-1 block text-xs">Ref: {error.digest}</span>}
        </p>
      </div>
      <button
        onClick={reset}
        className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-sm text-accent"
      >
        Try again
      </button>
    </div>
  );
}
