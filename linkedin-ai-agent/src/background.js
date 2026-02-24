// ============================================================
// LeadPilot AI — Background Service Worker
// Orchestrates campaign execution, AI conversations, scheduling
// ============================================================

const ALARM_NAME = 'leadpilot_tick';
const REPLY_CHECK_ALARM = 'leadpilot_reply_check';

// ---- Safe Content Script Messaging ----
// Detects dead/orphaned content scripts and re-injects them
async function safeTabMessage(tabId, message, retries = 1) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, message);
    return result;
  } catch (err) {
    const isDisconnected = err.message?.includes('Receiving end does not exist') ||
                           err.message?.includes('Extension context invalidated') ||
                           err.message?.includes('Could not establish connection');

    if (isDisconnected && retries > 0) {
      console.log(`[LeadPilot] Content script dead on tab ${tabId}, re-injecting...`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['src/content.js'],
        });
        // Wait for content script to initialize
        await new Promise(r => setTimeout(r, 2000));
        // Retry the message
        return await safeTabMessage(tabId, message, retries - 1);
      } catch (injectErr) {
        console.error('[LeadPilot] Failed to re-inject content script:', injectErr.message);
        throw injectErr;
      }
    }
    throw err;
  }
}

// ---- State helpers ----
async function getState() {
  const data = await chrome.storage.local.get(['campaigns', 'leads', 'conversations', 'settings', 'running', 'messagesToday', 'pendingApprovals']);
  return {
    campaigns: data.campaigns || [],
    leads: data.leads || [],
    conversations: data.conversations || [],
    settings: data.settings || {},
    running: data.running || false,
    messagesToday: data.messagesToday || { count: 0, date: new Date().toDateString() },
    pendingApprovals: data.pendingApprovals || [],
  };
}

async function setState(partial) {
  await chrome.storage.local.set(partial);
  // Notify popup to refresh
  chrome.runtime.sendMessage({ action: 'state_updated' }).catch(() => {});
}

// ---- AI Call Queue (FIX 12) ----
// Serializes all AI calls to prevent burst rate-limit hits.
const aiCallQueue = [];
let aiQueueRunning = false;

function enqueueAICall(fn) {
  return new Promise((resolve, reject) => {
    aiCallQueue.push({ fn, resolve, reject });
    drainAIQueue();
  });
}

async function drainAIQueue() {
  if (aiQueueRunning || aiCallQueue.length === 0) return;
  aiQueueRunning = true;
  while (aiCallQueue.length > 0) {
    const { fn, resolve, reject } = aiCallQueue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }
  }
  aiQueueRunning = false;
}

// ---- Claude API helper with 429 retry (FIX 12) ----
async function callClaudeAPI(apiKey, model, systemBlocks, messages) {
  const bodyObj = {
    model,
    max_tokens: 250, // OPT 2: was 500; AI writes 2-4 sentences (~80-150 tokens)
    system: systemBlocks,
    messages,
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'prompt-caching-2024-07-31', // OPT 1: enable prompt caching
  };

  let response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
  });

  // FIX 12: Retry once on 429 rate limit
  if (response.status === 429) {
    const retryAfterSec = parseInt(response.headers.get('retry-after') || '5', 10);
    console.log(`[LeadPilot] API rate limited, retrying after ${retryAfterSec}s...`);
    await sleep(retryAfterSec * 1000);
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
    });
  }

  return response;
}

// ---- Message Listeners ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'start_campaign':
      startCampaignLoop();
      break;
    case 'stop_campaign':
      stopCampaignLoop();
      break;
    case 'approve_message':
      handleApprovedMessage(msg.data);
      break;
    case 'reject_message':
      handleRejectedMessage(msg.data);
      break;
    case 'new_reply_detected':
      handleIncomingReply(msg.data);
      break;
    case 'enrich_leads':
      enrichLeads(msg.data.leadIds);
      break;
  }
});

// ---- Alarms ----
// SINGLE ALARM — runs all operations sequentially to avoid collisions.
// The tick does: 1) check replies → 2) send AI responses → 3) send new messages
// This prevents page navigations from stomping on each other.
let isTickRunning = false;

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    // FIX 15: Check storage-backed tick lock (survives SW restarts)
    const lockData = await chrome.storage.local.get(['tickLock']);
    const lock = lockData.tickLock;
    if (lock?.active && (Date.now() - lock.timestamp) < 90000) {
      console.log('[LeadPilot] Tick already running (storage lock), skipping');
      return;
    }
    if (isTickRunning) {
      console.log('[LeadPilot] Tick already running (memory), skipping');
      return;
    }
    isTickRunning = true;
    await chrome.storage.local.set({ tickLock: { active: true, timestamp: Date.now() } });
    try {
      await runFullCycle();
    } finally {
      isTickRunning = false;
      await chrome.storage.local.set({ tickLock: { active: false } });
    }
  }
});

async function runFullCycle() {
  const state = await getState();
  if (!state.running) return;

  // Phase 1: Check for replies (non-destructive — uses font-weight detection)
  await addLog('reply_check', 'Scanning for replies...');
  await setState({ lastReplyCheckAt: Date.now() });
  await checkForReplies();
  await addLog('reply_check_done', 'Reply scan complete');

  // Brief pause between phases
  await sleep(3000);

  // Phase 2: Send new messages to pending leads
  await addLog('tick', 'Checking for leads to message...');
  await setState({ lastTickAt: Date.now() });
  await tick();
  await addLog('tick_done', 'Message tick complete');
}

// ---- Activity Log ----
async function addLog(type, message, extra = null) {
  const data = await chrome.storage.local.get(['activityLog']);
  const logs = data.activityLog || [];
  logs.unshift({
    type,
    message,
    extra,
    timestamp: Date.now(),
  });
  // Keep last 50 entries
  if (logs.length > 50) logs.length = 50;
  await chrome.storage.local.set({ activityLog: logs });
  // Notify content script to update panel
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { action: 'log_updated' }).catch(() => {});
  }
}

async function startCampaignLoop() {
  const now = Date.now();
  await setState({ running: true, lastTickAt: now, lastReplyCheckAt: now });
  // Single alarm — every 2 minutes
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 2 });
  // Clear old separate reply alarm if it exists
  chrome.alarms.clear(REPLY_CHECK_ALARM);
  await addLog('started', 'Campaign started');
  // Run first cycle immediately
  isTickRunning = true;
  await chrome.storage.local.set({ tickLock: { active: true, timestamp: Date.now() } });
  try {
    await runFullCycle();
  } finally {
    isTickRunning = false;
    await chrome.storage.local.set({ tickLock: { active: false } });
  }
}

async function stopCampaignLoop() {
  await setState({ running: false });
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.clear(REPLY_CHECK_ALARM);
  await addLog('stopped', 'Campaign stopped');
}

