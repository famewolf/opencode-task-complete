import { describe, test, expect } from "bun:test"
import plugin from "../index.js"

/**
 * task-complete: the model's explicit "I am finished".
 *
 * The tool used to live inside the auto-resume plugin, which made it a private
 * copy of a general capability. It is its own plugin now: the tool registry is
 * one global map per opencode server, so every plugin can see it, extend it and
 * observe its calls.
 *
 * The escalation is the part worth testing. The ack is fed straight back into
 * the turn, and a stuck model answers it by calling the tool again rather than
 * ending with text; v1 logged 27 consecutive acked calls with zero new user
 * input. So the first call acks with an explicit stop instruction, the second
 * warns, and the third throws to force the turn to end.
 *
 * The counter is reset by a new user message and by any other tool call, so the
 * escalation measures a stuck loop and not several legitimate rounds of work.
 *
 * Every group carries a control.
 */

const SID = "ses_task_complete"
/** Unique per test: the plugin caches session parentage per id for a minute. */
let counter = 0
const OLD = Date.now() - 60 * 60_000

const userMessage = (text: string, at: number, id = `msg_u_${at}`) => ({
	type: "user",
	id,
	time: { created: at },
	content: [{ type: "text", text }],
})

/** A completed `todowrite` call: the todo list lives in the session history. */
const todoWrite = (todos: unknown[], at: number, id = `msg_tw_${at}`) => ({
	type: "assistant",
	id,
	time: { created: at },
	content: [
		{
			type: "tool",
			name: "todowrite",
			state: { status: "completed", input: { todos }, time: { end: at } },
		},
	],
})

type Registered = {
	name: string
	description: string
	input: unknown
	options?: { codemode?: boolean; namespace?: string; permission?: string }
	execute: (
		input: any,
		context: { sessionID: string },
	) => Promise<{ content: string; metadata?: Record<string, any> }>
}

type Harness = {
	tool: Registered | null
	hooks: Map<string, (event: any) => unknown>
	sessionHooks: Map<string, (event: any) => unknown>
	store: Map<string, any>
	history: unknown[]
	sid: string
	cleanup: () => void
}

async function setup(
	opts: {
		todos?: unknown[]
		extraMessages?: unknown[]
		parentID?: string
		maxOverrides?: number
		toolRegistry?: boolean
	} = {},
): Promise<Harness> {
	let registered: Registered | null = null
	const hooks = new Map<string, (event: any) => unknown>()
	const store = new Map<string, any>()
	const history: unknown[] = [userMessage("do the work", OLD), ...(opts.extraMessages ?? [])]
	if (opts.todos) history.push(todoWrite(opts.todos, OLD + 1))
	// A unique session id per test: the plugin caches parentage per session id
	// for a minute, and tests sharing one id would poison the cache for the next.
	const sid = `ses_tc_${counter++}`

	const sessionHooks = new Map<string, (event: any) => unknown>()

	const ctx: any = {
		options: opts.maxOverrides ? { maxOverrides: opts.maxOverrides } : {},
		session: {
			hook: (name: string, cb: (event: any) => unknown) => {
				sessionHooks.set(name, cb)
				return { dispose() {} }
			},
		},
		storage: {
			get: async (key: string) => store.get(key),
			set: async (key: string, value: any) => void store.set(key, value),
			remove: async (key: string) => void store.delete(key),
		},
		client: {
			session: {
				message: { list: async () => ({ data: history }) },
				get: async () => ({ data: opts.parentID ? { id: sid, parentID: opts.parentID } : { id: sid } }),
			},
		},
	}

	if (opts.toolRegistry !== false) {
		ctx.tool = {
			transform: async (cb: any) => {
				cb({
					add: (t: Registered) => {
						registered = t
					},
				})
				return { dispose() {} }
			},
			list: async () => (registered ? [registered] : []),
			hook: (name: string, cb: (event: any) => unknown) => {
				hooks.set(name, cb)
				return { dispose() {} }
			},
		}
	}

	const cleanup = await (plugin as any).setup(ctx)
	return {
		get tool() {
			return registered
		},
		hooks,
		sessionHooks,
		store,
		history,
		sid,
		cleanup: cleanup as () => void,
	}
}

