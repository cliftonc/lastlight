import clsx from "clsx";

/** A horizontal 0..1 bar with a value label; `best` flags the best-in-column. */
export function Bar({
  frac,
  value,
  color,
  best,
}: {
  frac: number;
  value: string;
  color: "accent" | "info" | "primary";
  best?: boolean;
}) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  const fill = { accent: "bg-accent", info: "bg-info", primary: "bg-primary" }[color];
  return (
    <div className="flex items-center gap-2">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-base-300">
        <span className={clsx("block h-full rounded-full", fill)} style={{ width: `${pct.toFixed(1)}%` }} />
      </span>
      <span className={clsx("min-w-[3rem] text-right font-mono text-xs", best ? "font-semibold text-success" : "text-base-content")}>
        {value}
        {best && <span className="ml-0.5 text-2xs text-accent">★</span>}
      </span>
    </div>
  );
}

export type PillKind = "pass" | "fail" | "na" | "run" | "wait";

export function Pill({ kind, children }: { kind: PillKind; children: React.ReactNode }) {
  const cls: Record<PillKind, string> = {
    pass: "bg-success/15 text-success",
    fail: "bg-error/15 text-error",
    na: "bg-base-300 text-base-content/50",
    run: "bg-accent/15 text-accent ll-pulse",
    wait: "bg-base-300 text-base-content/50",
  };
  return (
    <span className={clsx("inline-block rounded-full px-2 py-0.5 font-mono text-2xs font-semibold", cls[kind])}>
      {children}
    </span>
  );
}

/** A small check-result chip (behavioral checks), green/red bordered. */
export function Chip({ ok, name, detail }: { ok: boolean; name: string; detail?: string }) {
  return (
    <span
      title={detail ?? ""}
      className={clsx(
        "mr-1 mb-1 inline-block rounded border px-1.5 py-0.5 font-mono text-2xs",
        ok ? "border-success/40 text-success" : "border-error/40 text-error",
      )}
    >
      {name}
    </span>
  );
}

/** "2/3" pass-count shown next to a worst-case verdict when trials > 1. */
export function Frac({ pass, trials }: { pass?: number; trials?: number }) {
  if (pass === undefined || !trials || trials <= 1) return null;
  return <span className="ml-1 font-mono text-2xs text-base-content/50">{pass}/{trials}</span>;
}

/** Tiny inline-SVG trend line of metric rates (0..1), oldest → newest. */
export function Sparkline({ rates }: { rates: number[] }) {
  const w = 168;
  const h = 30;
  const pad = 3;
  if (!rates.length) return <span className="text-base-content/40">—</span>;
  const x = (i: number) => (rates.length === 1 ? pad : pad + (i * (w - 2 * pad)) / (rates.length - 1));
  const y = (r: number) => h - pad - Math.max(0, Math.min(1, r)) * (h - 2 * pad);
  const last = rates.length - 1;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      {rates.length > 1 && (
        <polyline
          fill="none"
          stroke="#fcd34d"
          strokeWidth={1.5}
          points={rates.map((r, i) => `${x(i).toFixed(1)},${y(r).toFixed(1)}`).join(" ")}
        />
      )}
      <circle cx={x(last).toFixed(1)} cy={y(rates[last]).toFixed(1)} r={2.5} fill="#fcd34d" />
    </svg>
  );
}