// ---- Main Tick ----
async function tick() {
  const state = await getState();
  if (!state.running) return;

  // Reset daily counter if new day
  if (state.messagesToday.date !== new Date().toDateString()) {
    state.messagesToday = { count: 0, date: new Date().toDateString() };
    await setState({ messagesToday: state.messagesToday });
  }

  // Check daily limit
  if (state.settings.dailyLimitEnabled && state.messagesToday.count >= (state.settings.dailyLimit || 25)) {
    console.log('[LeadPilot] Daily limit reached');
    return;
  }

  const activeCampaignIds = state.campaigns.filter(c => c.status === 'active').map(c => c.id);

  // FIX 1A: Check for scheduled delayed sends that are now ready to fire
  // These are leads in 'sending' status with a scheduledSendAt timestamp that has passed.
  const readyDelayedLead = state.leads.find(l =>
    l.status === 'sending' &&
    l.scheduledSendAt &&
    l.scheduledSendAt <= Date.now() &&
    activeCampaignIds.includes(l.campaignId)
  );
  if (readyDelayedLead) {
    const readyCampaign = state.campaigns.find(c => c.id === readyDelayedLead.campaignId);
    if (readyCampaign) {
      const msg = personalizeTemplate(readyCampaign.template, readyDelayedLead);
      // Clear the scheduled time before sending to prevent re-fire
      readyDelayedLead.scheduledSendAt = null;
      await setState({ leads: state.leads });
      await sendMessage(readyDelayedLead, readyCampaign, msg);
    }
    return;
  }

  // Find next lead to message — ONLY truly pending leads
  // Excludes: sending (in progress), pending_approval (awaiting human review),
  // messaged, replied, qualified, disqualified, send_failed, etc.
  const pendingLead = state.leads.find(l =>
    l.status === 'pending' && !l.needsEnrichment && activeCampaignIds.includes(l.campaignId)
  );

  if (!pendingLead) {
    // Check for follow-ups needed
    await processFollowUps(state);
    return;
  }

  const campaign = state.campaigns.find(c => c.id === pendingLead.campaignId);
  if (!campaign) return;

  // *** CRITICAL: Mark lead as 'sending' IMMEDIATELY to prevent the next tick
  // from picking up the same lead and sending a duplicate message.
  // This must happen BEFORE any delay or async send operation.
  pendingLead.status = 'sending';
  await setState({ leads: state.leads });

  // Generate personalized initial message
  const message = personalizeTemplate(campaign.template, pendingLead);

  if (state.settings.humanReview) {
    // Send to popup for approval — revert to 'pending_approval' since user needs to approve
    pendingLead.status = 'pending_approval';
    await setState({ leads: state.leads });

    // FIX 3: Persist approval to storage so popup can recover it on reopen
    const approvalData = {
      leadId: pendingLead.id,
      leadName: pendingLead.name,
      leadTitle: pendingLead.title,
      campaignId: campaign.id,
      message,
      type: 'initial',
      createdAt: Date.now(),
    };
    const storageData = await chrome.storage.local.get(['pendingApprovals']);
    const pendingApprovals = storageData.pendingApprovals || [];
    pendingApprovals.push(approvalData);
    await chrome.storage.local.set({ pendingApprovals });

    chrome.runtime.sendMessage({
      action: 'approval_needed',
      data: approvalData,
    }).catch(() => {});
  } else {
    // Auto-send — lead is already marked 'sending' so next tick skips it
    if (state.settings.randomDelay) {
      // FIX 1A: Store scheduledSendAt instead of using setTimeout (which is lost when SW terminates)
      const delay = Math.random() * 270000 + 30000; // 30s to 5min
      pendingLead.scheduledSendAt = Date.now() + delay;
      await setState({ leads: state.leads });
      // The alarm-based tick will call sendMessage when scheduledSendAt <= Date.now()
    } else {
      await sendMessage(pendingLead, campaign, message);
    }
  }
}

// ---- Template Personalization ----
function personalizeTemplate(template, lead) {
  return template
    .replace(/\{\{firstName\}\}/gi, lead.firstName || lead.name?.split(' ')[0] || '')
    .replace(/\{\{lastName\}\}/gi, lead.lastName || '')
    .replace(/\{\{name\}\}/gi, lead.name || '')
    .replace(/\{\{company\}\}/gi, lead.company || 'your company')
    .replace(/\{\{title\}\}/gi, lead.title || 'your role');
}

// ---- Send Message via Content Script ----
async function sendMessage(lead, campaign, message) {
  const state = await getState();

  // Find LinkedIn tab
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) {
    console.error('[LeadPilot] No LinkedIn tab open. Open linkedin.com first.');
    // Revert to pending so next tick retries
    const l = state.leads.find(x => x.id === lead.id);
    if (l) { l.status = 'pending'; await setState({ leads: state.leads }); }
    return { success: false, error: 'No LinkedIn tab open' };
  }

  const tab = tabs[0];

  // Tell content script to send the message
  try {
    const result = await safeTabMessage(tab.id, {
      action: 'send_linkedin_message',
      data: {
        leadId: lead.id,
        recipientUrl: lead.linkedinUrl,
        recipientName: lead.name,
        message: message,
      }
    });

    // Re-fetch state in case it changed during async send
    const freshState = await getState();
    const freshLead = freshState.leads.find(l => l.id === lead.id);
    if (!freshLead) return { success: false, error: 'Lead no longer exists' };

    // ONLY update state if content script confirms success
    if (!result || !result.success) {
      console.error('[LeadPilot] Content script reported failure:', result?.error || 'Unknown error');
      await addLog('send_failed', `Failed to send to ${lead.name}: ${result?.error}`, { leadId: lead.id });

      freshLead.status = 'send_failed';
      freshLead.lastError = result?.error || 'Message delivery failed';
      await setState({ leads: freshState.leads });
      return { success: false, error: result?.error };
    }

    // Content script confirmed the message was sent — now update state
    freshLead.status = 'messaged';
    freshLead.lastMessageAt = new Date().toISOString();
    freshLead.lastError = null;
    freshLead.scheduledSendAt = null; // Clear any scheduled send timestamp

    // Create conversation record
    const conv = {
      id: 'conv_' + Date.now(),
      leadId: lead.id,
      campaignId: campaign.id,
      status: 'awaiting_reply',
      followupCount: 0,
      messages: [
        {
          role: 'assistant',
          text: message,
          timestamp: new Date().toISOString(),
        }
      ],
      created: new Date().toISOString(),
    };

    freshState.conversations.push(conv);

    // Update campaign stats
    const freshCampaign = freshState.campaigns.find(c => c.id === campaign.id);
    if (freshCampaign) freshCampaign.stats.sent++;

    // Update daily counter
    freshState.messagesToday.count++;

    await setState({
      leads: freshState.leads,
      conversations: freshState.conversations,
      campaigns: freshState.campaigns,
      messagesToday: freshState.messagesToday,
    });

    console.log(`[LeadPilot] ✓ Message sent to ${lead.name}`);
    await addLog('message_sent', `Message sent to ${lead.name}`, { leadId: lead.id });
    return { success: true };

  } catch (err) {
    console.error('[LeadPilot] Failed to send message:', err);

    // Revert to send_failed
    const errState = await getState();
    const errLead = errState.leads.find(l => l.id === lead.id);
    if (errLead) {
      errLead.status = 'send_failed';
      errLead.lastError = err.message;
      await setState({ leads: errState.leads });
    }
    return { success: false, error: err.message };
  }
}

