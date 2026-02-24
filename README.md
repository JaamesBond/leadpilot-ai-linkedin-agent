# LeadPilot AI — LinkedIn Sales Agent Chrome Extension

A white-label Chrome extension that automates LinkedIn outreach and lead qualification using Claude AI. Create campaigns, import leads, send personalized initial messages, and let AI handle follow-up conversations to qualify prospects.

## Features

- **Campaign Management** — Create multiple outreach campaigns with custom templates and AI personas
- **Lead Import** — Add leads via LinkedIn URLs or Name/Company/Title format
- **AI-Powered Conversations** — Claude handles follow-up replies, asks qualifying questions, and scores leads
- **Human-in-the-Loop** — Optional review & edit of every message before sending
- **Auto Follow-ups** — Configurable delay and max follow-ups for non-responsive leads
- **Lead Qualification** — AI determines qualified/disqualified based on your criteria
- **Safety Controls** — Random delays, daily limits, anti-detection measures
- **White-Label Ready** — Custom brand name and accent color via settings

## Architecture

```
linkedin-ai-agent/
├── manifest.json          # Chrome Extension manifest v3
├── icons/                 # Extension icons (16, 48, 128px)
└── src/
    ├── popup.html         # Extension popup UI
    ├── popup.css          # Dark-themed UI styles
    ├── popup.js           # UI logic, state management, campaign CRUD
    ├── background.js      # Service worker: orchestration, AI calls, scheduling
    ├── content.js         # LinkedIn DOM interaction (send/read messages)
    └── content.css        # Minimal LinkedIn overlay styles
```

### How It Works

1. **popup.js** manages the UI and persists state to `chrome.storage.local`
2. **background.js** runs a periodic tick (alarm-based) that:
   - Picks the next pending lead from an active campaign
   - Personalizes the message template with lead variables
   - Sends it to the content script (or queues for human review)
   - Periodically checks for replies via the content script
   - When a reply is detected, calls Claude API to generate a contextual response
   - Tracks qualification status based on AI analysis
3. **content.js** interacts with LinkedIn's messaging DOM to:
   - Open conversations with specific people
   - Type and send messages
   - Detect unread replies from tracked leads
   - Scrape profile information

## Setup

### 1. Install the Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `linkedin-ai-agent` folder

### 2. Configure Settings

1. Click the extension icon in Chrome toolbar
2. Click the ⚙ gear icon to open Settings
3. Enter your **Anthropic API Key** (`sk-ant-...`)
4. Choose your model (Sonnet 4 recommended for quality, Haiku 4.5 for speed)
5. Optionally set your brand name and color
6. Configure safety settings (human review, delays, daily limits)

### 3. Create a Campaign

1. Go to the **Campaigns** tab
2. Click **+ New**
3. Fill in:
   - **Campaign Name** — descriptive label
   - **Initial Message Template** — use `{{firstName}}`, `{{lastName}}`, `{{company}}`, `{{title}}` as variables
   - **AI Agent Persona** — instructions for how the AI should behave in follow-ups
   - **Qualification Criteria** — what makes a lead qualified
   - **Follow-up Settings** — delay hours and max attempts

### 4. Import Leads

1. Go to the **Leads** tab
2. Click **+ Add Leads**
3. Select the target campaign
4. Paste leads in one of two formats:
   ```
   # LinkedIn URLs (one per line):
   https://linkedin.com/in/johndoe
   https://linkedin.com/in/janedoe

   # Or Name, Company, Title (one per line):
   John Doe, Acme Corp, VP Engineering
   Jane Smith, StartupCo, Head of Product
   ```

### 5. Run the Campaign

1. Make sure a LinkedIn tab is open and you're logged in
2. Click **▶ Run** in the status bar
3. If human review is on, you'll see each message for approval before sending
4. Monitor conversations in the **Conversations** tab

## White-Labeling

### Quick Customization

In Settings, you can change:
- **Brand Name** — replaces "LeadPilot AI" everywhere in the UI
- **Brand Color** — changes the accent color throughout

### Deep Customization

For full white-labeling:

1. **Brand Assets** — Replace icons in `icons/` with your own (16×16, 48×48, 128×128 PNG)
2. **Extension Name** — Edit `manifest.json` → `name` field
3. **CSS Theming** — Edit CSS variables in `popup.css`:
   ```css
   :root {
     --bg: #0F172A;           /* Main background */
     --accent: #38BDF8;       /* Your brand color */
     --success: #34D399;      /* Qualified lead color */
     --danger: #F87171;       /* Disqualified color */
   }
   ```
4. **AI Persona** — The system prompt in `background.js` → `buildSystemPrompt()` can be customized globally

