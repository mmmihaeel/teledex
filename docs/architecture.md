# Architecture

Teledex is a stateful gateway between Telegram and Codez App Server v2. It
owns authorization, chat and topic routing, durable Teledex metadata, prompt
coordination, and Telegram delivery. Codez owns the agent thread and tool
runtime.

## Trust boundaries

```mermaid
flowchart LR
    Operator[Allowlisted trusted operator]
    Telegram[Telegram Bot API]

    subgraph TeledexHost[Teledex host account]
        Poller[Long-poll leader]
        Router[Authorization and route selection]
        Sessions[Session and queue services]
        State[(Teledex state root)]
        LocalRunner[Local App Server v2 runner]
        Workspace[Bound workspace]
    end

    subgraph RemoteHost[Optional remote host]
        SSH[SSH and file staging]
        RemoteRunner[Codez App Server v2]
        RemoteWorkspace[Remote workspace]
    end

    Operator --> Telegram
    Telegram --> Poller
    Poller --> Router
    Router --> Sessions
    Sessions <--> State
    Sessions --> LocalRunner
    LocalRunner --> Workspace
    Sessions --> SSH
    SSH --> RemoteRunner
    RemoteRunner --> RemoteWorkspace
    LocalRunner --> Provider[Model and tool providers]
    RemoteRunner --> Provider
```

Binding resolution rejects paths outside the configured workspace root.
That boundary determines where a session starts and which files Teledex may
stage or deliver; it is not an operating-system sandbox. Codez runs with
`approvalPolicy=never` and `sandbox=danger-full-access`.

## Prompt flow

```mermaid
sequenceDiagram
    actor Operator
    participant API as Telegram Bot API
    participant Router as Teledex router
    participant Session as Session and queue services
    participant Codez as Codez App Server v2
    participant State as Teledex state

    Operator->>API: Send command, prompt, or attachment
    API->>Router: Long-polled update
    Router->>Router: Verify forum chat and sender allowlist
    Router->>Session: Resolve lane, topic, binding, and active run
    alt queue or manual buffer
        Session->>State: Persist queued or buffered input
        Session-->>API: Confirm queued state
    else active run can be steered
        Session->>Codez: Submit steering input
    else start or resume
        Session->>Codez: Spawn stdio App Server and start or resume thread
    end
    Codez-->>Session: Progress, tool, goal, and final events
    Session->>State: Persist metadata, exchange, progress, and artifacts
    Session-->>API: Edit progress and send final text or bounded files
    API-->>Operator: Telegram response
```

For a local task, Teledex starts `codex app-server --listen stdio:// --enable
goals` and exchanges JSONL/RPC over child-process stdio. For a remote task,
the host-aware runner stages inputs and launches the same protocol over SSH to
a POSIX-style host.

Private emergency repair is the deliberate exception: an allowlisted human's
private prompt bypasses normal topic/session routing and starts one isolated
`codex exec` process against the Teledex repository root. It is unavailable
while any normal topic run is active. There is no configurable HTTP App Server
transport.

## Session lifecycle

```mermaid
stateDiagram-v2
    [*] --> Active: topic session created or restored
    Active --> Active: prompt, queue, steer, or resume
    Active --> Parked: topic closed or unavailable
    Parked --> Active: topic becomes usable again
    Active --> PurgedStub: guarded operator purge
    Parked --> PurgedStub: retention age reached and session eligible
    PurgedStub --> Active: later activity creates fresh working state

    note right of Parked
      Default retention age: 168 hours
      Default sweep interval: 60 seconds
    end note

    note right of PurgedStub
      Content is removed, but minimal
      lifecycle metadata may remain.
    end note
```

Pinned, busy, compacting, or claimed-queue sessions are not eligible for the
automatic parked-session purge. Teledex retention also does not remove Codez's
separate session store under the configured Codez sessions root.

## Graceful service handover

A Linux service rollout may temporarily have a new polling leader while the
retiring generation still owns in-flight sessions. Generation state and a
token-protected loopback channel preserve routing during the drain.

```mermaid
sequenceDiagram
    actor Operator
    participant Store as Generation coordination
    participant Old as Retiring generation
    participant New as New polling leader
    participant API as Telegram Bot API

    Operator->>Store: Request service rollout
    Store->>Old: Mark generation retiring
    Old->>Store: Publish loopback endpoint and instance token
    Store->>New: Grant polling leadership
    API->>New: Deliver update
    alt session is still owned by retiring generation
        New->>Old: Forward update over authenticated loopback IPC
        Old-->>API: Continue progress and finish in-flight run
    else new or transferred session
        New-->>API: Process update
    end
    Old->>Store: Release drained ownership
```

This design reduces rollout interruption but is not a zero-data-loss
guarantee. Operators still need state backups, health checks, and a rollback
plan.

## Component map

| Area | Responsibility |
| --- | --- |
| `src/cli` | Startup, diagnostics, smoke, service install, rollout, and maintenance entrypoints. |
| `src/telegram` | Bot API, authorization, update routing, commands, panels, attachments, and delivery. |
| `src/session-manager` | Topic metadata, queues, lifecycle, briefs, settings, and ownership. |
| `src/app-server-v2` | JSONL/RPC transport, goals, steering, thread control, and local or remote runners. |
| `src/pty-worker` | Run orchestration, retries, recovery, progress, and artifact staging. |
| `src/hosts` | Host registry, SSH bootstrap, remote execution, and host diagnostics. |
| `src/runtime` | Process, environment, plugin, systemd, generation, and IPC utilities. |
| `src/state` | Directory layout, atomic writes, and platform permission handling. |
| `src/zoo` | Optional Project Catalog topic and project-analysis state. |

App Server v2 is the supported normal topic-session runtime. Private emergency
repair intentionally uses `codex exec`; other legacy execution paths remain in
the source tree for migration and test coverage.
