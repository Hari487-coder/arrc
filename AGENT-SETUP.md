# Jarvis Phone: Sarvam agent setup

Call your rented Sarvam number, talk in Hindi, English, Telugu or a mix, and the agent does things on your laptop.

```
Your phone ──call──▶ Sarvam number (Vobiz) ──▶ Sarvam Voice Agent
                                                 Saaras listens · Sarvam-105B decides · Bulbul speaks
                                                        │ HTTPS tool call (Bearer token + caller number)
                                                        ▼
                                  cloudflared tunnel ──▶ jarvis-phone/server.js on the laptop
                                                          fixed allowlist of actions, live log at :3710
```

## 1. Run the laptop side

```bash
node jarvis-phone/server.js
```

```bash
cloudflared tunnel --url http://localhost:3710
```

cloudflared prints a `https://<random>.trycloudflare.com` address. That is `TUNNEL` below. Open http://localhost:3710 to watch actions arrive live (good for the demo video).

Before going live, set `OWNER_NUMBER` in `jarvis-phone/.env` to your mobile (e.g. `919876543210`). Calls from any other number are refused.

## 2. Agent (indus.sarvam.ai → Build → Agents → Create from Scratch)

**Name:** Jarvis

**Greeting:** `Hi, Jarvis here. What should I do on your laptop?`

**Settings → Language personalisation:** starting language English, *Switch language during call* ON, allow Hindi, English, Telugu, Tamil, Kannada (add more if you like).

**Instructions (system prompt):**

```
You are Jarvis, a personal assistant who controls the owner's laptop over a phone call.
The owner speaks Hindi, English, Telugu or a mix. Always reply in the language they used last, in short spoken sentences.

You can do ONLY these things, each through its tool:
- open_website: open a website by name or address (YouTube, Gmail, IRCTC, any site)
- web_search: search Google for something and show the results on screen
- play_youtube: play a song or video on YouTube
- open_app: open an app (notepad, calculator, chrome, vs code, file explorer, downloads, paint, camera, settings, task manager, word, excel, powerpoint)
- take_note: write down a note or reminder the owner dictates
- read_notes: read the owner's latest notes aloud
- show_notes: open the notes file on screen
- system_status: tell the time, date and laptop battery
- lock_screen: lock the laptop. Always ask "Should I lock it?" and only call the tool after a clear yes.

Rules:
- When the owner asks for one of these, call the tool straight away. Do not ask for confirmation except for lock_screen.
- Pass the owner's words for the thing to open, search, play or note as the tool input, translated to English when it is a search or a song name.
- Only say something is done after the tool replies. Speak the tool's reply in the owner's language.
- If the tool says "Not authorised", say: "Sorry, I can only take orders from my owner's phone." and end the call.
- If asked to do anything else (send messages, pay, delete files, run commands), say you can't do that yet.
- Keep every reply under two sentences. No lists, no markdown.
```

## 3. Tools (Build → Tools → API tool), one per action

Create these 9 tools. They are identical apart from **Name**, **Description**, the URL ending, and whether they need an input.

Common settings for every tool:
- **Method:** POST
- **URL:** `TUNNEL/tools/<name>` (e.g. `https://abc-def.trycloudflare.com/tools/play_youtube`)
- **Auth:** Bearer token. Store the value of `JARVIS_TOKEN` from `jarvis-phone/.env` in Secrets and pick it here.
- **Headers:** `Content-Type: application/json`
- **Body:** `{"input": "<what the owner asked for>", "caller": "@User Identifier"}` (type `@` and pick *User Identifier* for the caller field; map `input` to the LLM-filled parameter)
- **Response template:** `{{result}}`
- **Max wait:** 10s. **If it fails:** `Sorry, I couldn't reach your laptop.`

| Name | Description (what the LLM sees) | Input |
|---|---|---|
| `open_website` | Open a website on the owner's laptop. Input: site name or address, e.g. "youtube", "irctc.co.in". | site |
| `web_search` | Search Google on the laptop and show results. Input: the search query in English. | query |
| `play_youtube` | Play a song or video on YouTube on the laptop. Input: song or video name in English. | query |
| `open_app` | Open an app on the laptop. Input: app name, e.g. "notepad", "calculator", "vs code". | app name |
| `take_note` | Save a note or reminder the owner dictates. Input: the note text. | note |
| `read_notes` | Read back the owner's latest notes. No input. | none |
| `show_notes` | Open the notes file on the laptop screen. No input. | none |
| `system_status` | Get the time, date and laptop battery. No input. | none |
| `lock_screen` | Lock the laptop. Only after the owner says yes. No input. | none |

The server accepts the input under any of `input`, `query`, `text`, `name`, `url`, `app`, `note`, so whatever field name the dashboard uses for the LLM parameter will work. The caller number is read from `caller`, `user_identifier`, or an `X-Caller` header.

## 4. Deploy

Deploy → Phone Numbers → your Sarvam Vobiz number → assign to **Jarvis** under Inbound Calls. Call it.

## Demo lines to try

- "Jarvis, YouTube pe Arijit Singh ka Tum Hi Ho chalao" → plays it
- "IRCTC kholo" → opens IRCTC
- "Note karo, kal subah 10 baje Anthony ko call karna hai" → note saved
- "Mere notes padho" → reads them back
- "Battery kitni hai?" → time + battery
- "Lock my laptop" → asks, then locks
- Call from another phone → "Sorry, I can only take orders from my owner's phone."
