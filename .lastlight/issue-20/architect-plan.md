# Architect Plan — Issue #20: Home Page

## Problem Statement

The dashboard currently defaults to the Workflows tab (`App.tsx:24,28`) with no dedicated home/overview page. Users must navigate between Workflows and Sessions tabs to get a full picture of system activity. The issue requests a Home tab showing live activity, recent workflows, and time-range stats (today/7d/30d) with charts for execution counts, token usage, and cost — using recharts for visualization.

The existing `useStats` hook (`hooks/useStats.ts:1-27`) polls basic stats (`executionStats()` at `db.ts:561-596`) but only returns aggregate totals and today's count — no time-series data or token/cost aggregates needed for the requested graphs.

## Summary of Changes

1. **Backend**: Add a new `/admin/api/stats/daily` endpoint returning daily-aggregated execution counts, token totals, and cost totals over the last 30 days
2. **Frontend**: Add `recharts` dependency, create a `HomePage` component with three sections (live activity, recent workflows, stats charts), wire it into `App.tsx` as a new "home" tab (default)
3. **State/DB**: Add a `dailyStats()` query to `StateDb` aggregating executions by date

## Files to Modify

### Backend

**`src/state/db.ts`** (after line ~596, near `executionStats`)
- Add `dailyStats(days: number)` method returning daily aggregates:
  ```
  { date: string, executions: number, successes: number, failures: number,
    totalTokens: number, inputTokens: number, outputTokens: number,
    cacheReadTokens: number, costUsd: number }[]
  ```
- SQL: `SELECT date(started_at) as date, COUNT(*), SUM(cost_usd), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_input_tokens) ... FROM executions WHERE started_at >= ? GROUP BY date(started_at) ORDER BY date`

**`src/admin/routes.ts`** (after line ~224, near existing `/stats` endpoint)
- Add `GET /stats/daily` endpoint:
  - Query param: `days` (default 30, max 90)
  - Returns `{ daily: DailyStat[] }`
  - Calls `db.dailyStats(days)`

### Frontend

**`dashboard/package.json`** (line 11, dependencies)
- Add `"recharts": "^2.15.0"`

**`dashboard/src/api.ts`** (after line ~204, near `stats()`)
- Add `DailyStat` type definition
- Add `dailyStats(days?: number)` method calling `GET /stats/daily?days=${days}`

**`dashboard/src/App.tsx`**
- Line 24: Change `Tab` type to `"home" | "sessions" | "workflows"`
- Line 28: Change `TABS` to `["home", "workflows", "sessions"]`
- Line 40-45: Change default tab from `"workflows"` to `"home"`
- Lines 231-244: Add "Home" tab button before Workflows
- Lines 245-279: Add `tab === "home"` branch rendering `<HomePage />`
- Import `HomePage` component

**`dashboard/src/components/HomePage.tsx`** (new file)
- Three-section layout:
  1. **Live Activity** — card showing live workflow count and live session count (reuse existing `api.workflowRuns({status:"active"})` and session stream data). Each live item shows repo, issue, current phase, elapsed time.
  2. **Recent Workflows** — last 3 completed workflows with status badge, repo, issue, duration, cost. Uses `api.workflowRuns({limit:3})`.
  3. **Stats Charts** — tab switcher (today/7d/30d) with recharts `AreaChart` or `BarChart` showing:
     - Execution count per day (bar)
     - Token usage per day (stacked area: input + output + cache)
     - Cost per day (area)
     - Summary stat cards above charts: total executions, total tokens, total cost for selected period
- Props: none (fetches own data)
- Polls every 15s for live data, 60s for daily stats

**`dashboard/src/hooks/useDailyStats.ts`** (new file)
- Hook wrapping `api.dailyStats(days)` with polling interval (default 60s)
- Returns `{ daily: DailyStat[] | null, loading: boolean }`

### Files NOT Modified
- No changes to `StatsHeader`, `WorkflowList`, `SessionList`, `UsageFooter` — they remain as-is
- No changes to workflow/session streaming infrastructure

## Implementation Approach

### Step 1: Backend — daily stats query and endpoint
1. Add `dailyStats(days)` to `StateDb` in `db.ts` with a single SQL query grouping by `date(started_at)`
2. Add `GET /stats/daily` route in `routes.ts`
3. Verify with existing test patterns (the query uses existing columns, no migration needed)

### Step 2: Frontend — recharts dependency
1. Add `recharts` to `dashboard/package.json`
2. Run `npm install` in the dashboard directory

### Step 3: Frontend — API client and hook
1. Add `DailyStat` type and `dailyStats()` method to `api.ts`
2. Create `useDailyStats` hook

### Step 4: Frontend — HomePage component
1. Create `HomePage.tsx` with the three sections
2. Use DaisyUI card/stat components for consistent styling
3. Use recharts `ResponsiveContainer` + `BarChart`/`AreaChart` for graphs
4. Match existing color scheme (DaisyUI semantic colors via CSS variables)
5. Use `hsl(var(--p))` etc. for recharts colors to match DaisyUI theme

### Step 5: Frontend — wire into App.tsx
1. Add "home" to Tab type and TABS array
2. Add Home tab button
3. Add conditional render for `tab === "home"`
4. Change default tab to "home"

### Step 6: Build verification
1. Run `npm run build` in dashboard to verify TypeScript + Vite build
2. Run `npm run build` at root to verify backend TypeScript
3. Run `npx vitest run` to ensure existing tests pass

## Risks and Edge Cases

1. **Empty state**: New installs will have zero executions. Charts should show a friendly empty state ("No data yet") rather than blank axes.
2. **SQLite date functions**: `date(started_at)` works on ISO8601 strings stored in the DB — verified this is the format used (`new Date().toISOString()` at `db.ts:269`).
3. **Large datasets**: The `GROUP BY date()` query is bounded by the `days` parameter (max 90) and hits an indexed `started_at` column. Performance should be fine.
4. **Token columns may be NULL**: Early executions before the migration won't have token/cost data. Use `COALESCE(col, 0)` in the aggregation query.
5. **recharts bundle size**: recharts adds ~200KB gzipped. Acceptable for an admin dashboard.
6. **Tab default change**: Existing bookmarks with `?tab=workflows` will still work since URL state parsing handles explicit values.

## Test Strategy

- **Backend unit test**: Add a test for `dailyStats()` in the existing test suite — insert sample executions across multiple dates, verify aggregation correctness (counts, sums, NULL handling)
- **Backend route test**: Verify `/stats/daily` returns correct shape and respects `days` parameter
- **Build verification**: `npm run build` for both dashboard and backend must succeed
- **Manual verification**: The dashboard should render the home page with charts when accessed at `/admin`
- **Edge case**: Verify empty-state rendering when no executions exist

## Estimated Complexity

**Medium** — Straightforward feature addition touching 6-7 files. The backend change is a single SQL query. The frontend is the bulk of the work (new component with recharts integration) but follows established patterns in the codebase. No architectural changes needed.