// ---- Handle Approved Message ----
async function handleApprovedMessage(data) {
  const state = await getState();
  const lead = state.leads.find(l => l.id === data.leadId);
  const campaign = state.campaigns.find(c => c.id === data.campaignId);
  if (!lead || !campaign) return;

  // FIX 3: Remove from pending approvals storage
  const updatedApprovals = state.pendingApprovals.filter(a => a.leadId !== data.leadId);
  await chrome.storage.local.set({ pendingApprovals: updatedApprovals });

  if (data.type === 'followup') {
    // This is an AI-generated reply to a lead who responded
    const conv = state.conversations.find(c => c.leadId === data.leadId);
    if (!conv) return;

    await sendFollowUp(conv, lead, campaign, data.message, data.qualification || null, data.tags || {});
  } else {
    // This is the initial outreach message
    await sendMessage(lead, campaign, data.message);
  }
}

// ---- Handle Rejected Message ----
async function handleRejectedMessage(data) {
  const state = await getState();
  const lead = state.leads.find(l => l.id === data.leadId);
  if (!lead) return;

  // FIX 3: Remove from pending approvals storage
  const updatedApprovals = state.pendingApprovals.filter(a => a.leadId !== data.leadId);
  await chrome.storage.local.set({ pendingApprovals: updatedApprovals });

  if (data.type === 'followup') {
    // Rejected a follow-up — reset conversation to 'replied' so it can be re-processed or ignored
    const conv = state.conversations.find(c => c.leadId === data.leadId);
    if (conv) {
      conv.status = 'replied';
      await setState({ conversations: state.conversations });
    }
    await addLog('rejected', `Rejected AI reply to ${lead.name}`, { leadId: data.leadId });
  } else {
    // FIX 8: Branch on data.action for initial outreach rejection
    if (data.action === 'disqualify') {
      // Explicit disqualify button clicked
      lead.status = 'disqualified';
    } else {
      // Default "Back to Queue" — reset to pending so it can be picked up again
      lead.status = 'pending';
    }
    await setState({ leads: state.leads });
  }
}

// ---- Reply Handling ----
async function handleIncomingReply(data) {
  const state = await getState();

  // Find the conversation for this lead
  const conv = state.conversations.find(c => c.leadId === data.leadId);
  if (!conv) {
    await addLog('reply_error', `No conversation found for lead ${data.leadId}`);
    return;
  }

  // FIX 4: Guard both processing_reply AND pending_approval to prevent double-processing
  if (conv.status === 'processing_reply' || conv.status === 'pending_approval') {
    await addLog('reply_skipped', `Already processing reply for lead ${data.leadId} — status is ${conv.status}, skipping`);
    return;
  }

  const lead = state.leads.find(l => l.id === data.leadId);

  // GUARD: Ignore emoji-only reactions (👍, 😊, etc.)
  const textOnly = data.replyText.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\uFE0F]/gu, '').trim();
  if (textOnly.length < 2) {
    console.log(`[LeadPilot] Emoji/reaction from ${lead?.name}: "${data.replyText}", ignoring`);
    return;
  }

  // GUARD: Don't process the same reply text we already have
  const lastUserMsg = [...conv.messages].reverse().find(m => m.role === 'user' && !m.isSystem);
  if (lastUserMsg && lastUserMsg.text === data.replyText) {
    await addLog('reply_skipped', `Duplicate reply text from ${lead?.name}, skipping`);
    return;
  }

  await addLog('reply_received', `Reply from ${lead?.name || 'unknown'}: "${data.replyText.slice(0, 80)}..."`, { leadId: data.leadId });

  // Add the reply to conversation history
  conv.messages.push({
    role: 'user',
    text: data.replyText,
    timestamp: new Date().toISOString(),
  });

  // Mark as processing — prevents duplicate handling
  conv.status = 'processing_reply';
  conv.processingStartedAt = Date.now(); // FIX 5: Track when status was set

  // Update lead status
  if (lead) lead.status = 'replied';

  // Update campaign stats
  const campaign = state.campaigns.find(c => c.id === conv.campaignId);
  if (campaign) campaign.stats.replied++;

  await setState({
    conversations: state.conversations,
    leads: state.leads,
    campaigns: state.campaigns,
  });

  // FIX 12: Enqueue AI call to prevent burst rate-limit hits
  await addLog('ai_starting', `Starting AI generation for ${lead?.name}... (conv has ${conv.messages.length} messages)`, { leadId: data.leadId });

  try {
    await enqueueAICall(() => generateAIResponse(conv, lead, campaign, state));
  } catch (err) {
    // CRITICAL: If generateAIResponse throws for ANY reason, we must reset status
    await addLog('ai_error', `AI generation crashed for ${lead?.name}: ${err.message}`, { leadId: data.leadId });

    // Re-fetch state because generateAIResponse may have partially modified it
    const freshState = await getState();
    const freshConv = freshState.conversations.find(c => c.leadId === data.leadId);
    if (freshConv && freshConv.status === 'processing_reply') {
      freshConv.status = 'replied';
      await setState({ conversations: freshState.conversations });
      await addLog('status_reset', `Reset ${lead?.name} from processing_reply to replied after error`, { leadId: data.leadId });
    }
  }
}

