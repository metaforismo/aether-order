# ADR 0003: Bound public in-memory service state

**Status:** accepted

## Context

AETHER ORDER is intentionally a single-process, free-play prototype. It has no
authentication, accounts, database, or cross-restart recovery, and this decision
does not add any of them. Public callers can nevertheless create sessions, play
rounds, retry tickets, and open shared-chamber streams. Leaving the corresponding
maps, arrays, and listener set unbounded would let one caller consume memory for
as long as the process remains alive.

## Decision

`SERVER_LIMITS` in `src/server/session.ts` is the normative list of service
ceilings:

- at most 1,024 live sessions exist in one process;
- each session retains its 128 most recent settled rounds and matching replay
  identities;
- commit timestamps retain only the active rolling-hour window, with an explicit
  900-entry ceiling matching the published 900-round policy; and
- the shared chamber accepts at most 256 simultaneous stream listeners.

New sessions are refused with the typed `SERVER_CAPACITY` `ServiceError` at the
session ceiling. We deliberately refuse instead of evicting: every retained
session may have an open commitment or a staged shared-chamber ticket, and the
server cannot infer that money-shaped state is safe to abandon. Streams use the
same typed capacity failure and release their slot on request, response, or error
closure.

Settled history uses oldest-first eviction. At the 2.5-second physical cycle
floor, 128 rounds preserve at least 5 minutes 20 seconds of exact-retry history;
at the published 900-round rolling-hour ceiling they preserve about 8 minutes
32 seconds. AO-02 retries remain exact and non-debiting throughout that window.
After eviction, the old round and its idempotency identity are both absent, so
the service cannot mistake a partial record for a recoverable retry. Unstaged
shared-draw shells are removed immediately after a rejected ticket because no
wallet mutation or retry guarantee exists for them.

## Consequences

Memory is bounded without pretending that the prototype offers persistence.
Callers must treat `SERVER_CAPACITY` as temporary process capacity and must save
any receipt they need beyond the documented in-memory history window. Process
restart still loses every session, exactly as before.
