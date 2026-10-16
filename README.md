# ARRC

**Call a phone number, speak in Hindi, English, Telugu or any mix, and your laptop does it.**

ARRC is a phone-line assistant for your own computer, built on Sarvam AI. A Sarvam Voice Agent answers an Indian phone number: **Saaras** listens, **Sarvam-105B** decides what to do, **Bulbul** speaks back. When you ask for something, the agent calls a small action server on your laptop through a secure tunnel, and the laptop does it.

```
Your phone ──call──▶ Sarvam number ──▶ Sarvam Voice Agent (Saaras · Sarvam-105B · Bulbul)
                                              │ HTTPS tool call: Bearer token + hashed caller id
                                              ▼
                       cloudflared tunnel ──▶ server.js on your laptop ──▶ fixed list of actions
                                                        │
                                                        └─▶ ARRC console (localhost only)
```

## What you can say

| Say | ARRC does |
|---|---|
| "YouTube pe Arijit Singh chalao" | Finds and plays it |
| "IRCTC kholo" / "open Gmail" | Opens the site |
| "Work mode on karo" | Opens VS Code, Gmail and Calendar |
| "5 minute ka timer lagao chai ke liye" | Sets a timer the laptop announces out loud |
| "Laptop se bolo, hello judges" | The laptop speakers say it |
| "Volume kam karo" / "next song" | Media keys |
| "Take a screenshot" | Saved to Pictures/Jarvis |
| "Draft an email to … about …" | Opens a Gmail draft. Never sends it |
| "Directions to Charminar" / "weather in Hyderabad" | Maps / weather on screen |
| "Note karo …" / "mere notes padho" | Saves and reads back notes |
| "Battery kitni hai?" | Time, date and battery |
| "Lock my laptop" | Asks first, then locks |

17 actions in total. See `ACTIONS` in [server.js](server.js).

## Safety model

A phone line that controls a computer has to be locked down. ARRC:

- **Runs only a fixed allowlist of actions.** No shell commands, no file deletion, no keystroke typing of caller text, no sending of messages or payments.
- **Never puts caller text on a command line.** Text that must reach PowerShell (words to speak, a screenshot path) travels in environment variables and is only spoken or saved, never executed.
- **Requires a secret bearer token** on every tool call (constant-time comparison).
- **Only obeys the owner's phone.** Sarvam passes a hashed caller id; the server matches it against the owner's number. Other callers get "Not authorised" and the agent ends the call.
- **Keeps the console private.** Anything arriving through the tunnel can reach only the authenticated `/action` endpoint; the live console and activity feed answer on localhost only.
- **De-duplicates bursts.** The same request repeated within 10 seconds runs once.

## Run it

Windows, Node 18+, [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```bash
cp .env.example .env      # set JARVIS_TOKEN (random) and OWNER_NUMBER
node server.js
```

```bash
cloudflared tunnel --url http://localhost:3710
```

Open http://localhost:3710 for the ARRC console. Then set up the Sarvam agent and tool with the tunnel URL: step-by-step in [AGENT-SETUP.md](AGENT-SETUP.md).

## Roadmap

- **Deadline call-backs:** ARRC calls *you* 24h, 3h, 1h and 15 min before an assignment is due (Sarvam instant outbound API).
- **Urgent-email alerts:** read new Gmail, let Sarvam-105B judge tone and urgency, and call the owner about the ones that matter.
- **Send email with spoken confirmation:** ARRC reads the email back on the call and sends only after a clear yes.

Built for the Sarvam AI hackathon, October 2026.