const call = (h: Harness, sid?: string) => h.tool!.execute({}, { sessionID: sid ?? h.sid })

describe("task-complete: the tool is offered to the model", () => {
	test("CONTROL: the tool is registered, and takes no arguments", async () => {
		const h = await setup()
		expect(h.tool).not.toBeNull()
		expect(h.tool!.name).toBe("task_complete")
		expect(h.tool!.description).toContain("Signal that all work is complete")
		// v1's `args: {}`: the signal is the call, not a payload.
		expect(h.tool!.input).toMatchObject({ type: "object", properties: {} })
		h.cleanup()
	})

	test("the tool is DIRECT - the model can call it, not only the Code Mode runtime", async () => {
		// packages/core/src/tool.ts: `direct` = the tools with
		// `options.codemode === false`; everything else goes into the Code Mode
		// catalog and is reachable only through `execute`.
		const h = await setup()
		expect(h.tool!.options?.codemode).toBe(false)
		h.cleanup()
	})

	test("CONTROL: a plain call is acknowledged and reports completion", async () => {
		const h = await setup()
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		expect(res.metadata?.completed).toBe(true)
		h.cleanup()
	})

	test("CONTROL: the ack is repeatable by design - no latching on the first call", async () => {
		const h = await setup()
		await call(h)
		h.cleanup()
	})
})

describe("task-complete: the plugin teaches the model the protocol", () => {
	test("the completion rule is injected into the session's system prompt", async () => {
		// The tool in the tool list is not enough: the model has to know WHEN to
		// call it. A user who installs this plugin may have no AGENTS.md
		// completion rule and no other plugin injecting one - so the plugin
		// carries the rule itself.
		const h = await setup()
		const system: any[] = []
		await h.sessionHooks.get("context")?.({ system, sessionID: h.sid })
		const injected = system.filter((p) => typeof p?.text === "string" && p.text.startsWith("Task completion:"))
		expect(injected.length).toBe(1)
		expect(injected[0].text).toContain("task_complete")
		expect(injected[0].text).toContain("mark every todo completed first")
		// The todo plugin may not be installed: the protocol has to cover the
		// findings-file / todo-file fallback the model uses instead.
		expect(injected[0].text).toContain("findings file or a todo file")
		// The bare-line signal is taught UNCONDITIONALLY: opencode withholds
		// tools from sessions created before the last restart, so the line is the
		// signal that always works - and it says who reads it: a watcher.
		expect(injected[0].text).toContain("TASK COMPLETE")
		expect(injected[0].text).toContain("Always end that reply with the bare words TASK COMPLETE")
		expect(injected[0].text).toContain("a watcher reads it from the transcript")
		h.cleanup()
	})

	test("no injection when the rule is ALREADY in effect", async () => {
		// An operator's AGENTS.md, an agent file or another plugin may already
		// carry the completion protocol. A second copy costs context on every
		// request (this hook fires before every generation) and says the same
		// thing twice.
		const h = await setup()
		const system: any[] = [
			{ type: "text", text: "some agent instructions" },
			{ type: "text", text: "end the turn with TASK COMPLETE on its own last line" },
		]
		await h.sessionHooks.get("context")?.({ system, sessionID: h.sid })
		expect(system.filter((p) => typeof p?.text === "string" && p.text.startsWith("Task completion:")).length).toBe(0)
		h.cleanup()
	})

	test("no injection when the tool rule is already in effect", async () => {
		const h = await setup()
		const system: any[] = [{ type: "text", text: "CALL the `task_complete` tool when the work is done" }]
		await h.sessionHooks.get("context")?.({ system, sessionID: h.sid })
		expect(system.filter((p) => typeof p?.text === "string" && p.text.startsWith("Task completion:")).length).toBe(0)
		h.cleanup()
	})

	test("the injection is idempotent - the same bytes, not a second copy", async () => {
		// The text is byte-identical on every request so the prefix cache stays
		// valid; a second copy would grow the prompt for nothing.
		const h = await setup()
		const system: any[] = []
		await h.sessionHooks.get("context")?.({ system, sessionID: h.sid })
		await h.sessionHooks.get("context")?.({ system, sessionID: h.sid })
		expect(system.filter((p) => typeof p?.text === "string" && p.text.startsWith("Task completion:")).length).toBe(1)
		h.cleanup()
	})
})