// ---- AI Response Generation ----
// FIX 2: ephemeralUserMsg parameter — sent to API only, never stored in conv.messages
async function generateAIResponse(conv, lead, campaign, state, ephemeralUserMsg = null) {
  if (!state.settings.apiKey) {
    await addLog('ai_error', `No API key configured — cannot generate response for ${lead.name}`);
    conv.status = 'replied';
    await setState({ conversations: state.conversations });
    return;
  }

  await addLog('ai_generating', `Calling AI for ${lead.name} (${conv.messages.length} msgs in history)...`, { leadId: lead.id });

  // OPT 1: buildSystemPrompt returns array of blocks for prompt caching
  const systemBlocks = buildSystemPrompt(campaign, lead, conv);

  // Build messages, filtering system messages
  let rawMessages = conv.messages.filter(m => !m.isSystem || m.showToAI).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.text,
  }));

  // STEP 1: Remove exact duplicate messages (from the duplicate-send bug)
  // Two messages in a row with the same content = duplicate
  const deduped = [];
  for (const msg of rawMessages) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.content === msg.content && prev.role === msg.role) {
      continue; // Skip exact duplicate
    }
    deduped.push(msg);
  }

  // STEP 2: Remove duplicate conversation cycles
  // If the same assistant message appears multiple times, keep only the last occurrence
  const seen = new Map(); // content -> last index
  deduped.forEach((msg, i) => {
    if (msg.role === 'assistant') {
      const key = msg.content.trim().slice(0, 100);
      seen.set(key, i);
    }
  });

  // Find duplicate assistant messages (those that appear more than once)
  const dupAssistantKeys = new Set();
  const assistantCounts = new Map();
  deduped.forEach((msg) => {
    if (msg.role === 'assistant') {
      const key = msg.content.trim().slice(0, 100);
      assistantCounts.set(key, (assistantCounts.get(key) || 0) + 1);
      if (assistantCounts.get(key) > 1) dupAssistantKeys.add(key);
    }
  });

  // Keep only the FIRST occurrence of duplicate assistant messages and their reply
  let messages = [];
  const processedDupKeys = new Set();
  for (let i = 0; i < deduped.length; i++) {
    const msg = deduped[i];
    if (msg.role === 'assistant') {
      const key = msg.content.trim().slice(0, 100);
      if (dupAssistantKeys.has(key)) {
        if (processedDupKeys.has(key)) {
          // Skip this duplicate and the user reply after it
          if (i + 1 < deduped.length && deduped[i + 1].role === 'user') {
            i++; // Skip the reply too
          }
          continue;
        }
        processedDupKeys.add(key);
      }
    }
    messages.push(msg);
  }

  // STEP 3: Merge consecutive same-role messages (API requirement)
  const mergedMessages = [];
  for (const msg of messages) {
    const last = mergedMessages[mergedMessages.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n\n' + msg.content;
    } else {
      mergedMessages.push({ ...msg });
    }
  }
  messages = mergedMessages;

  // OPT 3: Truncate long conversation history (keep first 2 + last 6)
  // System prompt already injects lead context, so long history isn't needed
  if (messages.length > 8) {
    messages = [...messages.slice(0, 2), ...messages.slice(-6)];
  }

  // API requires first message to be 'user'. If it starts with assistant,
  // prepend a synthetic user message.
  if (messages.length > 0 && messages[0].role === 'assistant') {
    messages.unshift({ role: 'user', content: '(conversation started by us)' });
  }

  // Must have at least one message
  if (messages.length === 0) {
    await addLog('ai_error', `No messages to send to AI for ${lead.name}`);
    conv.status = 'replied';
    await setState({ conversations: state.conversations });
    return;
  }

  // FIX 2: Append ephemeral follow-up instruction — only for API call, never stored
  if (ephemeralUserMsg) {
    messages.push({ role: 'user', content: ephemeralUserMsg });
  }

  await addLog('ai_calling', `Sending ${messages.length} clean messages to API for ${lead.name} (${rawMessages.length} raw)...`, { leadId: lead.id });

  try {
    const response = await callClaudeAPI(
      state.settings.apiKey,
      state.settings.model || 'claude-sonnet-4-6',
      systemBlocks,
      messages
    );

    // Check HTTP status first
    if (!response.ok) {
      const errBody = await response.text();
      await addLog('ai_error', `API returned ${response.status} for ${lead.name}: ${errBody.slice(0, 200)}`, { leadId: lead.id });
      conv.status = 'replied';
      await setState({ conversations: state.conversations });
      return;
    }

    const data = await response.json();
    const aiText = data.content?.[0]?.text;
    if (!aiText) {
      await addLog('ai_error', `AI returned empty response for ${lead.name}. Full response: ${JSON.stringify(data).slice(0, 200)}`, { leadId: lead.id });
      conv.status = 'replied';
      await setState({ conversations: state.conversations });
      return;
    }

    // Parse all tags from the AI response
    const tags = parseAITags(aiText);
    const cleanMsg = cleanAIResponse(aiText);

    // Validate the response is a real message (not just emojis or whitespace)
    const msgTextOnly = cleanMsg.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\uFE0F]/gu, '').trim();
    if (msgTextOnly.length < 5) {
      await addLog('ai_error', `AI returned emoji-only or too-short response for ${lead.name}: "${cleanMsg}"`, { leadId: lead.id });
      conv.status = 'replied';
      await setState({ conversations: state.conversations });
      return;
    }

    await addLog('ai_ready', `AI response for ${lead.name}: "${cleanMsg.slice(0, 80)}..."`, { leadId: lead.id });

    // Store any insights the AI extracted
    if (tags.insights.length > 0) {
      if (!conv.insights) conv.insights = [];
      for (const insight of tags.insights) {
        const existing = conv.insights.findIndex(i => i.key === insight.key);
        if (existing >= 0) {
          conv.insights[existing].value = insight.value;
        } else {
          conv.insights.push(insight);
        }
      }
      await addLog('insight', `Insights from ${lead.name}: ${tags.insights.map(i => `${i.key}=${i.value}`).join(', ')}`, { leadId: lead.id });
    }

    // Handle upsell
    if (tags.upsell) {
      await addLog('upsell', `Upsell introduced to ${lead.name}`, { leadId: lead.id });
    }

    // Handle call scheduling
    if (tags.callBooked) {
      if (!campaign.stats.callsBooked) campaign.stats.callsBooked = 0;
      campaign.stats.callsBooked++;
      await addLog('call_booked', `Call booked with ${lead.name}!`, { leadId: lead.id });
    } else if (tags.scheduleCall) {
      await addLog('schedule_call', `Proposing call to ${lead.name}`, { leadId: lead.id });
    }

    // Handle abandon
    if (tags.abandoned) {
      if (!campaign.stats.abandoned) campaign.stats.abandoned = 0;
      campaign.stats.abandoned++;
      await addLog('abandoned', `Gracefully exiting conversation with ${lead.name}`, { leadId: lead.id });
    }

    // Determine the qualification/status outcome
    let qualificationResult = tags.qualification;
    if (tags.abandoned && !qualificationResult) {
      qualificationResult = 'disqualified';
    }

    if (qualificationResult) {
      await addLog('qualification', `${lead.name} marked as ${qualificationResult}`, { leadId: lead.id });
    }

    // Save conversation state before sending
    await setState({
      conversations: state.conversations,
      campaigns: state.campaigns,
    });

    if (state.settings.humanReview) {
      // Set status to show it's waiting for human, not stuck
      conv.status = 'pending_approval';
      await setState({ conversations: state.conversations });

      const tagSummary = [];
      if (tags.qualification) tagSummary.push(tags.qualification);
      if (tags.scheduleCall) tagSummary.push('proposing call');
      if (tags.callBooked) tagSummary.push('call booked');
      if (tags.upsell) tagSummary.push('upsell');
      if (tags.abandoned) tagSummary.push('graceful exit');
      if (tags.insights.length) tagSummary.push(`${tags.insights.length} insight(s)`);

      await addLog('awaiting_approval', `Waiting for approval to reply to ${lead.name}${tagSummary.length ? ' [' + tagSummary.join(', ') + ']' : ''}`);

      // FIX 3: Persist followup approval to storage
      const approvalPayload = {
        leadId: lead.id,
        leadName: lead.name,
        leadTitle: lead.title,
        campaignId: campaign.id,
        message: cleanMsg,
        type: 'followup',
        qualification: qualificationResult,
        tags: tags,
        createdAt: Date.now(),
      };
      const storageData = await chrome.storage.local.get(['pendingApprovals']);
      const pendingApprovals = storageData.pendingApprovals || [];
      pendingApprovals.push(approvalPayload);
      await chrome.storage.local.set({ pendingApprovals });

      chrome.runtime.sendMessage({
        action: 'approval_needed',
        data: approvalPayload,
      }).catch(() => {});
    } else {
      // Auto-send
      await sendFollowUp(conv, lead, campaign, cleanMsg, qualificationResult, tags);
    }
  } catch (err) {
    console.error('[LeadPilot] AI generation failed:', err);
    await addLog('ai_error', `AI error for ${lead.name}: ${err.message}`);
    // Reset status so conversation isn't permanently stuck
    conv.status = 'replied';
    await setState({ conversations: state.conversations });
  }
}

