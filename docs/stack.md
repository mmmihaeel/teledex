# Codez Stack

Teledex is independently deployable but is designed around the Codez runtime
and optional Codex plugins.

| Project | Role | Required by Teledex |
| --- | --- | --- |
| [Codez](https://github.com/mmmihaeel/codez) | Codex-compatible agent runtime and App Server v2 implementation. | Yes |
| [Teledex](https://github.com/mmmihaeel/teledex) | Telegram routing, durable topic sessions, state, and delivery. | This repository |
| [RTK Codex Plugin](https://github.com/mmmihaeel/rtk-codex-plugin) | Optional Codex hook integration for bounded shell and output workflows. | No |
| Pitlane Codex Plugin | Optional Codex hook integration for code-navigation workflows. | No |
| cdxusage | Standalone companion project; not loaded by Teledex. | No |

Teledex launches Codez with App Server v2 over stdio. A remote host remains the
same protocol path transported through SSH; it is not an HTTP service.

Optional plugins are executable code. Enabling synchronization copies a
reviewed local source or existing Codex cache into a managed plugin cache and
updates hook trust configuration. The setting named `github` does not perform
a network clone or download.

Pin and test compatible versions together. Repository proximity is not a
compatibility guarantee; see [Compatibility](./compatibility.md).
