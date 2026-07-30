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
- a round-less session with no staged ticket becomes reclaimable after 30
  minutes without service activity;
- each session retains its 128 most recent settled rounds and matching replay
  identities;
- commit timestamps retain only the active rolling-hour window, with an explicit
  900-entry ceiling matching the published 900-round policy; and
- the shared chamber accepts at most 256 simultaneous stream listeners.

At the session ceiling, creation first evicts sessions whose idle time reached
`sessionIdleEvictMs` and which have neither an open round nor any staged ticket.
If every retained session still has one of those protected states, creation
keeps the typed `SERVER_CAPACITY` refusal: the server cannot infer that an open
commitment or money-shaped state is safe to abandon. The production TTL is 30
minutes; tests may lower it through the same lower-only limits seam. Streams use
the same typed capacity failure and release their slot on request, response, or
error closure.

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
Activity refreshes a session's idle clock, but an inactive, round-less session
may disappear after the TTL; callers must save any receipt they need beyond the
documented in-memory windows. `SERVER_CAPACITY` still means every slot is
currently protected. Process restart still loses every session, exactly as
before.
