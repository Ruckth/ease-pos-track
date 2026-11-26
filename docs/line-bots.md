# LINE bots per Project

LINE is available on legacy and disposable deployments. Configure the Convex backend with a dedicated, stable 32-byte base64 `LINE_SECRETS_KEY` before connecting a bot. Keep the key in deployment secrets. The named-account browser pilot keeps LINE settings, webhook intake and workers disabled.

From the staff workspace menu, open **LINE** for the selected Project. Add the channel secret and long-lived channel access token from LINE Developers Console. Choose a bot language. The app tests the bot’s fixed HTTPS webhook URL before changing the LINE endpoint. If setup fails, use **Add LINE bot** again with corrected credentials for the same bot, in this or another Project. Until a setup is verified, it holds nothing and anyone who re-proves the token can finish it; once connected, no other Project can take the bot. The token identifies the bot through LINE, and a retry uses the same webhook URL. LINE limits webhook tests to 60 requests per hour per channel.

In LINE Developers Console, enable **Use webhook**, **Webhook redelivery** and **Allow bot to join group chats**. In LINE Official Account Manager, turn off auto-reply and greeting messages. Open the bot details to view webhook activity, copy the URL, or choose **Update credentials** to verify and save a new channel secret, access token, or both. Setup and credential updates test the fixed URL before setting it. If setting the endpoint times out, retry to set the same URL again. The webhook returns HTTP 503 for live events during setup or signed only with a pending secret, so LINE can redeliver them. A credential update saves the new secret as soon as LINE's test confirms it. If anything fails after that, submit it again using the same URL. Approve, reject, mute and remove apply to the enrollment staff saw. If the chat has already rejoined, reopen it before taking action. [LINE Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)

A Project can connect multiple bots, each of which can join multiple chats. LINE allows one Official Account in each group or room at a time. [LINE group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/#add-bot-group-chat)

## LINE Ticket assistant

The assistant is off by default. It requires a legacy or disposable deployment, `LINE_AI_ENABLED=true`, and the existing `LINE_SECRETS_KEY`. The named-account pilot keeps it unavailable. Use a test LINE channel and synthetic messages for verification.

1. In **LINE**, the Owner chooses **Test and save** under **Project AI connection**. Google Gemini is the default. Gemini 4 Neon requires paid Gemini API access and uses the API key from Google AI Studio. OpenRouter, Anthropic Claude, and OpenAI each use their own API key. One tested connection serves the Project's bots. [Gemini API keys](https://aistudio.google.com/docs/api-key) · [Neon availability](https://aistudio.google.com/docs/whats-new-gemini-4-neon)
2. Open the bot and choose **Enable assistant** on an approved chat. Group members mention the bot with their request. Opted-in one-to-one chats can send a direct request. Follow-up attachments must come from the same sender and chat.
3. Open **LINE Ticket suggestions** to approve a draft, edit its reply, ask for details, or dismiss it. A closure must identify an active Ticket linked to that chat. **Create and send** and **Close and send** save the Ticket change and queue the approved reply together.

**Pause assistant** on the Project keeps the tested key. Resuming applies to new intake. Key rotation preserves drafts awaiting review and approved replies. **Disconnect provider** removes the stored key. A chat can be paused independently. Enable the chat again after reactivating its bot or restoring its Project. Review the enabled provider’s data handling, inform chat members before enabling live intake, and use only data approved for that provider.

The assistant sends the reviewed outcome by push to the originating chat. **Reply accepted by LINE** records acceptance by the Messaging API. If a reply times out, staff can retry it from **Recent replies**. If LINE reports a limit, check the rate and available message quota before retrying. The retry reuses its original payload and LINE retry key. It never repeats the Ticket change. [LINE push](https://developers.line.biz/en/reference/messaging-api/#send-push-message) · [LINE API retry keys](https://developers.line.biz/en/docs/messaging-api/retrying-api-request/) · [LINE limits](https://developers.line.biz/en/docs/messaging-api/handling-http-429-errors/)

Staff approval applies to the current Project, bot, chat enrollment and Ticket version. The assistant waits up to two minutes for follow-up files. It caps AI scans at 60 per Project per UTC day and analyzes up to two PNG, JPEG, or PDF attachments with an 8 MiB combined limit and 12 pages per PDF. Files are used for analysis in memory. Staff can attach approved files through the existing Ticket attachment workflow. Keep AI requests and replies disabled while replacing deployment data. Before restoring a backup, pause the assistant, stop in-flight work, and re-establish the connection and chat opt-ins with a fresh cutover boundary.

## Local setup and replay

Use a disposable worktree. Run `pnpm agent:setup`, then set a 32-byte base64 key and enable local fixtures.

```bash
pnpm convex:local env set LINE_SECRETS_KEY "$(openssl rand -base64 32)"
pnpm convex:local env set LOCAL_FIXTURES_ENABLED true
```

Keep the same key throughout the life of the local ciphertext. To use the replay tool, first create or seed an active Project using the [Ticket CLI local setup](ticket-cli.md). Substitute its key for `POS` below.

```bash
pnpm convex:local run line_local:seed '{"projectKey":"POS"}'
pnpm line:replay fixtures/line/join.json --bot "Replay bot POS"
pnpm line:replay fixtures/line/duplicate.json --bot "Replay bot POS"
pnpm line:replay fixtures/line/memberJoined.json --bot "Replay bot POS"
pnpm line:replay fixtures/line/message.json --bot "Replay bot POS"
pnpm line:replay fixtures/line/leave.json --bot "Replay bot POS"
```

Replay signs a fixture with the selected local fixture bot's channel secret and posts to this worktree's loopback Convex site port. Fixture bots use a simulated LINE adapter. The follow and unfollow fixtures exercise 1:1 chats. Event IDs and timestamps are fixed so a repeat exercises deduplication. To exercise a new lifecycle, use fresh event IDs and increasing timestamps.

For the assistant, set `LINE_AI_ENABLED=true` with `pnpm convex:local env set LINE_AI_ENABLED true` and enter `local-line-ai-fixture-key` in **Project AI connection**. This key is accepted only by the disposable fixture provider. Approve and enable the fixture chat, then replay a text event with a current timestamp, a fresh event and message ID, and a bot mention marked `isSelf: true`. The fixture model and LINE push run without external API requests.

The webhook records group, room and 1:1 lifecycle events. New groups and rooms need staff approval for their current enrollment. A newer join starts a fresh enrollment, even if it arrives before the preceding leave. Signed delivery for an archived Project is acknowledged without storing events. Queued events are checked again at claim and settlement. Staff can choose whether new 1:1 chats need approval and who owns future Tickets for an approved chat. Message intake requires the assistant to be enabled for the chat.
