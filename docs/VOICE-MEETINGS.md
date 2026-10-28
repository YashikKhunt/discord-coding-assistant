# M7 — Discord voice meetings (architecture)

Status: **Draft v1** · Last updated: 2026-10-28 · Supplements [ARCHITECTURE.md](ARCHITECTURE.md)

The product owner joins a Discord voice channel, talks to the coding agent, and the agent talks
back — out loud, through ElevenLabs text-to-speech. They go back and forth like a real dev
meeting. At the end the agent writes a standup: what was discussed, what was decided, and what it
will do next. Agreed next steps become real `/task` and `/bugreport` jobs, but only after the owner
confirms them.

> **User story.** *"When I as product owner join a meeting with my Discord agent, I can freely speak
> to him and the agent also gives its suggestions back and forth, and at the end he writes standups
> of what he will do next — just like real developer meetings."*

This plan was produced by three parallel research passes (Discord voice I/O; the speech pipeline,
latency and cost; repository integration) and reconciled against the code in this repository. Where
the passes disagreed, the disagreement and the resolution are recorded in §3.

---

## 1. Goals and non-goals

### Goals (v1)
- One named agent joins a voice channel on command, listens to the owner, and replies in speech.
- Natural turn-taking: the agent can be interrupted mid-sentence and yields the floor.
- A standup posted to `#responses` at the end of every meeting, including crashes and timeouts.
- Action items become real jobs **only on explicit confirmation** by an allowlisted human.
- Vendors (STT, TTS, voice transport) behind interfaces, as with `SandboxProvider` and `StepModel`.
- Multiple named agents are a **configuration** change later, not a rewrite.
- Fits the existing budget discipline: metered, capped, recorded per meeting in Postgres.

### Non-goals (v1)
- Multi-party meetings. One allowlisted speaker is transcribed; others are heard by nobody.
- Mid-conversation repository reading. The agent is briefed up front and takes action items.
- Voice-authorized job creation. Voice proposes; a Discord button authorizes.
- Speaker diarization, acoustic echo cancellation, local speech models.
- Stage channels, screen share, video.
- Reading code aloud. Code goes to the forum thread as text.

---

## 2. Decisions log

