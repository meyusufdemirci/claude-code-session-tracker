# How it stays fast

Feature-complete for v1 — phases 0 through 4 of [`PLAN.md`](../PLAN.md).

**Running sessions** come from `~/.claude/sessions/*.json`. Those files outlive the
processes that write them, so each one is checked twice before it becomes an Active
row: `process.kill(pid, 0)`, then the recorded start time against the real one, which
is what rules out a recycled PID.

**Recent sessions** come from the transcripts, which run to about a gigabyte on a
working machine. Listing them reads no file contents at all — one `readdir` per
project and a `stat` per file is enough to sort by recency. Only the sessions
actually shown are opened, and only their first 16 KB and last 64 KB, which is where
the title, the prompts, the model and the branch live. Results are memoised against
each file's size and mtime, so an untouched transcript is never read twice. Listing
all 794 transcripts on the development machine takes ~230 ms cold and ~75 ms warm.

Both the date range and the sort are settled from that same sweep where they can be.
A range is: `stat` already knows when each file was last written, so narrowing one
costs nothing and opens fewer files than not narrowing it. Ordering by tokens is not
— the totals are inside the transcripts — so it reads the whole range before it can
rank it, which is what makes "the ten biggest sessions this week" the ten biggest of
all 227 rather than of the ten on screen. That read is ~1.4 s cold for all 871
transcripts on the development machine, and free once memoised.

**Opening a session** streams its transcript once, line by line, capping how much of
any single line it holds — the largest record on the development machine is 9.4 MB,
and memory should be a property of the reader, not of the biggest tool output in the
session. A 37 MB transcript answers in 99 ms; the slowest of all 795 is 140 ms.

**The history page** adds no read of its own. It asks the same sweep for two things
the limit cards throw away — which project billed each half hour, and which model —
and the first costs nothing at all, since the sweep already walks `projects/<slug>/…`
and knew the slug it was dropping. A 7-day page is ~450 ms cold and ~15 ms warm on
the development machine, and the bucket cache is shared with the cards, so whichever
you open second is the cheap one. The year grid is a read of its own, a calendar
year at a time, so it is drawn after the rest of the page rather than holding it up;
past the 28 days the cards keep warm, the first read of a year is cold, and memoised
after that.

**The limits** are the one read that has to cover weeks rather than a page, because
the yardsticks they fall back on are the heaviest window of the last 7 days and the
heaviest week of the last 28. It bounds itself the same way: a transcript is append-only, so
one last written before the cutoff cannot hold a record after it, and `mtime` settles
that without opening anything. The files that survive are then reduced to half-hour
buckets and memoised per file version — the part that does not change — so only the
handful still being appended to are ever re-read. Both clocks are counted off that
one sweep: 901 files and 1 GB on the development machine come to ~1.3 s cold and ~7 ms
warm. The page asks every 15 seconds and ticks the countdown itself in between; the
server's percentage behind it is asked at most every five minutes, one request at a
time, with a five-second timeout.

Malformed lines are counted and skipped, never thrown on: the `.jsonl` format is
private and undocumented, and it will change under us. When it does, the detail
panel reports what it could not read in `notes` instead of pretending.