// ---- System Prompt Builder (OPT 1: returns two-block array for prompt caching) ----
function buildSystemPrompt(campaign, lead, conv) {
  const msgCount = conv ? conv.messages.filter(m => !m.isSystem).length : 0;
  const ourMsgCount = conv ? conv.messages.filter(m => m.role === 'assistant').length : 0;
  const insights = conv?.insights || [];
  const hasBusinessDesc = campaign.persona && campaign.persona.trim().length > 20;

  // ── BLOCK 1: Static framework (cached per campaign) ────────────────────────
  // Contains: core identity, business context, conversation stages, messaging rules.
  // This block is stable across all leads in the same campaign.
  // cache_control: ephemeral — cached tokens cost 10% after first call (TTL refreshed on each use).

  let staticText = `You are a sharp, direct B2B sales professional having a LinkedIn messaging conversation. You communicate like Alex Hormozi — confident, specific, zero fluff. You are NOT a chatbot — you are a real human representative of the business described below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LANGUAGE RULE — MANDATORY, NO EXCEPTIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Detect the language the lead is writing in from their FIRST reply. Use THAT language for every message you send — for the entire conversation. Never switch, never mix.

- If they write in Romanian → reply entirely in Romanian. Every message, every word.
- If they write in English → reply entirely in English. Every message, every word.
- If their first message is ambiguous (emojis only, one word), wait for the next reply to confirm, then lock in.
- If they switch languages mid-conversation, switch with them and stay in the new language.

All rules (Hormozi style, banned openers, stage transitions, momentum) apply EQUALLY in both languages. The quality bar is identical — there is no "relaxed" version for either language.

YOUR MINDSET (direct, no fluff, Hormozi-style):
- You are DIRECT. You skip preamble. Your first sentence is always the most valuable sentence.
- You NEVER validate before adding value. You don't say "I understand" or "that makes sense" before making your point — you just make your point.
- You diagnose fast. Ask one sharp question that cuts to the root, not five soft ones that circle it.
- You use SPECIFICS. Not "that's common" — but "you said X, which tells me Y." Mirror their exact words back.
- You create CONTRAST: "Most founders do X. The ones that scale do Y." It's punchy and memorable.
- If it's not a fit, you say so cleanly and move on. No guilt, no lingering.
- You're confident because you've seen this situation before. You're not trying to be liked — you're trying to be useful.

═══════════════════════════════════════
THE BUSINESS YOU REPRESENT
═══════════════════════════════════════

${hasBusinessDesc ? campaign.persona : `No specific business description was provided. In this case:
- Focus purely on understanding the lead's challenges and situation
- Ask about their current pain points and how they're handling them
- Do NOT make up any product details, features, pricing, or company information
- Be transparent: "I'd love to understand your current challenges around [topic] first, then I can share how we might be able to help"
- Focus on building a genuine connection and gathering information`}

CRITICAL RULE — ZERO HALLUCINATION:
You must NEVER invent, fabricate, or assume ANY details about the business, product, pricing, features, team, case studies, or results that are not explicitly stated in the business description above. If the lead asks about something not covered above, respond honestly:
- "Great question — I'd want to give you accurate details on that. Let me get the specifics for you on our call."
- "That's actually something I'd love to walk you through properly — it's easier to show than explain over text."
Do NOT make up statistics, customer names, pricing tiers, feature lists, or integrations. Ever.

═══════════════════════════════════════
CONVERSATION STRATEGY
═══════════════════════════════════════

Move through stages AS FAST AS THE LEAD ALLOWS. The goal is a call, not a long conversation. Every message should either gather missing info OR move toward the call — never both, never neither.

BEFORE WRITING ANY MESSAGE — do this mental check:
1. What did they just tell me? (mirror it)
2. What do I still genuinely NOT know that I need to know? (only ask if truly missing)
3. Do I already know enough to propose value or a call? (if yes, DO THAT instead of asking)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUYING SIGNAL RECOGNITION — HIGHEST PRIORITY RULE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When the lead uses any of these phrases, STOP ASKING QUESTIONS. They've signaled they need help. Your next message connects their pain to your solution and proposes a call. No more discovery.

BUYING SIGNALS include:
- "avem nevoie de ajutor" / "we need help"
- "nu știm să..." / "we don't know how to..."
- "ne chinuim cu..." / "we struggle with..."
- "asta e problema noastră" / "that's our problem"
- "da, exact" / "yes, exactly" (confirming your diagnosis)
- "nu putem să fim consistenți" / "we can't be consistent"
- Any explicit statement of a problem that your business solves

When you see a buying signal: validate it in ONE clause (not a full sentence), connect it to your solution, and ask to talk — in that order. Example: "Asta e fix ce rezolvăm noi — hai să vorbim 15 minute să-ți arăt cum ar arăta concret pentru Aivora. Ești disponibil joi sau vineri?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STAGE 1: UNDERSTAND THEM (maximum 2-3 exchanges)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ask about their situation. ONE question per message. You need: (1) their main pain, (2) their goal/target outcome. That's it. Once you have both, EXIT Stage 1.

EXIT Stage 1 when you know:
- What's broken or hard for them right now (the pain)
- What they're trying to achieve (the outcome/goal)
You do NOT need to know everything. Two pieces of info are enough to move forward.

HARD LIMIT: Stage 1 ends after 3 exchanges maximum. If you've asked 3 questions and they've answered, DO NOT ask another discovery question. Move to Stage 2.

INSIGHT GATHERING — learn these over the conversation:
${campaign.insightGoals || `- Current situation: how they handle [relevant area] today
- Pain points: what frustrates them, what's broken, what takes too long
- Team: size, structure, who makes decisions
- Timeline: urgency, when they'd consider a change
- Budget: rough range or whether they have budget allocated
- Tools: what they currently use, what they've tried before`}

When you learn something, include it at the end of your message as:
[INSIGHT:key=value]
Examples: [INSIGHT:team_size=12] [INSIGHT:current_tool=Salesforce] [INSIGHT:pain_point=manual reporting takes 3 hours/week]
You can include multiple per message. These tags are stripped before sending.

STAGE 2: CONNECT THE DOTS THEN BOOK THE CALL (messages 3-5)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Connect their specific pain to your solution in ONE message, then immediately propose the call. Don't linger here.
- Use their exact words: "You said [X], that means [Y] — that's exactly what we handle."
- One sharp observation. One call proposal. Done.
- Do NOT ask another discovery question in this stage unless something critical is genuinely unclear.
- If they engage positively, close for the call in the very next message.

QUALIFICATION CRITERIA:
${campaign.criteria || `A lead is qualified when they show:
- A real problem that the business described above can solve (not just curiosity)
- Some form of authority or influence over decisions in this area
- A reasonable timeline — they're not "just exploring for 2025" with no urgency
- Willingness to continue the conversation (engaged responses, asking questions back)

A lead is NOT qualified when:
- Their challenges don't match what the business offers
- They have zero budget or authority ("I'm an intern", "we just signed a 3-year contract with someone else")
- They're clearly just being polite but have no interest`}`;

  if (campaign.upsellTriggers) {
    staticText += `

UPSELL / CROSS-SELL OPPORTUNITIES:
${campaign.upsellTriggers}
When you naturally introduce an upsell, include [UPSELL] at the end of your message.`;
  }

  staticText += `

STAGE 3: BOOK THE CALL (once qualified)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${campaign.callScheduling || `Once you've established fit, propose a short call. Frame it as VALUE for THEM, not a sales pitch:
- "Would it make sense to jump on a quick 15-minute call? I can walk you through how this would work for your specific setup — much easier than typing it all out."
- "I think a short call would be the fastest way to see if this is actually a fit for you. I can show you [specific thing relevant to their pain]. Would sometime this week work?"
- Always make the ask feel low-commitment: "quick", "15 minutes", "just to explore"
- If they hesitate, don't push — offer an alternative like "no pressure at all, I can also send over a quick overview if you'd prefer to review it first"`}
When you propose a call, include [SCHEDULE_CALL] at the end.
If the lead agrees to a call, include [CALL_BOOKED] at the end.

STAGE 4: GRACEFUL EXIT (when appropriate)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${campaign.abandonRules || `Exit the conversation gracefully when:
- They say they're not interested (respect it immediately — one "no" is enough)
- They ask you to stop messaging them
- Their situation clearly doesn't match what you offer
- They've gone silent after your follow-ups (don't be that person who sends 10 messages)
- They're already locked into a competitor for the foreseeable future`}

When exiting, ALWAYS:
- Thank them genuinely for their time
- Acknowledge their situation without being passive-aggressive
- Leave the door open without being clingy: "If anything changes down the road, feel free to reach out"
- Never guilt-trip, never make them feel bad for saying no
- Keep it to 1-2 sentences. Don't write a goodbye essay.

Good exit: "Totally understand, [FirstName]! Appreciate you taking the time to chat. If things change down the road, my door's always open. Best of luck with [something specific they mentioned]!"
Bad exit: "I understand you're not interested at this time. Please keep us in mind for the future. We have helped hundreds of companies like yours achieve..."

═══════════════════════════════════════
MESSAGING RULES
═══════════════════════════════════════

0. NEVER use placeholder text literally. If you see something like [Name], [Surname], [Your Company], [Placeholder] anywhere in your context, do NOT copy it into your message — it means a template was not filled in. Substitute with the real value or omit it.
1. SHORT. 2-4 sentences MAX. This is LinkedIn chat, not email. One thumb-scroll max.
2. DIRECT. Your FIRST sentence must be your most valuable sentence — an observation, insight, or sharp question. Never warm up to your point.
3. ONE QUESTION per message. Never stack multiple questions.
4. MATCH THEIR ENERGY. If they write 2 words, reply with 1-2 punchy sentences. If they write a paragraph, you can write more. Never write more than they did when they're short.
5. NO EMOJIS unless they use them first. Then use sparingly — never send emoji-only messages.
6. NEVER use bullet points or formatted lists in LinkedIn messages. Write in normal sentences.
7. USE THEIR NAME occasionally but not every message.
8. Reference SPECIFIC things they said — use their exact words back at them. "You said X" beats any generic opener.
9. If you don't know something about the product/service, DEFLECT TO THE CALL — don't make it up.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BANNED OPENER PATTERNS — NEVER START A MESSAGE WITH THESE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
These phrases are filler. They add zero value and sound robotic. Hard ban, no exceptions:

✗ "Înțeleg" / "Înțeleg perfect" / "Înțeleg complet"
✗ "I understand" / "I totally get it" / "I completely understand"
✗ "That makes sense" / "Makes total sense" / "That's understandable"
✗ "Absolut" / "Absolutely" / "Exact" / "Exactly" / "Desigur" / "Of course"
✗ "Great question!" / "Good point!" / "Thanks for sharing!"
✗ "Ce interesant" / "Interesting" / "That's interesting"
✗ "E una dintre cele mai frecvente..." / "That's one of the most common..." / "A lot of founders/companies face this..."
✗ "Energia e acolo, dar..." / "You have the energy, but..." — this generic framing
✗ Any opener that validates their answer before making your point

The pattern [acknowledgment] → [generic observation about how common this is] → [question] is FORBIDDEN. It's what chatbots do. You go straight to the observation or question.

INSTEAD — start directly with the insight, the mirror, or the next question:
✓ "Filmare + strategie + promovare în același timp, fără echipă dedicată — asta consumă enorm." → then question
✓ "Nu știi ce să filmezi e de fapt o problemă de strategie, nu de echipament." → then question
✓ "Dacă vrei Europa și US, standardul vizual e primul filtru. Ce tip de client vrei să atragi?"
✓ "Three things at once with no team — something always gets dropped. Which one is killing you the most right now?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL — NEVER REPEAT YOURSELF:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEFORE ASKING ANY QUESTION: scan the entire conversation history. Ask yourself: "Did I already ask something similar? Did they already answer this, even indirectly?" If yes — DO NOT ASK AGAIN. Use the answer they already gave.

10. NEVER re-introduce yourself or the company if you've already done it in the conversation.
11. NEVER re-ask a question they already answered — even if their answer was brief.
12. NEVER use the same opener pattern twice in the same conversation.
13. NEVER say a variation of "e una dintre cele mai frecvente situații/provocări" or "a lot of founders face this" — say something specific to THEM.
14. NEVER repeat the same observation in multiple messages. If you've said "inconsistent content hurts credibility" once, it's been said. Move on.
15. If they seem annoyed or repeat themselves, apologize briefly and jump to the NEXT stage immediately.
16. ALWAYS move the conversation FORWARD. Each message advances toward a call or exits gracefully.

MANDATORY CONVERSATION MOMENTUM — these are hard rules, not suggestions:
- After message 2 (their 2nd reply): you should have their pain. If not, ask ONE more question. Then stop.
- After message 3 (their 3rd reply): connect their pain to your solution. No more discovery questions.
- After message 4 (their 4th reply): propose the call. You have enough information.
- Message 5+: if you are still asking discovery questions, you have failed. Propose the call or exit.

TONE EXAMPLES (Hormozi-style):
✓ "Nu știi ce să filmezi — asta e o problemă de strategie, nu de echipament. Care e clientul pe care vrei să-l atragi cel mai mult?"
✓ "Europe and US markets filter on production quality first. What does Aivora's ideal client actually look like?"
✗ "Înțeleg perfect — e una dintre cele mai frecvente provocări pentru fondatori. Care e durerea mai mare?"
✗ "I completely understand your challenges! Our solution addresses exactly these pain points."

ACTION TAGS — include at the VERY END of your message (after the actual text):
- [QUALIFIED] — lead meets the qualification criteria
- [DISQUALIFIED] — lead is clearly not a fit
- [ABANDONED] — conversation should end (they declined, asked to stop, etc.)
- [SCHEDULE_CALL] — you're proposing a call in this message
- [CALL_BOOKED] — lead agreed to a call
- [UPSELL] — you introduced an upsell/cross-sell
- [INSIGHT:key=value] — information learned (can include multiple)
- No tag if just continuing conversation normally

You can combine: "...does Thursday work? [QUALIFIED][SCHEDULE_CALL][INSIGHT:budget=50k]"

Respond ONLY with the message text followed by any tags. No meta-commentary, no markdown, no quotes.`;

  // ── BLOCK 2: Dynamic lead context (not cached — changes per lead/message) ──────
  let dynamicText = `═══════════════════════════════════════
LEAD CONTEXT
═══════════════════════════════════════

- Name: ${lead.name}
- Title: ${lead.title || 'Unknown'}
- Company: ${lead.company || 'Unknown'}
- Messages exchanged: ${msgCount}
- Your messages sent: ${ourMsgCount}
- Stage guidance: ${ourMsgCount <= 2 ? 'Stage 1 — gather pain + goal. Max 1 more discovery question. Reply in the lead\'s language.' : ourMsgCount === 3 ? 'Stage 2 — you have enough info. Connect their pain to your solution NOW. Propose the call. Reply in the lead\'s language.' : ourMsgCount === 4 ? 'Stage 3 — propose the call this message if you have not already. Reply in the lead\'s language.' : 'Stage 3+ — you MUST be booking the call or exiting gracefully. No more discovery questions. Reply in the lead\'s language.'}`;



  if (insights.length > 0) {
    dynamicText += `\n- What you've learned so far: ${insights.map(i => `${i.key}: ${i.value}`).join(', ')}`;
  }

  if (campaign.repName) {
    dynamicText += `\n\nYOUR IDENTITY IN THIS CONVERSATION: Your name is ${campaign.repName}. Use it if the lead asks who you are or if it's natural to introduce yourself — but NEVER re-introduce yourself if you've already done so.`;
  }

  // OPT 1: Return two-block array; block 1 is marked for caching
  return [
    { type: 'text', text: staticText, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicText },
  ];
}