describe("task-complete: the ack self-loop", () => {
	test("a second consecutive call warns instead of acking again", async () => {
		const h = await setup()
		await call(h)
		const second = await call(h)
		expect(second.content).toContain("acknowledged already on your previous call")
		expect(second.content).toContain("further repeat calls are rejected as errors")
		h.cleanup()
	})

	test("a third consecutive call is rejected as an error, forcing the turn to end", async () => {
		const h = await setup()
		await call(h)
		await call(h)
		await expect(call(h)).rejects.toThrow(/acknowledged twice/)
		h.cleanup()
	})

	test("a fourth call is still an error - the loop cannot re-enter through the ack", async () => {
		const h = await setup()
		await call(h)
		await call(h)
		await expect(call(h)).rejects.toThrow(/acknowledged twice/)
		await expect(call(h)).rejects.toThrow(/acknowledged twice/)
		h.cleanup()
	})

	test("CONTROL: any other tool call is work and resets the counter", async () => {
		const h = await setup()
		await call(h)
		// Another tool ran: the model is doing work, not looping.
		await h.hooks.get("execute.after")?.({ tool: "read", sessionID: h.sid, status: "completed" })
		const second = await call(h)
		expect(second.content).toContain("Task completion acknowledged")
		expect(second.content).not.toContain("acknowledged already")
		h.cleanup()
	})

	test("CONTROL: a new user message also resets the counter", async () => {
		const h = await setup()
		await call(h)
		h.history.push(userMessage("actually, also this", Date.now() - 10 * 60_000))
		const second = await call(h)
		expect(second.content).toContain("Task completion acknowledged")
		expect(second.content).not.toContain("acknowledged already")
		h.cleanup()
	})
})

describe("task-complete: the todo list", () => {
	const OPEN = [
		{ content: "Write the migration guide", status: "pending", priority: "high" },
		{ content: "Delete the temp fixtures", status: "in_progress", priority: "low" },
	]

	test("CONTROL: a call with todos still open is blocked and names them", async () => {
		const h = await setup({ todos: OPEN })
		const res = await call(h)
		expect(res.content).toContain("Write the migration guide")
		expect(res.content).toContain("Delete the temp fixtures")
		expect(res.content).toContain("Mark any finished todos complete")
		// Not an ack: the model has not been told its work is recorded.
		expect(res.content).not.toContain("No further continuation will be sent")
		expect(res.metadata?.completed).toBe(false)
		expect(res.metadata?.openTodos).toBe(2)
		h.cleanup()
	})

	test("a blocked call does not count toward the ack escalation", async () => {
		const h = await setup({ todos: OPEN, maxOverrides: 1 })
		await call(h)
		const second = await call(h)
		expect(second.content).toContain("Task completion acknowledged")
		expect(second.content).not.toContain("acknowledged already")
		h.cleanup()
	})

	test("the block is bounded - a model insisting is eventually believed", async () => {
		const h = await setup({ todos: OPEN })
		let res = await call(h)
		for (let i = 0; i < 3; i++) res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		expect(res.content).not.toContain("Mark any finished todos")
		h.cleanup()
	})

	test("CONTROL: a call with every todo closed is acked", async () => {
		const h = await setup({
			todos: [{ content: "Ship it", status: "completed", priority: "high" }],
		})
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		expect(res.metadata?.completed).toBe(true)
		h.cleanup()
	})

	test("CONTROL: a call with no todo tool at all is acked, not blocked", async () => {
		const h = await setup()
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		h.cleanup()
	})
})

describe("task-complete: a subagent", () => {
	test("a subagent reporting completion is not gated on the parent's todo list", async () => {
		const h = await setup({
			parentID: "ses_parent",
			todos: [{ content: "Parent work", status: "pending", priority: "high" }],
		})
		const res = await call(h)
		expect(res.content).toContain("Task completion acknowledged")
		expect(res.metadata?.completed).toBe(true)
		h.cleanup()
	})
})

describe("task-complete: degrades rather than failing", () => {
	test("a host with no tool registry still loads the plugin", async () => {
		const h = await setup({ toolRegistry: false })
		expect(h.tool).toBeNull()
		h.cleanup()
	})
})
