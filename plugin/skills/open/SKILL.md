---
name: open
description: Open the Claude Code Session Tracker dashboard in the browser, starting the tracker first if it is not running.
disable-model-invocation: true
allowed-tools: Bash(claude-code-session-tracker open:*)
---

Ask the Claude Code Session Tracker to open its page by running this with the
Bash tool, exactly as written:

```
claude-code-session-tracker open
```

Only when that command is not found, run this instead:

```
npx -y claude-code-session-tracker@0.11.1 open
```

Tell the user in one line what happened, with the address when there is one.
When it could not be started, give them the reason and the log path it named,
and do not try to start it another way.