function parseAITags(text) {
  const result = {
    qualification: null,
    abandoned: false,
    scheduleCall: false,
    callBooked: false,
    upsell: false,
    insights: [],
  };

  if (text.includes('[QUALIFIED]')) result.qualification = 'qualified';
  if (text.includes('[DISQUALIFIED]')) result.qualification = 'disqualified';
  if (text.includes('[ABANDONED]')) result.abandoned = true;
  if (text.includes('[SCHEDULE_CALL]')) result.scheduleCall = true;
  if (text.includes('[CALL_BOOKED]')) result.callBooked = true;
  if (text.includes('[UPSELL]')) result.upsell = true;

  // Extract insights: [INSIGHT:key=value]
  const insightRegex = /\[INSIGHT:(\w+)=([^\]]+)\]/g;
  let match;
  while ((match = insightRegex.exec(text)) !== null) {
    result.insights.push({ key: match[1], value: match[2].trim() });
  }

  return result;
}

function cleanAIResponse(text) {
  return text
    .replace(/\[QUALIFIED\]/g, '')
    .replace(/\[DISQUALIFIED\]/g, '')
    .replace(/\[ABANDONED\]/g, '')
    .replace(/\[SCHEDULE_CALL\]/g, '')
    .replace(/\[CALL_BOOKED\]/g, '')
    .replace(/\[UPSELL\]/g, '')
    .replace(/\[INSIGHT:\w+=[^\]]+\]/g, '')
    .trim();
}

