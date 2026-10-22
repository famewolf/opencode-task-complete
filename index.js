// task-complete — the `task_complete` tool, re-added for opencode v2.
//
// Why a plugin at all: v2 removed v1's `task_complete` tool, and auto-resume
// (which owns the completion stand-down) carried a private copy of it. The
// tool registry is ONE global map per opencode server, so a tool that every
// plugin can list, extend and observe is the honest shape for a general
// capability. Other plugins use it exactly like any other tool:
//   - `ctx.tool.list()` sees it,
//   - `editor.update("task_complete", ...)` can extend it,
//   - `ctx.tool.hook("execute.after", ...)` observes the call.
//
// The tool is DIRECT (`options.codemode: false`), so the model can call it
// itself. A plugin tool without that option lands in the Code Mode catalog
// and is only reachable through the `execute` runtime - which is why the
// completion protocol had to fall back to "return the words TASK COMPLETE".
// (Same switch the todowrite/todoread plugin uses.)
//
// v1 semantics, kept:
//   - the todo gate: a completion is REFUSED while todos are still open;
//   - the ack self-loop guard: the first call acks, the second warns, the
//     third is an error (v1 logged 27 consecutive acked calls with no new
//     user input, so the ack has to tell the model to stop);
//   - the counter resets on a new inbound user message or on any other tool
//     call, so the escalation only ever measures a genuinely stuck loop.
//
// The todo list belongs to the todowrite plugin, and plugin storage is
// namespaced per plugin id - so the list is read the way the todolist
// plugin's own TUI reads it: the newest completed `todowrite` tool part in
// the session history. A `todowrite` REPLACES the whole list, so the newest
// such call IS the current list.
//
// The result carries `metadata.completed`: true when the completion was
// accepted, false when the todo gate refused it. That is the channel a
// consumer (auto-resume) reads to decide whether to stand down.
//
// Shape mirrors the other plugins in this tree (see compaction-inject): a
// default export with id + setup, no runtime dependencies.
//
// The session todo-list parser below is derived from the npm package
// `opencode-todolist@0.6.1` (MIT, (c) 2026 aiev,
// https://github.com/aiev/opencode-todolist, tag v0.6.1, file
// src/tui-data.ts) - the same routine is called latestTodosFromMessages
// there. NOT the famewolf/opencode-todolist mirror and NOT the
// opencode-todolist-fix fork: neither was the source of this file. The
// third-party notice is in the LICENSE file.
import { readFileSync } from "node:fs";

const DESCRIPTION =
	"Signal that all work is complete and stop automatic continuation prompts. Call this ONLY after finishing everything requested. Call exactly once per completed round of work — repeat calls with no new user message in between are rejected.";

const ACK =
	"Task completion acknowledged. No further continuation will be sent. " +
	"End your turn now with a brief text reply — do not call task_complete or any other tool again " +
	"unless the user sends a new message.";

const REPEAT_WARNING =
	"Task completion acknowledged already on your previous call — completion is recorded. " +
	"End your turn now with a brief text reply. Do not call task_complete again; " +
	"further repeat calls are rejected as errors.";

const REPEAT_ERROR =
	"task_complete already acknowledged twice with no new user message or tool work since — " +
	"completion is recorded. End your turn with text and make no further tool calls.";

/** How many times the todo gate may be overridden before it stops refusing.
 *  A model that keeps calling after being told what is left is a loop, not a
 *  worker. */
const DEFAULT_MAX_OVERRIDES = 3;

/**
 * The completion protocol, injected into the session's system prompt.
 *
 * The tool being in the model's tool list is not enough - the model has to
 * know WHEN to call it. In v1 the tool was a builtin and the trigger was the
 * tool's description plus the operator's AGENTS instructions. A user who
 * installs this plugin may have neither, so the plugin carries the rule
 * itself.
 *
 * Byte-identical on every request: changing the head of the token stream
 * would invalidate the whole prefix cache.
 */
const PROTOCOL_MARKER = "Task completion:";

