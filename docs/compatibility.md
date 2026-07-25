# Compatibility

This document separates declared requirements from compatibility that must be
verified for a specific release.

## Runtime matrix

| Component | Declared boundary | Verification expectation |
| --- | --- | --- |
| Node.js | `^20.19.0`, `^22.13.0`, or `>=24` | Run runtime and release checks on the exact deployed version; the locked ESLint 10 toolchain requires this range. |
| Operator language | English-only | Stored `ui_language` values canonicalize to `eng`; clear any pre-existing language-specific Telegram command catalogs before reusing a bot. |
| Codez | App Server v2 with goals for normal topic sessions; `codex exec` for private emergency repair | Pin an exact Codez release or commit and run the live App Server v2 suite plus a disposable emergency-lane smoke when claiming both paths. |
| Telegram | Bot API plus forum-enabled supergroup | Validate bot membership, topic management, message deletion, files, and long polling. |
| Linux | Foreground; systemd user service on systemd `>=250` | Verify linger, generated unit, logs, rollout, and restart behavior. |
| Windows | Foreground wrappers | Verify PATH resolution and secure ACLs; no native service installer is included. |
| macOS | Foreground Node process | Supply and validate an external process manager if unattended operation is required. |
| Remote hosts | POSIX-style target with Bash, OpenSSH, `rsync`, and SSH-backed Codez stdio | Verify shell/tool availability, file staging, remote paths, Codez version, and provider credentials per host. |

## What is not implied

- Node's declared engine range is not evidence that every matching release has
  been tested.
- Package and release version `0.1.0` are independent of the inherited App
  Server initialize client metadata, which currently reports `1.0.0`. Do not
  use that protocol metadata as the installed Teledex version.
- `doctor` does not verify Codez startup or provider access.
- Unit tests exclude files whose names contain `.live.`.
- A successful local App Server v2 test does not validate remote SSH hosts.
- Windows wrappers do not provide Windows Service integration.
- Teledex does not support a configurable HTTP App Server endpoint.

Record the exact Node, Codez, operating-system, and Telegram test environment
in each release note. Do not publish a compatibility badge or claim until that
combination has passed the [release gates](./testing.md).