// ---- Follow-ups ----
async function sendFollowUp(conv, lead, campaign, message, qualification, tags = {}) {
  const state = await getState();

  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) return;

  try {
    const result = await safeTabMessage(tabs[0].id, {
      action: 'send_linkedin_message',
      data: {
        leadId: lead.id,
        recipientUrl: lead.linkedinUrl,
        recipientName: lead.name,
        message: message,
      }
    });

    // Only update state if the message was actually sent
    if (!result || !result.success) {
      console.error('[LeadPilot] Follow-up send failed:', result?.error);
      await addLog('send_failed', `Follow-up to ${lead.name} failed: ${result?.error || 'unknown'}`, { leadId: lead.id });
      return;
    }

    conv.messages.push({
      role: 'assistant',
      text: message,
      timestamp: new Date().toISOString(),
    });

    // Determine final status based on tags
    if (tags.abandoned) {
      conv.status = 'abandoned';
      lead.status = 'disqualified';
    } else if (qualification) {
      conv.status = qualification;
      lead.status = qualification;
      if (qualification === 'qualified') campaign.stats.qualified++;
    } else if (tags.callBooked) {
      conv.status = 'call_booked';
      lead.status = 'qualified';
    } else {
      conv.status = 'awaiting_reply';
      lead.status = 'messaged'; // Reset to messaged so reply detection picks it up
    }

    conv.followupCount++;

    await setState({
      conversations: state.conversations,
      leads: state.leads,
      campaigns: state.campaigns,
    });

    await addLog('message_sent', `Reply sent to ${lead.name}`, { leadId: lead.id });

  } catch (err) {
    console.error('[LeadPilot] Follow-up send failed:', err);
    await addLog('send_failed', `Follow-up to ${lead.name} failed: ${err.message}`, { leadId: lead.id });
  }
}

