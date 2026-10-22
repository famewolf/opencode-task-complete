// example: watch a session's completion from another plugin.
//
// The task-complete plugin registers the `task_complete` tool; this example
// only OBSERVES it through the tool registry. That is the point of the tool
// living in its own plugin: the registry is one global map per opencode
// server, so any plugin can list the tool, extend it, and watch its calls.
//
// Install both:
//
//   "plugins": [
//     "opencode-task-complete@0.1.0",
//     "file:///path/to/this/example"
//   ]
//
// What it does: when the model calls task_complete and the completion was
// ACCEPTED, it stands the session down in the observer's own terms - here it
// just records it, because a real watcher (auto-resume) stops nudging a
// session that has finished.

export default {
	id: "task-complete-watcher-example",
	setup(ctx) {
		// The tool's own description tells the model when to call it; the hook
		// tells a watcher when it happened.
		ctx.tool?.hook?.("execute.after", async (event) => {
			if (event?.tool !== "task_complete") return
			if (event?.status !== "completed") return

			const completed = event?.result?.metadata?.completed !== false
			if (!completed) {
				// The todo gate refused it: the model still has open todos.
				// event.result.metadata.openTodos says how many, and
				// event.result.content names them.
				console.log(
					`[watcher] ${event.sessionID} is NOT done: ${event.result?.metadata?.openTodos ?? "?"} todo(s) open`,
				)
				return
			}

			// The model says the work is done. A watcher stops nudging here.
			console.log(`[watcher] ${event.sessionID} is done - standing down`)
		})

		return () => {}
	},
}
