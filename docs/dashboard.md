# On the page

Click any row for the full read. Everything has a key:

| Key | Does |
| --- | --- |
| <kbd>/</kbd> | Jump to the filter |
| <kbd>↑</kbd> <kbd>↓</kbd> | Move between sessions, across both tables |
| <kbd>Home</kbd> <kbd>End</kbd> | First and last session |
| <kbd>↵</kbd> | Open the selected session |
| <kbd>Esc</kbd> | Close the panel, or clear the filter |

The list refreshes every 2 seconds — the masthead shows the time of the last
read, to the second — and says so when the server goes away. The detail panel
slides in beside the list and back out when you close it. The
page takes the same limit from the query string, so `?limit=200` and
`--limit 200` show the same depth of history.

**Range** and **Sort** above the Recent table narrow it to a stretch of history and
order it by recency or by token spend. Both go into the query string alongside the
limit — `?range=7d&sort=tokens-desc`, or `?range=custom&from=2026-08-01&to=2026-08-14`
— so a reload comes back to the same view, and a bookmark keeps it. Ranges are whole
local days, so "today" means since midnight rather than the last 24 hours. **Reset**
appears beside them once either is off its default and puts both back; it leaves the
text filter and how far you have paged alone. Neither control touches the Active
table: a running session is shown whatever window is on screen.

The theme follows your OS by default; **Auto / Light / Dark** in the top right
overrides it, and the choice is remembered. **Settings** is the third tab beside
Sessions and History — see [Getting told](limits.md#getting-told).