/**
 * Does this text already carry the completion protocol?
 *
 * The rule can arrive from several places - an operator's AGENTS.md, an agent
 * file, another plugin's system injection - and the tool's own presence in the
 * tool list is not one of them (the description is not part of the system
 * prompt). Both spellings count: the tool call and the bare-line fallback.
 */
function hasCompletionRule(text) {
	if (typeof text !== "string" || text.length === 0) return false;
	return text.includes("TASK COMPLETE") || text.includes("task_complete");
}
const PROTOCOL =
	"Task completion: when all the requested work is done, call the task_complete tool once - that is what stops the automatic continue nudges. " +
	"If todo tools are available, mark every todo completed first: a completion with open items is refused and you are told what is left. " +
	"Call it once, then end the turn with a brief text reply.";

// ---------------------------------------------------------------------------
// Per-session state (plugin storage, so it survives a plugin reload)
// ---------------------------------------------------------------------------

const stateKey = (sid) => `state/${sid}`;

async function readState(ctx, sid) {
	try {
		const raw = await ctx.storage?.get(stateKey(sid));
		if (!raw || typeof raw !== "object") return {};
		return raw;
	} catch {
		return {};
	}
}

async function writeState(ctx, sid, state) {
	try {
		await ctx.storage?.set(stateKey(sid), state);
	} catch {
		// A session without storage still works: the counters just do not
		// survive a reload.
	}
}

// ---------------------------------------------------------------------------
// The todo list (the todowrite plugin owns it; read it from the history)
// ---------------------------------------------------------------------------

function normalizeTodos(input) {
	if (input === null || typeof input !== "object") return undefined;
	const todos = input.todos;
	if (!Array.isArray(todos)) return undefined;
	const out = [];
	for (const entry of todos) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.content !== "string" || typeof entry.status !== "string") continue;
		const todo = { content: entry.content, status: entry.status, priority: "medium" };
		if (typeof entry.priority === "string") todo.priority = entry.priority;
		out.push(todo);
	}
	return out.length > 0 ? out : undefined;
}

/** The most recent completed `todowrite` list in the session history.
 *
 * An entry with an unrecognized status is KEPT, not dropped: only
 * `pending`/`in_progress` count as open, so an unknown status reads as closed -
 * and dropping it would shrink the list, which is the dangerous direction (it
 * makes real open work look finished). */
function latestTodosFromMessages(messages) {
	if (!Array.isArray(messages)) return undefined;
	const writes = [];
	let order = 0;
	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part === null || typeof part !== "object") continue;
			if (part.type !== "tool" || part.name !== "todowrite") continue;
			if (part.state?.status !== "completed") continue;
			let todos;
			try {
				todos = normalizeTodos(part.state.input);
			} catch {
				continue;
			}
			if (!todos) continue;
			const t = part.state?.time ?? part.time ?? message.time ?? {};
			const at = [t?.end, t?.start, t?.created].find((v) => typeof v === "number");
			writes.push({ at: typeof at === "number" ? at : null, todos, order: order++ });
		}
	}
	if (writes.length === 0) return undefined;
	writes.sort((a, b) => {
		if (a.at === null && b.at === null) return a.order - b.order;
		if (a.at === null) return 1;
		if (b.at === null) return -1;
		if (a.at !== b.at) return a.at - b.at;
		return a.order - b.order;
	});
	return writes[writes.length - 1]?.todos;
}

const isOpenTodo = (t) => t.status === "pending" || t.status === "in_progress";
const getOpenTodos = (todos) => (Array.isArray(todos) ? todos.filter(isOpenTodo) : []);

/** Names the open items rather than saying "continue": the model has already
 *  decided it is done, and a bare continuation prompt gets answered with
 *  another done-claim. */
function buildOpenTodosReminder(todos) {
	if (!Array.isArray(todos)) return "continue";
	const open = todos.filter(isOpenTodo);
	if (open.length === 0) return "continue";
	const list = open.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n");
	const plural = open.length > 1 ? "s" : "";
	const taskWord = open.length > 1 ? "tasks" : "task";
	const thisWord = open.length > 1 ? "these" : "this";
	return `You have ${open.length} unfinished task${plural}:\n${list}\n\nPlease continue working on ${thisWord} ${taskWord}.`;
}

