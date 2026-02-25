# CLAUDE.md

This file provides guidance to Claude Code when working with the LeadPilot AI Chrome extension.

## Overview

LeadPilot AI is a Chrome Extension (Manifest V3) for LinkedIn sales automation. It automates outreach messaging, detects replies, generates AI follow-ups using Claude, and syncs pipeline status with the Aivora platform.

## Key Facts

- **No build step** — plain JavaScript, no TypeScript, no npm, no bundler
- **No server** — runs entirely in the browser as a Chrome extension
- **Load directly** — `chrome://extensions/` → Load unpacked → `linkedin-ai-agent/` folder
- **AI** — Claude API called directly from service worker (user's own API key)
- **Auth** — Supabase Auth REST API (no SDK)

## Project Structure

```
linkedin-ai-agent/
├── manifest.json          # MV3 manifest
├── icons/                 # Extension icons
└── src/
    ├── background.js      # Service worker: orchestration, AI, scheduling
    ├── content.js         # LinkedIn DOM automation
    ├── content.css        # LinkedIn overlay styles
    ├── popup.html         # Extension popup UI
    ├── popup.js           # UI logic, campaign CRUD, Aivora integration
    ├── auth.js            # Supabase auth (email/password)
    └── config.js          # Backend URL + Supabase anon key
```

## Development

1. Edit files directly in `linkedin-ai-agent/src/`
2. Go to `chrome://extensions/`
3. Click the reload button on the extension
4. Changes take effect immediately

No build, no compile, no hot reload. Just edit and reload.

## Key Patterns

- **State persistence**: All state in `chrome.storage.local` (not variables — service worker restarts)
- **Scheduling**: Chrome Alarms API (2-minute tick), not setTimeout
- **DOM selectors**: Priority-ordered arrays with `queryFirst()` fallback (LinkedIn changes its DOM)
- **AI prompts**: 2-block system prompt for prompt caching (block 1 cached, block 2 dynamic)
- **Anti-detection**: Random delays, daily limits, character-by-character typing, human review mode

## Agents (in `.claude/agents/`)

| Agent | Model | Domain |
|-------|-------|--------|
| `leadpilot-engineer` | Sonnet | DOM automation, Claude AI, campaigns, Aivora sync |
| `strategic-architect` | Opus | Architecture decisions, cross-system design |
| `qa-engineer` | Sonnet | Manifest validation, syntax checks, flow testing |
| `full-stack-debugger` | Opus | Cross-cutting debugging (extension + backend + Supabase) |

## Skills (in `.claude/skills/`)

| Skill | Trigger |
|-------|---------|
| `/product-owner` | Before building any new feature |
| `/project-manager` | Multi-step implementations |
| `/security-architect` | API key handling, auth flows, permissions, Aivora integration |
| `/qa-lead` | Before releasing a new version of the extension |

## Architecture Documentation

- **This repo**: `docs/architecture.md` — Complete extension architecture
- **Parent**: `../CLAUDE.md` — Ecosystem overview (3-repo structure), agents, skills
- **Cross-project**: `../Aivora-infra/enterprise-architecture/` — System overview, traffic flows, data ownership

## Part of Aivora Ecosystem

This extension is a satellite client of the Aivora SaaS platform. It shares:
- Same Supabase project (`kvlfpwzmjxuapjheknnj`)
- Same auth system (Supabase Auth)
- Same `leads_linkedin` table (reads enriched leads, writes pipeline status)
- Same backend API (`staging-api.getaivora.co`)

The extension works standalone without Aivora login. Dashboard integration and status sync are optional.

## Common Tasks

### Fixing broken LinkedIn selectors
1. Open LinkedIn in Chrome DevTools
2. Find the element that changed
3. Update the selector array in `content.js` (add new selector at top priority)
4. Test with extension reload

### Updating AI system prompt
1. Edit `buildSystemPrompt()` in `background.js`
2. Block 1 = static (cached), Block 2 = dynamic (per lead)
3. Keep max_tokens at 250 for LinkedIn-appropriate message length

### Adding new action tags
1. Define in Block 1 of system prompt (`background.js`)
2. Parse in `generateAIResponse()` response handler
3. Handle in the appropriate status update flow
