# LeadPilot AI — Architecture Documentation

> LinkedIn sales automation Chrome extension. Part of the Aivora ecosystem.

## Purpose

LeadPilot AI is a Chrome extension that automates LinkedIn outreach: sending personalized messages, detecting replies, generating AI follow-ups with Claude, and tracking lead pipeline status. It integrates with the Aivora SaaS platform for enriched lead data and bi-directional status sync.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Chrome Extension Manifest V3 |
| Language | Plain JavaScript (ES modules) |
| Build | None — load directly as unpacked extension |
| Storage | `chrome.storage.local` + `chrome.storage.session` |
| Scheduling | Chrome Alarms API (2-minute tick) |
| AI | Anthropic Claude API (direct from service worker) |
| Auth | Supabase Auth REST API (no SDK) |
| UI | Pure HTML/CSS, dark theme, 420px popup |

**No dependencies.** No node_modules, no package.json, no build step.

## Project Structure

```
leadpilot-ai-linkedin-agent/
├── .gitignore
├── README.md
└── linkedin-ai-agent/              # Chrome extension (load unpacked)
    ├── manifest.json                # MV3 manifest
    ├── icons/
    │   ├── icon16.png
    │   ├── icon48.png
    │   └── icon128.png
    └── src/
        ├── background.js            # Service worker: orchestration, AI, scheduling
        ├── content.js               # LinkedIn DOM automation
        ├── content.css              # LinkedIn overlay styles
        ├── popup.html               # Extension popup UI
        ├── popup.js                 # UI logic, campaign CRUD, Aivora integration
        ├── auth.js                  # Supabase auth (email/password, token refresh)
        └── config.js                # Hardcoded Aivora backend URL + Supabase anon key
```

## Message Passing Architecture

### Background Service Worker Listeners (`background.js`)

| `msg.action` | Trigger | Handler |
|---|---|---|
| `start_campaign` | Popup "Run" button | `startCampaignLoop()` — creates 2-min alarm, runs first cycle |
| `stop_campaign` | Popup "Stop" button | `stopCampaignLoop()` — clears alarms |
| `approve_message` | Popup approval modal "Send" | `handleApprovedMessage()` — sends approved message |
| `reject_message` | Popup "Back to Queue"/"Disqualify" | `handleRejectedMessage()` — resets or disqualifies lead |
| `new_reply_detected` | Content script reply scan | `handleIncomingReply()` — processes reply, calls Claude AI |
| `enrich_leads` | Popup after URL-based import | `enrichLeads()` — navigates to LinkedIn profiles to scrape |

### Content Script Listeners (`content.js`)

| `msg.action` | Trigger | Handler |
|---|---|---|
| `send_linkedin_message` | Background sends a message | `handleSendMessage()` — full LinkedIn DOM automation |
| `check_replies` | Background periodic check | `handleCheckReplies()` — scans overlay conversation cards |
| `scrape_profile` | Background enrichment | `handleScrapeProfile()` — scrapes name/title/company/location |

### External API Calls

| Endpoint | From | Purpose |
|---|---|---|
| `api.anthropic.com/v1/messages` | background.js | Claude AI follow-up generation |
| `staging-api.getaivora.co/api/content/linkedin-leads` | popup.js | Fetch enriched leads from Aivora |
| `staging-api.getaivora.co/api/content/linkedin-leads/:id/status` | background.js | Push pipeline stage updates to Aivora |
| `kvlfpwzmjxuapjheknnj.supabase.co/auth/v1/token` | auth.js | Login + token refresh |

## Core Flows

### Campaign Execution (every 2 minutes)

