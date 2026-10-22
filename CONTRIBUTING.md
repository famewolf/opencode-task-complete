# Contributing

Small plugin, small rules.

## The shape of the change

- **The tool is the contract.** `task_complete` is v1's tool, re-added for v2.
  Its v1 semantics (the todo gate, the ack self-loop guard, the counter
  resets) are deliberate — a change to them changes what the model is told.
- **The tool must stay DIRECT.** `options: { codemode: false }` is what puts
  it in the model's own tool list. Without it the tool lands in the Code Mode
  catalog and the model can never call it.
- **The protocol is taught unconditionally, but injected only when needed.**
  The bare-line signal (`TASK COMPLETE` alone on the last line) must be
  taught even when the tool is available, because opencode withholds tools
  from sessions created before the last restart. The injection must not
  duplicate a rule that is already in effect.
- **Workers are not counted.** The protocol injection skips subagent sessions:
  a worker's completion is the controller's business.

## Before you open a pull request

```sh
bun test test/        # the suite must be green
npm pack --dry-run    # read the file list before anything is published
```

## Reporting a problem

Open an issue with the opencode version, the plugin version, and — if a
number looked wrong — the session id and the nudge text you saw. The nudge
text carries both counters (`attempt N/M`, `retry #K`), and the plugin's log
carries the detection line for the same session.
