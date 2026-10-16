## Findings

Keep each finding in its own folder in the workbase, as you go, not at the end: `{{workbase}}/findings/F<n>-<short-name>/README.md` (take the next free number; `ls {{workbase}}/findings`). Start one as soon as you have a lead worth checking. The README starts with a short header, then whatever you know:

```
---
state: suspected      # lead | suspected | confirmed | ruled_out
severity: high        # critical | high | medium | low | info
location: src/file.c:123 function_name
poc: poc.bin          # relative to this folder
---
# One-line title

What it is, why it's reachable, impact. How to reproduce (exact commands). What you tried.
```

Keep `state` current as you learn more, and put PoCs, crash logs and harnesses for the finding in its folder. Never delete a finding: mark it `ruled_out` and say why, so nobody checks it again. Subagents write findings the same way. This is what the human watches while you work and what later agents read. `TRIAGE.md` in the workbase has the human's verdicts on your findings when there are any; read it when you start and after a restart.
