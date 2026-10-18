# ARRC

**Call a phone number, speak in Hindi, English, Telugu or any mix, and your laptop does it. And when something needs you, ARRC calls you.**

ARRC is a phone-line assistant for your own computer, built on Sarvam AI. A Sarvam Voice Agent answers an Indian phone number: **Saaras** listens, **Sarvam-105B** decides what to do, **Bulbul** speaks back. When you ask for something, the agent calls a small action server on your laptop through a secure tunnel, and the laptop does it. The same server keeps watch, and when a deadline is close or your battery is about to die, it phones you through Sarvam's outbound call API.

```
                 ┌──────────── you call ARRC ────────────┐
Your phone ◀────▶ Sarvam number ◀──▶ Sarvam Voice Agent (Saaras · Sarvam-105B · Bulbul)
     ▲                                     │ HTTPS tool call: Bearer token + caller number
     │                                     ▼
     │                cloudflared tunnel ──▶ server.js on your laptop ──▶ fixed list of actions
     │                                               │
     └──── ARRC calls you (Sarvam outbound API) ◀────┤ monitor: deadlines, battery, focus timer
                                                     └─▶ ARRC console (localhost only)
```

## The two things that matter

**1. Find my file.** "Mera EM5120 assignment kholo." ARRC searches your Desktop, Documents, Downloads and OneDrive, opens the best match on screen and tells you which file it is and when it was last edited. Course codes have to match exactly, so "EM5120" never opens your SE5723 report by mistake. The index of about 14,000 files builds in the background in under 3 seconds and refreshes every 10 minutes.

**2. Focus session.** "25 minute focus session for my DBMS assignment." ARRC opens that assignment, starts focus music and runs the timer. When time is up the laptop says so out loud and ARRC phones you.

## ARRC calls you

Tell ARRC on a call, "remind me, DBMS project due tomorrow 5 pm", or add it on the console. ARRC then phones you:

- 24 hours, 3 hours, 1 hour and 15 minutes before it's due
- at the due time, if it still isn't marked submitted ("This is urgent, please take a look")
- when your laptop battery drops to 15% while unplugged
- when a focus session ends

Say "submitted" on any call and the reminders for that deadline stop. Guard rails: at most one call every 10 minutes and 8 a day, and no calls between 11 pm and 7 am unless something is due within 2 hours.

## Everything you can say

| Say | ARRC does |
|---|---|
| "Mera EM5120 assignment kholo" | Finds and opens the file |
| "25 minute focus session for my assignment" | File, focus music, timer, then calls you |
| "Remind me, DBMS project due tomorrow 5 pm" | Saves the deadline and calls you before it |
| "What's due?" / "DBMS submitted" | Reads deadlines / stops the reminders |
| "YouTube pe Arijit Singh ke gaane chalao" | Finds and plays it |
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

22 actions in total. See `ACTIONS` in [server.js](server.js), [files.js](files.js) for file search and [monitor.js](monitor.js) for deadlines and outbound calls.

## Safety model

A phone line that controls a computer has to be locked down. ARRC:

- **Runs only a fixed allowlist of actions.** No shell commands, no file deletion, no keystroke typing of caller text, no sending of messages or payments.
- **Only opens documents.** File search indexes document and media types (PDF, Office, text, images, video). Programs and scripts are never indexed, so they can never be opened by voice.
- **Never puts caller text on a command line.** Text that must reach PowerShell (words to speak, a screenshot path) travels in environment variables and is only spoken or saved, never executed.
- **Requires a secret bearer token** on every tool call (constant-time comparison).
- **Only obeys the owner's phone.** The server checks the caller against the owner's number. Other callers get "Not authorised" and the agent ends the call.
- **Keeps the console private.** Anything arriving through the tunnel can reach only the authenticated `/action` endpoint. The console, activity feed, deadlines and test-call button answer on localhost only.
- **De-duplicates bursts.** The same request repeated within 10 seconds runs once.
- **Doesn't nag.** Outbound calls are rate-limited and respect quiet hours.

## Run it

Windows, Node 18+, [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```bash
cp .env.example .env      # set JARVIS_TOKEN (random), OWNER_NUMBER and the Sarvam outbound values
node server.js
```

```bash
cloudflared tunnel --url http://localhost:3710
```

Open http://localhost:3710 for the ARRC console. Then set up the Sarvam agent and tool with the tunnel URL: step-by-step in [AGENT-SETUP.md](AGENT-SETUP.md).

For outbound calls, get the org and workspace IDs from **Voice Agents → Settings → API Key** in Indus, create an API key on the same page, and put all three in `.env`. Without them ARRC runs in dry-run mode and logs the calls it would have made.

A quick tunnel gets a new address whenever the laptop sleeps or restarts, so update the tool URL in Sarvam when that happens, or use a named Cloudflare tunnel for a fixed address.

## Next

- **Urgent-email alerts:** read new Gmail, let Sarvam-105B judge tone and urgency, and call the owner about the ones that matter.
- **Send email with spoken confirmation:** ARRC reads the email back on the call and sends only after a clear yes.
- **Calendar-aware calls:** read the owner's calendar and call before exams and meetings.

Built for the Sarvam AI hackathon, October 2026.
