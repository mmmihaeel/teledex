# Telegram Surface

Teledex uses one configured forum-enabled supergroup plus a narrow private
emergency lane.

## Conversation lanes

| Lane | Purpose |
| --- | --- |
| General topic | Create work topics, inspect hosts, open global settings, request help or the guidebook, and open Project Catalog. |
| Work topic | Operate one durable session with its own binding, model, reasoning, suffix, queue, and active run. |
| Private chat | Isolated emergency repair against the Teledex checkout; it is not a normal topic session. |

Every update must come from `TELEGRAM_FORUM_CHAT_ID` when group-scoped and from
an identifier in `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_USER_ID`, or
the optional `TELEGRAM_ALLOWED_BOT_IDS`. Authorized bot identifiers have the
same operational trust as authorized users.

## Private emergency lane

An allowlisted human can use private chat when the gateway checkout itself
needs repair. Bots are rejected from this lane. `/help`, `/status`, and
`/interrupt` are control commands; any other text is treated as an emergency
prompt. Attachments can be buffered and paired with the next prompt.

Emergency work bypasses the normal forum-topic and App Server v2 session
pipeline. It starts one isolated `codex exec` process against the Teledex
repository root. A second emergency run is rejected, and emergency work cannot
start while a normal topic run is active.

This is a full-authority repair path, not a general-purpose private session.
Use it only for the gateway checkout, keep that checkout recoverable, and
inspect its diff after every emergency run.

## Core commands

| Command | Scope | Purpose |
| --- | --- | --- |
| `/help` | General or work topic | Send the two-page command reference. |
| `/guide` | General | Send the operator guidebook PDF. |
| `/new ...` | General | Create a bound work topic, optionally selecting host, provider, model, profile, and path. |
| `/hosts`, `/host <id>` | General | Inspect execution hosts. |
| `/global` | General | Open global defaults. |
| `/menu` | Work topic | Open topic-local controls. |
| `/status`, `/limits` | General or work topic | Inspect session/runtime state and Codez usage windows. |
| `/q <text>` | Work topic | Queue a prompt behind current work. |
| `/wait ...` | General or work topic | Buffer multipart text and attachments before dispatch. |
| `/interrupt` | Work topic or private lane | Stop the active run for that lane. |
| `/diff` | Work topic | Deliver a workspace diff artifact. |
| `/goal` | Work topic | Inspect or change the App Server v2 goal. |
| `/compact` | Work topic | Rebuild the durable brief from the exchange log. |
| `/purge` | Work topic | Request guarded deletion of Teledex session content. |
| `/suffix`, `/model`, `/reasoning` | General or work topic | Inspect or change global or topic settings. |
| `/zoo` | General | Open the optional Project Catalog topic. |

Use `/help` for the exact syntax supported by the running version.

## Prompt dispatch

- Plain text in a work topic starts work when the session is idle.
- When a run is steerable, follow-up input can be submitted to the active
  thread.
- `/q <text>` persists work for later execution.
- `/wait <seconds>` opens a one-shot topic buffer for multipart input.
- `/wait global <seconds>` opens a persistent chat-wide buffer.
- Send `All` to flush the current buffer immediately.
- `/wait off` or `/wait global off` clears the corresponding buffer.

Only use global buffering when every authorized operator understands that
messages across topics can participate in the same collection window.

## Attachments and returned files

- Incoming Telegram files have a 20 MiB soft limit.
- Outbound files have a 45 MiB soft limit.
- Normal outbound delivery is restricted to the session's bound worktree,
  current working directory, or Teledex session state.
- `TELEDEX_ALLOW_SYSTEM_TEMP_DELIVERY=1` also permits system-temp delivery and
  expands the trust boundary.
- Remote execution stages files between hosts; review both local and remote
  paths before enabling it.

Telegram Bot API traffic is not a private local channel. Avoid sending secrets,
credential files, regulated data, or unrelated personal data through prompts
and attachments.

## Topic failures

When Telegram reports that a topic is closed or unavailable, Teledex can park
the session rather than repeatedly failing delivery. Reopening the topic can
reactivate it. Retention and purge behavior are documented in the
[State contract](./state-contract.md).