// ---------------------------------------------------------------------------
// Reading the session
// ---------------------------------------------------------------------------

/** Candidate local server base URLs: env vars first, then /proc/self/cmdline.
 *  The /proc read is not belt-and-braces: under OpenChamber the server is
 *  spawned as `opencode serve --hostname 127.0.0.1 --port <n>` and exports NO
 *  port env var, so an env-only list comes back EMPTY and the HTTP path is
 *  never attempted at all. */
function serverBaseUrls(cmdline) {
	const out = [];
	const push = (v) => {
		if (typeof v !== "string" || !v) return;
		const url = v.startsWith("http") ? v : `http://127.0.0.1:${v.replace(/^:/, "")}`;
		if (!out.includes(url)) out.push(url.replace(/\/$/, ""));
	};
	const env = process.env;
	push(env.OPENCODE_SERVER_URL);
	push(env.OPENCODE_URL);
	push(env.OPENCODE_SERVER_PORT);
	push(env.OPENCODE_PORT);
	push(env.PORT);
	try {
		const raw = cmdline ?? readFileSync("/proc/self/cmdline", "utf8");
		const argv = raw.split("\0");
		const portFlag = argv.indexOf("--port");
		if (portFlag !== -1 && argv[portFlag + 1]) {
			const hostFlag = argv.indexOf("--hostname");
			const host = hostFlag !== -1 && argv[hostFlag + 1] ? argv[hostFlag + 1] : "127.0.0.1";
			push(`http://${host}:${argv[portFlag + 1]}`);
		}
	} catch {
		// No cmdline: the env list is all there is.
	}
	return out;
}

