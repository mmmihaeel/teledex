# Changelog

All notable changes to Teledex are recorded here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-25

Initial public release.

### Added

- Telegram forum-topic sessions backed by Codez App Server v2.
- Prompt queuing, manual buffering, steering, interruption, and goal controls.
- Local stdio and SSH-backed remote execution paths.
- Attachment intake, bounded artifact delivery, session retention, and
  graceful service-generation handover.
- English-only commands, messages, documentation, and help assets, with stored
  language state canonicalized to English on read.
- Linux systemd user-service support, Windows foreground wrappers, operational
  diagnostics, tests, and publication checks.

### Security

- Documented the trusted-operator model and `danger-full-access` runtime
  boundary.
- Removed private runtime state and machine-specific configuration from the
  public source tree.

[0.1.0]: https://github.com/mmmihaeel/teledex/releases/tag/v0.1.0
