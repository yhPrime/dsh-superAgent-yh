import { l as key, n as health, r as sourceContext, t as KV, y as threadKey } from "./kv-Chhax9WP.js";
import { z } from "zod";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
// src/sources/qq-channel.ts
let current;
/** Installs the live connection for outbound replies, replacing (and so retiring) any previous one. */
function setQqSender(sender) {
	current = sender;
}
/** Retires `sender` only if it is still installed, so a stopped connection cannot clear its replacement. */
function clearQqSender(sender) {
	if (current === sender) current = void 0;
}
/** Reads a QQ channel address back into the fields OneBot and roost-host calls need. */
function qqAddressFields(address) {
	const chatId = address.chatId ?? "";
	if (!chatId) throw new Error("The QQ address names no chat");
	const chatKind = address.chatKind === "group" ? "group" : "private";
	return {
		chatKind,
		chatId,
		providerKind: address.providerKind || chatKind
	};
}
/** Sends one reply on the installed connection; throws while no connection is live so the Outbox retries later. */
async function sendQq(address, text) {
	const sender = current;
	if (!sender) throw new Error("The QQ Source is not connected; the reply will be retried");
	await sender.send(address, text);
	return "sent";
}
// src/sources/qq-onebot.ts
/**
* OneBot v11 client: HTTP for calls and a Universal WebSocket for events, reconnecting on its own.
* Ported from the plugin's earlier OneBot client (MIT, aurabot authors); the retry, fallback, and reconnect
* semantics are unchanged. Only Node's global `fetch` and `WebSocket` are used.
*/
const RECONNECT_MIN = 2e3;
const RECONNECT_MAX = 3e4;
const RETRY_DELAYS = [
	1e3,
	3e3,
	5e3
];
/** An OneBot action failed; `transport` marks a gateway that could not be reached, which is worth retrying. */
var OneBotError = class extends Error {
	action;
	data;
	transport;
	uncertain;
	constructor(action, data, options = {}) {
		const detail = data;
		const why = detail?.message ?? detail?.wording ?? detail?.retcode ?? "unknown error";
		super(`${action} failed: ${String(why)}`);
		this.name = "OneBotError";
		this.action = action;
		this.data = data;
		this.transport = options.transport ?? false;
		this.uncertain = options.uncertain ?? false;
	}
};
/** fetch failures are not always "not connected": a dropped connection may already have reached the gateway. */
const notConnected = (error) => {
	const code = error?.cause?.code;
	return [
		"ECONNREFUSED",
		"ENOTFOUND",
		"EAI_AGAIN",
		"EHOSTUNREACH",
		"ENETUNREACH"
	].includes(String(code));
};
const messageOf = (error) => error instanceof Error ? error.message : String(error);
function createOneBotClient({ endpoint, onEvent, onState, retryDelays = RETRY_DELAYS, fetchImpl = globalThis.fetch }) {
	let ws = null;
	let stopped = true;
	let timer;
	let backoff = RECONNECT_MIN;
	let state = "stopped";
	let echoSeq = 0;
	let stopGeneration = 0;
	let explicitlyStopped = false;
	const pending = /* @__PURE__ */ new Map();
	const retryWaits = /* @__PURE__ */ new Set();
	const setState = (next, detail) => {
		if (state === next) return;
		state = next;
		try {
			onState?.(next, detail);
		} catch {}
	};
	const describeNetError = (error, ep) => {
		const where = ep.httpUrl || ep.wsUrl || "(no address configured)";
		const why = error?.cause?.code ?? error?.cause?.message ?? messageOf(error);
		return `cannot reach the OneBot gateway (${where}): ${String(why)}`;
	};
	/** One HTTP or WebSocket attempt; network failures are marked transport, business errors pass through. */
	async function callOnce(action, params, timeoutMs, generation) {
		const ep = endpoint();
		if (ep.httpUrl) {
			const controller = new AbortController();
			const abort = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const headers = { "content-type": "application/json" };
				if (ep.httpToken) headers.authorization = `Bearer ${ep.httpToken}`;
				const response = await fetchImpl(`${ep.httpUrl.replace(/\/+$/, "")}/${action}`, {
					method: "POST",
					headers,
					body: JSON.stringify(params),
					signal: controller.signal
				});
				let body;
				try {
					body = await response.json();
				} catch (error) {
					if (error.name === "AbortError") throw error;
					throw new OneBotError(action, { message: `the gateway answered HTTP ${response.status} with a body that is not JSON` }, { uncertain: true });
				}
				if (body?.status === "ok" || body?.retcode === 0) return body.data;
				throw new OneBotError(action, body);
			} catch (error) {
				if (error instanceof OneBotError) throw error;
				if (error.name === "AbortError") throw new OneBotError(action, { message: "timed out" }, { uncertain: true });
				if (!notConnected(error)) throw new OneBotError(action, { message: describeNetError(error, ep) }, { uncertain: true });
				if (generation !== stopGeneration) throw new OneBotError(action, { message: "the OneBot client stopped" });
				if (ws && ws.readyState === WebSocket.OPEN) return callWs(action, params, timeoutMs);
				throw new OneBotError(action, { message: describeNetError(error, ep) }, { transport: true });
			} finally {
				clearTimeout(abort);
			}
		}
		return callWs(action, params, timeoutMs);
	}
	async function call(action, params = {}, { timeoutMs = 3e4, retries = retryDelays.length } = {}) {
		if (explicitlyStopped) throw new OneBotError(action, { message: "the OneBot client stopped" });
		const ep = endpoint();
		if (!ep.httpUrl && !ep.wsUrl) throw new OneBotError(action, { message: "no OneBot gateway address is configured" }, { transport: true });
		let lastError;
		const generation = stopGeneration;
		const stoppedError = () => new OneBotError(action, { message: "the OneBot client stopped" });
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (generation !== stopGeneration) throw stoppedError();
			try {
				return await callOnce(action, params, timeoutMs, generation);
			} catch (error) {
				lastError = error;
				if (generation !== stopGeneration) throw stoppedError();
				if (!(error instanceof OneBotError) || !error.transport) throw error;
				if (attempt === retries) break;
				const wait = retryDelays[attempt] ?? retryDelays[retryDelays.length - 1] ?? 0;
				if (generation !== stopGeneration) throw stoppedError();
				await new Promise((resolve) => {
					const done = () => {
						clearTimeout(waitTimer);
						retryWaits.delete(done);
						resolve();
					};
					const waitTimer = setTimeout(done, wait);
					retryWaits.add(done);
				});
			}
		}
		throw lastError;
	}
	function callWs(action, params, timeoutMs) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new OneBotError(action, { message: "not connected to the OneBot gateway" }, { transport: true }));
		const echo = `syh-${Date.now()}-${++echoSeq}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(echo);
				reject(new OneBotError(action, { message: "timed out" }, { uncertain: true }));
			}, timeoutMs);
			pending.set(echo, {
				resolve,
				reject,
				timer: timeout,
				action
			});
			ws.send(JSON.stringify({
				action,
				params,
				echo
			}));
		});
	}
	function connect() {
		if (stopped) return;
		const ep = endpoint();
		if (!ep.wsUrl) {
			setState("unconfigured", "no WebSocket URL");
			schedule();
			return;
		}
		if (typeof WebSocket !== "function") {
			setState("unsupported", "this runtime has no global WebSocket, so QQ events cannot be received");
			return;
		}
		setState("connecting");
		let url = ep.wsUrl;
		if (ep.wsToken) url += (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(ep.wsToken);
		let socket;
		try {
			socket = new WebSocket(url);
		} catch {
			schedule();
			return;
		}
		ws = socket;
		socket.onopen = () => {
			backoff = RECONNECT_MIN;
			setState("connected");
		};
		socket.onmessage = (event) => {
			let data;
			try {
				const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
				data = JSON.parse(text);
			} catch {
				return;
			}
			const echo = data.echo;
			if (typeof echo === "string" && pending.has(echo)) {
				const call_ = pending.get(echo);
				pending.delete(echo);
				clearTimeout(call_.timer);
				if (data.status === "ok" || data.retcode === 0) call_.resolve(data.data);
				else call_.reject(new OneBotError(call_.action, data));
				return;
			}
			if (typeof data.post_type === "string") try {
				onEvent(data);
			} catch {}
		};
		socket.onclose = () => {
			if (ws === socket) ws = null;
			for (const [echo, call_] of pending) {
				clearTimeout(call_.timer);
				call_.reject(new OneBotError(call_.action, { message: "connection closed" }, { uncertain: true }));
				pending.delete(echo);
			}
			if (!stopped) {
				setState("disconnected");
				schedule();
			}
		};
		socket.onerror = () => {};
	}
	function schedule() {
		clearTimeout(timer);
		if (stopped) return;
		timer = setTimeout(connect, backoff);
		backoff = Math.min(RECONNECT_MAX, backoff * 2);
	}
	return {
		call,
		start() {
			if (!stopped) return;
			explicitlyStopped = false;
			stopped = false;
			backoff = RECONNECT_MIN;
			connect();
		},
		stop() {
			stopped = true;
			explicitlyStopped = true;
			stopGeneration++;
			for (const done of [...retryWaits]) done();
			clearTimeout(timer);
			setState("stopped");
			try {
				ws?.close();
			} catch {}
			ws = null;
		},
		get state() {
			return state;
		}
	};
}
// src/sources/qq-roost.ts
/**
* roost-host/1 client: SSE over `GET /events` and `POST /rpc`, reconnecting on its own.
* Implements only the subset this Source needs: message events, `system.capabilities`, and `msg.send`.
* Protocol: https://github.com/roost-qq/qq-bot-roost/blob/master/docs/宿主协议v1.md
*/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A roost-host call or stream failed. */
var RoostError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.name = "RoostError";
		this.status = status;
	}
};
/** Parses SSE frames: blocks end at a blank line; `id` is the sequence and `data` the whole JSON frame. */
function feedSse(buffer, chunk, lastSeq) {
	let text = buffer + chunk;
	const frames = [];
	let seq = lastSeq;
	for (;;) {
		const at = text.indexOf("\n\n");
		if (at < 0) break;
		const block = text.slice(0, at);
		text = text.slice(at + 2);
		let id;
		let data;
		for (const line of block.split("\n")) if (line.startsWith("id:")) id = Number(line.slice(3).trim());
		else if (line.startsWith("data:")) data = (data === void 0 ? "" : data + "\n") + line.slice(5).trimStart();
		if (Number.isFinite(id) && id > seq) seq = id;
		if (data !== void 0 && data !== "") try {
			frames.push(JSON.parse(data));
		} catch {}
	}
	return {
		rest: text,
		frames,
		lastSeq: seq
	};
}
function createRoostHostClient({ baseUrl, token, onEvent, onState, since = 0, onSeq, fetchImpl = globalThis.fetch, reconnectMinMs = 2e3, reconnectMaxMs = 3e4 }) {
	let stopped = true;
	let controller = null;
	let lastSeq = since;
	let state = "stopped";
	let rpcSeq = 0;
	const setState = (next, detail) => {
		if (state === next) return;
		state = next;
		try {
			onState?.(next, detail);
		} catch {}
	};
	async function call(method, params = {}, { timeoutMs = 3e4 } = {}) {
		const abort = new AbortController();
		const timeout = setTimeout(() => abort.abort(), timeoutMs);
		try {
			const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/rpc`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				body: JSON.stringify({
					id: `syh-${++rpcSeq}`,
					method,
					params
				}),
				signal: abort.signal
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok) throw new RoostError(`roost-host RPC ${method} answered HTTP ${response.status}`, response.status);
			if (!payload?.ok) {
				const error = payload?.error ?? {};
				throw new RoostError(`roost-host RPC ${method} failed: ${error.code ?? ""} ${error.message ?? ""}`.trim(), response.status);
			}
			return payload.data;
		} catch (error) {
			if (error.name === "AbortError") throw new RoostError(`roost-host RPC ${method} timed out`);
			if (error instanceof RoostError) throw error;
			throw new RoostError(`roost-host RPC ${method} cannot connect: ${String(error?.cause?.code ?? error.message)}`);
		} finally {
			clearTimeout(timeout);
		}
	}
	async function run() {
		let backoff = reconnectMinMs;
		while (!stopped) {
			controller = new AbortController();
			try {
				setState("connecting");
				const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/events?since=${lastSeq}`, {
					headers: {
						accept: "text/event-stream",
						authorization: `Bearer ${token}`
					},
					signal: controller.signal
				});
				if (!response.ok) throw new RoostError(`roost-host /events answered HTTP ${response.status}`, response.status);
				setState("connected");
				backoff = reconnectMinMs;
				const body = response.body;
				if (!body) throw new RoostError("roost-host /events returned no body");
				const reader = body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					const parsed = feedSse(buffer, decoder.decode(value, { stream: true }), lastSeq);
					buffer = parsed.rest;
					for (const frame of parsed.frames) try {
						onEvent(frame);
					} catch {}
					if (parsed.lastSeq !== lastSeq) {
						lastSeq = parsed.lastSeq;
						onSeq?.(lastSeq);
					}
				}
				throw new RoostError("roost-host /events stream ended");
			} catch (error) {
				if (stopped) return;
				setState("disconnected", error instanceof Error ? error.message : String(error));
				await sleep(backoff);
				backoff = Math.min(reconnectMaxMs, backoff * 2);
			}
		}
	}
	return {
		call,
		start() {
			if (!stopped) return;
			stopped = false;
			run();
		},
		stop() {
			stopped = true;
			controller?.abort();
			controller = null;
			setState("stopped");
		},
		get state() {
			return state;
		},
		get lastSeq() {
			return lastSeq;
		}
	};
}
// src/sources/qq-trigger.ts
/** Normalizes OneBot v11 events and roost-host frames into Triggers; filters nothing the Policy decides. */
const SOURCE = "qq";
const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const text = (value) => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const cqCode = /\[CQ:[^\]]+\]/g;
const NOT_TEXT = "[non-text message]";
/** The native conversation id used as a Thread id; group and private conversations never share one. */
const qqThread = (chatKind, chatId) => `${chatKind}:${chatId}`;
/** The address a reply goes back to; `providerKind` keeps roost-host's group/c2c/guild/dm spelling. */
const qqAddress = (chatKind, chatId, providerKind, messageId) => ({
	chatKind,
	chatId,
	providerKind,
	messageId
});
const timestamp = (value, scale) => {
	const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
	if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric * scale).toISOString();
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
	}
	return (/* @__PURE__ */ new Date()).toISOString();
};
/** Reads OneBot's message array (preferred) or strips CQ codes from `raw_message`. */
function oneBotText(raw, message) {
	const segments = Array.isArray(message) ? message.map(record) : [];
	if (segments.length) return segments.flatMap((segment) => {
		const data = record(segment.data);
		switch (segment.type) {
			case "text": return [text(data.text)];
			case "at": return [`@${text(data.qq)}`];
			case "image": return ["[image]"];
			case "face": return ["[face]"];
			case "reply": return [];
			default: return [`[${text(segment.type) || "segment"}]`];
		}
	}).join("").trim() || NOT_TEXT;
	return text(raw).replace(cqCode, "").trim() || NOT_TEXT;
}
const mentionedInOneBot = (message, selfId) => {
	if (!selfId || !Array.isArray(message)) return false;
	return message.some((segment) => {
		const item = record(segment);
		return item.type === "at" && text(record(item.data).qq) === selfId;
	});
};
/** A OneBot v11 `message` event becomes a Trigger; everything else (heartbeats, notices) is ignored. */
function personalTrigger(event, options = {}) {
	if (event.post_type !== "message") return void 0;
	const chatKind = event.message_type === "group" ? "group" : event.message_type === "private" ? "private" : void 0;
	if (!chatKind) return void 0;
	const selfId = text(options.selfId);
	const sender = record(event.sender);
	const senderId = text(event.user_id) || text(sender.user_id);
	if (!senderId || selfId && senderId === selfId) return void 0;
	const chatId = chatKind === "group" ? text(event.group_id) : senderId;
	if (!chatId) return void 0;
	const messageId = text(event.message_id) || `${senderId}-${text(event.time)}`;
	const mentioned = chatKind === "group" && mentionedInOneBot(event.message, selfId);
	const direct = chatKind === "private";
	const thread = qqThread(chatKind, chatId);
	const senderName = text(sender.card) || text(sender.nickname) || void 0;
	return {
		id: key("qq", chatKind, chatId, messageId),
		source: "qq",
		threads: [{
			source: "qq",
			id: thread
		}],
		actor: {
			source: "qq",
			id: senderId
		},
		human: true,
		...direct ? { addressed: "direct" } : mentioned ? { addressed: "mention" } : {},
		at: timestamp(event.time, 1e3),
		text: oneBotText(event.raw_message, event.message),
		channel: {
			source: "qq",
			thread,
			address: qqAddress(chatKind, chatId, chatKind, messageId)
		},
		meta: {
			chatKind,
			chatId,
			messageId,
			mentioned,
			direct,
			...senderName ? { senderName } : {}
		}
	};
}
const KINDS = /* @__PURE__ */ new Set([
	"group",
	"c2c",
	"guild",
	"dm"
]);
/** A roost-host message frame becomes a Trigger; other frames (capabilities, gap) are the loop's concern. */
function officialTrigger(frame) {
	if (frame.type !== "message") return void 0;
	const data = record(frame.data);
	const chat = record(data.chat);
	const providerKind = text(chat.kind);
	if (!KINDS.has(providerKind)) return void 0;
	const chatKind = providerKind === "group" || providerKind === "guild" ? "group" : "private";
	const chatId = text(chat.chatId) || text(chat.groupId);
	const sender = record(data.sender);
	const actor = text(sender.openid) || text(data.identityId) || text(sender.uin);
	if (!chatId || !actor) return void 0;
	const body = text(data.content).trim();
	if (!body) return void 0;
	const messageId = text(data.eventId) || text(data.msgId) || (frame.seq === void 0 ? "" : `seq-${text(frame.seq)}`);
	if (!messageId) return void 0;
	const mentioned = data.addressed === true || data.mentioned === true;
	const direct = chatKind === "private";
	const thread = `chat:${providerKind}:${chatId}`;
	const human = sender.bot !== true && sender.isBot !== true && data.bot !== true;
	const senderName = text(sender.name) || text(sender.nickname) || void 0;
	return {
		id: key("qq", "official", providerKind, chatId, messageId),
		source: "qq",
		threads: [{
			source: "qq",
			id: thread
		}],
		actor: {
			source: "qq",
			id: actor
		},
		human,
		...direct ? { addressed: "direct" } : mentioned ? { addressed: "mention" } : {},
		at: timestamp(data.at ?? frame.at, 1),
		text: body,
		channel: {
			source: "qq",
			thread,
			address: qqAddress(chatKind, chatId, providerKind, messageId)
		},
		meta: {
			chatKind,
			chatId,
			messageId,
			providerKind,
			mentioned,
			direct,
			...senderName ? { senderName } : {}
		}
	};
}
// src/sources/qq-loops.ts
/** QQ background loop: one live connection (OneBot WebSocket or roost-host SSE) feeding Triggers, plus its reply path. */
const CONNECTION_CHECK_MS = 5e3;
const enabled = (ctx) => ctx.config("qq");
const waitAbort = (signal) => signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
/** What keeps the configured mode from connecting; undefined when it can. */
const connectionProblem = (config) => {
	if (config.mode === "onebot") return config.httpUrl || config.wsUrl ? void 0 : "The OneBot mode needs an HTTP or WebSocket URL";
	return config.baseUrl && config.token ? void 0 : "The roost-host mode needs a base URL and a token";
};
/** Runs the QQ connection only while the Source is enabled; disabling it stops the connection within five seconds. */
async function runQq(ctx, signal) {
	await ctx.ready;
	if (!available(ctx)) return;
	let retry;
	while (!signal.aborted) {
		const config = enabled(ctx);
		if (!config) {
			ctx.report("qq", health("paused", "sourceOff"));
			await setTimeout$1(CONNECTION_CHECK_MS, void 0, { signal }).catch(() => {});
			continue;
		}
		if (connectionProblem(config)) {
			ctx.report("qq", health("paused", "qqUnset"));
			await setTimeout$1(CONNECTION_CHECK_MS, void 0, { signal }).catch(() => {});
			continue;
		}
		const running = new AbortController();
		const check = setInterval(() => {
			if (!enabled(ctx)) running.abort();
		}, CONNECTION_CHECK_MS);
		const stop = () => running.abort();
		signal.addEventListener("abort", stop, { once: true });
		const began = Date.now();
		try {
			await connect(ctx, config, running.signal);
		} catch (error) {
			if (!running.signal.aborted) ctx.report("qq", {
				state: "error",
				detail: String(error)
			});
		} finally {
			clearInterval(check);
			signal.removeEventListener("abort", stop);
		}
		if (running.signal.aborted) continue;
		retry = retryDelay(retry, Date.now() - began);
		await setTimeout$1(retry, void 0, { signal }).catch(() => {});
	}
}
function available(ctx) {
	if (ctx.configured()) return true;
	ctx.report("qq", ctx.problem ? {
		state: "paused",
		detail: ctx.problem.detail
	} : health("paused", "setupPending"));
	return false;
}
/** Wait before reconnecting: 1s after a connection that stayed up for a minute, otherwise exponential backoff up to 60s. */
const retryDelay = (previous, ranMs) => previous === void 0 || ranMs >= 6e4 ? 1e3 : Math.min(previous * 2, 6e4);
async function connect(ctx, config, signal) {
	return config.mode === "onebot" ? connectOneBot(ctx, config, signal) : connectRoost(ctx, config, signal);
}
function queueReceive(ctx, config) {
	let chain = Promise.resolve();
	return {
		get chain() {
			return chain;
		},
		push(trigger) {
			chain = chain.then(async () => {
				if (!enabled(ctx)) return;
				await receive(ctx, config, trigger);
			}).catch((error) => {
				ctx.report("qq", {
					state: "error",
					detail: String(error)
				});
			});
		}
	};
}
async function receive(ctx, config, trigger) {
	const chatId = String(trigger.meta.chatId ?? "");
	const name = config.chats.find((chat) => chat.chatId === chatId)?.name;
	const label = trigger.meta.direct === true ? `QQ ${String(trigger.meta.senderName ?? chatId)}` : `QQ ${name || chatId}`;
	await ctx.receive(trigger);
	for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { label });
}
async function connectOneBot(ctx, config, signal) {
	const feed = queueReceive(ctx, config);
	const client = createOneBotClient({
		endpoint: () => ({
			httpUrl: config.httpUrl || void 0,
			wsUrl: config.wsUrl || void 0,
			httpToken: config.httpToken || void 0,
			wsToken: config.wsToken || void 0
		}),
		onEvent: (event) => {
			const trigger = personalTrigger(event, { selfId: config.selfId });
			if (trigger) feed.push(trigger);
		},
		onState: (state, detail) => reportOneBot(ctx, state, detail)
	});
	const sender = { async send(address, body) {
		const { chatKind, chatId } = qqAddressFields(address);
		const id = Number(chatId);
		if (!Number.isSafeInteger(id)) throw new Error(`The QQ chat id ${chatId} is not an OneBot numeric id`);
		if (chatKind === "group") await client.call("send_group_msg", {
			group_id: id,
			message: body
		});
		else await client.call("send_private_msg", {
			user_id: id,
			message: body
		});
	} };
	setQqSender(sender);
	try {
		client.start();
		await waitAbort(signal);
	} finally {
		client.stop();
		clearQqSender(sender);
	}
	await feed.chain;
}
async function connectRoost(ctx, config, signal) {
	const feed = queueReceive(ctx, config);
	const client = createRoostHostClient({
		baseUrl: config.baseUrl,
		token: config.token,
		since: ctx.state.get(KV.qq.since) ?? 0,
		onSeq: (seq) => ctx.state.set(KV.qq.since, seq),
		onEvent: (frame) => {
			if (frame.type === "gap") {
				ctx.report("qq", {
					state: "paused",
					detail: "The roost-host event buffer dropped frames; QQ messages may be missing"
				});
				return;
			}
			const trigger = officialTrigger(frame);
			if (trigger) feed.push(trigger);
		},
		onState: (state, detail) => reportRoost(ctx, state, detail)
	});
	const sender = { async send(address, body) {
		const { chatId, providerKind } = qqAddressFields(address);
		await client.call("msg.send", {
			kind: providerKind,
			chatId,
			content: body
		});
	} };
	setQqSender(sender);
	try {
		client.start();
		await waitAbort(signal);
	} finally {
		client.stop();
		clearQqSender(sender);
	}
	await feed.chain;
}
function reportOneBot(ctx, state, detail) {
	switch (state) {
		case "connected":
			ctx.report("qq", {
				state: "ready",
				detail: detail || "Connected to the OneBot gateway"
			});
			break;
		case "connecting":
			ctx.report("qq", {
				state: "starting",
				detail: detail || "Connecting to the OneBot gateway"
			});
			break;
		case "disconnected":
			ctx.report("qq", {
				state: "paused",
				detail: detail || "The OneBot gateway connection closed; reconnecting"
			});
			break;
		case "unconfigured":
			ctx.report("qq", health("paused", "qqUnset"));
			break;
		case "unsupported": ctx.report("qq", {
			state: "error",
			detail: detail || "This runtime has no global WebSocket"
		});
	}
}
function reportRoost(ctx, state, detail) {
	switch (state) {
		case "connected":
			ctx.report("qq", {
				state: "ready",
				detail: detail || "Connected to roost-host"
			});
			break;
		case "connecting":
			ctx.report("qq", {
				state: "starting",
				detail: detail || "Connecting to roost-host"
			});
			break;
		case "disconnected": ctx.report("qq", {
			state: "paused",
			detail: detail || "The roost-host stream closed; reconnecting"
		});
	}
}
// src/sources/qq.ts
const chatIdPattern = "[0-9A-Za-z_:-]{1,128}";
const senderIdPattern = /^[0-9A-Za-z_:-]{1,128}$/;
const QqConfigSchema = z.object({
	mode: z.enum(["onebot", "official"]).default("onebot"),
	httpUrl: z.string().trim().max(500).default("http://127.0.0.1:3000"),
	wsUrl: z.string().trim().max(500).default("ws://127.0.0.1:3000"),
	httpToken: z.string().max(500).default(""),
	wsToken: z.string().max(500).default(""),
	selfId: z.string().trim().max(64).default(""),
	baseUrl: z.string().trim().max(500).default(""),
	token: z.string().max(500).default(""),
	chats: z.array(z.object({
		chatId: z.string().trim().regex(new RegExp(`^${chatIdPattern}$`)),
		name: z.string().trim().max(60).optional(),
		listen: z.enum(["mentions", "all"])
	}).strict()).refine((chats) => new Set(chats.map((chat) => chat.chatId)).size === chats.length, "Duplicate chat IDs").default([]),
	directMessages: z.boolean().default(true),
	otherChats: z.enum(["none", "mentions"]).default("none")
}).strict();
const qqKind = {
	kind: "qq",
	title: {
		zh: "QQ",
		en: "QQ"
	},
	description: {
		zh: "接收 QQ 群和私聊里的消息，按策略接单并把结果回到原会话。",
		en: "Receives messages in QQ groups and direct chats, opens Tickets under the Policy, and replies in the same conversation."
	},
	schema: QqConfigSchema,
	fields: [
		{
			key: "mode",
			type: "select",
			label: {
				zh: "接入方式",
				en: "Mode"
			},
			options: [{
				value: "onebot",
				label: {
					zh: "OneBot v11（个人号）",
					en: "OneBot v11 (personal account)"
				}
			}, {
				value: "official",
				label: {
					zh: "roost-host（官方机器人）",
					en: "roost-host (official bot)"
				}
			}],
			hint: {
				zh: "OneBot v11 连本地网关（如 SnowLuma）；roost-host 连官方宿主协议。切换后重启 dsh-superagent-yh。",
				en: "OneBot v11 talks to a local gateway (such as SnowLuma); roost-host talks to the official host protocol. Restart dsh-superagent-yh after switching."
			}
		},
		{
			key: "httpUrl",
			type: "text",
			label: {
				zh: "OneBot HTTP 地址",
				en: "OneBot HTTP URL"
			},
			hint: {
				zh: "OneBot v11 的 HTTP 接口根地址，例如 http://127.0.0.1:3000；发表格走这里。",
				en: "The root URL of the OneBot v11 HTTP API, such as http://127.0.0.1:3000; replies go here."
			}
		},
		{
			key: "wsUrl",
			type: "text",
			label: {
				zh: "OneBot WebSocket 地址",
				en: "OneBot WebSocket URL"
			},
			hint: {
				zh: "OneBot v11 的 Universal WebSocket 地址，例如 ws://127.0.0.1:3000；消息从这里收。",
				en: "The OneBot v11 Universal WebSocket URL, such as ws://127.0.0.1:3000; messages arrive here."
			}
		},
		{
			key: "httpToken",
			type: "text",
			label: {
				zh: "HTTP access token",
				en: "HTTP access token"
			},
			advanced: true
		},
		{
			key: "wsToken",
			type: "text",
			label: {
				zh: "WebSocket access token",
				en: "WebSocket access token"
			},
			advanced: true
		},
		{
			key: "selfId",
			type: "text",
			label: {
				zh: "机器人 QQ 号",
				en: "Bot QQ id"
			},
			hint: {
				zh: "用来认出 @ 机器人的消息，也避免把机器人自己的消息当成请求。",
				en: "Identifies messages that mention the bot, and keeps the bot's own messages from becoming requests."
			}
		},
		{
			key: "baseUrl",
			type: "text",
			label: {
				zh: "roost-host 地址",
				en: "roost-host URL"
			},
			hint: {
				zh: "官方机器人宿主的根地址；SSE 走 /events，调用走 /rpc。",
				en: "The official bot host root; events come from /events and calls go to /rpc."
			}
		},
		{
			key: "token",
			type: "text",
			label: {
				zh: "roost-host token",
				en: "roost-host token"
			},
			advanced: true
		},
		{
			key: "chats",
			type: "rows",
			label: {
				zh: "接收的群",
				en: "Groups"
			},
			hint: {
				zh: "“仅 @”只接收 @ 机器人的消息和已有工单的线程；“全部消息”也接收其余消息，评估可以按规则从中推断工作。",
				en: "\"@ only\" receives messages that mention the bot and Threads that have Tickets; \"All\" also receives the rest, from which Eval may infer work under the rules."
			},
			columns: [
				{
					key: "chatId",
					type: "text",
					label: {
						zh: "群号",
						en: "Group"
					},
					pattern: chatIdPattern
				},
				{
					key: "name",
					type: "text",
					label: {
						zh: "名字",
						en: "Name"
					},
					optional: true
				},
				{
					key: "listen",
					type: "select",
					label: {
						zh: "接收",
						en: "Receive"
					},
					options: [{
						value: "mentions",
						label: {
							zh: "仅 @",
							en: "@ only"
						}
					}, {
						value: "all",
						label: {
							zh: "全部消息",
							en: "All"
						}
					}]
				}
			]
		},
		{
			key: "otherChats",
			type: "select",
			label: {
				zh: "其他群",
				en: "Other groups"
			},
			options: [{
				value: "none",
				label: {
					zh: "不接收",
					en: "Not received"
				}
			}, {
				value: "mentions",
				label: {
					zh: "仅 @",
					en: "@ only"
				}
			}],
			hint: {
				zh: "机器人已加入、但没列在上面的群。“仅 @”接收那里 @ 机器人的消息；谁的消息能发起工作看策略里的准入。",
				en: "Groups the bot has joined that are not listed above. \"@ only\" receives messages there that mention the bot; whose messages may originate work is the Policy's admission."
			}
		},
		{
			key: "directMessages",
			type: "switch",
			label: {
				zh: "接收私聊",
				en: "Direct messages"
			}
		}
	],
	health: ["qq"],
	scope({ meta }, config) {
		if (meta.direct === true || meta.chatKind === "private") return config.directMessages ? {
			listened: true,
			observed: false,
			row: "direct"
		} : {
			listened: false,
			reason: "direct_messages_not_allowed"
		};
		const chat = config.chats.find((item) => item.chatId === meta.chatId);
		if (chat) return {
			listened: true,
			observed: chat.listen === "all",
			row: chat.chatId
		};
		return config.otherChats === "mentions" ? {
			listened: true,
			observed: false,
			row: "other"
		} : {
			listened: false,
			reason: "chat_not_allowed"
		};
	},
	channel: {
		allowed: (address, config) => qqKind.scope({ meta: {
			chatId: address.chatId ?? "",
			direct: address.chatKind === "private"
		} }, config).listened,
		send: (_host, message) => sendQq(message.channel.address, message.text),
		link: (_address, _links) => ({
			url: "",
			label: {
				zh: "QQ",
				en: "QQ"
			}
		})
	},
	policy: {
		unnamed: {
			person: {
				zh: "QQ 用户",
				en: "QQ user"
			},
			bot: {
				zh: "QQ 机器人",
				en: "QQ bot"
			}
		},
		schema: z.object({
			allowed: z.array(z.object({
				id: z.string().regex(senderIdPattern),
				name: z.string().trim().max(100).optional()
			}).strict()).refine((users) => new Set(users.map((user) => user.id)).size === users.length, "Duplicate sender ids").default([]),
			bots: z.array(z.object({
				id: z.string().regex(senderIdPattern),
				name: z.string().trim().max(100).optional()
			}).strict()).refine((bots) => new Set(bots.map((bot) => bot.id)).size === bots.length, "Duplicate bot ids").optional()
		}).strict(),
		fields: [{
			key: "allowed",
			type: "rows",
			label: {
				zh: "能发起工作的 QQ 用户",
				en: "QQ users who may originate work"
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "QQ 号或 openid",
					en: "QQ id or openid"
				},
				pattern: chatIdPattern
			}, {
				key: "name",
				type: "text",
				label: {
					zh: "名字",
					en: "Name"
				},
				optional: true
			}]
		}, {
			key: "bots",
			type: "rows",
			label: {
				zh: "消息可以成为候选的机器人",
				en: "Bots whose messages may become candidates"
			},
			hint: {
				zh: "名单里的机器人发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。",
				en: "Messages of a bot on this list become inferred candidates for an assessment; they never make an explicit request or stop a ticket."
			},
			columns: [{
				key: "id",
				type: "text",
				label: {
					zh: "QQ 号或 openid",
					en: "QQ id or openid"
				},
				pattern: chatIdPattern
			}, {
				key: "name",
				type: "text",
				label: {
					zh: "名字",
					en: "Name"
				},
				optional: true
			}]
		}],
		explicit: {
			zh: "名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。",
			en: "Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting."
		},
		rows(stored) {
			const config = QqConfigSchema.parse(stored);
			const mentions = {
				zh: "仅 @",
				en: "@ only"
			};
			return [
				...config.chats.map((chat) => ({
					id: chat.chatId,
					label: chat.name || chat.chatId,
					note: chat.listen === "all" ? {
						zh: "全部消息",
						en: "All"
					} : mentions,
					cells: {
						listedUnaddressed: chat.listen === "all",
						unlistedAddressed: true,
						unlistedUnaddressed: chat.listen === "all"
					}
				})),
				{
					id: "other",
					label: {
						zh: "其他群",
						en: "Other groups"
					},
					note: config.otherChats === "mentions" ? mentions : {
						zh: "不接收",
						en: "Not received"
					},
					cells: {
						listedUnaddressed: false,
						unlistedAddressed: config.otherChats === "mentions",
						unlistedUnaddressed: false
					}
				},
				{
					id: "direct",
					label: {
						zh: "私聊",
						en: "Direct messages"
					},
					note: config.directMessages ? {
						zh: "接收",
						en: "Received"
					} : {
						zh: "不接收",
						en: "Not received"
					},
					cells: {
						listedUnaddressed: false,
						unlistedAddressed: config.directMessages,
						unlistedUnaddressed: false
					}
				}
			];
		}
	},
	environment: {
		variables: [{
			key: "DSH_SUPERAGENT_QQ_CHAT",
			description: {
				zh: "接下工单的 QQ 会话；工单不是从 QQ 来的时为空",
				en: "The QQ conversation that started the ticket; empty when the ticket did not start on QQ"
			}
		}],
		values: ({ trigger }) => ({ DSH_SUPERAGENT_QQ_CHAT: trigger?.source === "qq" ? String(trigger.meta.chatId ?? "") : "" })
	}
};
const name = "dsh-superagent-yh-qq";
const inject = ["orchestrator"];
function apply(ctx) {
	ctx.effect(() => ctx.orchestrator.sources.register(qqKind), "qq: source kind");
	ctx.effect(() => {
		const controller = new AbortController();
		const running = runQq(sourceContext(ctx.orchestrator, qqKind), controller.signal);
		return async () => {
			controller.abort();
			await running;
		};
	});
}
export { QqConfigSchema, SOURCE, apply, inject, name, qqKind, qqThread };
