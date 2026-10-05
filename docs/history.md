# Where the tokens went

The limit cards say how full the window in progress is. The history page says what
filled it. It reads the same sweep — the transcripts are read once and counted for
both — so opening it beside a running dashboard costs a `stat` per file.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="history-dark.png" />
  <img alt="The history page: a range summary, a bar per day for thirty days, an hour-of-day grid with the busy half hours falling between nine in the morning and eleven at night, and a table of projects ranked by billed tokens" src="history-light.png" />
</picture>

Five reads, in the order the question gets asked:

- **Spend per day**, a bar for every local day in the range — including the quiet
  ones, because a chart that closed the gaps would draw a busy fortnight and a
  scattered month identically. A mark under a bar is a day Claude refused a turn.
  **Day / Week / Month** beside it folds the bars into Monday-to-Sunday weeks or
  calendar months, cut to the range at either end, for a range too long to read
  a day at a time.
- **Hour of day**, every half hour of the range folded onto one week. This is the
  reading the daily bars cannot give: whether the five-hour window keeps being
  opened at nine in the morning or at eleven at night.
- **Year**, a calendar year as a grid of days, Monday to Sunday, shaded by billed
  tokens in four steps cut at the quartiles of the days that billed anything — so
  the shading tracks your own year rather than a fixed scale. It reads a calendar
  year whatever the range above says, follows the project picked, and steps back
  a year at a time with **‹ ›**, as far as 2025. Days still to come are drawn
  empty, so the current year reads as a whole year.
- **Projects**, ranked by billed tokens, with cache reads shown apart. Where two
  checkouts share a directory name the parent goes in front of it, and the full
  path is printed under each. Pick one and the summary, the drawings and the model
  list narrow to it; pick it again to let go.
- **Models**, the same ranking, one row each — where an Opus habit shows up.

**Range**, in the masthead because it governs every section but the year, is 7, 30 or
90 days, or a pair of dates of your own. It goes into the query string alongside the
project, the bar grouping and a past year — `?range=7d&group=week&year=2025&project=…`
— so a reload comes back to the same view, a bookmark keeps it, and Back walks the
ranges, the years and the selections. Only what differs from the default is written,
so a plain `/history` stays plain. Ranges are whole local days, which is why the day
count and the number of bars always agree. A custom range left open at the start
reaches back ninety days; a year and a week is the ceiling, and asking for more reads
that much and says that it narrowed.

Nothing on this page polls — a month of history does not move fast enough to be worth
re-reading every two seconds — so **Refresh** is how you ask for another read.

## Export

**Export** beside Refresh writes a report — built in the page, with no library and
nothing sent anywhere. A dialog asks first, and says back what the file will hold
before it is written:

- **Dates** — as on the page, the last 7, 30 or 90 days, or a pair of your own.
- **Rows** — daily, weekly or monthly; it starts as the bars on the page do.
- **Projects** — all of them, or one, from the projects that billed in those dates.
- **Format** — a PDF, or an `.xlsx` that Excel, Numbers and Google Sheets open as
  their own.

Both formats say the same numbers, because the report is added up once and each
writer only lays it out: the totals (billed, input, output, cache writes, cache reads,
turns, projects and active days), every project ranked by billed tokens with its
share when there is more than one, then each project's rows — one for every day, week
or month that billed something. The PDF is A4, one table per project with a total row
and a page count in the footer. The spreadsheet has two sheets, **Summary** and the
rows, with real numbers and dates, a frozen header and filters, so it sorts and pivots
like anything else. **Preview** opens the PDF in a new tab and leaves the dialog open.

Files are named for what is in them:
`claude-code-usage_<project or all-projects>[_weekly|_monthly]_<from>_<to>.pdf`.

## Share your year

**Share** on the year grid draws it as a picture — in the theme on screen, with the
year, the active days and the tokens billed — and offers **Share on X** and **Share on
LinkedIn**. Neither network lets a link attach an image, so a click copies the
picture to the clipboard, saves it to your downloads as `claude-code-<year>.png`, and
opens a new post with a caption filled in (*My 2026 with Claude Code: 214 active days
and 1.2B tokens billed.*); paste the image in with ⌘V or Ctrl+V. Nothing is posted
for you, and nothing leaves the page until you press the network's own Post.

Two things it is honest about rather than quiet about: a project whose directory has
since been moved or deleted cannot be resolved from the folder name Claude Code
stores, so it shows the plainest reading of that name and may be wrong about the
path; and the split by model covers every turn that named one, which on every
transcript seen so far is all of them.
