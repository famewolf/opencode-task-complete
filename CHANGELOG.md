# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-22

First release.

### Added

- The `task_complete` tool for opencode v2, registered as a **direct** tool
  (`options: { codemode: false }`) so the model can call it itself — a plugin
  tool without that option is only reachable through the `execute` runtime.
- The v1 semantics, kept:
  - the **todo gate** — a completion is refused while todos are still open,
    the result names them, and the block is bounded (`maxOverrides`, default 3)
    so a model that keeps insisting is eventually believed;
  - the **ack self-loop guard** — first call acks with a stop instruction,
    second warns, third throws to force the turn to end (v1 logged 27
    consecutive acked calls with no new user input);
  - the repeat counter resets on a new inbound user message and on any other
    tool call, so the escalation measures a stuck loop and not several
    legitimate rounds of work.
- The completion protocol is injected into the session's system prompt, so the
  model knows *when* to call the tool — and only when the rule is not already
  in effect, because the context hook fires before every model request.
- The protocol teaches the **bare-line** signal (`TASK COMPLETE`, alone on
  the last line) unconditionally: opencode withholds tools from sessions
  created before the last restart, so the line is the completion signal that
  always works.
- The result carries `metadata.completed` — `true` when the completion was
  accepted, `false` when the todo gate refused it — which is the channel a
  consumer plugin reads through the registry's `execute.after` hook.
- Subagent sessions are skipped by the protocol injection: a worker's
  completion is the controller's business, and the controller reads the
  worker's own `DONE: <summary>` contract.

### Notes

- The session todo-list parser is derived from the npm package
  `opencode-todolist@0.6.1` (MIT, © 2026 aiev) — see the third-party notice
  in `LICENSE`.
- The plugin needs no todo plugin: the gate reads the `todowrite` history, so
  with none installed there is no list, the gate never refuses, and the tool is
  a pure completion signal.

[0.1.0]: https://github.com/famewolf/opencode-task-complete/releases/tag/v0.1.0
