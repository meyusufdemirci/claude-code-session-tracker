# Troubleshooting

**Nothing is listed.** Check `curl -s 127.0.0.1:3099/api/health` — it prints the
directory that was searched. If that is not where your transcripts are, set
`CLAUDE_CONFIG_DIR` or pass `--claude-dir`.

**A session I just started is missing.** The list refreshes every 2 seconds and
a session appears once Claude Code has written its first record.

**A session shows as idle while it is clearly working.** Status comes from what
Claude Code itself records in `~/.claude/sessions/`. If that file is stale, the
row is honest about the file rather than guessing.

**The port is taken.** It steps forward automatically, up to 20 times; the
address it actually bound is the one printed. `--port` picks a different start.

**An old session has no title.** Titles are Claude's own, and older transcripts
predate them. The derived name and the first prompt stand in.