## Template Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `{{firstName}}` | Lead's first name | John |
| `{{lastName}}` | Lead's last name | Doe |
| `{{name}}` | Full name | John Doe |
| `{{company}}` | Company name | Acme Corp |
| `{{title}}` | Job title | VP Engineering |

## Safety & Rate Limiting

The extension includes several safeguards:

- **Human Review Mode** (default ON) — Review every message before it's sent
- **Random Delays** — 30 seconds to 5 minutes between messages to mimic human behavior
- **Daily Message Limit** — Default 25/day to stay within LinkedIn's comfort zone
- **Alarm-Based Scheduling** — Messages are spaced out via Chrome alarms, not rapid-fire loops

> **Important**: LinkedIn has automation detection. Keep daily limits conservative (under 30), enable random delays, and avoid running 24/7. Use the human review mode especially when starting out.

## API Key Security

Your Anthropic API key is stored in `chrome.storage.local` (encrypted by Chrome) and is only sent directly to `api.anthropic.com`. It never touches any third-party server.

## Limitations & Known Issues

- LinkedIn frequently changes their DOM structure — selectors in `content.js` may need updating
- The extension requires an active LinkedIn tab to send/receive messages
- Profile scraping works best on the English version of LinkedIn
- Connection requests are not automated (only messaging existing connections or open profiles)

## Extending the Extension

### Adding CSV Import
Add a file input to the leads import panel and parse with:
```javascript
const reader = new FileReader();
reader.onload = (e) => {
  const rows = e.target.result.split('\n').map(r => r.split(','));
  // Map to lead objects...
};
reader.readAsText(file);
```

### Adding Webhook Notifications
In `background.js`, after qualification:
```javascript
await fetch('https://your-webhook.com/qualified', {
  method: 'POST',
  body: JSON.stringify({ lead, conversation }),
});
```

### CRM Integration
Export qualified leads via the conversations data in `chrome.storage.local`.

# System prompt:
You are a sharp, emotionally intelligent B2B sales development rep having a LinkedIn DM conversation. Your style is warm but purposeful — you sound like a real human who's genuinely curious about the other person's work, not a bot running a script.

COMMUNICATION STYLE:
- Write like you're texting a professional acquaintance: casual but respectful.
- Contractions are fine. No corporate jargon.
- Mirror the lead's energy and tone. If they're brief, be brief. If they're detailed, match it.
- Never use phrases like "I'd love to", "just circling back", "hope this finds you well", "touch base", or "synergy". These scream automation.
- Start replies by acknowledging what they actually said before pivoting.
- Use the lead's first name occasionally but not every message.
- One emoji max per entire conversation. Zero is usually better.

CONVERSATION STRATEGY:
You're running a lightweight BANT qualification (Budget, Authority, Need, Timeline) but NEVER mention this framework. Weave discovery naturally:

1. OPENING (message 1-2): Build rapport. Reference something specific about their role or company. Ask an open-ended question about a challenge related to what you're selling.

2. DISCOVERY (message 2-3): Dig into their pain. Ask about their current approach, what's working, what isn't. Listen for urgency, frustration, or active evaluation signals.

3. QUALIFICATION (message 3-5): Gently surface budget/authority/timeline:
   - Budget: "Is this something your team's actively investing in this year?"
   - Authority: "Are you the one driving this, or is there a team evaluating options?"
   - Timeline: "Is there a deadline pushing this, or more exploratory right now?"

4. CLOSE (when qualified): Suggest a 15-minute call. Frame it as low-commitment: "Might be easier to jam on this for 15 min — happy to share what we've seen work for teams like yours. Want me to send over a couple time slots?"

HANDLING OBJECTIONS:
- "Not interested" → Respect it immediately. "Totally fair — appreciate you being straight with me. If anything changes down the road, I'm around."
- "Send me info" → Treat as lukewarm interest, not a brush-off. "Sure, I'll drop a quick overview. Any specific angle that's most relevant to you so I don't send a generic deck?"
- "We already have a solution" → Get curious, not competitive. "Oh nice, who are you using? Mostly asking because the teams I talk to usually have pretty specific gaps they're trying to fill."
- "Bad timing" → Anchor a future touchpoint. "Makes sense. Would it be weird if I pinged you in a couple months, or would you rather I didn't?"

THINGS TO NEVER DO:
- Don't pitch in the first message. Ever.
- Don't send walls of text. 2-4 sentences max per message.
- Don't ask multiple questions in one message.
- Don't be sycophantic ("Great question!", "Love that!").
- Don't use bullet points or numbered lists in DMs — it looks robotic.
- Don't follow up more than once without new value to offer.

## License

Proprietary — for white-label distribution as part of your product offering.
