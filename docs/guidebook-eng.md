# Teledex Operator Guidebook

Teledex turns a Telegram forum into a control surface for durable Codez
sessions. This guide explains the operator workflow; installation and
hardening remain separate responsibilities.

## Before you begin

Teledex is for trusted operators. Codez runs with broad host authority and no
interactive approval prompts. Use a dedicated environment and send only work
that the Teledex service account is allowed to perform.

Complete the installation guide, run `doctor`, and validate one disposable
foreground session before using real workspaces.

## Mental model

- General is the control lobby.
- Each work topic is one durable Teledex session.
- A session has its own workspace binding, host, model, reasoning, suffix,
  queue, and active run.
- Codez performs the agent work; Teledex routes updates and stores coordination
  state.
- Private chat is an isolated repair lane for the Teledex checkout, not a
  work-topic replacement.

## Start a session

In General, inspect hosts when needed and create a topic:

```text
/hosts
/new Project name
```

Advanced `/new` forms can select a host, provider, model, profile, and path.
Use `/help` for the syntax supported by the running version.

Open the new topic and check:

```text
/status
/menu
```

Confirm the path and host before sending a prompt that can modify files.

## Send and control work

Send plain text to start immediately when the topic is idle.

Use the queue when work should wait:

```text
/q Run the focused test suite after the current task
```

Use a manual buffer for a prompt assembled from several messages or files:

```text
/wait 60
```

Send the fragments and attachments, then send `All` to dispatch immediately.
Use `/wait off` to cancel and clear the local buffer.

Use `/interrupt` when the active run must stop. An interrupt can leave partial
workspace changes, child-process output, or external side effects; inspect the
workspace before retrying.

## Emergency repair

An allowlisted human can send a private message when the Teledex checkout
itself needs repair. `/help`, `/status`, and `/interrupt` control the emergency
lane; any other text starts an emergency prompt. A file or image can be
buffered and paired with the next prompt.

This lane bypasses normal topic sessions and launches one isolated
`codex exec` process against the Teledex repository root. It rejects a second
emergency task and stays locked while any normal topic run is active.

Emergency execution has the same broad host authority as normal work. Keep the
checkout recoverable, use narrowly scoped repair prompts, and inspect the
resulting diff before restarting the service.

## Runtime controls

Useful commands:

- `/status` shows the session and runtime view.
- `/limits` shows available Codez usage windows.
- `/model` and `/reasoning` inspect or change topic settings.
- `/goal` inspects or changes the App Server v2 goal.
- `/suffix` manages instructions appended to routed prompts.
- `/compact` rebuilds the durable brief from the exchange log.
- `/diff` returns a workspace diff artifact.

Global variants affect future or multiple topics. Prefer topic-local changes
unless a deliberate shared default is required.

## Files and attachments

Incoming files have a 20 MiB soft limit. Returned files have a 45 MiB soft
limit and must normally come from the bound workspace, current directory, or
session state.

Review every path before requesting delivery. Do not send credential files,
private keys, unrelated personal data, or secrets through Telegram.

## Topic and session lifecycle

If Telegram closes or loses a topic, Teledex can park the session. Reopening
the topic can reactivate it. Eligible parked sessions are eventually purged
according to retention settings.

`/purge` removes Teledex session content under guarded conditions. It does not
delete Telegram history, Codez's separate session store, remote files, provider
logs, system logs, or backups.

## A reliable daily pattern

1. Check `/status` and the workspace path.
2. State the goal and constraints in one clear prompt.
3. Use `/q` for sequential follow-up work.
4. Use `/wait` only for intentional multipart input.
5. Watch progress for an unexpected host, path, model, or tool.
6. Interrupt when the risk exceeds the value of continuing.
7. Inspect `/diff` and run the project's verification.
8. Preserve important artifacts outside transient state.
9. Purge only after retention and recovery needs are understood.

Use the [Runbook](./runbook.md) for service operations and
[Troubleshooting](./troubleshooting.md) for failures.
