# AI disclosure

This package (`@local/agent-bus`, published as the `agent-bus` plugin) was written by an
AI agent running inside DeepSeek Harness (session `session-398ba21f-630b-451a-bdbf-fed7af17de54`,
model `deepseek-v4.1-flash`), on 2026-11-20, at the direction and under the review of the
human owner of this machine (GitHub account `ZJ929-max`).

## What the AI produced

- `index.js`: the whole plugin — two tool definitions, the delivery path through
  `ctx.agents` / `agent.inject` / `agent.followup`, the untrusted-data marking, the
  per-pair reply budget, and the on-disk inbox mirror.
- `docs/DETAIL.md`, `README.md`, `locale/*.json`, `icon.svg`.

## What the human decided

- The feature (cross-session messaging inside one profile) and its red lines: no npm
  dependencies, no conditional tool registration, cross-session text treated as untrusted
  data, and at most one unprompted reply per peer.
- Publication: which license (MPL-2.0, matching the plugin pack), which repository, and
  whether the package joins the pack.

## What was verified, and how

Every claim in `README.md` / `docs/DETAIL.md` about behavior was exercised on this machine
against DSH 0.2.2-rc.3 (profile `desktop`): a real two-session A→B→A round trip, a second
round after a code reload, and the loop-guard rejection. The transcript is in the workspace
file `agent-bus-selftest.md` next to this package.

## Limits of that verification

Design decisions and mechanism claims are the AI's; they are backed by the references cited
in `docs/DETAIL.md`, not by an independent audit. Anything about DSH internals can change
with the next DSH release.

## License

MPL-2.0, see [LICENSE](LICENSE).