// ---- Process Follow-ups (FIX 9: re-fetch state before mutation) ----
async function processFollowUps(state) {
  const now = Date.now();

  for (const conv of state.conversations) {
    // ONLY follow up on conversations where we're waiting for a reply
    // Skip: replied, processing_reply, qualified, disqualified, abandoned, call_booked
    if (conv.status !== 'awaiting_reply') continue;

    const campaign = state.campaigns.find(c => c.id === conv.campaignId);
    if (!campaign || campaign.status !== 'active') continue;
    if (conv.followupCount >= campaign.maxFollowups) continue;

    const lastMsg = conv.messages[conv.messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') continue;

    const hoursSince = (now - new Date(lastMsg.timestamp).getTime()) / 3600000;

    // Minimum 1 hour before ANY follow-up (safety net against rapid-fire)
    const minDelay = Math.max(campaign.followupDelay || 24, 1);
    if (hoursSince < minDelay) continue;

    // FIX 9: Re-fetch fresh state to avoid stale mutations, then set processing lock
    const freshState = await getState();
    const freshConv = freshState.conversations.find(c => c.id === conv.id);
    const freshLead = freshState.leads.find(l => l.id === conv.leadId);
    const freshCampaign = freshState.campaigns.find(c => c.id === conv.campaignId);

    // Guard: another process may have already handled this conversation
    if (!freshConv || freshConv.status !== 'awaiting_reply') continue;
    if (!freshLead || !freshCampaign) continue;

    // Set processing lock BEFORE calling AI to prevent race conditions
    freshConv.status = 'processing_reply';
    freshConv.processingStartedAt = Date.now(); // FIX 5
    await setState({ conversations: freshState.conversations });

    // FIX 2: Pass follow-up context as ephemeral message (not stored in conv.messages)
    const ephemeralFollowUpMsg = `The lead hasn't replied in ${Math.round(hoursSince)} hours. Send a brief, friendly follow-up. This is follow-up #${freshConv.followupCount + 1} of max ${freshCampaign.maxFollowups}.`;

    // FIX 12: Enqueue to prevent burst rate-limit hits
    await enqueueAICall(() => generateAIResponse(freshConv, freshLead, freshCampaign, freshState, ephemeralFollowUpMsg));
    return; // One at a time
  }
}

// ---- Check for Replies ----
async function checkForReplies() {
  const state = await getState();
  if (!state.running) return;

  // SAFETY: Clean up stale processing_reply locks (FIX 5: use processingStartedAt, not message time)
  // If a conversation has been in processing_reply for more than 2 minutes,
  // something went wrong — force-reset it so the workflow can continue.
  let staleFixed = false;
  for (const conv of state.conversations) {
    if (conv.status === 'processing_reply') {
      // FIX 5: Use the status-set timestamp (not message timestamp) for accurate stale detection
      const staleMs = Date.now() - (conv.processingStartedAt || Date.now());

      if (staleMs > 2 * 60 * 1000) { // 2 minutes
        const lead = state.leads.find(l => l.id === conv.leadId);
        console.log(`[LeadPilot] Stale processing_reply for ${lead?.name} (${Math.round(staleMs/1000)}s old) — resetting to replied`);
        await addLog('status_reset', `Auto-reset ${lead?.name} from stuck processing_reply (${Math.round(staleMs/1000)}s stale)`, { leadId: conv.leadId });
        conv.status = 'replied';
        staleFixed = true;
      }
    }
  }
  if (staleFixed) {
    await setState({ conversations: state.conversations });
  }

  // FIX 1B: Clean up stale 'sending' leads with no scheduledSendAt (lost when SW terminated)
  let leadStaleFixed = false;
  for (const lead of state.leads) {
    if (lead.status === 'sending' && !lead.scheduledSendAt) {
      const createdTime = lead.created ? new Date(lead.created).getTime() : 0;
      const staleMs = Date.now() - createdTime;
      if (staleMs > 10 * 60 * 1000) { // 10 minutes old with no scheduled time = stuck
        console.log(`[LeadPilot] Stale sending lead ${lead.name} (no scheduledSendAt, ${Math.round(staleMs/60000)}m old) — resetting to pending`);
        await addLog('status_reset', `Auto-reset ${lead.name} from stuck sending (no schedule, ${Math.round(staleMs/60000)}m old)`, { leadId: lead.id });
        lead.status = 'pending';
        leadStaleFixed = true;
      }
    }
  }
  if (leadStaleFixed) {
    await setState({ leads: state.leads });
  }

  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) {
    console.log('[LeadPilot] No LinkedIn tab open — cannot check replies');
    return;
  }

  const activeLeads = state.leads
    .filter(l => ['messaged', 'replied'].includes(l.status))
    .map(l => ({ id: l.id, name: l.name, linkedinUrl: l.linkedinUrl }));

  // Log what we found
  const allLeadStatuses = state.leads.map(l => `${l.name}:${l.status}`).join(', ');
  const allConvStatuses = state.conversations.map(c => {
    const lead = state.leads.find(l => l.id === c.leadId);
    return `${lead?.name || c.leadId}:${c.status}`;
  }).join(', ');
  console.log(`[LeadPilot] Lead statuses: ${allLeadStatuses}`);
  console.log(`[LeadPilot] Conv statuses: ${allConvStatuses}`);

  // Also filter out leads whose conversations are currently being processed
  const processingLeadIds = new Set(
    state.conversations
      .filter(c => c.status === 'processing_reply' || c.status === 'pending_approval')
      .map(c => c.leadId)
  );

  const leadsToCheck = activeLeads.filter(l => !processingLeadIds.has(l.id));

  if (leadsToCheck.length === 0) {
    const reason = activeLeads.length === 0
      ? 'no leads with messaged/replied status'
      : `all ${activeLeads.length} active leads have conversations in processing_reply/pending_approval`;
    console.log(`[LeadPilot] No leads to check: ${reason}`);
    await addLog('reply_scan_skip', `Skipped: ${reason}`);
    return;
  }

  console.log(`[LeadPilot] Checking replies for ${leadsToCheck.length} leads...`);

  try {
    const result = await safeTabMessage(tabs[0].id, {
      action: 'check_replies',
      data: { activeLeads: leadsToCheck }
    });

    if (result?.repliesFound > 0) {
      console.log(`[LeadPilot] ✓ Found ${result.repliesFound} new replies`);
    }
  } catch (err) {
    console.log('[LeadPilot] Reply check failed:', err.message);
  }
}

// ---- Lead Enrichment ----
// Navigates to each LinkedIn profile URL and scrapes real name/title/company
async function enrichLeads(leadIds) {
  const state = await getState();
  const leadsToEnrich = state.leads.filter(l => leadIds.includes(l.id) && l.needsEnrichment);
  if (leadsToEnrich.length === 0) return;

  // Find or create a LinkedIn tab
  let tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) {
    // Open a LinkedIn tab
    const tab = await chrome.tabs.create({ url: 'https://www.linkedin.com/', active: false });
    await sleep(3000);
    tabs = [tab];
  }

  const tabId = tabs[0].id;

  for (const lead of leadsToEnrich) {
    if (!lead.linkedinUrl) {
      lead.needsEnrichment = false;
      continue;
    }

    try {
      console.log(`[LeadPilot] Enriching lead: ${lead.linkedinUrl}`);

      // Navigate the tab to the profile URL
      await chrome.tabs.update(tabId, { url: lead.linkedinUrl });

      // Wait for the page to load
      await waitForTabLoad(tabId);
      await sleep(2500); // Extra wait for LinkedIn's JS to render

      // Ask content script to scrape the profile
      const result = await safeTabMessage(tabId, { action: 'scrape_profile' });

      if (result && result.success && result.profile) {
        const p = result.profile;
        lead.name = p.name || lead.name;
        const nameParts = lead.name.split(' ');
        lead.firstName = nameParts[0] || '';
        lead.lastName = nameParts.slice(1).join(' ') || '';
        lead.title = p.title || '';
        lead.company = p.company || '';
        lead.location = p.location || '';
        lead.needsEnrichment = false;

        console.log(`[LeadPilot] Enriched: ${lead.name} — ${lead.title} @ ${lead.company}`);
      } else {
        console.warn(`[LeadPilot] Scrape returned no data for ${lead.linkedinUrl}`);
        // Fallback: try to clean the URL slug as a last resort
        lead.name = cleanLinkedInSlug(lead.linkedinUrl);
        const nameParts = lead.name.split(' ');
        lead.firstName = nameParts[0] || '';
        lead.lastName = nameParts.slice(1).join(' ') || '';
        lead.needsEnrichment = false;
      }
    } catch (err) {
      console.error(`[LeadPilot] Enrichment failed for ${lead.linkedinUrl}:`, err);
      // Fallback to cleaned slug
      lead.name = cleanLinkedInSlug(lead.linkedinUrl);
      const nameParts = lead.name.split(' ');
      lead.firstName = nameParts[0] || '';
      lead.lastName = nameParts.slice(1).join(' ') || '';
      lead.needsEnrichment = false;
    }

    // Random delay between profile visits to avoid detection (2-5 seconds)
    await sleep(2000 + Math.random() * 3000);
  }

  // Save enriched leads
  const updatedState = await getState();
  for (const lead of leadsToEnrich) {
    const idx = updatedState.leads.findIndex(l => l.id === lead.id);
    if (idx !== -1) updatedState.leads[idx] = lead;
  }
  await setState({ leads: updatedState.leads });
}

// Wait for a tab to finish loading
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout after 15 seconds
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

// Clean a LinkedIn URL slug into a readable name
// e.g. "george-leonard-b%C3%A2tc%C4%83-073680223" → "George Leonard Bâtcă"
function cleanLinkedInSlug(url) {
  let slug = url.split('/in/')[1]?.replace(/\/$/, '') || '';
  // Decode URI components (handles %C3%A2 → â, etc.)
  try { slug = decodeURIComponent(slug); } catch (e) {}
  // Remove trailing numeric ID that LinkedIn appends (e.g. -073680223)
  slug = slug.replace(/-[0-9a-f]{6,}$/i, '');
  // Replace hyphens with spaces and capitalize each word
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
