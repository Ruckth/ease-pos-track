import assert from "node:assert/strict";
import test from "node:test";
import {
  lineAiModels, lineAiLimits, parseLineAiSuggestion, scanLineRequest, syntheticLineAiInput, type LineAiProvider,
} from "../convex/adapters/line_ai_provider";

const answer = { intent: "create", title: "Printer error", description: "E-42 on the counter printer", ticketNumber: null, reply: null, evidence: ["error E-42"] };
const text = JSON.stringify(answer);
const replies: Record<LineAiProvider, object> = {
  gemini: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking", thought: true }, { text }] } }] },
  openrouter: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] },
  claude: { stop_reason: "end_turn", content: [{ type: "text", text }] },
  openai: { status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text }] }] },
};

function withFlag(value: string | undefined, run: () => Promise<void>) {
  return async () => {
    const original = process.env.LINE_AI_ENABLED;
    if (value === undefined) delete process.env.LINE_AI_ENABLED; else process.env.LINE_AI_ENABLED = value;
    try { await run(); }
    finally { if (original === undefined) delete process.env.LINE_AI_ENABLED; else process.env.LINE_AI_ENABLED = original; }
  };
}

function capture(response: () => Response) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const transport = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    return response();
  }) as typeof fetch;
  return { calls, transport };
}

const connection = (provider: LineAiProvider) => ({ provider, model: lineAiModels[provider], apiKey: `${provider}-secret-key` });

test("each provider gets one fixed endpoint, audited model, text+image+PDF and no tools", withFlag("true", async () => {
  const expected: Record<LineAiProvider, [string, string, string]> = {
    gemini: ["https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent", "x-goog-api-key", "gemini-secret-key"],
    openrouter: ["https://openrouter.ai/api/v1/chat/completions", "Authorization", "Bearer openrouter-secret-key"],
    claude: ["https://api.anthropic.com/v1/messages", "x-api-key", "claude-secret-key"],
    openai: ["https://api.openai.com/v1/responses", "Authorization", "Bearer openai-secret-key"],
  };
  for (const provider of Object.keys(expected) as LineAiProvider[]) {
    const { calls, transport } = capture(() => Response.json(replies[provider]));
    assert.deepEqual(await scanLineRequest(connection(provider), syntheticLineAiInput(), transport), answer);
    const [{ url, init, body }] = calls;
    const [endpoint, header, value] = expected[provider];
    assert.equal(url, endpoint);
    assert.equal((init.headers as Record<string, string>)[header], value);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /"tools"|"tool_choice"|"functionDeclarations"/);
    assert.doesNotMatch(serialized, /secret-key/);
    assert.match(serialized, /JVBERi0/); // base64 "%PDF-"
    assert.match(serialized, /iVBORw0KGgo/); // base64 PNG signature
    assert.match(serialized, /error E-42/);
    if (provider !== "gemini") assert.equal(body.model, lineAiModels[provider]);
  }
  const openrouter = capture(() => Response.json(replies.openrouter));
  await scanLineRequest(connection("openrouter"), syntheticLineAiInput(), openrouter.transport);
  assert.deepEqual(openrouter.calls[0].body.provider, {
    order: ["google-ai-studio"], only: ["google-ai-studio"], allow_fallbacks: false, require_parameters: true, data_collection: "deny",
  });
  assert.deepEqual(openrouter.calls[0].body.plugins, [{ id: "file-parser", pdf: { engine: "native" } }]);
  assert.equal(openrouter.calls[0].body.models, undefined);
  const openai = capture(() => Response.json(replies.openai));
  await scanLineRequest(connection("openai"), { text: "hi" }, openai.transport);
  assert.equal(openai.calls[0].body.store, false);
}));

test("the flag must be exactly true and the model must match the provider before any call", async () => {
  for (const flag of [undefined, "TRUE", "1"]) {
    await withFlag(flag, async () => {
      const { calls, transport } = capture(() => Response.json(replies.gemini));
      await assert.rejects(scanLineRequest(connection("gemini"), { text: "hi" }, transport), /^Error: LINE_AI_DISABLED$/);
      assert.equal(calls.length, 0);
    })();
  }
  await withFlag("true", async () => {
    const { calls, transport } = capture(() => Response.json(replies.gemini));
    await assert.rejects(scanLineRequest({ ...connection("gemini"), model: "gemini-other" }, { text: "hi" }, transport), /LINE_AI_PROVIDER_INVALID/);
    await assert.rejects(scanLineRequest({ ...connection("openrouter"), model: "google/gemini-4-neon:free" }, { text: "hi" }, transport), /LINE_AI_PROVIDER_INVALID/);
    await assert.rejects(scanLineRequest({ provider: "other" as LineAiProvider, model: "x", apiKey: "k" }, { text: "hi" }, transport), /LINE_AI_PROVIDER_INVALID/);
    const big = new Uint8Array(lineAiLimits.fileBytes + 1); big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const input of [
      { text: "" }, { text: "x".repeat(lineAiLimits.textChars + 1) },
      { text: "hi", files: [{ mimeType: "image/png" as const, bytes: new TextEncoder().encode("%PDF-1.4") }] },
      { text: "hi", files: [{ mimeType: "image/gif" as "image/png", bytes: new Uint8Array([0x47, 0x49, 0x46]) }] },
      { text: "hi", files: [{ mimeType: "image/png" as const, bytes: big }] },
      { text: "hi", files: Array(lineAiLimits.files + 1).fill(syntheticLineAiInput().files![0]) },
    ]) await assert.rejects(scanLineRequest(connection("gemini"), input, transport), /LINE_AI_INPUT_INVALID/);
    assert.equal(calls.length, 0);
  })();
});

