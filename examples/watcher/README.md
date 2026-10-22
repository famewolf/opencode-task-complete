# Example: a watcher plugin

A minimal plugin that observes the `task_complete` tool and records when a
session has finished.

It exists to show the integration surface: the tool lives in its own plugin,
and any other plugin watches it through the tool registry's `execute.after`
hook — no import, no shared storage, no polling.

```ts
ctx.tool.hook("execute.after", async (event) => {
  if (event.tool !== "task_complete") return
  if (event.status !== "completed") return
  const completed = event.result?.metadata?.completed !== false
  // completed === true  -> the model says the work is done
  // completed === false -> the todo gate refused it (openTodos names how many)
})
```

`index.js` is the whole example. Install it next to the task-complete plugin:

```jsonc
"plugins": [
  "opencode-task-complete@0.1.0",
  "file:///path/to/this/example"
]
```

For a real watcher, see the auto-resume plugin: it latches a stand-down on an
accepted completion, and injects the open todos itself when the gate refused
it (a collapsed tool result would hide them).
