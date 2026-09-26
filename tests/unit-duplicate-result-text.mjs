/**
 * A local slash command (e.g. `/model`) produces no stream_events at all: CC
 * emits one `assistant` message carrying the text, then a `result` whose
 * `result` field repeats the same text. The success-path guard in the `result`
 * handler was `!turnSawStreamEvent`, which reads "no stream_events yet" rather
 * than "no text already delivered this turn" — so both processAssistantMessage
 * and the result handler pushed a text block, and pi's TUI showed the answer
 * twice. Verified against ~/.pi/agent/sessions/--private-tmp--/*01a0dac0*.jsonl,
 * where the assistant entry answering /model carries two identical text parts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), new Map(), fakeModel, () => false, c);
}

const streamEvent = (event) => ({ type: "stream_event", event });

describe("a result that repeats the assistant message's text", () => {
	it("gives one text block, not two", async () => {
		const c = makeCtx();
		await consume(c, [
			{ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "Current model: opus" }] } },
			{ type: "result", subtype: "success", is_error: false, result: "Current model: opus" },
		]);

		const texts = c.turnOutput.content.filter((b) => b.type === "text");
		assert.deepStrictEqual(texts.map((b) => b.text), ["Current model: opus"]);
	});

	it("a result alone still pushes its text", async () => {
		const c = makeCtx();
		await consume(c, [{ type: "result", subtype: "success", is_error: false, result: "done" }]);

		const texts = c.turnOutput.content.filter((b) => b.type === "text");
		assert.deepStrictEqual(texts.map((b) => b.text), ["done"]);
	});

	it("stream events then a result add no extra block", async () => {
		const c = makeCtx();
		await consume(c, [
			streamEvent({ type: "message_start", message: { id: "msg_1" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
			{ type: "result", subtype: "success", is_error: false, result: "hi" },
		]);

		const texts = c.turnOutput.content.filter((b) => b.type === "text");
		assert.deepStrictEqual(texts.map((b) => b.text), ["hi"]);
	});
});