function serverHeaders() {
	const pw = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_PASSWORD;
	if (!pw) return {};
	return { Authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` };
}

/** The session's messages. `limit` matters: the default page is 50 messages
 *  and 200 is the server's ceiling. Newest first, so a recent `todowrite` is
 *  always inside the page. */
async function readMessages(ctx, sid) {
	try {
		const message = ctx.client?.session?.message;
		if (typeof message?.list === "function") {
			const res = await message.list.call(message, { path: { id: sid } });
			const data = res?.data ?? res;
			if (Array.isArray(data)) return data;
		}
	} catch {
		// No client surface (production): the HTTP path below.
	}
	for (const base of serverBaseUrls()) {
		try {
			const res = await fetch(`${base}/api/session/${encodeURIComponent(sid)}/message?limit=200`, {
				headers: serverHeaders(),
			});
			if (!res.ok) continue;
			const body = await res.json();
			const data = body?.data ?? body;
			if (Array.isArray(data)) return data;
		} catch {
			// Next base; exhaustion returns no messages.
		}
	}
	return [];
}

function lastUserMessageId(messages) {
	if (!Array.isArray(messages)) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.type !== "user" && m?.role !== "user") continue;
		return typeof m.id === "string" ? m.id : null;
	}
	return null;
}

/** Is this session a subagent? A subagent reporting completion is not a parent
 *  finishing, and gating a child's report on the parent's todo list would
 *  block it on work it was never asked to do (v1 skips the todo gate for
 *  subagents for the same reason). */
async function isSubAgentSession(ctx, sid) {
	try {
		const res = await ctx.client?.session?.get?.({ path: { id: sid } });
		if (res?.data?.parentID) return true;
	} catch {
		// No client surface: fall through to the HTTP check.
	}
	for (const base of serverBaseUrls()) {
		try {
			const res = await fetch(`${base}/api/session?limit=500`, { headers: serverHeaders() });
			if (!res.ok) continue;
			const body = await res.json();
			const data = body?.data ?? body;
			if (!Array.isArray(data)) continue;
			return data.some((r) => r?.id === sid && typeof r?.parentID === "string");
		} catch {
			// Next base; exhaustion reads as "not a subagent".
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export default {
	id: "task-complete",
	setup(ctx) {
		// Set when the completion rule was found already in effect: the plugin
		// then stays quiet instead of injecting a duplicate.
		let protocolElsewhere = false;
		const options = ctx.options ?? {};
		const maxOverrides = typeof options.maxOverrides === "number" ? options.maxOverrides : DEFAULT_MAX_OVERRIDES;

		const setupDone = (async () => {
			// Teach the model the protocol. Without this the tool sits in the
			// list unexplained, and the model has no reason to call it.
			try {
				await ctx.session?.hook?.("context", async (event) => {
					try {
						if (!Array.isArray(event?.system)) return;
						if (event.system.some((p) => typeof p?.text === "string" && p.text.startsWith(PROTOCOL_MARKER))) return;
						// Is the rule ALREADY in effect? An operator's AGENTS.md, an
						// agent file or another plugin may already carry the
						// completion protocol. Injecting a second copy costs
						// context on EVERY request (this hook fires before every
						// generation) and says the same thing twice.
						if (event.system.some((p) => hasCompletionRule(p?.text))) {
							protocolElsewhere = true;
							return;
						}
						event.system.push({ type: "text", text: PROTOCOL });
					} catch (e) {
						// best-effort: never break a request
					}
				});
			} catch {
				// No context hook surface: the tool description still says when
				// to call it.
			}
			if (!ctx.tool?.transform) return;
			await ctx.tool.transform((editor) => {
				editor.add({
					name: "task_complete",
					description: DESCRIPTION,
					// DIRECT, not Code Mode: the model must be able to call this
					// itself. A plugin tool without codemode:false is only
					// reachable through the `execute` runtime.
					options: { codemode: false },
					// No arguments. v1's `args: {}` is the same thing: the signal
					// is the call, not a payload.
					input: { type: "object", properties: {}, additionalProperties: false },
					execute: async (_input, toolCtx) => {
						const sid = toolCtx?.sessionID;
						if (!sid) return { content: ACK, metadata: { completed: true } };

						const messages = await readMessages(ctx, sid);
						const state = await readState(ctx, sid);
						const userId = lastUserMessageId(messages);
						// A new inbound user message ends the episode: the repeat
						// counter and the override counter both start over.
						if (userId && state.lastUserMessageID && userId !== state.lastUserMessageID) {
							state.signals = 0;
							state.overrides = 0;
						}
						if (userId) state.lastUserMessageID = userId;

						// The todo gate. A subagent is exempt (see above).
						if (!(await isSubAgentSession(ctx, sid))) {
							const open = getOpenTodos(latestTodosFromMessages(messages));
							if (open.length > 0 && (state.overrides ?? 0) < maxOverrides) {
								state.overrides = (state.overrides ?? 0) + 1;
								// Work remains, so a later completion is legitimate:
								// reset the repeat-signal counter rather than letting
								// this override feed the escalation.
								state.signals = 0;
								await writeState(ctx, sid, state);
								const reminder = buildOpenTodosReminder(open);
								const blockMsg = `Mark any finished todos complete and do not redo completed work.\n${reminder}`;
								return { content: blockMsg, metadata: { completed: false, openTodos: open.length } };
							}
						}

						state.signals = (state.signals ?? 0) + 1;
						await writeState(ctx, sid, state);
						if (state.signals === 2) return { content: REPEAT_WARNING, metadata: { completed: true } };
						if (state.signals > 2) throw new Error(REPEAT_ERROR);
						return { content: ACK, metadata: { completed: true } };
					},
				});
			});

			// Any OTHER tool call is work: it resets the repeat counter, so the
			// escalation only ever measures a genuinely stuck loop.
			try {
				ctx.tool.hook?.("execute.after", async (event) => {
					if (event?.tool === "task_complete") return;
					const sid = event?.sessionID;
					if (!sid) return;
					const state = await readState(ctx, sid);
					if (!state.signals) return;
					state.signals = 0;
					await writeState(ctx, sid, state);
				});
			} catch {
				// No hook surface: the counter resets on the next user message.
			}
			// One boot line, so the server log shows the tool is offered.
			console.info(
				`[task-complete] registered the task_complete tool (direct)${protocolElsewhere ? " — the completion rule is already in effect, no injection" : ""}`,
			);
		})();

		return async () => {
			await setupDone.catch(() => {});
		};
	},
};
