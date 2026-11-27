import assert from "node:assert/strict";
import test from "node:test";
import {
  extractLineAiEvent,
  LINE_AI_MAX_TEXT_LENGTH,
  opaqueLineSenderDigest,
  trimLineAiEvents,
} from "../convex/domain/line_ai_intake";

const now = 1_795_656_000_000;

test("extractLineAiEvent parses group bot mentions, strips self-mention spans, and rejects chatter", () => {
  const mentioned = extractLineAiEvent({
    type: "message",
    mode: "active",
    webhookEventId: "evt-group-1",
    timestamp: now,
    source: { type: "group", groupId: "Cgroup", userId: "Usender" },
    message: {
      id: "msg-1",
      type: "text",
      text: "@POSBot  Receipt printer jammed on counter 2\r\nPlease check",
      mention: {
        mentionees: [
          { index: 0, length: 7, type: "user", userId: "Ubot", isSelf: true },
        ],
      },
    },
  });
  assert.deepEqual(mentioned, {
    eventType: "text",
    webhookEventId: "evt-group-1",
    timestamp: now,
    kind: "group",
    lineChatId: "Cgroup",
    messageId: "msg-1",
    senderUserId: "Usender",
    text: "Receipt printer jammed on counter 2\nPlease check",
  });

  // Minimal fixture without index/length still accepted via isSelf: true.
  const minimal = extractLineAiEvent({
    type: "message",
    webhookEventId: "evt-group-min",
    timestamp: now,
    source: { type: "room", roomId: "Rroom", userId: "Usender" },
    message: {
      id: "msg-min",
      type: "text",
      text: "  @POSBot เครื่องพิมพ์ใบเสร็จไม่ทำงาน  ",
      mention: { mentionees: [{ isSelf: true }] },
    },
  });
  assert.equal(minimal?.eventType, "text");
  assert.equal(minimal && "text" in minimal ? minimal.text : "", "@POSBot เครื่องพิมพ์ใบเสร็จไม่ทำงาน");

  // Non-mentioned chatter, other-user mention, @all, mention-only, standby mode, and missing userId are ignored.
  const ignored = [
    {
      type: "message", webhookEventId: "e1", timestamp: now,
      source: { type: "group", groupId: "Cgroup", userId: "Usender" },
      message: { id: "m1", type: "text", text: "ordinary group chatter" },
    },
    {
      type: "message", webhookEventId: "e2", timestamp: now,
      source: { type: "group", groupId: "Cgroup", userId: "Usender" },
      message: {
        id: "m2", type: "text", text: "@Alice hi",
        mention: { mentionees: [{ index: 0, length: 6, type: "user", userId: "Ualice", isSelf: false }] },
      },
    },
    {
      type: "message", webhookEventId: "e3", timestamp: now,
      source: { type: "group", groupId: "Cgroup", userId: "Usender" },
      message: {
        id: "m3", type: "text", text: "@All hello",
        mention: { mentionees: [{ index: 0, length: 4, type: "all", isSelf: true }] },
      },
    },
    {
      type: "message", webhookEventId: "e4", timestamp: now,
      source: { type: "group", groupId: "Cgroup", userId: "Usender" },
      message: {
        id: "m4", type: "text", text: "@POSBot   ",
        mention: { mentionees: [{ index: 0, length: 7, type: "user", isSelf: true }] },
      },
    },
    {
      type: "message", mode: "standby", webhookEventId: "e5", timestamp: now,
      source: { type: "group", groupId: "Cgroup", userId: "Usender" },
      message: {
        id: "m5", type: "text", text: "@POSBot help",
        mention: { mentionees: [{ index: 0, length: 7, type: "user", isSelf: true }] },
      },
    },
    {
      type: "message", webhookEventId: "e6", timestamp: now,
      source: { type: "group", groupId: "Cgroup" },
      message: {
        id: "m6", type: "text", text: "@POSBot missing userId",
        mention: { mentionees: [{ index: 0, length: 7, type: "user", isSelf: true }] },
      },
    },
  ];
  for (const raw of ignored) assert.equal(extractLineAiEvent(raw), undefined);
});