| # | Area | Decision |
|---|---|---|
| V1 | Pipeline | **Own pipeline**, not ElevenLabs' managed Agents platform. Discord Opus → PCM → streaming STT → `@dca/llm` → ElevenLabs streaming TTS → Opus → Discord. Agents costs $0.08/min of connected audio ≈ $2.40 per 30-minute meeting, which alone would exceed the project's entire $10/month cap at four meetings, and its per-minute wholesale billing cannot be metered the way everything else here is. |
| V2 | Escape hatch | Keep Agents + custom-LLM endpoint as a documented pivot if our own barge-in proves unpleasant. It would preserve `@dca/llm` as the brain but needs a public OpenAI-compatible SSE endpoint on `autocode.duckdns.org`. |
| V3 | Process | New **`apps/voice`** app with its own gateway client. Not `apps/bot` (sole drain of the `job_events` outbox — must never stall), not `apps/worker` (holds the Docker socket; `ARCHITECTURE.md` §3 makes workers Discord-agnostic). |
| V4 | Hand-off | `apps/voice` claims meetings from Postgres with `FOR UPDATE SKIP LOCKED`, mirroring `claimNextJob`. No new network path; a dead voice app leaves the meeting `requested` until the reaper. |
| V5 | Credentials | `apps/voice` never receives `GITHUB_BOT_TOKEN`. The API assembles the meeting briefing and snapshots it into `meetings.context`. |
| V6 | Transport | `@discordjs/voice@0.19.2`, **pinned exactly**, with a `pnpm patch` for the open DAVE defect (§3, §19 risk 1). `selfDeaf: false` — the default is `true` and silently kills all inbound audio. |
| V7 | Intents | Add exactly one, **to the `apps/voice` client only**: `GatewayIntentBits.GuildVoiceStates` (`1 << 7`). Not privileged, no portal toggle. `apps/bot` keeps `Guilds` alone. Channel permissions: `ViewChannel`, `Connect`, `Speak`, `UseVAD`. |
| V8 | Opus codec | **`opusscript` 0.1.1** (pure WASM, no build step, no `allowBuilds` entry) over native `@discordjs/opus`. See §3 — the native prebuilds do not resolve on Debian bookworm, and the fallback is a source build the runtime image cannot do. |
| V9 | STT | **Deepgram Flux (`flux-general-en`)** primary, **AssemblyAI Universal-Streaming** configured fallback, both behind one `SpeechToText` interface. Flux is chosen for semantic end-of-turn detection inside the transcript stream — the hardest part of turn-taking, bought for ~$0.05/meeting. |
| V10 | STT, rejected | **No local Whisper.** On 2 Ampere A1 cores the only size that fits is `base.en`, which mangles exactly the vocabulary a meeting about code uses (`pnpm`, `drizzle`, `aarch64`, branch names). Saves under $1/month and costs the box its headroom. |
| V11 | TTS | ElevenLabs **`eleven_flash_v2_5`** over the **websocket** `stream-input` endpoint for conversational turns (built for feeding LLM output as it arrives), and the **HTTP stream** endpoint for the templated standup readout. Never a Professional Voice Clone — documented slower. |
| V12 | Audio format | Request **`pcm_48000`** so no resampling is needed: mono s16le 48 kHz → duplicate to stereo → 960-sample frames → Opus. The output stage is a configurable resampler that is a no-op at 48 kHz, so a tier or format surprise is one config value, not a redesign. |
| V13 | LLM | A new **`stream()` on `StepModel`** (`ai@^7` `streamText`) is a **prerequisite**, not an enhancement — without it the latency budget collapses from "first token" to "full completion". Cost accounting is unchanged: `streamText`'s finish event reports the same usage shape `costUsd()` already consumes. |
| V14 | Conversation loop | **Do not reuse `runAgent`.** A text-only response trips its "call `finish`" nudge and then exits `no_tool_call` — but a normal spoken reply *is* text-only, so every turn would break the loop. Reuse only `StepModel`, in a new `MeetingConversation`. |
| V15 | Start | **`/meeting start`** with a required `repo`, so the existing allowlist and `#create-job` channel restriction apply unchanged. Auto-join on a voice-state event is opt-in later behind `VOICE_AUTOJOIN_CHANNEL_ID`. |
| V16 | Meeting identity | Meetings get their own table, statuses, state machine and `MTG-` counter. They cannot be a `JobType`: `claimNextJob` claims any `queued` row, and `JobRunner`, `JOB_ID_PREFIX`, `Profile.id` and `job_counters.type` all assume the three existing types. |
| V17 | Standup delivery | Through a **`meeting_events` outbox** drained by a **`MeetingNotifier`** in `apps/bot`, mirroring the existing `Notifier`. Nothing is posted to Discord from `apps/voice`. `job_events.job_id` is `NOT NULL → jobs.id` and `ForumPublisher` is typed on `JobDto`, so this is a sibling of the existing path, not a widening of it. |
| V18 | Human-in-the-loop | Voice never creates a job. Items land as `action_items.status = 'proposed'`; a **Discord button** in the standup post is the authorization, with the allowlist re-checked on whoever clicked and a claim-first guard against double clicks. |
| V19 | Spend | Meeting **LLM** spend joins the existing `$10` cap by making `llm_calls.job_id` nullable, adding `meeting_id`, and a `CHECK` that exactly one is set — then `monthSpendUsd` needs no change at all. **Voice vendor** spend is a separate currency: `voice_usage` rows priced from a `VOICE_PRICES` table, capped by `MONTHLY_VOICE_CAP_USD` (default 5) plus `VOICE_MEETING_CAP_USD` (default 1.50). |
| V20 | Consent | Allowlisted speakers only — everyone else's audio is discarded undecoded. Spoken announcement on join plus text in the forum post. Raw audio is never written to disk. Transcripts redacted before insert and kept 7 days; standups keep the standard 30. |
| V21 | Agent roster | A separate `MeetingAgentProfile` type (`Profile.id` is typed `JobType`, so don't widen it): name, `voice_id`, persona, model, limits. One agent from env today; `AGENT_ROSTER` JSON adds more. N personas can share one voice connection with per-utterance voices; N distinct Discord identities would need N applications. |

---

## 3. What the research settled, and what it did not

Three findings reshape the plan. They are first because they decide build order.

### 3.1 DAVE is mandatory, receive works, and there is an open defect on our exact flow

Discord's end-to-end voice encryption (DAVE) is enforced — voice close code **4017** is
"E2EE/DAVE protocol required", and `@discordjs/voice` has shipped `@snazzah/davey` as a hard
dependency since 0.19.1 ("Always install Davey as DAVE is becoming required", PR #11385).
Setting `daveEncryption: false` is a dead end; worse, the library does not special-case 4017
(`canResume = code === 4015 || code < 4000`), so a DAVE-less config **reconnect-loops forever**
instead of failing loudly.

Receive-side decrypt **is** implemented in 0.19.2 and is called on every inbound packet. So the
feature is possible. But:

- **[discordjs/discord.js#11653](https://github.com/discordjs/discord.js/issues/11653) is open and
  unfixed in 0.19.2**, and it fires on the most natural flow we have — the bot joining a channel the
  owner is already sitting in. The recovery guard reads
  `if (this.lastTransitionId) this.recoverFromInvalidTransition(...) else throw error`, and
  `lastTransitionId` is the transition id verbatim: **transition 0 is falsy**, so a session whose
  only transition is 0 can never recover and throws, destroying the receive stream.
- The `UnencryptedWhenPassthroughDisabled` error it reproduces was filed separately (#11445) and
  closed **`not_planned`**, as was #11441. Upstream appetite for receive bugs is limited.
- `@discordjs/voice`'s own README: *"Audio receive is not documented by Discord so stable support is
  not guaranteed"*, and a maintainer in #11419: receive "has always been on a 'it may work' basis."

**Mitigation** is a `pnpm patch` with **both** changes, against `dist/index.mjs` (these packages are
`"type": "module"`, so that is the file actually loaded) and `dist/index.js` for safety:

1. `if (this.lastTransitionId !== undefined)` — makes recovery possible at transition 0. On its own
   this still drops ≥720 ms of audio (36 failures × 20 ms) and forces a re-key.
2. Call `setPassthroughMode(true, TRANSITION_EXPIRY)` in `processWelcome`. `reinit()` and the
   upgrade path do this and `processWelcome` does not, and the hypothesis is that the omission is what
   produces the failures in the first place. **This second change is our own proposed fix: it is
   untested, not upstream, and not in the issue.** Change 1 alone is the safe part; treat change 2 as
   something M7.0 must prove or discard.

Also: subscribe to **one** user, because `consecutiveFailures` is a single per-session counter, not
per-user, so an unrelated speaker can poison it.

**This makes a go/no-go spike the first milestone** (§18, M7.0). It is ~30 minutes: join with
`debug: true`, try both join orders, have the owner speak immediately, and grep the debug stream for
`Failed to decrypt`.

**If receive degrades further**, the designed escape hatch is a mic page on the existing
Caddy + dashboard origin: Discord voice becomes send-only, which is officially supported and stable,
and the whole receive risk class disappears while the back-and-forth UX survives. Push-to-talk
recordings are the cruder fallback. Self-bot audio capture is a ToS violation and is ruled out.

### 3.2 The Opus prebuilds do not resolve on our image

The two research passes disagreed here, and the evidence settles it against the faster option.

`@discordjs/opus@0.10.0` publishes `...-node-v127-napi-v3-linux-arm64-glibc-2.31.tar.gz` and
`...-glibc-2.35.tar.gz`. Node 22 is ABI 127, so the ABI matches. But `@discordjs/node-pre-gyp`
substitutes the **detected** libc version verbatim into the asset name
(`libc_version: detect_libc.versionSync() || 'unknown'`) and has **no nearest-match logic**. Debian
bookworm is glibc **2.36**, so the URL becomes `...glibc-2.36.tar.gz` → 404 →
`--fallback-to-build` → `node-gyp` compiles from source → fails on `bookworm-slim`, which has no
toolchain. Ubuntu 24.04 (glibc 2.39) is no better, and `@discordjs/opus` has had no release since
January 2025.

So: **`opusscript` 0.1.1** (Emscripten libopus 1.4, pure WASM, no install script) for round 1. We
need one decode stream and one encode stream; WASM is comfortably fast enough for that, and it also
needs no `allowBuilds` entry and survives a future Node upgrade. If the spike shows WASM decode
costs too much on the Ampere box, the alternative is adding `python3 make g++` to the Dockerfile
`deps` stage **and** `"@discordjs/opus": true` to `allowBuilds` — without that second change pnpm
silently skips the install script and you get a package with no `.node` at runtime.

**UNVERIFIED:** `prism-media@1.3.5` declares a peer of `opusscript ^0.0.8` while latest is 0.1.1.
Test the loader shape in the spike.

### 3.3 Discord sends nothing during silence — the STT stream must be padded

Discord clients run their own VAD and **stop sending packets** during silence. That gives us free
speaker separation and a first-pass endpointer, but it also means a naive bridge forwards *nothing*
to the STT socket — and Flux's `eot_timeout_ms`, `EndOfTurn` and `Update` cadence are all driven by
audio it actually receives. **End-of-turn may never fire**, and an idle socket may be dropped: the
pipeline looks built and never answers.

The bridge must **synthesize silence**: when a speaker's packets stop, write zero-valued 16 kHz
s16le frames at real-time pace (20 ms / 320 samples / 640 bytes per tick) until packets resume or
the turn ends. About twenty lines of `setInterval` plumbing, and load-bearing. The padding is
billable audio — it is why §14 assumes the STT socket bills for the full meeting.

The alternative (Deepgram `KeepAlive` plus our own `ForceEndTurn` timer) trades away the semantic
endpointing we picked Flux for. **UNVERIFIED:** Flux's KeepAlive behaviour and idle-socket timeout
are not documented; resolve during the spike.

Compounding this, **[#8105](https://github.com/discordjs/discord.js/issues/8105)** (open since 2022)
means `EndBehaviorType` can fire mid-sentence, so one utterance arrives as several streams. **Never
treat stream `end` as end-of-turn**; debounce 800–1200 ms across consecutive streams from the same
speaker.

### 3.4 Open unknowns, each cheap to settle

| # | Unknown | How to settle | Worst case |
|---|---|---|---|
| U1 | DAVE receive on the real arm64 host | M7.0 spike | the mic-page escape hatch (§3.1) |
| U2 | `pcm_48000` tier gating. The stream reference names tiers for `mp3_44100_192` (Creator+) and `pcm_44100` (Pro+) and lists `pcm_48000` with **no tier stated**; the help-center list is silent on 48 kHz too. Genuinely unknown, not implicitly Pro. | one API call on the real account | `pcm_24000` + 2× integer upsample, ~1–3 ms/frame. **Not** a $99/mo plan |
| U3 | ElevenLabs PCM channel count, bit depth, endianness; whether `opus_48000_*` is Ogg-containered | one curl: check for the `OggS` magic, measure bytes/second (48000 × 2 × channels for s16le) | the configurable interleave stage in V12 absorbs it |
| U4 | ElevenLabs free-tier overage behaviour. ~36k Flash chars/month exceeds the free tier's 20k included, so either overage meters at $0.04/1k (fixed cost $0) or it is a hard quota (floor becomes Starter $6/mo, which *replaces* rather than adds to the metered TTS line) | account settings / one overage test | §14 prices both; define caps over metered spend only |
| U5 | Two gateway sessions on one bot token, both receiving `INTERACTION_CREATE` | M7.0 spike | a second Discord application and `DISCORD_VOICE_TOKEN`, already in the config shape |
| U6 | Flux accuracy on technical speech. Deepgram claims sub-300 ms EOT; AssemblyAI's **competitor-authored** benchmark reports Flux at 15.58% pooled WER vs their 6.99%, and 568 ms mean / 1319 ms p95. Both are marketing. | A/B Flux vs AssemblyAI on 10 minutes of the owner's real speech with real repo jargon — costs cents | swap providers behind `SpeechToText` |
| U7 | Discord Developer Policy on recording voice. The current policy returns **HTTP 403** to automated fetches; the archived 2017 terms treat voice data as End User Data needing express permission and deletion on request | a human reads it before launch | §15 is built to the stricter reading anyway |
| U8 | `onnxruntime-node@1.31.1` on linux-arm64 (Silero VAD) | Docker build test | a 30-line RMS gate with hysteresis; VAD is a refinement, not a requirement |

---

## 4. System overview

```
 Discord
  #create-job ── /meeting start|end|cancel|status ──────────┐
  voice channel ◄══ Opus audio (send + receive) ═══════╗    │
  #responses (forum) ◄── standup + action buttons ──┐  ║    │
                                                    │  ║    │
┌───────────────────── docker compose ──────────────┼──╫────┼──────────────────┐
│                                                   │  ║    ▼                  │
│  ┌────────────┐      ┌────────────┐      ┌────────────────────────────────┐  │
│  │ dashboard  │─────►│ api        │◄─────│ bot (gateway, Guilds)          │  │
│  │  Meetings  │      │ Fastify    │      │  • /meeting → api              │  │
│  └────────────┘      └─────┬──────┘      │  • Notifier: job_events        │  │
│                            │             │  • MeetingNotifier: mtg_events │  │
│                            │             │  • buttons: approve an item    │  │
│                            ▼             └────────────────────────────────┘  │
│                 ┌──────────────────────┐                                     │
│                 │ Postgres             │ meetings (also the queue)           │
│                 │                      │ meeting_turns · meeting_events      │
│                 │                      │ standups · action_items             │
│                 │                      │ voice_usage · llm_calls             │
│                 └──────────┬───────────┘                                     │
│                            │ claim (FOR UPDATE SKIP LOCKED)                  │
│                 ┌──────────▼────────────────────────────────────┐            │
│                 │ voice  (gateway: Guilds + GuildVoiceStates)   │══╝         │
│                 │  DiscordVoiceTransport ─ opusscript ─ PCM     │            │
│                 │  MeetingConversation (StepModel.stream)       │            │
│                 │  no GITHUB_BOT_TOKEN · no docker socket       │            │
│                 └───┬──────────────┬───────────────────┬────────┘            │
│                     │ STT (wss)    │ LLM              │ TTS (wss)            │
└─────────────────────┼──────────────┼──────────────────┼──────────────────────┘
                      ▼              ▼                  ▼
                 Deepgram Flux   Anthropic/…        ElevenLabs Flash v2.5
```

Three properties worth stating plainly: Discord audio is the **only** thing that touches
`apps/voice` from outside; everything the agent *knows* arrives through Postgres; and everything the
meeting *produces* leaves through Postgres. A dead voice process loses a conversation, never a
standup.

---

## 5. The pipeline

```
Discord voice (48 kHz stereo Opus, 20 ms frames)
  → receiver.subscribe(ownerId, { end: Manual })        per-user Opus packets
  → prism-media opus.Decoder(48000, 2ch) [opusscript]   s16le 48 kHz stereo, 3840 B/frame
  → downmix + decimate 3:1 → 16 kHz mono s16le          linear16 for Deepgram
  → real-time zero-PCM padding during packet gaps       §3.3 — load-bearing
  → Deepgram Flux  wss://api.deepgram.com/v2/listen?model=flux-general-en
      EagerEndOfTurn → start LLM + TTS speculatively, BUFFER the audio
      TurnResumed    → abort, discard
      EndOfTurn      → release buffered audio / run the turn
  → StepModel.stream()  (haiku-4-5, cached briefing prefix)
  → sentence chunker                                    see §5.2
  → ElevenLabs wss .../stream-input (eleven_flash_v2_5, auto_mode=true, flush per sentence)
  → pcm_48000 mono → stereo interleave → Opus encode
  → @discordjs/voice AudioPlayer (StreamType.Raw, silencePaddingFrames: 5) → Discord
```

### 5.1 Latency budget — end of speech to first agent audio

| Stage | Conservative | Optimistic | Note |
|---|---|---|---|
| Endpoint detection (Flux, `eot_threshold` 0.8) | 400 ms | 250 ms | vendor claims sub-300 ms; competitor benchmark says 568 ms mean |
| STT finalization | 150 ms | 50 ms | the transcript ships *with* the `EndOfTurn` event |
| Context assembly + cap re-check | 40 ms | 10 ms | Postgres on the same host |
| **LLM first token** (haiku, cached prefix) | 600 ms | 300 ms | **UNVERIFIED — measure.** Needs V13 |
| First sentence accumulates (~8–12 words) | 300 ms | 150 ms | real added latency, overlaps nothing |
| TTS time-to-first-byte (Flash, websocket, NA/EU) | 150 ms | 100 ms | ElevenLabs publishes 100–150 ms |
| PCM → stereo → Opus encode | 20 ms | 5 ms | WASM opus, 2 arm64 vCPU |
| Discord playback start (jitter + RTT) | 100 ms | 40 ms | |
| **Total, sequential** | **≈1.76 s** | **≈0.91 s** | |
| **Total with eager EOT (0.6)** | **≈1.25 s** | **≈0.65 s** | eager EOT does not shorten the endpoint wait; it hides the middle of the table behind it |

**Target: p50 ≤ 900 ms, p95 ≤ 1.8 s.** Human conversation minimizes inter-turn silence — Stivers et
al. 2009 (PNAS 106(26):10587–10592) found this across all ten languages studied, with cross-language
means varying within roughly a 250 ms range, and ~200 ms is the figure usually quoted. Industry
voice-agent practice (vendor blogs, heuristics rather than peer review) converges on <500 ms
responsive, <800 ms acceptable, >1 s wrong, >1.5 s and users start talking over the agent.

**A meeting can be more relaxed than a phone IVR**: a collaborator pausing a second before answering
a design question reads as thoughtful. Two perceptual tricks beat shaving 200 ms:

- **Cached filler.** If no audio has started by ~700 ms, play a pre-generated 300 ms acknowledgement
  ("Right —", "Okay, so —") from disk. One-time TTS cost, instant, buys 1–2 s of apparent
  responsiveness. Not persisted as a turn.
- **Instrument every stage** into Postgres per turn. Latency is a distribution; p95 is what annoys
  the owner. `firstAudioMs` is the single number that decides whether this feels like a conversation.

After the first sentence, everything pipelines: while 2–4 s of audio plays, the rest generates and
synthesizes. **Only the first sentence's latency is ever visible**, so the system prompt asks the
model to open with a short clause.

### 5.2 Sentence chunking

Buffer `streamText` deltas and flush on a sentence boundary, with guards that matter for a *coding*
agent:

- Flush on `[.!?]` + whitespace; or on `[,;:]`/newline past ~80 chars; or unconditionally at ~180.
- Minimum first chunk ~40 chars — three words synthesize as audibly clipped, wrongly-prosodied speech.
- **Don't split inside backticks**, and don't treat `v2.5`, `0.19.2`, `pnpm -r`, `Node.js` or `e.g.`
  as sentence ends. A regex on `\d\.\d`, known abbreviations and fenced spans covers most of it.
- **Never read code aloud.** Detect fenced blocks and long identifier runs and substitute a spoken
  summary ("I'll put the diff in the thread") while posting the real text to the forum. This is a
  product decision with a latency and cost payoff.
- Send each chunk as `SendText` with a trailing space, `flush: true` on sentence ends, `auto_mode=true`.
- `enable_ssml_parsing` defaults to **false**. Leave it off for conversation (model-generated `<...>`
  would be reinterpreted); enable it only for the templated standup, where `<break time="0.3s" />`
  between list items helps.

**UNVERIFIED:** ElevenLabs' websocket docs name the field `generator_config` on `SendText` and
`generation_config` on `InitializeConnection`. Resolve at integration time. `optimize_streaming_latency`
is **deprecated with no named replacement** — noted so nobody adds it later from an old tutorial.

---

## 6. Turn-taking, barge-in and the floor

Three layers, in order of authority:

1. **Discord packet gaps** — a hint only, never end-of-turn (§3.3, #8105). Subscribe with
   `EndBehaviorType.Manual` and one long-lived stream per speaker; `receiver.speaking` start/stop is
   driven by real received packets, so it is true voice activity and silent for a muted user.
2. **Flux end-of-turn** — the decision-maker. `eot_threshold` **0.8** (docs default 0.7, recommend
   0.85): an owner thinking out loud pauses mid-sentence, and being cut off is far worse than 150 ms
   of extra wait. `eot_timeout_ms` **4000**. `eager_eot_threshold` **0.6** — on `EagerEndOfTurn`,
   start the LLM *and* TTS but **buffer the audio and play not one frame** until `EndOfTurn` arrives;
   release then, or abort on `TurnResumed`. Playing speculative audio early means talking over
   someone who merely paused, which is strictly worse than being 400 ms slower. Log `EndOfTurn`'s
   `trigger` (`model | manual | timeout`) — it tells you whether the threshold or the timeout is
   doing the work.
3. **VAD** — optional refinement given layers 1–2. If needed, Silero v5 via `onnxruntime-node`
   (arm64 UNVERIFIED, U8); `@ricky0123/vad-node` is stale at 0.0.3 and `node-vad`/`webrtcvad` are old
   native bindings with arm64 build risk. A 30-line RMS gate with hysteresis is the right fallback.

**Barge-in** needs three things together, and the research passes split on the trigger. Resolution:
use both signals for what each is good at.

```ts
// Fast local signal. `speaking.start` fires once, at onset, so the 300 ms gate has to be a timer
// that `speaking.end` cancels — there is no sustained-duration value to read in the handler.
let gate: NodeJS.Timeout | undefined;
receiver.speaking.on("start", (userId) => {
  if (userId !== ownerId || !session.speaking) return;
  gate = setTimeout(() => {
    player.stop(true);   // force=true skips padding; a plain stop() does NOT interrupt
  }, 300);               // gate: the bot's own voice bleeding back through the owner's mic
});
receiver.speaking.on("end", (userId) => {
  if (userId === ownerId) clearTimeout(gate);
});

// Authoritative signal. Flux's StartOfTurn carries a non-empty transcript, so it does not fire
// on a cough or a keyboard.
flux.on("StartOfTurn", () => controller.abort());   // aborts StepModel.stream AND the TTS socket
```

**When playback was stopped locally but `StartOfTurn` never arrives** — a cough, a door, a chair —
the turn still ends. Abort the LLM and TTS, persist the turn as `interrupted` with the spoken-text
truncation, and **yield the floor without resuming**. Resuming mid-sentence is worse than stopping:
it needs re-synthesis from an arbitrary offset, and a human who coughed will simply say "sorry, go
on", which is a new turn. The cost is an occasional truncated sentence; the alternative is a resume
path that is hard to get right and rarely exercised.

`player.stop(true)` leaves ~20–60 ms of already-sent audio playing through Discord's jitter buffer.
That is acceptable; humans do this too. The ElevenLabs `fetch`/socket must be aborted or we keep
paying for audio nobody hears.

**The subtle bug that makes barge-in feel broken** is history, not audio: truncate the assistant turn
in conversation history to **what was actually spoken**, or the model believes it said three
sentences the owner never heard. ElevenLabs' websocket returns per-character `alignment`
(`char_start_times_ms`, `char_durations_ms`); cut at the character reached by elapsed playback time
and append `[interrupted]`.

Two accounting consequences, easy to miss:

- An aborted `step()` **throws and reports no usage**, so that turn's LLM cost is lost. Write an
  estimated row (prompt tokens known, output estimated from what was spoken) flagged `priced: false`,
  or the cap undercounts.
- TTS bills what was **requested**, not what was played. Take `charactersBilled()` at abort time.

**Holding the floor.** Speak only when not already speaking and no speech has been detected;
utterances arriving mid-speech are **queued and concatenated into one turn** (so "…and also the auth
thing" is not a second LLM call); replies capped at ~300 output tokens with a system prompt demanding
1–3 spoken sentences and an explicit hand-back. A 150 ms guard after the player goes idle swallows
the owner's speakers bleeding the agent's sentence tail back into their mic. We do **not** build
acoustic echo cancellation — the bot never receives its own audio back, and the owner's Discord
client handles the mic leak.

---

## 7. Meeting lifecycle

```ts
// packages/core/src/meetings.ts
export const MEETING_STATUSES = [
  "requested", "joining", "active", "summarizing", "ended", "failed", "cancelled",
] as const;
export const MEETING_ID_PREFIX = "MTG";          // MTG-0007
```

```ts
// packages/core/src/meeting-state-machine.ts   — mirrors state-machine.ts exactly
const TRANSITIONS: Record<MeetingStatus, readonly MeetingStatus[]> = {
  requested:   ["joining", "cancelled", "failed"],
  joining:     ["active", "failed", "cancelled"],
  active:      ["summarizing", "failed", "cancelled"],
  summarizing: ["ended", "failed"],
  ended: [], failed: [], cancelled: [],
};
```

`listening` and `speaking` are deliberately **not** DB states — they flip many times a minute and
live in memory on `MeetingConversation`.

| Transition | Written by |
|---|---|
| `→ requested` | API, in `createMeeting` (+ a `created` event) |
| `requested → joining` | `apps/voice`, as the `SKIP LOCKED` claim (sets `voice_worker_id`, `heartbeat_at`) |
| `joining → active` | `apps/voice`, once connected **and** the consent line has been spoken |
| `active → summarizing` | `apps/voice` on `/meeting end`, idle, alone-in-channel, cap or max duration; or the reaper |
| `summarizing → ended` | whoever generated the standup — voice app normally, worker on recovery |
| `→ cancelled` / `→ failed` | API (before join), `apps/voice`, or the reaper |

Every transition inserts a `meeting_events` row with the same guarded-update shape as `transitionJob`.

**Edge cases, all of which still produce a standup** except an explicit cancel:

- **Idle** — no allowlisted utterance for `VOICE_IDLE_TIMEOUT_SEC` (180). At half the window the
  agent says "Still there? I'll wrap up and write the standup otherwise."
- **Alone** — no allowlisted human in the channel for `VOICE_ALONE_GRACE_SEC` (30). The bot never
  leaves on its own otherwise, and an empty channel burns STT money (§14).
- **Caps / max duration** — `VOICE_MAX_MEETING_MIN` (45), `VOICE_MEETING_CAP_USD`, or the monthly
  caps. **Standup budget is reserved up front** (`standupReserveUsd`), so hitting a cap
  mid-conversation still yields one. On breach the agent speaks one sentence ("I'm at my budget for
  this meeting — switching to text"), leaves, and continues in the thread.
- **Cancel** — `/meeting cancel` sets `cancel_requested_at`, polled on the worker's 2 s cadence, and
  skips the standup.
- **Crash** — every turn is persisted as it completes. `heartbeat_at` plus a reaper in `apps/voice`
  (and a slower backstop in the worker, so a dead voice app still resolves) moves stale meetings to
  `summarizing`, and the worker generates the standup from `meeting_turns`.
- **Discord disconnects** — on `Disconnected` with close code 4014, wait briefly for `Connecting` (a
  channel move) via `entersState`, else destroy; otherwise `rejoin()` up to 5 times. **Add an explicit
  4017 handler that destroys and reports** rather than looping (§3.1). Re-subscribe after a rejoin:
  the SSRC map clears per user on `ClientDisconnect`.

---

## 8. Conversation orchestration and context

```ts
// packages/meeting/src/conversation.ts
export class MeetingConversation {
  /** Handles one utterance. Returns the reply; empty when the agent yields the floor. */
  handleUtterance(u: Utterance, signal: AbortSignal): Promise<{ text: string; costUsd: number }>;
  /** A late, off-critical-path lookup result, injected before the next turn. */
  noteAside(text: string): void;
  /** Final call: whole transcript → StandupDraft. Separate from the turn loop. */
  summarize(signal: AbortSignal): Promise<{ draft: StandupDraft; costUsd: number }>;
}
```

One `StepModel.stream()` call per utterance, `maxOutputTokens` 300, history compacted past ~24 turns,
and a `beforeTurn` hook returning a stop reason exactly like `AgentHooks.beforeStep`. `StepModel`
already sets the Anthropic cache breakpoint on the last message, which matters here: the briefing is
a long stable prefix re-sent every turn.

**The briefing is assembled by the API at meeting creation** and snapshotted into `meetings.context`
— one round trip, zero mid-conversation latency, and no `GITHUB_BOT_TOKEN` in the voice process (V5):

- Repo, default branch, detected stack, `.agent.yml` `instructions` if present.
- Last 10 jobs: short ID, type, status, one-line request, PR URL, cost (`listJobs` already returns this).
- Open PRs by `GITHUB_BOT_LOGIN`: number, title, draft/ready, CI state.
- Last 5 commit subjects on the default branch.
- The previous meeting's standup: decisions, next steps, still-open blockers.
- Open action items from previous meetings with their job IDs and status — so "did you do the
  rate-limiting thing?" is answerable instantly.
- Remaining monthly budget, so the agent never promises work the cap will refuse.

Target ≤ 3k tokens.

**Mid-conversation tools: almost none, on purpose.** `note_action_item` and `note_decision` only —
in-memory writes, sub-millisecond, no network. There is deliberately **no repo-reading tool**: it
would need credentials the voice process must not have and would put seconds into a conversation.
"Can you look into X?" becomes an action item, which is the honest developer answer anyway. If a
lookup later proves necessary, the pattern is fire-and-forget: the agent says "let me check", the
query runs on a 2.5 s budget *outside* the turn, and the result arrives via `noteAside()` before the
next one. The critical path never waits on I/O.

This is also why tool-calling loops are a reason to reject the managed-agent platform (V1/V2): a
multi-step `/task`-style loop inside one conversational turn produces no tokens for seconds and
would stall the voice.

---

## 9. The standup, and action items becoming jobs

```ts
export const standupSchema = z.object({
  title: z.string().max(100),
  discussed: z.array(z.string().max(300)).max(8),
  decisions: z.array(z.string().max(300)).max(8),
  nextUp: z.array(z.object({
    summary: z.string().max(300),
    kind: z.enum(["task", "bugreport", "runtest"]),
    repo: z.string().max(140),
    description: z.string().max(6000),      // ready-to-submit job input
  })).max(6),
  blockers: z.array(z.string().max(300)).max(6),
  openQuestions: z.array(z.string().max(300)).max(6),
});
```

Generated on **every** `active → summarizing`, with one `summarize()` call on `MODEL_MEETING_STANDUP`
against the full transcript, using the budget reserved at meeting start.

Delivered through the **`meeting_events` outbox** and a **`MeetingNotifier`** in `apps/bot` that
mirrors the existing `Notifier`: same 2 s tick, same leave-unnotified-until-Discord-accepts rule,
same give-up window, same per-meeting ordering, same `ensurePost` single-flight lock. Add `"meeting"`
to `ALL_TAG_NAMES` so `ensureTags()` creates it; reuse the existing status tags. The forum post is
created on `created`, so the thread exists while the meeting is still running and the ack can link it.

```
🟩 MTG-0007 · standup · yashik/my-api
 Rate limiting and the flaky auth test · 14m · 2 participants

 ─ Discussed ────────────────────────────────────
 • Token-bucket vs sliding window for /api rate limiting
 • auth/refresh.test.ts flakes on CI about 1 run in 5

 ─ Decided ──────────────────────────────────────
 ✔ Token bucket, limits from RATE_LIMIT_* env
 ✔ Fix the flake before shipping anything else

 ─ Next up ──────────────────────────────────────
 1. BUG  · fix the refresh-token test flake     [ Create BUG ] [ Skip ]
 2. TASK · token-bucket rate limiting on /api   [ Create TASK ] [ Skip ]

 ─ Blockers ─────────────────────────────────────
 ⛔ Staging DB credentials expired — I could not run the integration suite

 haiku-4-5 · $0.07 LLM · $0.26 voice · 14m · View meeting ↗
```

**The buttons are the authorization boundary.** STT mishears, and a spoken "yes" leaves no audit
trail, so voice collects intent and a click creates the job. `apps/bot/src/main.ts` currently drops
everything that is not `isChatInputCommand()`, and there is no button code in the repo yet:

```ts
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) return handleCommand(interaction, deps);
  if (interaction.isButton()) return handleComponent(interaction, deps);   // new
});
// stateless custom_id — no in-memory map survives a bot restart
const ACTION_ITEM = /^mtg:(?<itemId>[0-9a-f-]{36}):(?<verb>approve|skip)$/;
```

`handleComponent`, in order: **re-check `isAllowed`** on whoever clicked (the button is visible to the
whole channel, and this is the only approval gate in the system) → `deferUpdate()` immediately, since
`submitJob` calls GitHub and can exceed Discord's 3 s window → **claim first** with a guarded
`proposed → creating` update, so a double click updates zero rows and stops (there is no idempotency
key on `POST /internal/jobs`) → create the job with `requestedByDiscordId` set to **the approver, not
the agent** → on success `creating → created`, store the job id, disable that row's buttons and link
the new thread → on `ApiError` revert to `proposed` so it can be retried, surfacing the API's own
message ephemerally (notably the spend-cap refusal).

**Migration needed:** `job_source` is a pgEnum and `createJobRequest.source` is
`z.enum(["discord","dashboard"])`, so `"meeting"` needs `ALTER TYPE job_source ADD VALUE 'meeting'`
plus the zod change. The monthly cap needs no new code — `submitJob` already refuses when
`spent + profile.limits.maxUsd > MONTHLY_LLM_CAP_USD`, which is exactly the wanted behaviour.

---

## 10. Data model

New tables, in the style of `packages/db/src/schema.ts`:

```
meetings            id · short_id (MTG-0007) · status · repo · guild_id · voice_channel_id
                    started_by_discord_id · agent_id · model_primary · model_used
                    context jsonb (briefing snapshot) · discord_forum_thread_id
                    discord_ack_message_id · error · turns · cost_usd · voice_cost_usd
                    started_at · ended_at · cancel_requested_at
                    voice_worker_id · heartbeat_at · created_at
meeting_counters    kind pk · last_value          (job_counters.type is a job_type enum)
meeting_participants  meeting_id fk · discord_user_id · display_name · allowlisted · joined_at · left_at
meeting_turns       id · meeting_id fk · index · role(human|agent|system) · speaker_id
                    text (redacted before insert) · interrupted · stt_confidence
                    audio_ms · latency_ms · created_at
meeting_events      id · meeting_id fk · type · payload jsonb · created_at · notified_at
standups            id · meeting_id fk unique · title · content jsonb · model · cost_usd · created_at
action_items        id · meeting_id fk · status(proposed|creating|created|skipped|expired)
                    kind job_type · repo · summary · description · created_job_id fk
                    approved_by_discord_id · approved_at · created_at
voice_usage         id · meeting_id fk · kind(stt|tts) · vendor · units · cost_usd · created_at
```

### Two accounting problems and their fixes

1. **Meeting LLM spend would be invisible to the cap.** `llm_calls.job_id` is `NOT NULL → jobs.id`
   and `monthSpendUsd` sums `llm_calls`. Make `job_id` nullable, add `meeting_id uuid → meetings.id`,
   and `CHECK ((job_id is null) <> (meeting_id is null))`. **`monthSpendUsd` then needs no change at
   all**, and meeting turns count against the $10 cap automatically — which is right, since a meeting
   that burns the budget must stop the jobs too. One casualty: `costReport.byType` inner-joins `jobs`,
   so meeting rows drop out of that breakdown; add a `byKind` (job vs meeting) split beside it.
2. **Voice vendor spend is a different currency** — audio seconds and characters, not tokens. It goes
   in `voice_usage`, priced from `packages/voice/src/pricing.ts` built like
   `packages/llm/src/pricing.ts` (keyed `vendor:model`, unknown entries charged at a deliberately
   high placeholder so budgets still stop them), and capped separately. Separate because the units
   are unrelated and the failure modes differ: a voice overrun must not block `/task`.

### Retention and redaction

`RETENTION_DAYS` exists in `config.ts`, its test and `ARCHITECTURE.md` §10 — and **nowhere else**.
There is no retention task yet, so M7 ships the one it needs:

- **Raw audio never reaches disk.** PCM goes from Discord to the STT stream and is dropped. Nothing
  to retain, nothing to leak.
- **`meeting_turns` keep `VOICE_TRANSCRIPT_RETENTION_DAYS` (7)** — shorter than everything else,
  because these are recordings of human speech containing things said off-hand that nobody intends to
  keep. `standups` and `action_items` keep the standard 30: the decisions are the durable artefact,
  the verbatim words are not.
- **Redaction before insert**, not after: run each turn through the finalize guardrails' secret
  patterns and replace matches with `[redacted]`. Someone reading an API key aloud is a realistic event.

---

## 11. Discord UX

```ts
const meeting = base("meeting", "Talk to the agent in a voice channel");
meeting.addSubcommand((s) => s.setName("start").setDescription("Join a voice channel and start a meeting")
  .addStringOption((o) => o.setName("repo")
    .setDescription("Exact GitHub repository, e.g. owner/repo").setRequired(true).setMaxLength(140))
  .addChannelOption((o) => o.setName("channel")
    .setDescription("Voice channel (defaults to the one you are in)")
    .addChannelTypes(ChannelType.GuildVoice))   // resolved by apps/voice, not the bot — see below
  .addStringOption((o) => o.setName("agenda").setDescription("What you want to cover").setMaxLength(2000))
  .addStringOption((o) => o.setName("agent")
    .setDescription("Which agent joins (default: the only one)").setMaxLength(40)));
meeting.addSubcommand((s) => s.setName("end").setDescription("Leave the channel and post the standup"));
meeting.addSubcommand((s) => s.setName("cancel").setDescription("Leave without writing a standup"));
meeting.addSubcommand((s) => s.setName("status").setDescription("Show the current meeting"));
```

`repo` is required because `submitJob` cannot create a job without one and the briefing needs it.
`/meeting start` joins the `#create-job` channel restriction — rename the `JOB_COMMANDS` set to
`CHANNEL_RESTRICTED` rather than overloading the job meaning.

**"Defaults to the one you are in" cannot be resolved in `apps/bot`.** `member.voice` reads the
guild voice-state cache, which is only populated for a client holding `GuildVoiceStates` — and per V7
the bot keeps `Guilds` alone. So when `channel` is omitted the API stores a null `voice_channel_id`
and **`apps/voice` resolves the starter's current channel at claim time**, where the intent exists; it
fails the meeting with a spoken-nothing, text-only "you are not in a voice channel" if they have since
left. The alternative is making `channel` required, which is worse UX for the common case.

**On join, before subscribing to anyone**, the agent speaks and the forum post repeats in text: the
meeting is transcribed, the transcript is kept N days, and a standup will be posted in `#responses`.

**Dashboard:** a Meetings list (ID, repo, status, duration, turns, LLM $, voice $, participants) and
a detail page reusing the job-detail timeline (turn-by-turn transcript, barge-in markers, per-turn
latency, the standup, action items with their job links). The Costs page gains a voice series and a
`MONTHLY_VOICE_CAP_USD` gauge beside the LLM one.

**Logging** (pino, `service: "voice"`, child per meeting): join/leave, transitions, per turn
`{ turnIndex, speakerId, sttMs, llmMs, ttsMs, firstAudioMs, interrupted, costUsd }`, barge-ins,
fillers, cap checks, vendor errors and fallbacks, reaper actions, and the `x-region` header
ElevenLabs returns. **Never log transcript text above `debug`**, and redact it there too.

---

## 12. Interfaces and layout

```ts
// packages/voice/src/types.ts
export interface Utterance {
  speakerId: string; text: string;
  startedAt: number; endedAt: number;
  confidence: number | null;
  audioSeconds: number;               // billable, for voice_usage
}

export interface SpeechToText {
  readonly id: string;                                        // "deepgram-flux", "assemblyai"
  open(opts: { speakerId: string; sampleRate: number }): Promise<SttStream>;
}
export interface SttStream {
  write(pcm: Buffer): void;
  close(): Promise<Utterance | null>;                         // null when the audio held no speech
}

export interface TextToSpeech {
  readonly id: string;                                        // "elevenlabs"
  synthesize(opts: { text: string; voiceId: string; signal: AbortSignal }):
    AsyncIterable<Buffer> & { readonly charactersBilled: () => number };
}

export interface VoiceTransport {
  join(opts: {
    guildId: string; channelId: string;
    transcribeSpeakerIds: readonly string[];                  // the consent + injection boundary
  }): Promise<VoiceSession>;
}

export interface VoiceSession {
  readonly channelId: string;
  readonly speaking: boolean;                                 // the floor flag
  utterances(): AsyncIterable<Utterance>;
  onSpeechStart(listener: (speakerId: string) => void): () => void;
  onParticipantChange(listener: (p: { speakerIds: string[] }) => void): () => void;
  speak(text: string, opts?: { voiceId?: string; signal?: AbortSignal }): Promise<SpeechHandle>;
  usage(): { sttAudioSeconds: number; ttsCharacters: number };
  leave(): Promise<void>;
}

export interface SpeechHandle {
  spokenText: string;                 // what actually reached the channel — for history truncation
  cancelled: boolean;
  playbackMs: number;
}
```

| Package | Exports | Depends on |
|---|---|---|
| `packages/voice` | the interfaces above; `ElevenLabsTextToSpeech`, `DeepgramSpeechToText`, `DiscordVoiceTransport`; `FakeVoiceTransport`, `ScriptedSpeechToText`, `RecordingTextToSpeech`; `pricing.ts` | neither `@dca/db` nor `@dca/llm` |
| `packages/meeting` | `MeetingConversation`, `buildBriefing()`, `MEETING_SYSTEM`, `standupSchema`, `MeetingAgentProfile`, `getMeetingAgent()` | `@dca/llm`, `@dca/core` |
| `apps/voice` | the claim loop, the meeting runtime | the only place `@dca/voice`, `@dca/meeting` and `@dca/db` meet |

Rendering goes in `packages/discord-ui`; schema in `packages/db`; statuses and the state machine in
`packages/core`. ElevenLabs appears only as `ElevenLabsTextToSpeech` plus `ELEVENLABS_*` env.

---

## 13. Configuration

```ts
export const voiceEnv = z.object({
  VOICE_ENABLED: z.stringbool().default(false),
  /** Second gateway session; defaults to DISCORD_TOKEN. A separate app if U5 says so. */
  DISCORD_VOICE_TOKEN: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_flash_v2_5"),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_OUTPUT_FORMAT: z.string().default("pcm_48000"),     // U2 fallback: pcm_24000
  STT_PROVIDER: z.enum(["deepgram", "assemblyai", "elevenlabs"]).default("deepgram"),
  DEEPGRAM_API_KEY: z.string().optional(),
  ASSEMBLYAI_API_KEY: z.string().optional(),
  MONTHLY_VOICE_CAP_USD: z.coerce.number().positive().default(5),
  VOICE_MEETING_CAP_USD: z.coerce.number().positive().default(1.5),
  VOICE_IDLE_TIMEOUT_SEC: z.coerce.number().int().positive().default(180),
  VOICE_ALONE_GRACE_SEC: z.coerce.number().int().positive().default(30),
  VOICE_MAX_MEETING_MIN: z.coerce.number().int().positive().default(45),
  VOICE_FILLER_AFTER_MS: z.coerce.number().int().positive().default(700),
  VOICE_TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  VOICE_EOT_THRESHOLD: z.coerce.number().default(0.8),
  VOICE_EAGER_EOT_THRESHOLD: z.coerce.number().default(0.6),
  VOICE_AUTOJOIN_CHANNEL_ID: z.string().default(""),             // empty = /meeting start only
  AGENT_ROSTER: z.string().default(""),                          // JSON; one agent today
});
```

Plus `MODEL_MEETING`, `MODEL_MEETING_FALLBACK` and `MODEL_MEETING_STANDUP`, read exactly as
`getProfile` already reads `MODEL_<TYPE>`.

```ts
// packages/meeting/src/agents.ts — Profile.id is typed JobType, so don't widen Profile
export interface MeetingAgentProfile {
  id: string;                  // "dev"
  version: number;
  displayName: string;         // "Ada" — spoken name and standup byline
  voiceId: string;
  persona: string;             // prepended to MEETING_SYSTEM
  model: { primary: string; fallback?: string };
  standupModel: string;
  limits: { maxMinutes: number; maxUsd: number; standupReserveUsd: number };
}
```

`meetings.agent_id` is already on the row and `speak()` takes a per-utterance `voiceId`, so **N
personas can share one voice connection** — cheap, no extra gateway sessions. N *distinct Discord
identities* (separate avatars in the member list) would need N applications and tokens. Use default
or Instant Voice Clone voices, never Professional, and keep stability/similarity identical across
agents so only timbre differs.

---

## 14. Cost model and caps

Unit prices as published on 2026-10-28; re-check before fixing the cap. Deepgram's streaming prices
are flagged "limited-time promotional" with no end date (Nova-3 shows $0.46/hr struck through
against $0.29), so the STT line could rise ~60%.

| Item | Price |
|---|---|
| ElevenLabs Flash / Turbo TTS | **$0.04 / 1k characters** |
| ElevenLabs v4 / v4 Turbo TTS | $0.08 / 1k characters |
| ElevenLabs **Agents** | **$0.08 / min connected audio** ($4.80/hr), burst $0.16, plus LLM |
| Deepgram Flux (English streaming) | **$0.39/hr** ($0.0065/min) PAYG |
| Deepgram Nova-3 streaming | $0.29/hr PAYG promo |
| AssemblyAI Universal-Streaming | **$0.15/hr**, billed on **websocket session duration** |
| ElevenLabs Scribe v2 batch / realtime | $0.22/hr / $0.39/hr |
| `claude-haiku-4-5` | $1 / $5 per MTok (repo `pricing.ts`) |
| `claude-sonnet-5` | $2 / $10 per MTok |

### One 30-minute meeting

Assumptions, stated so they can be re-run: the agent speaks **35%** of the meeting (10.5 min at
150 wpm ≈ 9,000 characters); the STT socket is open the full 30 minutes (every vendor here bills
wall-clock, and our silence padding is billable audio); **60 turns**; context averaging ~7,700 tokens
per turn with **85% served from the Anthropic prompt cache**; turns on haiku, standup on sonnet.

| Line | Cost |
|---|---|
| TTS — Flash v2.5, 9,000 chars | $0.36 |
| STT — Deepgram Flux, 0.5 hr | $0.195 |
| LLM — 60 turns, haiku, mostly cache reads | $0.14 |
| LLM — standup, sonnet | $0.03 |
| Eager-EOT speculative waste (~20% extra LLM) | $0.03 |
| **Total** | **≈ $0.76** |

AssemblyAI instead of Flux → $0.64. TTS on v4 Turbo → $1.12.

### Four meetings a month

| | Own pipeline (Flux + Flash) | Own pipeline (AssemblyAI) | Managed Agents |
|---|---|---|---|
| Per 30-min meeting | $0.76 | $0.64 | $2.40 + $0.17 own LLM = **$2.57** |
| Four meetings | **$3.04** | **$2.56** | **$10.28** |

**$10.28/month for the managed platform would by itself exceed the project's entire existing $10 LLM
cap.** That is the decisive number behind V1.

### Caps

- **`MONTHLY_VOICE_CAP_USD = 5.00`** over **metered** spend (TTS characters + STT seconds), checked
  before opening the STT socket and re-checked every turn, exactly like the LLM cap.
- **`VOICE_MEETING_CAP_USD = 1.50`** per meeting, mirroring the $2 `/task` cap.
- **Meeting LLM spend stays inside the existing `$10`** cap and the existing `llm_calls` accounting
  (§10).
- **Any ElevenLabs subscription is a fixed monthly cost outside the cap.** Under U4 scenario (ii) the
  floor is Starter $6/mo, whose included characters cover ~16 meetings and *replace* the metered TTS
  line. Counting it inside a $5 cap would break the cap on day one with zero usage.
- Total: **$10 LLM + $5 metered voice = $15/month**, or $21 under U4 (ii) — marginally over the
  project's <$20 infra intent, so either drop the voice cap to $4 or accept it knowingly.

**Failure handling degrades to text, never to silence.** TTS fails mid-turn → finish the turn as text
in the thread, speak one cached line ("I've put that in the thread"), keep going; three consecutive
failures → announce text-only mode. STT fails → fatal to voice: announce, leave, invite `/task`; do
**not** sit silently in the channel. LLM fails → the existing `isProviderOutage` fallback path, with a
filler while it switches. And **write the transcript and standup to the thread incrementally**, so the
meeting's value survives a crash and the feature stays useful even when voice is broken.

One concurrent TTS stream is all a meeting needs, so even the free tier's 4 Flash slots suffice.
**UNVERIFIED:** websocket-specific rate limits and 429 behaviour are undocumented — handle 429 and
abrupt socket close defensively regardless.

---

## 15. Privacy, consent and the injection boundary

| Control | Rule |
|---|---|
| Who is transcribed | Allowlisted speakers only, passed to `VoiceTransport.join`. Everyone else's audio is discarded undecoded. Role allowlists need a `guild.members.fetch()` at join to expand `ALLOWED_ROLE_IDS`. |
| Why that matters twice | It is the privacy rule **and** the prompt-injection boundary: an unapproved guest must not be able to talk the agent into queueing a job. |
| Announcement | Spoken aloud before subscribing to anyone, and repeated in the forum post. |
| Raw audio | Never written to disk; dropped the moment STT returns. |
| Transcripts | Redacted for secrets before insert, kept 7 days. |
| Non-allowlisted participants | Recorded in `meeting_participants` with `allowlisted: false`; the briefing tells the agent others are present and not transcribed. |
| Opt-out | `/meeting cancel` and `/meeting end` both leave immediately. |
| Training | Captured audio and transcripts are never used for training. |
| Policy | U7 — a human must read the current Discord Developer Policy before this goes beyond the owner's own guild. The archived 2017 terms treat voice data as End User Data requiring express permission and deletion on request; US all-party-consent states and GDPR Art. 6 apply regardless of what Discord says. |

Single owner, self-hosted, own guild: the consent story is genuinely simple. Keep it that way by
never widening the allowlist casually.

---

## 16. Infrastructure

- **`Dockerfile`** — the `deps` stage copies each `package.json` by hand, so add `apps/voice/`,
  `packages/voice/` and `packages/meeting/` or the install silently misses them. With `opusscript`
  (V8) **no toolchain and no `allowBuilds` entry are needed**; with native opus, add
  `python3 make g++` to `deps` only *and* `"@discordjs/opus": true` to `allowBuilds`.
- **`compose.prod.yml`** — a new `voice` service on the `x-app` anchor,
  `command: ["node_modules/.bin/tsx", "apps/voice/src/main.ts"]`, `mem_limit: 1g` (PCM buffers plus a
  WASM opus module; the bot's 512m is not enough), **no docker socket**, and an explicit
  `environment:` list rather than `env_file: ../.env` so it never receives `GITHUB_BOT_TOKEN`.
- **Networking needs no changes.** gVisor is only used for sandbox containers, so voice UDP runs on
  plain `runc`; the bot is on the default bridge, so outbound UDP is NATed with conntrack and return
  traffic is automatic (`network_mode: host` is unnecessary and would cost the compose DNS names);
  `setup-oracle.sh` only touches `INPUT` and OCI's default security list allows all stateful egress.
  The Squid allowlist is HTTP-only and is not and cannot be in this path.
- **CPU on 2 cores.** A live meeting is the only interactive workload in the system, and a job that
  takes 20 minutes can take 21. The send path is a global 20 ms dispatcher, so an event-loop stall is
  audible stutter. Give `voice` a `cpu_shares` above the worker's; for M7 document that the owner runs
  with `SANDBOX_CPUS=1` during meetings, and make the worker claim at most one job while a meeting is
  `active` in M7.7.
- **Startup self-check** — log `generateDependencyReport()` and the DAVE max protocol version, so a
  missing native module is a loud boot failure rather than a silent "Could not find an Opus module!".
- **Stay on Node 22 and Debian bookworm.** `@discordjs/voice@1.0.0-dev` already requires Node ≥24.17
  and there are no opus prebuilds past ABI 127; `opusscript` makes that a non-event.

---

## 17. Testing

No Discord gateway and no real voice connection anywhere in CI.

| Unit | How |
|---|---|
| `MeetingConversation` | the `scripted()` fake `StepModel` from `loop.test.ts`, lifted into a shared helper. One call per utterance; text-only replies trip nothing; merged utterances; compaction; `beforeTurn` stop honoured |
| Barge-in | `FakeVoiceTransport` whose `speak()` resolves after a controllable delay; fire `onSpeechStart` mid-synthesis. Assert the signal aborted, `SpeechHandle.cancelled`, the turn persisted `interrupted` with partial `spokenText`, and an estimated-cost `llm_calls` row written |
| Floor control | utterances at fixed offsets while `speaking` is true: no overlapping `speak()`, queued utterances merge |
| STT / TTS | `ScriptedSpeechToText` over JSON fixtures (`{ speakerId, text, startedAt, endedAt, audioSeconds }`) — recorded transcripts, **no audio files in git**. `RecordingTextToSpeech` captures requested text and `charactersBilled`. Real vendor calls behind `describe.skipIf(!process.env.ELEVENLABS_API_KEY)`, not in CI |
| State machine | pure table test over `MEETING_STATUSES`, mirroring `state-machine.test.ts` |
| Lifecycle | Postgres + `FakeVoiceTransport` + scripted model through the claim loop: exclusive claim under two claimers; idle and alone both produce a standup; cancel does not; a killed claimer is reaped and the worker finishes the standup from persisted turns |
| `MeetingNotifier` | `FakeMeetingPublisher` copied from `FakePublisher`: outbox ordering, retry on a thrown Discord error, give-up window, single-flight `ensurePost` |
| Buttons | fake interaction + fake `ApiClient`: non-allowlisted click refused, double click creates one job, `spend_cap_reached` reverts to `proposed` |
| Spend | `monthSpendUsd` counts a meeting row with a null `job_id`; the `CHECK` rejects both-or-neither; unknown voice vendors charge the placeholder rate |
| Chunking | the guard cases: backticks, `v2.5`, `e.g.`, fenced code → spoken summary |
| Redaction | a turn containing a fake GitHub token stores `[redacted]` |

---

## 18. Milestones

| M | Scope | Done when |
|---|---|---|
| **M7.0** | **Spike, before anything is designed further.** Join a real voice channel from the arm64 host with `debug: true`, both join orders, owner speaking immediately; grep for `Failed to decrypt`. Probe ElevenLabs output format with one curl (U3) and `pcm_48000` tier (U2). Confirm `opusscript` works through prism-media's loader. Check two gateway sessions on one token (U5). Time-box: one session | A human sentence spoken in Discord comes out of the arm64 host as decodable PCM **with the patch applied and the owner already sitting in the channel before the bot joins** — the easy join order proves nothing (§3.1) — and the ElevenLabs format question is answered. **If receive fails, stop and reconsider**: the mic-page escape hatch changes the architecture, not just the schedule |
| **M7.1** | `packages/core` statuses + state machine + counter; the Drizzle tables; `llm_calls.job_id` nullable + `meeting_id` + `CHECK`; `job_source` gains `meeting`; queries (`createMeeting`, `claimNextMeeting`, `transitionMeeting`, `recordTurn`, `fetchPendingMeetingEvents`) | `pnpm test` green, migrations run, `monthSpendUsd` counts a meeting LLM row |
| **M7.2** | **Text-in / voice-out.** `StepModel.stream()` (V13); `packages/meeting` conversation loop; `packages/voice` interfaces + `ElevenLabsTextToSpeech` + sentence chunker; `apps/voice` joins on `/meeting start` and speaks replies to text typed in the forum thread. No STT | The owner types in the thread and hears a spoken reply in the voice channel, with turns in `meeting_turns` and an LLM row against the meeting |
| **M7.3** | **Standup end to end.** `summarize()`, `standups`, the `meeting_events` outbox, `MeetingNotifier` + `MeetingPublisher`, the `meeting` tag, `standupEmbed`, `/meeting end` and `/meeting cancel` | `/meeting end` posts the standup in the meeting's `#responses` thread, and nothing is posted to Discord from `apps/voice` |
| **M7.4** | **Voice in.** `DiscordVoiceTransport` receive path with the DAVE patch, allowlisted-speaker filter, **silence padding** and stream-boundary debounce, Flux end-of-turn, consent line, `voice_usage` + both voice caps | A spoken sentence gets a spoken reply; a non-allowlisted guest is not transcribed; voice cost lands on the meeting row |
| **M7.5** | **Full duplex.** Barge-in (stop + abort + alignment-based history truncation + estimated cost), eager-EOT with buffered audio, floor control and utterance merging, cached fillers, `firstAudioMs` instrumentation | Interrupting mid-sentence stops the agent within ~300 ms, its next reply acknowledges the interruption rather than repeating, and `firstAudioMs` p50/p95 are recorded on the Ampere host |
| **M7.6** | **Action items → jobs.** `note_action_item`, standup buttons, `handleComponent` with allowlist re-check and claim-first, `source: "meeting"`, cap handling | Clicking **Create BUG** opens a real `BUG-00xx`; a second click creates nothing; at the cap the item stays `proposed` with the cap message |
| **M7.7** | **Resilience and ops.** Idle / alone / max-duration timeouts, heartbeat + reaper in `apps/voice` with the worker backstop, standup budget reserve, transcript redaction + the retention task, meeting concurrency throttle, dashboard Meetings pages, compose + Dockerfile | Killing `apps/voice` mid-meeting still yields a standup from persisted turns; a 7-day-old transcript is gone while its standup remains; a meeting stays responsive while two jobs run |

M7.2 is the smallest thing that proves the loop: it exercises the conversation layer, the LLM
streaming wiring, cost accounting against a meeting, the voice connection and ElevenLabs — while
leaving STT, barge-in and floor control out, so a failure has one obvious cause.

---

## 19. Open risks, ranked

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **DAVE decrypt never recovers after an MLS welcome at transition 0** (#11653, open, confirmed present in 0.19.2's shipped `.mjs`) — and it fires on the bot joining a channel the owner is already in, i.e. every meeting we will run | **High**, certain on that flow | `pnpm patch` **both** changes (§3.1), of which **the second is an untested hypothesis of ours, not an upstream fix** — M7.0 must prove it. Subscribe to one user so the session-wide failure counter cannot be poisoned. Re-subscribe on stream `error` with backoff. Bot-joining-first is anecdotal, not a fix. **Never** `daveEncryption: false` |
| 2 | **Receive is unsupported by contract** — "not documented by Discord so stable support is not guaranteed"; two of four receive issues closed `not_planned` | **High**, low probability per quarter | Keep STT behind the interface so the owner's audio can come from a mic page instead (§3.1). Pin `@discordjs/voice` to exactly 0.19.2. Alert on `Failed to decrypt` debug lines |
| 3 | **Silence padding** — forward nothing during Discord's packet gaps and Flux's end-of-turn may never fire; the pipeline looks built and never answers | **High**, certain if missed | Real-time zero-PCM padding, plus a watchdog that force-ends a turn if no Flux event arrives within `eot_timeout_ms + 1 s` |
| 4 | **Barge-in history truncation** — the agent referencing sentences the owner never heard | High for perceived quality | Truncate with ElevenLabs per-character `alignment` against elapsed playback; test over recorded alignment fixtures. Buffer eager-EOT audio until `EndOfTurn` |
| 5 | **`@discordjs/opus` has no glibc-2.36 prebuild** and node-pre-gyp matches libc verbatim → source build → fails on `bookworm-slim` | High, certain | `opusscript` (V8). If native is needed: toolchain in `deps` **and** the `allowBuilds` entry |
| 6 | **`EndBehaviorType` fires mid-sentence** (#8105, open since 2022) → chopped transcripts | Medium | Treat stream `end` as a hint; debounce 800–1200 ms per speaker |
| 7 | **Flux accuracy on technical speech is contested** (U6) | Medium | A/B against AssemblyAI on 10 minutes of the owner's real speech; both behind `SpeechToText` |
| 8 | **2 vCPUs are already busy** — Opus codec, resampling, two websockets and a streaming LLM loop alongside Postgres, four services and sandboxes; a 20 ms dispatcher stall is audible | Medium | Own process with `cpu_shares` priority, `mem_limit: 1g`, no local STT or VAD models, one job at a time during meetings |
| 9 | **Billed silence** — every STT vendor bills wall-clock, and AssemblyAI bills session duration. A bot left in an empty channel burns money | Medium | The 45-minute cap and the alone-in-channel auto-disconnect |
| 10 | **`selfDeaf` defaults to `true`** → a clean connection and total silence | Low, but a guaranteed day-one bug | `selfDeaf: false` in V6; assert it in the join helper |
| 11 | **Free-tier overage behaviour** decides whether fixed cost is $0 or $6/mo (U4) | Low | Caps over metered spend only; subscription as a separate line |
| 12 | **N named agents may need N applications** — one bot user likely holds one voice connection per guild (UNVERIFIED) | Low now, design-shaping | The voice process takes its token and identity from config, so a second agent is a second container, not a refactor |
| 13 | **4017 reconnect loop** if DAVE is disabled or `@snazzah/davey` fails to load (the library does not special-case 4017) | Low — the arm64 prebuild exists | An explicit 4017 handler that destroys and reports; `generateDependencyReport()` at boot |

---

## 20. Questions for the owner

1. **One Discord identity or several?** N named agents with their own avatars in the member list need
   N bot applications and tokens. Sharing one identity with per-utterance voices is free today.
2. **Auto-join?** `/meeting start` is recommended — it keeps the allowlist and channel restriction and
   makes the cost moment explicit. Auto-join on entering a designated channel gives both up.
3. **Voice budget.** `MONTHLY_VOICE_CAP_USD = 5` covers four 30-minute meetings with ~60% headroom.
   How many meetings a week, and how long?
4. **Transcript retention.** 7 days for verbatim turns and 30 for standups — or shorter? Should
   `/meeting cancel` delete the transcript immediately rather than wait for the retention task?
5. **Guests.** Non-allowlisted people in the channel are currently not transcribed at all, so the
   agent half-hears the room. Acceptable, or should it refuse to join when one is present?
6. **Action items.** Should the standup hand you a one-click pre-filled job, or a `/task` draft to
   edit before submitting?
7. **Standup destination.** `#responses` beside the jobs (reuses the whole notifier path), or a
   separate `#standups` forum (keeps job noise out of the morning read)?

---

## 21. Sources

Checked 2026-10-28. Prices and model names change — and §14's Deepgram figures are explicitly
promotional — so re-read these before fixing a cap or pinning a model.

**Discord voice and the DAVE question**
- `@discordjs/voice@0.19.2` — <https://registry.npmjs.org/@discordjs/voice> (the shipped
  `dist/index.js` and `dist/index.mjs` were read directly for the DAVE and receiver behaviour in §3.1)
- Voice connections · <https://docs.discord.com/developers/topics/voice-connections>
- Close codes, incl. 4017 · <https://docs.discord.com/developers/topics/opcodes-and-status-codes>
- Gateway intents · <https://docs.discord.com/developers/topics/gateway#gateway-intents>
- Permissions · <https://docs.discord.com/developers/topics/permissions>
- **#11653** DAVE decrypt never recovers after a welcome at transition 0 (**open**) ·
  <https://github.com/discordjs/discord.js/issues/11653>
- #11419 reconnect loops + zero capture (fixed by PR #11449, in 0.19.2) ·
  <https://github.com/discordjs/discord.js/issues/11419> ·
  <https://github.com/discordjs/discord.js/pull/11449>
- #11445 `UnencryptedWhenPassthroughDisabled` (closed `not_planned`) ·
  <https://github.com/discordjs/discord.js/issues/11445>
- #11441 MLS-transition packet loss (closed `not_planned`; treat its 34% figure as unsubstantiated) ·
  <https://github.com/discordjs/discord.js/issues/11441>
- #8105 `EndBehaviorType` ends mid-utterance (**open since 2022**) ·
  <https://github.com/discordjs/discord.js/issues/8105>
- PR #11385 "Always install Davey as DAVE is becoming required" ·
  <https://github.com/discordjs/discord.js/pull/11385>
- voice CHANGELOG · <https://raw.githubusercontent.com/discordjs/discord.js/main/packages/voice/CHANGELOG.md>

**Opus packaging (§3.2)**
- `@discordjs/opus` v0.10.0 prebuild asset list ·
  <https://api.github.com/repos/discordjs/opus/releases/tags/v0.10.0>
- `@discordjs/node-pre-gyp@0.4.5` `lib/util/versioning.js` — verbatim libc matching, read from the
  tarball
- Node ABI registry (22 → 127) ·
  <https://raw.githubusercontent.com/nodejs/node/main/doc/abi_version_registry.json>
- `prism-media` opus loader order ·
  <https://raw.githubusercontent.com/amishshah/prism-media/master/src/opus/Opus.js>

**ElevenLabs**
- Models · <https://elevenlabs.io/docs/models>
- Latency optimization (TTFB figures, PVC caveat) ·
  <https://elevenlabs.io/docs/best-practices/latency-optimization>
- Websocket `stream-input` reference ·
  <https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input>
- HTTP stream reference, incl. output formats and the deprecated `optimize_streaming_latency` ·
  <https://elevenlabs.io/docs/api-reference/text-to-speech/stream>
- Supported audio formats (the tier ambiguity in U2) ·
  <https://elevenlabs.io/docs/help-center/troubleshooting/what-audio-formats-do-you-support.md>
- API pricing, incl. Agents at $0.08/min · <https://elevenlabs.io/pricing/api>
- Concurrency limits · <https://elevenlabs.io/docs/help-center/technical/how-many-text-to-speech-requests-can-i-make-and-can-i-increase-it.md>
- Agents overview and websocket transport · <https://elevenlabs.io/docs/agents-platform/overview> ·
  <https://elevenlabs.io/docs/agents-platform/libraries/web-sockets>
- Custom LLM endpoint · <https://elevenlabs.io/docs/agents-platform/customization/llm/custom-llm>
- Node SDK `@elevenlabs/elevenlabs-js` 2.75.0 · <https://registry.npmjs.org/@elevenlabs/elevenlabs-js>

**Speech-to-text**
- Deepgram Flux configuration (`eot_threshold`, `eot_timeout_ms`, `eager_eot_threshold`) ·
  <https://developers.deepgram.com/docs/flux/configuration>
- Deepgram Flux turn state machine · <https://developers.deepgram.com/docs/flux/state>
- Deepgram pricing · <https://deepgram.com/pricing>
- AssemblyAI pricing (session-duration billing) · <https://www.assemblyai.com/pricing>
- OpenAI `gpt-realtime-whisper` · <https://developers.openai.com/api/docs/models/gpt-realtime-whisper.md>
- whisper.cpp on arm64, the RTF reference behind V10 ·
  <https://turingpi.com/whisper-cpp-piper-tts-arm64-turing-pi-rk3588/>

**Other**
- Turn-gap research cited in §5.1 — Stivers et al., *Universals and cultural variation in turn-taking
  in conversation*, PNAS 106(26):10587–10592, 2009 · <https://doi.org/10.1073/pnas.0903616106>
- OCI default security list (stateful egress, §16) ·
  <https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm>
- Discord Developer Policy — **could not be retrieved (HTTP 403 to automated fetches); U7 needs a
  human** · <https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy>
- This repository: `apps/bot/src/main.ts`, `packages/llm/src/step.ts`, `packages/agent/src/loop.ts`,
  `packages/db/src/schema.ts`, `packages/db/src/queries.ts`, `packages/core/src/config.ts`,
  `pnpm-workspace.yaml`, `Dockerfile`, `infra/compose.prod.yml`, `infra/scripts/setup-oracle.sh`
