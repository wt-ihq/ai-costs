# ai-costs

Internal dashboard tracking AI-tool spend **per user** and **per department** across all of Intent HQ's AI subscriptions and developer platforms.

It serves three audiences from one data model:

- **Finance / leadership** — monthly spend rollups per department for budgeting and renewal decisions
- **Ops / IT** — seat hygiene: unused seats and duplicate tool subscriptions per person
- **Engineering / FinOps** — API usage trends on the developer platforms

## Sources

| Source | Acquisition | Cost shape |
|---|---|---|
| Cursor Teams | Admin API | seat + metered overage |
| Anthropic Console | Usage + Cost Report API | metered |
| OpenAI Developer Platform | Usage + Costs API | metered |
| Claude Team | Manual CSV export | seat + overage |
| ChatGPT Business | Manual entry (member-table paste) | seat + overage |
| HiBob | People API | identity spine (employee → department) |

Every spend row is tagged `cost_type: seat | overage | metered` so the distinction stays visible in every rollup.

## Stack

- **App:** Next.js (App Router) on Vercel
- **Database:** Supabase Postgres
- **Auth:** Auth.js with Google SSO, domain-locked to `@intenthq.com` (roles: `admin`, `viewer`)
- **Sync:** Vercel Cron (daily) for API sources; admin UI for monthly manual imports
- **UI:** Tailwind + shadcn/ui + Recharts, dark mode

## Design

The full, approved design lives in
[`docs/superpowers/specs/2026-06-11-ai-spend-dashboard-design.md`](docs/superpowers/specs/2026-06-11-ai-spend-dashboard-design.md).
Source research (vendor capabilities as of May 2026) is in
`AI tool admin _ usage analytics - plan comparison.docx`.

## Status

Design approved; implementation in progress. v1 is **view-only** — no budgets or alerting.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
```

Environment variables (vendor API keys, Supabase, Auth.js secrets) are configured in Vercel and pulled locally with `vercel env pull`. Secrets never live in the database or client.