test("extractLineAiEvent parses 1:1 text, minimal file refs, bounded text length, and unsend", () => {
  const longText = "x".repeat(LINE_AI_MAX_TEXT_LENGTH + 500);
  const direct = extractLineAiEvent({
    type: "message",
    webhookEventId: "evt-dm-1",
    timestamp: now,
    source: { type: "user", userId: "Udm" },
    message: { id: "msg-dm-1", type: "text", text: longText },
  });
  assert.equal(direct?.eventType, "text");
  assert.equal(direct && "text" in direct ? direct.text.length : 0, LINE_AI_MAX_TEXT_LENGTH);
  assert.equal(direct?.senderUserId, "Udm");

  const file = extractLineAiEvent({
    type: "message",
    webhookEventId: "evt-file-1",
    timestamp: now,
    source: { type: "group", groupId: "Cgroup", userId: "Usender" },
    message: {
      id: "msg-img-1",
      type: "image",
      contentProvider: { type: "line" },
      fileName: "must-not-persist.png",
      fileSize: 12345,
    },
  });
  assert.deepEqual(file, {
    eventType: "file",
    webhookEventId: "evt-file-1",
    timestamp: now,
    kind: "group",
    lineChatId: "Cgroup",
    messageId: "msg-img-1",
    senderUserId: "Usender",
    fileType: "image",
  });

  // Unsupported media types are dropped.
  for (const unsupported of ["sticker", "location", "audio"]) {
    assert.equal(extractLineAiEvent({
      type: "message", webhookEventId: `evt-${unsupported}`, timestamp: now,
      source: { type: "user", userId: "Udm" },
      message: { id: `m-${unsupported}`, type: unsupported },
    }), undefined);
  }

  const unsend = extractLineAiEvent({
    type: "unsend",
    webhookEventId: "evt-unsend-1",
    timestamp: now + 50,
    source: { type: "group", groupId: "Cgroup", userId: "Usender" },
    unsend: { messageId: "msg-1" },
  });
  assert.deepEqual(unsend, {
    eventType: "unsend",
    webhookEventId: "evt-unsend-1",
    timestamp: now + 50,
    kind: "group",
    lineChatId: "Cgroup",
    messageId: "msg-1",
    senderUserId: "Usender",
  });
});

test("opaqueLineSenderDigest is deterministic, scoped per bot and chat, and rejects invalid keys", async () => {
  const previous = process.env.LINE_SECRETS_KEY;
  try {
    process.env.LINE_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
    const first = await opaqueLineSenderDigest("botA", "Cgroup1", "Ualice");
    const repeat = await opaqueLineSenderDigest("botA", "Cgroup1", "Ualice");
    const otherSender = await opaqueLineSenderDigest("botA", "Cgroup1", "Ubob");
    const otherChat = await opaqueLineSenderDigest("botA", "Cgroup2", "Ualice");
    const otherBot = await opaqueLineSenderDigest("botB", "Cgroup1", "Ualice");

    assert.equal(first, repeat);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.ok(!first.includes("Ualice"));
    assert.notEqual(first, otherSender);
    assert.notEqual(first, otherChat);
    assert.notEqual(first, otherBot);

    process.env.LINE_SECRETS_KEY = "not-32-bytes";
    await assert.rejects(() => opaqueLineSenderDigest("botA", "Cgroup1", "Ualice"), /LINE_SECRETS_KEY_INVALID/);
  } finally {
    if (previous === undefined) delete process.env.LINE_SECRETS_KEY;
    else process.env.LINE_SECRETS_KEY = previous;
  }
});

test("trimLineAiEvents drops new events and seals unsend senders when intake is paused", async t => {
  const previousFlag = process.env.LINE_AI_ENABLED;
  const previousKey = process.env.LINE_SECRETS_KEY;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.LINE_AI_ENABLED;
    else process.env.LINE_AI_ENABLED = previousFlag;
    if (previousKey === undefined) delete process.env.LINE_SECRETS_KEY;
    else process.env.LINE_SECRETS_KEY = previousKey;
  });
  process.env.LINE_AI_ENABLED = "false";
  process.env.LINE_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  const source = { type: "user", userId: "Usender" };
  const events = await trimLineAiEvents("botA", [
    { type: "message", timestamp: now, source, webhookEventId: "e1", message: { type: "text", id: "m1", text: "private" } },
    { type: "message", timestamp: now, source, webhookEventId: "e2", message: { type: "image", id: "m2" } },
    { type: "unsend", timestamp: now, source, webhookEventId: "e3", unsend: { messageId: "m0" } },
  ]);
  assert.deepEqual(events, [{
    eventType: "unsend", timestamp: now, kind: "user", lineChatId: "Usender", webhookEventId: "e3", messageId: "m0",
    senderDigest: await opaqueLineSenderDigest("botA", "Usender", "Usender"),
  }]);
});
