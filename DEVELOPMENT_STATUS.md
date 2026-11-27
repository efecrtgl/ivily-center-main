# Development Status

Last updated: 2026-11-27

No completion percentages are given on purpose; a phase is either **done** (built, tested,
committed, pushed and verified on GitHub), **in progress**, or **planned**.

## Current phase

**Phase 0 — Audit, architecture and planning:** done.

## Phases

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Audit, architecture, planning | done | [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 1 | Repository infrastructure | planned | |
| 2 | Core & custom window | planned | Includes DB, settings, theme tokens, command registry (roadmap change, see plan §3) |
| 3–25 | See plan | planned | |

## Architectural decisions

See [ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-key-technology-decisions-adr-summary).

## Known issues

* Ivily Envora's IEP envelope differs from IEP 0.1 used by Optimizer, Portly and Structura.
  Center will ship an adapter; alignment should happen in the Envora repository.
* `gh` CLI is not installed on the development machine; pushes are verified with `git ls-remote`.

## Build / test status

No code yet.

## Release status

Unreleased.

## Repository synchronisation

Remote `origin` = https://github.com/efecrtgl/ivily-center-main (empty before the first push).