```
Chrome Alarm fires → background.js runFullCycle()

  PHASE 1: Reply Check
    → checkForReplies() → content.js scans overlay cards
    → For each new reply: handleIncomingReply()
      → Add to conversation.messages
      → Set status = 'processing_reply'
      → Enqueue AI call (serial queue)
      → generateAIResponse() → Claude API
      → Parse action tags: [QUALIFIED], [DISQUALIFIED], [SCHEDULE_CALL], etc.
      → If humanReview: approval_needed → popup
      → If auto: sendFollowUp() → content.js
      → syncStatusToDashboard() → PATCH Aivora API

  PHASE 2: New Messages
    → tick() → find next pending lead
    → personalizeTemplate() fills {{firstName}}, {{company}}, etc.
    → If humanReview: pending_approval → popup
    → If randomDelay: store scheduledSendAt, return
    → If immediate: sendMessage() → content.js → LinkedIn DOM
```

### LinkedIn DOM Automation

**Message Sending (`handleSendMessage`):**
1. Locate `.msg-overlay-list-bubble` (messaging sidebar)
2. Search existing conversations by name matching
3. If not found: click "new message", type recipient into typeahead
4. Wait for compose box (`div.msg-form__contenteditable`)
5. Type message character-by-character with keyboard events
6. Click send, verify compose box empty
7. Close conversation bubble

**Reply Detection (`handleCheckReplies`):**
- Scan conversation cards in messaging overlay
- Check `font-weight` >= 600 (unread) and no "You:" prefix (lead replied)
- Deduplicate via `leadId:hash` in `chrome.storage.session`

**Profile Scraping (`handleScrapeProfile`):**
- Navigate to LinkedIn profile URL
- Query: `h1.text-heading-xlarge` (name), `div.text-body-medium` (title), company button, location span
- Multi-strategy selector fallbacks for each field

### Anti-Detection Measures
- Random delay 30s-5min between messages (stored as timestamp, survives service worker restarts)
- Daily message limit (default 25)
- 2-5 second delays between profile scrapes
- Human review mode (default ON)
- Alarm-based scheduling (not rapid loops)
- Character-by-character typing with real keyboard events

## AI System

### Claude Configuration
- **Model**: `claude-sonnet-4-6` (default), `claude-haiku-4-5-20251001` (optional)
- **API Key**: User's own key, stored in `chrome.storage.local`
- **Max tokens**: 250 (2-4 LinkedIn-appropriate sentences)

### System Prompt Architecture (Two-Block for Prompt Caching)

**Block 1 — Static** (marked `cache_control: { type: 'ephemeral' }`):
- Core identity: sharp, direct B2B sales professional
- Language detection: mirror lead's language (Romanian or English)
- Business description (from campaign `persona`)
- 4-stage conversation strategy: Understand → Connect/Book → Book Call → Graceful Exit
- BANT qualification framework (woven naturally)
- Messaging rules: 2-4 sentences, 1 question, no emojis first
- Action tag definitions

**Block 2 — Dynamic** (per lead/message):
- Lead name, title, company, message count
- Stage guidance based on conversation length
- Aivora enrichment data: `personal_research`, `company_weakness`, `company_description`
- Accumulated `[INSIGHT:key=value]` tags
- Sales rep name

### Action Tags
`[QUALIFIED]`, `[DISQUALIFIED]`, `[ABANDONED]`, `[SCHEDULE_CALL]`, `[CALL_BOOKED]`, `[UPSELL]`, `[INSIGHT:key=value]`

### Dedup & Quality
- Jaccard word similarity check (>0.8 triggers retry with explicit dedup instruction)
- Emoji-only response filtering
- Serial AI call queue prevents burst rate-limiting
- 429 retry with `retry-after` header

## Storage Schema

### `chrome.storage.local`

| Key | Type | Description |
|---|---|---|
| `campaigns` | Campaign[] | `{ id, name, template, repName, persona, criteria, callScheduling, followupDelay, maxFollowups, status, stats }` |
| `leads` | Lead[] | `{ id, campaignId, name, company, title, linkedinUrl, status, dashboardLeadId, dashboardData, scheduledSendAt, retryCount }` |
| `conversations` | Conversation[] | `{ id, leadId, campaignId, status, followupCount, messages, insights }` |
| `settings` | Settings | `{ apiKey, model, brandName, brandColor, humanReview, randomDelay, dailyLimit }` |
| `running` | boolean | Campaign running state |
| `messagesToday` | `{ count, date }` | Daily message counter |
| `pendingApprovals` | ApprovalData[] | Messages awaiting human review |
| `activityLog` | LogEntry[] | Last 50 log entries |
| `tickLock` | `{ active, timestamp }` | Prevents concurrent ticks |

