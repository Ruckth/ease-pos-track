# LINE bots per Project

LINE is available on legacy and disposable deployments. Configure the Convex backend with a dedicated, stable 32-byte base64 `LINE_SECRETS_KEY` before connecting a bot. Keep the key in deployment secrets. The named-account browser pilot keeps LINE settings, webhook intake and workers disabled.

From the staff workspace menu, open **LINE** for the selected Project. Add the channel secret and long-lived channel access token from LINE Developers Console. Choose a bot language. The app tests the bot’s fixed HTTPS webhook URL before changing the LINE endpoint. If setup fails, use **Add LINE bot** again with corrected credentials for the same bot, in this or another Project. Until a setup is verified, it holds nothing and anyone who re-proves the token can finish it; once connected, no other Project can take the bot. The token identifies the bot through LINE, and a retry uses the same webhook URL. LINE limits webhook tests to 60 requests per hour per channel.

In LINE Developers Console, enable **Use webhook**, **Webhook redelivery** and **Allow bot to join group chats**. In LINE Official Account Manager, turn off auto-reply and greeting messages. Open the bot details to view webhook activity, copy the URL, or choose **Update credentials** to verify and save a new channel secret, access token, or both. Setup and credential updates test the fixed URL before setting it. If setting the endpoint times out, retry to set the same URL again. The webhook returns HTTP 503 for live events during setup or signed only with a pending secret, so LINE can redeliver them. A credential update saves the new secret as soon as LINE's test confirms it. If anything fails after that, submit it again using the same URL. Approve, reject, mute and remove apply to the enrollment staff saw. If the chat has already rejoined, reopen it before taking action. [LINE Messaging API reference](https://developers.line.biz/en/reference/messaging-api/)

A Project can connect multiple bots, each of which can join multiple chats. LINE allows one Official Account in each group or room at a time. [LINE group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/#add-bot-group-chat)

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

The webhook records group, room and 1:1 lifecycle events. New groups and rooms need staff approval for their current enrollment. A newer join starts a fresh enrollment, even if it arrives before the preceding leave. Signed delivery for an archived Project is acknowledged without storing events. Queued events are checked again at claim and settlement. Staff can choose whether new 1:1 chats need approval and who owns future Tickets for an approved chat. The webhook discards messages and postbacks.
