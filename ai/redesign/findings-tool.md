# Findings (replace PROGRESS.md)

Decided 2026-10-15. First built as an opencode plugin with four tools writing FINDINGS.json; the same day the user asked for plain files instead, so everything stays in the workbase, readable by any agent, with no tool or MCP call (see decisions.md). What is built is described in `ai/design.md` § Findings; the agent text is `templates/parts/findings.md`.

## Format

One folder per finding in the run's workbase, written by the agent with its normal file tools:

```
findings/F3-iccp-heap-overflow/
  README.md      ---
                 state: confirmed      # lead | suspected | confirmed | ruled_out
                 severity: high        # critical | high | medium | low | info
                 location: pngrutil.c:1184
                 poc: iccp-0041.png    # relative to the folder
                 ---
                 # Heap overflow in iCCP decompression
                 what, why reachable, impact, how to reproduce, what was tried
  iccp-0041.png
```

States:
- **lead**: an idea worth checking. Severity optional.
- **suspected**: looks like a real bug, not reproduced yet.
- **confirmed**: reproduced, with a PoC.
- **ruled_out**: checked, not a bug; the README says why, so nobody checks it again. Findings are never deleted (a deleted folder shows as removed).

Pixel owns `FINDINGS.md` (index) and `TRIAGE.md` (verdicts) at the workbase root and never writes inside `findings/`.

## Triage (2026-10-20, replaced the verdicts)

The human's (or an MCP client's), per finding, in two parts:
- **Disposition**, once: **R** report (real, novel, disclose it), **K** known (already public), **D** duplicate (of another finding, named), **W** weak (real, not worth disclosing), **I** invalid (not a bug); a final severity when it differs from the agent's; a note.
- **Disclosure**, only for report, set by hand in the dashboard: not sent, sent (with the advisory link), fixed (version or commit), or dropped with a reason.

Written to TRIAGE.md, FINDINGS.md and TRIAGED.md (all runs) for later agents; they never message the run. The run's result ("2 to report (1 high, 1 low)") comes from them. The Findings page has four lists over them: To triage, Report, Resolved, Reviewed (plus Set aside for leads and ruled out).

## UI (see spec.md)

- Findings tab: grouped by state, verdict buttons with keys, detail with the README rendered, a link to the folder, the PoC, history, and any problem Pixel had reading the header.
- Tile finding line, finished-row dots, nav count, To triage filter and stat, Latest feed, stream marks, Findings page: all read the `findings` table / live `finding` events.
