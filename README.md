# vibe code from phone (Telegram → Cursor Cloud Agents)

Telegram bot that forwards text or voice notes to a **Cursor Cloud Agent** on your GitHub repo (`autoCreatePR`), so you can vibe-code from your phone.

## Quick setup

1. Copy [.env.example](.env.example) to `.env` and fill values:
   - `CURSOR_API_KEY` — [Cursor Cloud Agents](https://cursor.com/dashboard/cloud-agents)
   - `TELEGRAM_BOT_TOKEN` — [@BotFather](https://t.me/BotFather)
   - `ALLOWED_USER_IDS` — your numeric Telegram id ([@userinfobot](https://t.me/userinfobot)), comma-separated
   - `GITHUB_TOKEN` — optional GitHub [classic PAT](https://github.com/settings/tokens) with **`repo`** scope so `/repos` lists your repos (tap to switch) and `/repocreate` makes new ones on your account
   - `DEFAULT_REPO_URL` — optional fallback if you do not use `/repos` yet
   - `OPENAI_API_KEY` — optional; needed for **voice** (Whisper)
2. `npm install`
3. `npm run dev`

Leave that terminal open; message your bot on Telegram.

## Commands

- `/start` — short help + repo status  
- `/repo https://github.com/you/repo` — save repo (ends current agent session)  
- `/repos` — list repos from GitHub (`GITHUB_TOKEN`); tap a row to select; `/repos 2` next page  
- `/repocreate my-repo [public]` — new repo under your user (private by default), then selects it  
- `/status` — active session / repo / agent id  
- `/end` — dispose agent and clear persisted session  

Plain text (not starting with `/`) starts a session if none, otherwise continues the same Cloud Agent.

## Voice TLDR (after each Cursor reply)

Telegram **does not let two bots DM each other**, so this bot cannot “paste text into @Erandroid_bot” directly.

Instead, after each agent **finish**, we build a **short spoken summary** (Cursor run summary when useful, otherwise assistant text without tool spam), then:

1. **`TTS_WEBHOOK_URL`** (best for Erandroid) — your Erandroid stack exposes **HTTP POST** `{"text":"..."}` and returns **`audio/mpeg` bytes**, or JSON `{"audio_base64":"..."}`. Optional header **`TTS_WEBHOOK_BEARER`**.
2. **`ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`** — same engine many voice bots use; Cursor Mobile calls ElevenLabs directly.
3. **`OPENAI_TTS_VOICE`** (e.g. `alloy`) — uses existing **`OPENAI_API_KEY`** with OpenAI speech (`tts-1`).

Priority if multiple set: **webhook → ElevenLabs → OpenAI**.

## Deploy on EC2 (Ubuntu)

1. **Never commit** `key.pem`, `.env`, or API keys — keep them on the server only.
2. On your laptop: push this repo to [GitHub](https://github.com/eranhaim/cursor_mobile).
3. SSH: `ssh -i key.pem ubuntu@YOUR_IP`
4. On the server:
   ```bash
   sudo apt-get update && sudo apt-get install -y git
   git clone https://github.com/eranhaim/cursor_mobile.git
   cd cursor_mobile
   bash scripts/ec2-install.sh
   ```
5. Create `.env` on the server (copy from `.env.example`, fill all required vars + `ELEVENLABS_*` for voice TLDR).
6. Optional systemd (runs on boot):
   ```bash
   sudo cp scripts/cursor-mobile.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now cursor-mobile
   sudo journalctl -u cursor-mobile -f
   ```

Mount a volume at `/app/data` for `sessions.json` persistence.

```bash
docker build -t cursor-mobile .
docker run --env-file .env -v cursor_mobile_data:/app/data cursor-mobile
```

## Notes

- Keys stay on the server — Telegram never sees `CURSOR_API_KEY`.
- Core logic lives under `src/core`; `src/adapters/telegram.ts` is replaceable with a web adapter later.