test("provider failures map to stable codes without provider or customer details", withFlag("true", async () => {
  const leak = JSON.stringify({ error: { message: "key gemini-secret-key invalid for customer text" } });
  const cases: [() => Response | Promise<Response>, string][] = [
    [() => new Response(leak, { status: 401 }), "LINE_AI_KEY_REJECTED"],
    [() => new Response(leak, { status: 403 }), "LINE_AI_KEY_REJECTED"],
    [() => new Response(leak, { status: 402 }), "LINE_AI_QUOTA_EXCEEDED"],
    [() => new Response(leak, { status: 429 }), "LINE_AI_RATE_LIMITED"],
    [() => new Response(leak, { status: 400 }), "LINE_AI_REQUEST_REJECTED"],
    [() => new Response(leak, { status: 503 }), "LINE_AI_PROVIDER_UNAVAILABLE"],
    [() => Promise.reject(new TypeError("network down: customer text")), "LINE_AI_PROVIDER_UNAVAILABLE"],
    [() => Promise.reject(new DOMException("timed out", "TimeoutError")), "LINE_AI_PROVIDER_UNAVAILABLE"],
    [() => new Response("not json"), "LINE_AI_RESPONSE_INVALID"],
    [() => new Response("x".repeat(lineAiLimits.responseBytes + 1)), "LINE_AI_RESPONSE_INVALID"],
  ];
  for (const [response, code] of cases) {
    const error = await scanLineRequest(connection("gemini"), { text: "customer text" }, (async () => response()) as typeof fetch)
      .then(() => null, (caught: Error) => caught);
    assert.equal(error?.message, code);
  }
}));

test("tool calls, refusals, truncation and multiple answers are rejected", withFlag("true", async () => {
  const bad: [LineAiProvider, object][] = [
    ["gemini", { candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "close", args: {} } }] } }] }],
    ["gemini", { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text }] } }] }],
    ["gemini", { candidates: [{ finishReason: "STOP", content: { parts: [{ text }, { text }] } }] }],
    ["gemini", { promptFeedback: { blockReason: "SAFETY" } }],
    ["openrouter", { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "x" }] } }] }],
    ["openrouter", { choices: [{ finish_reason: "stop", message: { content: text, tool_calls: [{ id: "x" }] } }] }],
    ["claude", { stop_reason: "tool_use", content: [{ type: "tool_use", name: "x", input: {} }] }],
    ["claude", { stop_reason: "end_turn", content: [{ type: "text", text }, { type: "tool_use", name: "x", input: {} }] }],
    ["claude", { stop_reason: "refusal", content: [{ type: "text", text }] }],
    ["openai", { status: "completed", output: [{ type: "function_call", name: "x", arguments: "{}" }] }],
    ["openai", { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }],
    ["openai", { status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text }] }] }],
  ];
  for (const [provider, reply] of bad) {
    await assert.rejects(scanLineRequest(connection(provider), { text: "hi" }, (async () => Response.json(reply)) as typeof fetch),
      /^Error: LINE_AI_RESPONSE_INVALID$/, `${provider} ${JSON.stringify(reply)}`);
  }
}));

test("suggestions are validated with exact keys, intent requirements and bounds", () => {
  const valid = [
    answer,
    { intent: "close", title: null, description: null, ticketNumber: "POS-0007", reply: null, evidence: ["fixed now, thanks"] },
    { intent: "clarify", title: null, description: null, ticketNumber: null, reply: "Which branch?", evidence: ["it broke"] },
    { intent: "skip", title: null, description: null, ticketNumber: null, reply: null, evidence: ["thanks!"] },
  ];
  for (const suggestion of valid) assert.deepEqual(parseLineAiSuggestion(JSON.stringify(suggestion)), suggestion);
  const invalid = [
    { ...answer, extra: true }, { ...answer, actions: [] }, { ...answer, intent: "delete" }, { ...answer, title: null },
    { ...answer, evidence: [] }, { ...answer, evidence: Array(6).fill("x") }, { ...answer, evidence: ["x".repeat(201)] },
    { ...answer, evidence: "x" }, { ...answer, title: "x".repeat(121) }, { ...answer, title: "   " }, { ...answer, reply: 3 },
    { ...valid[1], ticketNumber: null }, { ...valid[1], ticketNumber: "../POS-1" }, { ...valid[2], reply: null },
    { intent: "skip" },
  ];
  for (const suggestion of invalid) assert.throws(() => parseLineAiSuggestion(JSON.stringify(suggestion)), /LINE_AI_RESPONSE_INVALID/);
  assert.throws(() => parseLineAiSuggestion("[]"), /LINE_AI_RESPONSE_INVALID/);
  assert.throws(() => parseLineAiSuggestion("```json\n{}\n```"), /LINE_AI_RESPONSE_INVALID/);
});

test("the synthetic PDF is a well-formed single-page document with a correct xref", () => {
  const pdf = new TextDecoder().decode(syntheticLineAiInput().files![1].bytes);
  const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
  assert.ok(pdf.startsWith("xref\n", xref));
  const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(match => Number(match[1]));
  assert.equal(offsets.length, 5);
  offsets.forEach((offset, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, offset)));
  const stream = /<< \/Length (\d+) >>\nstream\n([^\n]*)\nendstream/.exec(pdf)!;
  assert.equal(Number(stream[1]), stream[2].length);
});
