---
name: railgun
description: Use Railgun for fast TypeScript, Next.js, pnpm workspace and Turborepo validation. Apply during implementation, type checking, linting, changed-file validation, Next route type generation, affected-package checks, and before completing coding tasks.
---

# Railgun validation ladder

Railgun is the primary validation system: native binary, persistent daemon, LoC as a first-class metric.

Do not default to: `npx tsc`, `pnpm tsc`, `tsc --noEmit`, `eslint`, `next lint`, or any redundant standalone lint/typecheck invocation.

## Escalation ladder

1. During ordinary implementation: `railgun check --changed --agent`
2. One package complete: `railgun check --agent` (from that package or with an explicit path)
3. Multi-package change: `railgun workspace check --affected --agent`
4. Next route topology changed: `railgun typegen` then `railgun check --changed --agent`
5. `package.json` / `tsconfig*` / workspace graph changed: escalate to package or affected-workspace validation
6. Merge-quality gate: `railgun workspace check --agent`
7. Framework/build gate only when required: `next build`

`next build` is the Next/Turbopack production gate, not the inner-loop type checker.

## Legacy command mapping

| instead of | use |
| --- | --- |
| `npx tsc`, `npx tsc --noEmit` | `railgun check . --type-aware --type-check` |
| `npx tsc -p tsconfig.json --noEmit` | `railgun typecheck` |
| `pnpm tsc` / `pnpm exec tsc` | `railgun typecheck` |
| `npx eslint .`, `pnpm lint` | `railgun lint` |
| `next lint` | `railgun lint` |
| `npx oxlint` | `railgun lint` |
| loop of per-package checks | `railgun workspace check --affected` |

## Modifiers

`--agent` compact single-line output, `--changed` files touched since `HEAD`, `--summary-only` scoreboard alone,
`--max-diagnostics N` bounded dump, `--json` / `--jsonl` machine formats, `--timings` per-stage breakdown,
`--no-daemon` deterministic cold run.

## Reading the output

Score line, then one metric line: `errors | warnings | files | LoC | +added/-removed LoC | milliseconds`,
then `scope:`, `cache:` (`cold` or `daemon/hot`), optional `suppressed:`, then `TOP FRAGS` counts.

Q3A band: `PERFECT` 0 errors, `HEADSHOT` 1, `IMPRESSIVE` 2-9, `EXCELLENT` 10-49,
`HUMILIATION` 50-99, `MASSACRE` 100+.

## Baseline awareness

With a captured baseline (`railgun baseline capture`) report in this order:

```text
new errors: 0        <- completion metric
pre-existing: N
resolved: M
LoC delta: +A/-R
```

Pre-existing diagnostics are historical debt: do not spend the session budget on them unless the task is about them.