### `chrome.storage.session`

| Key | Type | Description |
|---|---|---|
| `processedReplyKeys` | string[] | `leadId:hash` dedup keys (survives navigation, not restart) |

## Chrome Extension Configuration

### Manifest Permissions
- `storage`, `tabs`, `activeTab`, `alarms`, `scripting`, `unlimitedStorage`

### Host Permissions
- `https://www.linkedin.com/*` — content script + tab messaging
- `https://api.anthropic.com/*` — Claude API
- `https://staging-api.getaivora.co/*` — Aivora backend
- `https://kvlfpwzmjxuapjheknnj.supabase.co/*` — Supabase Auth

## Authentication

### Anthropic (Extension-Local)
- User enters API key in Settings
- Stored in `chrome.storage.local`
- Sent directly to Anthropic with `x-api-key` + `anthropic-dangerous-direct-browser-access: true`

### Aivora Platform (Supabase)
- Optional email/password login in Dashboard tab
- `auth.js` calls Supabase Auth REST API (no SDK)
- Tokens in `chrome.storage.local`: `aivora_access_token`, `aivora_refresh_token`, `aivora_user`, `aivora_expires_at`
- Auto-refresh 60 seconds before expiry
- Extension works standalone without Aivora login

## Aivora Integration

### Lead Import (Aivora → Extension)
- Dashboard tab fetches enriched leads via `GET /api/content/linkedin-leads`
- Imports with `dashboardData` (personal_research, company_weakness, etc.)
- AI system prompt injects this research into dynamic context block

### Status Sync (Extension → Aivora)
- Every status change: `PATCH /api/content/linkedin-leads/:id/status`
- Status mapping: `messaged→contacted`, `replied→replied`, `qualified→qualified`, `disqualified→disqualified`, `abandoned→abandoned`, `call_booked→call_booked`
- Non-blocking (errors logged, not thrown)

### Shared Resources
- Same Supabase project (`kvlfpwzmjxuapjheknnj`)
- Same auth system (same user account)
- Same `company_id` multi-tenant isolation

## Configuration

### Hardcoded (`config.js`)
- `SUPABASE_URL`: `https://kvlfpwzmjxuapjheknnj.supabase.co`
- `SUPABASE_ANON_KEY`: Public anon key
- `BACKEND_URL`: `https://staging-api.getaivora.co`

### User-Configurable Settings
| Setting | Default | Description |
|---|---|---|
| `apiKey` | `''` | Anthropic API key |
| `model` | `claude-sonnet-4-6` | Claude model |
| `humanReview` | `true` | Review messages before sending |
| `randomDelay` | `true` | 30s-5min delay between messages |
| `dailyLimit` | `25` | Messages per day |
| `brandName` | `LeadPilot AI` | White-label name |
| `brandColor` | `#38BDF8` | Accent color |

### Lead Caps
- Soft cap: 150 leads (warning toast)
- Hard cap: 500 leads (import blocked)

## Deployment

**No deployment pipeline.** Client-side Chrome extension only.

1. `chrome://extensions/` → Enable Developer Mode
2. "Load unpacked" → select `linkedin-ai-agent/` folder
3. Extension runs locally in Chrome

No build step. Edit files directly and reload the extension.

## External Dependencies

| Service | Purpose | Access Method |
|---|---|---|
| Anthropic Claude | AI conversation generation | Direct HTTPS from service worker |
| Supabase | Auth (login/refresh) | REST API via fetch |
| Aivora Backend | Enriched leads + status sync | REST API via fetch |
| LinkedIn | DOM automation | Content script injection |
