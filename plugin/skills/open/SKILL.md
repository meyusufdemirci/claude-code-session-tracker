---
name: open
description: Open the Claude Code Session Tracker dashboard in the browser, starting the tracker first if it is not running.
disable-model-invocation: true
allowed-tools: Bash(claude-code-session-tracker open:*), Bash(npx -y claude-code-session-tracker@latest open:*)
---

The Claude Code Session Tracker was asked to open its page, and said:

```
!`claude-code-session-tracker open 2>&1 || npx -y claude-code-session-tracker@latest open 2>&1 || true`
```

Tell the user in one line what happened, with the address when there is one.
When it could not be started, give them the reason and the log path it named,
and do not try to start it another way.
