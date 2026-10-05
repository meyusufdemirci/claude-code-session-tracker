# The limits

Claude Code bills against two clocks: a five-hour window it calls a session
limit, and a seven-day one it calls a weekly limit. Neither quota is written to
disk — both are enforced server-side and the only trace either leaves in a
transcript is the turn it refused. So the share of each limit is asked of the
server, the same way `/usage` asks it, and everything else on the cards — the
windows, the tokens, the pace — is **measured from the transcripts**:

- **The five-hour window** is chained from the turn timestamps. It opens on your
  first billed turn after the last one emptied and runs five hours from there,
  floored to the half hour, which is where Claude puts it: on the one refusal
  this was calibrated against, a first turn at 08:37 reset at 13:30. When Claude
  *has* refused a turn, its own `resetsAt` is used instead of ours.
- **The week** cannot be chained the same way — nobody goes seven quiet days, so
  there is no gap to read a week's edge off. Claude writes its weekly clock down
  in exactly one place: a weekly refusal. With one of those in your history the
  weeks are pinned to it and stepped forward in sevens; without one the card
  counts the seven days behind you and says so rather than implying a reset
  nobody can read.
- **Used** is input, output and newly-cached tokens across every project — and
  every subagent, whose turns bill to the window that spawned them. Cache reads
  are shown apart: they cost a fraction as much and outweigh the rest roughly
  fifty to one, so folding them in would produce a number that tracks how long
  your conversations are rather than how much work you asked for.
- **At this pace** is the forecast: if you keep working the way you are working
  now, when this window runs out — or, if it will not, where it stands when it
  resets. The rate is the recent stretch's — the last hour of the five-hour window,
  the last day of the week — not the window's average, since a burst of agents two
  hours into a quiet window barely moves the average and is exactly what the
  forecast is for. It waits until that stretch covers a twentieth of the window (a
  quarter of an hour, or eight hours of the week), since one heavy turn two minutes
  in projects sixty times itself, and it stays away from a rolling week entirely:
  that one ends at the instant it is measured, leaving nothing to forecast into.
- **Two ticks on the bar.** The thin one is the clock — how much of the window's
  time has gone — and the other is the forecast, where the fill reaches by the
  reset, pinned at the end when the window runs out first. Hover or focus either for
  the figures behind it.
- **The colour** is read against the clock tick, not against the limit alone: half
  the limit spent a tenth of the way into the window is trouble, and nine tenths
  spent with an hour of five to go is not. A fill past the tick is red, closing on
  it amber, well behind it green. A rolling week has no clock tick, so its bar falls
  back to the limit's own scale.
- **The share** — the bar, and the percentage printed at the end of it — is
  Anthropic's reading of that limit, from the endpoint Claude Code's own `/usage`
  reads, so it is the same number `/usage` shows you. It is asked with the token
  Claude Code is already signed in with — from the macOS Keychain, or
  `~/.claude/.credentials.json` elsewhere — read and never written: an expired token
  is skipped rather than refreshed, because refreshing it here would sign Claude Code
  out. It is asked at most every five minutes, a failed request keeps the last good
  answer, and the note under the bar says whose reading it is and how long ago it
  was taken.

  With `--offline`, or when the server cannot be asked, the bar uses the readout
  Claude Code caches in `~/.claude.json` instead — the same figure, but only as fresh
  as Claude Code's own last request for it.

  Where there is neither — a machine whose account file has none, a window whose
  reading has already reset, or a reading left more than a fifth of its window
  behind the work, which is an hour for the five-hour card and a day and a half for
  the weekly one — the bar falls back to a yardstick: the heaviest window that has
  already closed, the last 7 days for the five-hour card and the last 28 for the
  weekly one, never the one in progress, since a window is always 100% of itself.
  The note says which of the two you are looking at. Past the end the bar reads
  full, having nowhere further to go, while the percentage keeps counting.

If nothing has run in a window there is none, and the card says so rather than
showing an empty bar.

## Getting told

A desktop notification when a window's forecast reaches the top of the bar before
the window resets — the real limit where there is a reading of it, and the heaviest
window that has already closed where there is not. It says when, and how long before
the reset that is: *At the last hour's pace you'll hit the limit at 15:40, 1h 20m
before it resets.* The card says the same thing in
colour; this is the same fact addressed to whoever is not looking at the card, which
is the usual case for a tab parked behind an editor.

The first time the dashboard has a limit to show you and has never asked, a sheet
comes up along the bottom offering these. **Not now** means not now: it goes away
and comes back once, a fortnight later, if you still have not turned either switch
on. A second **Not now** is the last of it. Opening the settings page from it closes
the offer for good, whatever you decide once you are there — and so does turning a
switch on or off yourself, since that is you having decided.

**Settings** has a switch for each limit — the five-hour window and the week —
because the two answer different questions and plenty of people want one and not
the other. Both start off. Turning either one on is what asks the browser for
permission; nothing asks on load. If you have already refused notifications for
this page the switches come back off and the page says so — that one is a
setting in your browser's address bar, not here. Your answer is kept underneath
either way, so unblocking the page is enough to get them back.

Beside each switch is how often that limit may interrupt you. **An hour** for the
five-hour window and **four hours** for the week to begin with — each about a fifth
of its own span, which is roughly where a second warning is news rather than a
repeat. Session offers 30 minutes to 5 hours, the week 1 hour to a day; the
quietest choice on either is one warning per window.

What they will and will not send:

- **One, then quiet.** A window over its yardstick stays over it for hours, and it
  says so once. Nothing else is sent until the interval is up, including if the
  rate settles back under and crosses again — that is the same interruption
  arriving twice.
- **Again once the interval is up**, if the window is still headed past. The news
  by then is that it did not settle.
- **Nothing for a rolling week.** A week with no reported reset ends at the
  instant it is measured, so there is no remainder to forecast into — the same
  silence the card's `At this pace` cell keeps.
- **Only while a dashboard tab is open.** Nothing runs in the background: this
  is the page noticing, not a service. The tab can be buried, but it has to be
  there.

The switches, the intervals and whether that first-run sheet has been answered are
remembered in the browser, per browser, like the theme.
