# Scripting and API

## Scripting

`--json` prints the same payload the page uses, then exits:

```sh
npx claude-code-session-tracker --json | jq '.sessions[] | .project.name'
```

```jsonc
{
  "sessions": [
    {
      "id": "279ed6ae-49fd-4234-a74e-145f5535341c",
      "source": "claude-code",
      "status": "busy",              // busy · waiting · idle · ended
      "project": { "name": "…", "path": "…", "slug": "…", "gitBranch": "main" },
      "title": "Disable dependabot", // Claude's own title, when it wrote one
      "firstPrompt": "…",
      "lastPrompt": "…",
      "model": "claude-sonnet-5",
      "version": "2.1.235",          // the Claude Code that wrote the session
      "startedAt": 1787142489923,
      "lastActiveAt": 1787142700231,
      "transcriptPath": "…/279ed6ae….jsonl",
      "sizeBytes": 136133,
      "live": { "pid": 4129, "kind": "interactive", "entrypoint": "cli" }
    }
  ],
  "sources": [ /* one entry per adapter, with whether it found its data */ ],
  "total": 794,
  "generatedAt": 1787142701002
}
```

Only running sessions carry `live`. Everything else is optional — a field that
was not in the transcript is absent rather than null.

## HTTP API

The server is the same one the page talks to, so anything the page can do you
can do with `curl`:

| Route | Returns |
| --- | --- |
| `GET /api/sessions?limit=N` | The list above. `limit` matches `--limit`, and running sessions are always included |
| `GET /api/sessions?since=&until=` | The same list, narrowed to transcripts last written in that window. Epoch milliseconds; `since` is inclusive, `until` exclusive; either may be left off. Running sessions ignore it |
| `GET /api/sessions?sort=` | `recent` (the default), `tokens-desc`, or `tokens-asc`. Ranks the finished sessions across the whole window, not just the page. An unknown value falls back to `recent` |
| `GET /api/sessions/:id` | One session with `counts`, `tokens`, `models`, `activeMs`, `awaySummary`, and `notes` |
| `GET /api/limits` | Both limits, as `session` (five hours) and `weekly` (seven days). Each carries `windowMs`, `clock`, `historyDays`, the `current` window, the `recent` stretch the forecast is drawn from, the server's percentage as `reported` when there is one for the window in progress (its `source` says whether this tool fetched it — `server` — or read Claude Code's cached one — `claude-code` — and on the weekly limit, `scope` names the one model it covers when the plan has no all-models week), the heaviest closed window as `reference`, and `lastLimited` if Claude ever cut one short. 404 when no source can measure them |
| `GET /api/usage/history?since=&until=&project=&perProject=` | Where the tokens went: a sparse half-hour series, every project in the range with its name and directory, and every model, each ranked by billed tokens. Epoch milliseconds again; `since` defaults to 30 days back, `until` to now, and a span wider than a year and a week (371 days) is narrowed — `range` in the reply is always the one actually read. `project` takes a slug from the same reply and narrows the series and the models to it, never the project list. `perProject=1` adds each covered project's own half-hour series as `buckets` on its entry — what the export uses to split a day by project; left off, the payload carries only the merged series. 404 when no source can measure it |
| `GET /api/health` | `ok`, the version, the Node it runs on, the resolved Claude directory, and per-source status |
| `POST /api/sessions/:id/reveal` | Shows that transcript in your file manager. Requires a loopback `Origin` |

Every route refuses a request whose `Host` is not loopback. `reveal` is the only
one that acts rather than reports, so it is a POST, it checks `Origin` as well,
and the path it opens comes from our own lookup — never from the request.

## Programmatic use

```js
import { createConfig, SessionRegistry } from 'claude-code-session-tracker/core';

const registry = new SessionRegistry(createConfig());
const { sessions } = await registry.list({ limit: 20 });
const detail = await registry.detail(sessions[0].id);
```

`createConfig()` takes `{ claudeDir, host, port }` overrides. `registry.detail()`
resolves to `null` for an unknown id rather than throwing.
