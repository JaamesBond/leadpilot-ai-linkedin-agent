// ============================================================
// LeadPilot AI — Content Script
// Runs on LinkedIn pages to interact with messaging UI
//
// ARCHITECTURE NOTE:
// LinkedIn is a React SPA with obfuscated/changing class names.
// This script uses a MULTI-STRATEGY approach for every DOM interaction:
//   1. Try known class-based selectors (may break with LinkedIn updates)
//   2. Try role/aria-based selectors (more stable)
//   3. Try text-content based search (most resilient)
//   4. Log detailed errors when all strategies fail
//
// If selectors break after a LinkedIn update, open DevTools on
// linkedin.com/messaging, inspect the elements, and update the
// SELECTORS object below.
// ============================================================

(() => {
  'use strict';

  if (window.__leadpilot_loaded) return;
  window.__leadpilot_loaded = true;

  const LOG_PREFIX = '[LeadPilot]';
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);
  const logErr = (...args) => console.error(LOG_PREFIX, ...args);

  // ==========================================================
  // CONTEXT INVALIDATION DETECTION
  // When the extension is reloaded/updated, the content script
  // becomes orphaned — chrome.* APIs throw "Extension context
  // invalidated". We detect this and stop all intervals/listeners
  // so the old script dies cleanly and a new one can be injected.
  // ==========================================================

  let contextValid = true;

  function isContextValid() {
    try {
      // This will throw if context is invalidated
      void chrome.runtime.id;
      return true;
    } catch (e) {
      return false;
    }
  }

  function onContextInvalidated() {
    if (!contextValid) return; // Already handled
    contextValid = false;
    warn('Extension context invalidated — stopping all intervals');

    // Stop countdown and refresh intervals
    if (panelState.countdownInterval) clearInterval(panelState.countdownInterval);
    if (panelState.refreshInterval) clearInterval(panelState.refreshInterval);

    // Allow re-injection by clearing the loaded flag
    window.__leadpilot_loaded = false;
  }

  // Safe wrapper for chrome.storage.local.get
  function safeStorageGet(keys, callback) {
    if (!isContextValid()) { onContextInvalidated(); return; }
    try {
      chrome.storage.local.get(keys, (data) => {
        if (chrome.runtime.lastError) {
          onContextInvalidated();
          return;
        }
        callback(data);
      });
    } catch (e) {
      onContextInvalidated();
    }
  }

  // Safe wrapper for chrome.runtime.sendMessage
  function safeSendMessage(msg) {
    if (!isContextValid()) { onContextInvalidated(); return; }
    try {
      chrome.runtime.sendMessage(msg).catch(() => onContextInvalidated());
    } catch (e) {
      onContextInvalidated();
    }
  }

  log('Content script loaded on', window.location.href);

  // ==========================================================
  // SELECTORS — Update these when LinkedIn changes their DOM
  // Each key has an array of selectors tried in order.
  // ==========================================================
  const SELECTORS = {
    // The message compose textbox (contenteditable div)
    composeBox: [
      'div.msg-form__contenteditable[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"][aria-label*="message"]',
      'div[role="textbox"][contenteditable="true"][aria-label*="Write"]',
      'div[role="textbox"][contenteditable="true"]',
      '.msg-form__contenteditable',
      'div[contenteditable="true"][data-placeholder*="Write a message"]',
      'div[contenteditable="true"][aria-placeholder*="Write a message"]',
    ],

    // Send button
    sendButton: [
      'button.msg-form__send-button',
      'button.msg-form__send-btn',
      'button[type="submit"][class*="msg-form"]',
      'form.msg-form button[type="submit"]',
    ],

    // "New message" / compose button in messaging
    newMessageButton: [
      'a[href="/messaging/thread/new/"]',
      'button[class*="msg-overlay-bubble-header__button--new-convo"]',
      'button[data-control-name="overlay.new_message"]',
      '.msg-conversations-container__title-row button',
    ],

    // "To" field when composing a new message
    recipientInput: [
      'input[name="msgSessionInput"]',
      'input[role="combobox"][aria-label*="Type a name"]',
      'input[role="combobox"][placeholder*="Type a name"]',
      '.msg-connections-typeahead__top-fixed input',
      '.msg-compose-form input[role="combobox"]',
      'input[placeholder*="recipient"]',
    ],

    // Typeahead suggestion results
    recipientSuggestion: [
      '.msg-connections-typeahead__search-result',
      '.basic-typeahead__selectable',
      'li[role="option"]',
      '[data-entity-urn*="MINI_PROFILE"]',
    ],

    // Profile page selectors
    profileName: [
      'h1.text-heading-xlarge',
      'h1[class*="text-heading"]',
      '.pv-top-card h1',
      'h1',
    ],

    profileTitle: [
      'div.text-body-medium.break-words',
      '.pv-top-card .text-body-medium',
    ],

    profileCompany: [
      'button[aria-label*="Current company"] span',
      '.pv-top-card--experience-list-item',
    ],

    profileLocation: [
      'span.text-body-small.inline.t-black--light.break-words',
      '.pv-top-card .pb2.pv-text-details__left-panel .text-body-small',
    ],

    // Conversation cards in messaging list
    conversationCard: [
      '.msg-conversation-card',
      '.msg-conversation-listitem',
      'li[class*="msg-conversation"]',
    ],

    // Message body elements in an open conversation
    messageBody: [
      '.msg-s-event-listitem__body',
      '.msg-s-message-group__content',
      '.msg-s-event__content',
    ],
  };

  // ==========================================================
  // SELECTOR HELPERS
  // ==========================================================

  function queryFirst(selectorArray, context = document) {
    for (const sel of selectorArray) {
      try {
        const el = context.querySelector(sel);
        if (el) return el;
      } catch (e) { /* invalid selector, skip */ }
    }
    return null;
  }

  function queryAll(selectorArray, context = document) {
    const results = [];
    for (const sel of selectorArray) {
      try {
        context.querySelectorAll(sel).forEach(el => {
          if (!results.includes(el)) results.push(el);
        });
      } catch (e) { /* skip */ }
    }
    return results;
  }

  function findButtonByText(text) {
    const buttons = document.querySelectorAll('button, a[role="button"]');
    const lower = text.toLowerCase();
    for (const btn of buttons) {
      if (btn.textContent.trim().toLowerCase().includes(lower)) return btn;
    }
    return null;
  }

  function waitForAny(selectorArray, timeout = 12000) {
    return new Promise((resolve, reject) => {
      const el = queryFirst(selectorArray);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = queryFirst(selectorArray);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Selectors not found within ${timeout}ms: ${selectorArray.join(' | ')}`));
      }, timeout);
    });
  }

  // ==========================================================
  // EVENT SIMULATION
  // LinkedIn uses React — we need to fire events that React
  // actually listens to (native DOM events bubbling up).
  // ==========================================================

  async function simulateNativeInput(element, text) {
    element.focus();

    // For regular <input> elements
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(element, text);
      } else {
        element.value = text;
      }

      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));

      // Fire keyboard events for React's synthetic event system
      for (const char of text) {
        element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      }
      return;
    }

    // For contenteditable divs (LinkedIn messaging)
    // Must type character-by-character so React registers the input
    if (element.contentEditable === 'true' || element.getAttribute('role') === 'textbox') {
      const p = element.querySelector('p');
      const target = p || element;

      element.click();
      target.focus();

      // Clear existing content
      target.innerHTML = '<br>';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(200);

      // Type each character with full keyboard event cycle
      for (const char of text) {
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: char, code: `Key${char.toUpperCase()}`, bubbles: true
        }));
        document.execCommand('insertText', false, char);
        target.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: char
        }));
        target.dispatchEvent(new KeyboardEvent('keyup', {
          key: char, code: `Key${char.toUpperCase()}`, bubbles: true
        }));
        await sleep(15);
      }
    }
  }

  // ==========================================================
  // UTILITIES
  // ==========================================================

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitForNavigation(timeout = 15000) {
    return new Promise(resolve => {
      const done = () => { window.removeEventListener('load', done); resolve(); };
      window.addEventListener('load', done);
      setTimeout(resolve, timeout);
    });
  }

  // ==========================================================
  // MESSAGE LISTENER
  // ==========================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case 'send_linkedin_message':
        handleSendMessage(msg.data)
          .then(result => sendResponse(result))
          .catch(e => sendResponse({ success: false, error: e.message }));
        return true;

      case 'check_replies':
        handleCheckReplies(msg.data)
          .then(result => sendResponse(result))
          .catch(e => sendResponse({ success: false, error: e.message }));
        return true;

      case 'scrape_profile':
        handleScrapeProfile()
          .then(result => sendResponse(result))
          .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }
  });

  // ==========================================================
  // SEND MESSAGE — Main flow
  // Uses the messaging OVERLAY to send messages without navigating
  // away from the current page. This prevents page refreshes that
  // kill the content script and reset the overlay state.
  //
  // Flow: Open overlay → find/create conversation → type → send → close
  // ==========================================================

  async function handleSendMessage(data) {
    const { recipientUrl, recipientName, message } = data;
    log(`Starting send flow → ${recipientName}`);

    // Step 1: Ensure the overlay is open
    const overlay = document.querySelector('.msg-overlay-list-bubble');
    if (!overlay) {
      throw new Error('Messaging overlay not found. Make sure you are on a LinkedIn page.');
    }

    const isMinimized = overlay.className.includes('minimized');
    if (isMinimized) {
      log('Expanding messaging overlay...');
      const headerBtn = document.querySelector('.msg-overlay-bubble-header__button');
      if (headerBtn) {
        headerBtn.click();
        await sleep(1500);
      }
    }

    // Step 2: Try to find existing conversation in the overlay
    // FIX 10: Stricter name matching to prevent wrong-person sends
    let found = false;
    const cards = overlay.querySelectorAll('.msg-conversation-card');
    const nameLC = recipientName.toLowerCase();
    const nameParts = nameLC.split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ');

    for (const card of cards) {
      const nameEl = card.querySelector('h3');
      if (!nameEl) continue;
      const cardName = nameEl.textContent.trim().toLowerCase();

      // FIX 10: Strict matching — require full name or both first+last name
      let nameMatch = false;

      // 1. Exact full name match (preferred)
      if (cardName === nameLC) {
        nameMatch = true;
      }
      // 2. Card name contains full name (e.g. "John Smith 🔵")
      else if (cardName.includes(nameLC) && nameLC.length >= 3) {
        nameMatch = true;
      }
      // 3. Full name contains card name (only if card name is long enough to be unambiguous)
      else if (nameLC.includes(cardName) && cardName.length >= 5) {
        nameMatch = true;
      }
      // 4. First name match ONLY if last name also present and matches
      else if (firstName.length >= 3 && lastName.length >= 2) {
        if (cardName.includes(firstName) && cardName.includes(lastName)) {
          nameMatch = true;
        }
      }

      if (!nameMatch) continue;

      log(`Found existing conversation with ${recipientName} in overlay`);
      const clickTarget = card.closest('a, [class*="listitem__link"]') || card;
      clickTarget.click();
      await sleep(2000);
      found = true;
      break;
    }

    // Step 3: If no existing conversation, start a new one via the overlay compose button
    if (!found) {
      log('No existing conversation found, composing new message...');
      await composeNewMessageViaOverlay(recipientName);
    }

    // Step 4: Find the compose box (now inside the overlay conversation bubble)
    log('Looking for compose box...');
    let composeBox;
    try {
      composeBox = await waitForAny(SELECTORS.composeBox, 10000);
    } catch (e) {
      // Try broader fallback
      composeBox = document.querySelector('div[contenteditable="true"][role="textbox"]')
        || document.querySelector('div.msg-form__contenteditable');
      if (!composeBox) {
        throw new Error('COMPOSE BOX NOT FOUND after opening conversation');
      }
    }
    log('Compose box found');

    // Step 5: Type the message
    await sleep(500);
    await simulateNativeInput(composeBox, message);
    log('Message typed');
    await sleep(800);

    // Step 6: Find and click Send
    let sendBtn = queryFirst(SELECTORS.sendButton);
    if (!sendBtn) sendBtn = findButtonByText('Send');
    if (!sendBtn) {
      const form = composeBox.closest('form');
      if (form) sendBtn = form.querySelector('button[type="submit"]');
    }
    if (!sendBtn) {
      throw new Error('SEND BUTTON NOT FOUND');
    }

    await sleep(500);
    if (sendBtn.disabled) {
      warn('Send button disabled, waiting...');
      await sleep(2000);
      if (sendBtn.disabled) {
        throw new Error('Send button still disabled — text not registered');
      }
    }

    sendBtn.click();
    log('Send button clicked');
    await sleep(1500);

    // Step 7: Verify (compose box should be empty)
    const boxAfterSend = queryFirst(SELECTORS.composeBox);
    if (boxAfterSend && boxAfterSend.textContent.trim() === message) {
      throw new Error('Message still in compose box — send may have failed');
    }

    // Step 8: Close the conversation bubble to go back to the list
    await closeConversationBubble();

    log(`✓ Message sent to ${recipientName}`);
    return { success: true };
  }

  // ==========================================================
  // COMPOSE NEW MESSAGE VIA OVERLAY
  // Uses the "new message" button in the overlay header to start
  // a new conversation without navigating away.
  // ==========================================================

  async function composeNewMessageViaOverlay(name) {
    // Click new message button in overlay header
    const newMsgBtn = document.querySelector(
      '.msg-overlay-bubble-header__control--new-convo-btn, ' +
      'button[class*="msg-overlay-bubble-header__control--new-convo"]'
    );

    if (!newMsgBtn) {
      // Fallback: try generic new message selectors
      const btn = queryFirst(SELECTORS.newMessageButton) || findButtonByText('New message');
      if (btn) {
        btn.click();
      } else {
        throw new Error('Could not find new message button in overlay');
      }
    } else {
      newMsgBtn.click();
    }

    log('Clicked new message button in overlay');
    await sleep(1500);

    // Fill the "To" / recipient field
    let toField;
    try {
      toField = await waitForAny(SELECTORS.recipientInput, 8000);
    } catch (e) {
      throw new Error('RECIPIENT INPUT NOT FOUND in overlay compose');
    }

    log('Filling recipient field with:', name);
    await simulateNativeInput(toField, name);
    await sleep(2500);

    // Click first typeahead suggestion
    let suggestion;
    try {
      suggestion = await waitForAny(SELECTORS.recipientSuggestion, 5000);
    } catch (e) {
      suggestion = null;
    }

    // FIX 13: Throw descriptive error when no typeahead suggestion found
    if (!suggestion) {
      throw new Error(`NOT_A_CONNECTION: "${name}" returned no typeahead results. They may not be a LinkedIn connection, or their name doesn't match exactly.`);
    }

    suggestion.click();
    log('Selected recipient from typeahead');
    await sleep(1000);
  }

  // ==========================================================
  // CLOSE CONVERSATION BUBBLE
  // After sending a message, close the overlay conversation to
  // return to the conversation list. This prevents the next
  // reply from being auto-read.
  // ==========================================================

  async function closeConversationBubble() {
    // Try the X / close button on the conversation bubble
    const closeBtn = document.querySelector(
      'button[data-control-name="overlay.close_conversation_window"], ' +
      'button[class*="msg-overlay-conversation-bubble__close"], ' +
      'button[aria-label*="Close your conversation"]'
    );

    if (closeBtn) {
      closeBtn.click();
      log('Closed conversation bubble');
      await sleep(500);
      return;
    }

    // Try the back button to return to the list
    const backBtn = document.querySelector(
      'button[class*="msg-overlay-conversation-bubble__back"], ' +
      'button[aria-label*="Go back"], ' +
      'button[aria-label*="Back to"]'
    );

    if (backBtn) {
      backBtn.click();
      log('Clicked back to conversation list');
      await sleep(500);
      return;
    }

    // Last resort: minimize the whole overlay and reopen it
    const headerBtn = document.querySelector('.msg-overlay-bubble-header__button');
    if (headerBtn) {
      headerBtn.click();
      await sleep(300);
      headerBtn.click();
      await sleep(500);
    }

    warn('Could not find close/back button for conversation bubble');
  }

  // ==========================================================
  // CHECK FOR REPLIES
  //
  // Detection strategy (multi-signal):
  //   1. Font-weight 600 on name = LinkedIn marks it unread (primary signal)
  //   2. Preview NOT starting with "You:" = they sent the last message
  //   3. Cross-reference with our state: if we're awaiting_reply and
  //      preview doesn't start with "You:", it's a new reply even if
  //      font-weight is 400 (because opening the conv to send marks it read)
  //
  // We do NOT click into conversations. Reply text comes from preview.
  // Deduplication via processedReplies Set (leadId:hash).
  // ==========================================================

  // FIX 7: processedReplies persisted to chrome.storage.session (survives page navigations)
  const processedReplies = new Set();

  // FIX 7: Initialize processedReplies from session storage on script load
  (async function initProcessedReplies() {
    try {
      const data = await chrome.storage.session.get(['processedReplyKeys']);
      if (data.processedReplyKeys && Array.isArray(data.processedReplyKeys)) {
        for (const key of data.processedReplyKeys) {
          processedReplies.add(key);
        }
        log(`Loaded ${processedReplies.size} processed reply keys from session storage`);
      }
    } catch (e) {
      // chrome.storage.session may not be available in all contexts — fail silently
      warn('Could not load processedReplyKeys from session storage:', e.message);
    }
  })();

  // FIX 7: Persist a new reply key to session storage
  function persistReplyKey(key) {
    processedReplies.add(key);
    try {
      // Cap at 300 entries to avoid unbounded growth
      chrome.storage.session.set({
        processedReplyKeys: [...processedReplies].slice(-300)
      }).catch(() => {}); // Fail silently
    } catch (e) {
      // Ignore — in-memory set is still updated
    }
  }

  async function handleCheckReplies(data) {
    const { activeLeads } = data;
    log(`Checking replies for ${activeLeads.length} active leads...`);

    if (activeLeads.length === 0) {
      return { success: true, repliesFound: 0 };
    }

    // Step 1: Make sure the messaging overlay is open
    const overlay = document.querySelector('.msg-overlay-list-bubble');
    if (!overlay) {
      warn('Messaging overlay not found on page');
      return { success: false, error: 'No messaging overlay' };
    }

    const isMinimized = overlay.className.includes('minimized');
    if (isMinimized) {
      log('Expanding messaging overlay...');
      const headerBtn = document.querySelector('.msg-overlay-bubble-header__button');
      if (headerBtn) {
        headerBtn.click();
        await sleep(2000);
      }
    }

    // FIX 6: Scroll-to-load — collect cards across multiple scroll iterations
    // LinkedIn lazy-loads conversation cards; we need to scroll to reveal more.
    const scannedCardElements = new Set();
    let allCards = [];

    // Initial scan
    const initialCards = overlay.querySelectorAll('.msg-conversation-card');
    for (const card of initialCards) {
      if (!scannedCardElements.has(card)) {
        scannedCardElements.add(card);
        allCards.push(card);
      }
    }

    // FIX 6: Scroll up to 3 times to load more conversation cards
    const scrollContainer = overlay.querySelector(
      '.msg-conversations-container__conversations-list, ' +
      '.msg-overlay-list-bubble__content, ' +
      '.msg-conversation-card'
    )?.closest('[class*="conversations"]') ||
    overlay.querySelector('[class*="conversations-list"], [class*="overlay-list"]');

    if (scrollContainer) {
      for (let scrollIter = 0; scrollIter < 3; scrollIter++) {
        scrollContainer.scrollTop += 300;
        await sleep(800);
        const newCards = overlay.querySelectorAll('.msg-conversation-card');
        let foundNew = false;
        for (const card of newCards) {
          if (!scannedCardElements.has(card)) {
            scannedCardElements.add(card);
            allCards.push(card);
            foundNew = true;
          }
        }
        if (!foundNew) break; // No more cards loaded, stop scrolling
      }
      // Scroll back to top after scanning
      scrollContainer.scrollTop = 0;
    }

    log(`Found ${allCards.length} conversation cards (after scroll-to-load)`);

    const detectedReplies = [];

    for (const card of allCards) {
      const nameEl = card.querySelector('h3');
      if (!nameEl) continue;
      const convName = nameEl.textContent.trim();

      // Get font-weight and preview
      const fontWeight = parseInt(getComputedStyle(nameEl).fontWeight) || 400;
      const isUnread = fontWeight >= 600;

      const previewEl = card.querySelector('p');
      const preview = previewEl?.textContent.trim() || '';
      const weSentLast = preview.toLowerCase().startsWith('you:');

      // FIX 10: Stricter name matching for reply detection
      for (const lead of activeLeads) {
        const leadFullName = lead.name.toLowerCase();
        const leadFirstName = leadFullName.split(' ')[0];
        const leadLastName = leadFullName.split(' ').slice(1).join(' ');
        const convNameLower = convName.toLowerCase();

        // FIX 10: Require minimum name length and stricter matching
        if (leadFirstName.length < 3) continue; // Skip ambiguous short names

        let nameMatch = false;

        // 1. Full name match (most reliable)
        if (convNameLower.includes(leadFullName) && leadFullName.length >= 3) {
          nameMatch = true;
        }
        // 2. Card name is contained in our lead's full name (e.g. lead "John Smith", card "John Smith 🔵")
        else if (leadFullName.includes(convNameLower) && convNameLower.length >= 5) {
          nameMatch = true;
        }
        // 3. First AND last name both present in card name
        else if (leadLastName.length >= 2 && convNameLower.includes(leadFirstName) && convNameLower.includes(leadLastName)) {
          nameMatch = true;
        }
        // Note: firstName-only matching removed — too many false positives (FIX 10)

        if (!nameMatch) continue;

        // Log what we see for debugging
        log(`Card: ${convName} | weight: ${fontWeight} | unread: ${isUnread} | preview: "${preview.slice(0, 50)}" | weSentLast: ${weSentLast}`);

        // DECISION: Is this a reply we should process?
        if (weSentLast) {
          // Preview shows "You: ..." — we sent the last message, no new reply
          break;
        }

        // If we get here: the preview does NOT start with "You:", meaning
        // the lead sent the last message. This is a reply.

        // Extract reply text from preview (strip "Name: " prefix)
        let replyText = preview;
        const colonIdx = preview.indexOf(':');
        if (colonIdx > 0 && colonIdx < 40) {
          replyText = preview.slice(colonIdx + 1).trim();
        }

        if (!replyText) {
          log(`Empty reply text for ${convName}, skipping`);
          break;
        }

        // Filter out emoji-only reactions and very short non-text replies
        const textOnly = replyText.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\u200d\uFE0F]/gu, '').trim();
        if (textOnly.length < 2) {
          log(`Emoji/reaction only from ${convName}: "${replyText}", skipping`);
          break;
        }

        // Deduplicate — have we already processed this exact reply?
        const replyKey = `${lead.id}:${simpleHash(replyText)}`;
        if (processedReplies.has(replyKey)) {
          log(`Already processed reply from ${convName} (key: ${replyKey})`);
          break;
        }

        log(`✓ New reply from ${convName}: "${replyText.slice(0, 80)}"`);
        // FIX 7: Persist reply key to session storage
        persistReplyKey(replyKey);

        detectedReplies.push({ leadId: lead.id, replyText, leadName: convName });

        safeSendMessage({
          action: 'new_reply_detected',
          data: { leadId: lead.id, replyText }
        });

        break;
      }
    }

    // Re-minimize if we expanded it
    if (isMinimized) {
      const headerBtn = document.querySelector('.msg-overlay-bubble-header__button');
      if (headerBtn) {
        headerBtn.click();
        await sleep(500);
      }
    }

    log(`Reply check done. ${detectedReplies.length} new replies. Scanned ${allCards.length} cards total.`);
    return { success: true, repliesFound: detectedReplies.length };
  }

  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString(36);
  }

  // ==========================================================
  // PROFILE SCRAPING
  // ==========================================================

  async function handleScrapeProfile() {
    try {
      await sleep(1000);
      const name = queryFirst(SELECTORS.profileName)?.textContent.trim() || '';
      const title = queryFirst(SELECTORS.profileTitle)?.textContent.trim() || '';
      const company = queryFirst(SELECTORS.profileCompany)?.textContent.trim() || '';
      const location = queryFirst(SELECTORS.profileLocation)?.textContent.trim() || '';

      log('Scraped profile:', { name, title, company, location });
      return { success: !!(name), profile: { name, title, company, location } };
    } catch (e) {
      logErr('Profile scrape failed:', e);
      return { success: false, error: e.message };
    }
  }

  // ==========================================================
  // PERSISTENT SIDE PANEL
  // A docked panel on the right side of the LinkedIn page showing
  // real-time status, countdown timers, and activity log.
  // ==========================================================

  let panelState = {
    collapsed: false,
    countdownInterval: null,
  };

  function injectSidePanel() {
    if (document.getElementById('leadpilot-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'leadpilot-panel';
    panel.innerHTML = `
      <style>
        #leadpilot-panel {
          position: fixed;
          top: 0;
          right: 0;
          width: 280px;
          height: 100vh;
          background: #0F172A;
          border-left: 1px solid #1E293B;
          z-index: 99998;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 12px;
          color: #CBD5E1;
          display: flex;
          flex-direction: column;
          transition: transform 0.25s ease;
          box-shadow: -4px 0 24px rgba(0,0,0,0.3);
        }
        #leadpilot-panel.collapsed {
          transform: translateX(244px);
        }
        #leadpilot-panel .lp-grab-tab {
          display: none;
        }
        #leadpilot-panel.collapsed .lp-grab-tab {
          display: flex;
          position: absolute;
          left: -32px;
          top: 50%;
          transform: translateY(-50%);
          width: 32px;
          height: 72px;
          background: #0F172A;
          border: 1px solid #1E293B;
          border-right: none;
          border-radius: 8px 0 0 8px;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          color: #38BDF8;
          font-size: 14px;
          font-weight: 700;
          writing-mode: vertical-lr;
          letter-spacing: 1px;
          box-shadow: -4px 0 12px rgba(0,0,0,0.2);
        }
        #leadpilot-panel.collapsed .lp-grab-tab:hover {
          background: #1E293B;
          width: 36px;
          left: -36px;
        }

        .lp-header {
          padding: 12px 14px;
          border-bottom: 1px solid #1E293B;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
        }
        .lp-logo {
          display: flex;
          align-items: center;
          gap: 7px;
          font-weight: 700;
          font-size: 13px;
          color: #F1F5F9;
        }
        .lp-logo-accent { color: #38BDF8; }
        .lp-collapse-btn {
          background: none;
          border: 1px solid #334155;
          color: #94A3B8;
          width: 26px;
          height: 26px;
          border-radius: 5px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          transition: all 0.15s;
        }
        .lp-collapse-btn:hover { background: #1E293B; color: #F1F5F9; }

        .lp-status-bar {
          padding: 10px 14px;
          border-bottom: 1px solid #1E293B;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }
        .lp-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .lp-status-dot.running { background: #34D399; animation: lp-pulse-anim 1.5s infinite; }
        .lp-status-dot.stopped { background: #64748B; }
        .lp-status-text { font-weight: 600; color: #F1F5F9; }

        @keyframes lp-pulse-anim {
          0%,100% { box-shadow: 0 0 0 0 rgba(52,211,153,0.4); }
          50% { box-shadow: 0 0 0 5px rgba(52,211,153,0); }
        }

        .lp-timers {
          padding: 10px 14px;
          border-bottom: 1px solid #1E293B;
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex-shrink: 0;
        }
        .lp-timer-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .lp-timer-label { color: #94A3B8; font-size: 11px; }
        .lp-timer-value {
          font-weight: 700;
          font-size: 13px;
          font-variant-numeric: tabular-nums;
          color: #38BDF8;
        }
        .lp-timer-value.imminent { color: #FBBF24; }
        .lp-timer-value.now { color: #34D399; }

        .lp-progress-bar {
          width: 100%;
          height: 3px;
          background: #1E293B;
          border-radius: 2px;
          overflow: hidden;
          margin-top: 2px;
        }
        .lp-progress-fill {
          height: 100%;
          background: #38BDF8;
          border-radius: 2px;
          transition: width 1s linear;
        }

        .lp-stats {
          padding: 10px 14px;
          border-bottom: 1px solid #1E293B;
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          flex-shrink: 0;
        }
        .lp-stat {
          background: #1E293B;
          border-radius: 6px;
          padding: 8px 10px;
          text-align: center;
        }
        .lp-stat-value {
          font-size: 18px;
          font-weight: 800;
          color: #F1F5F9;
          line-height: 1;
        }
        .lp-stat-label {
          font-size: 10px;
          color: #64748B;
          margin-top: 3px;
          text-transform: uppercase;
          letter-spacing: 0.3px;
        }

        .lp-log-header {
          padding: 8px 14px;
          font-weight: 700;
          font-size: 11px;
          color: #64748B;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px solid #1E293B;
          flex-shrink: 0;
        }

        .lp-log {
          flex: 1;
          overflow-y: auto;
          padding: 6px 0;
        }
        .lp-log::-webkit-scrollbar { width: 4px; }
        .lp-log::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }

        .lp-log-entry {
          padding: 6px 14px;
          display: flex;
          gap: 8px;
          align-items: flex-start;
          border-bottom: 1px solid rgba(30,41,59,0.5);
          transition: background 0.15s;
        }
        .lp-log-entry:hover { background: rgba(30,41,59,0.5); }
        .lp-log-entry.new { animation: lp-flash 0.6s ease; }

        @keyframes lp-flash {
          0% { background: rgba(56,189,248,0.15); }
          100% { background: transparent; }
        }

        .lp-log-icon {
          width: 18px;
          height: 18px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          flex-shrink: 0;
          margin-top: 1px;
        }
        .lp-log-icon.tick { background: rgba(56,189,248,0.15); color: #38BDF8; }
        .lp-log-icon.send { background: rgba(52,211,153,0.15); color: #34D399; }
        .lp-log-icon.reply { background: rgba(251,191,36,0.15); color: #FBBF24; }
        .lp-log-icon.ai { background: rgba(168,85,247,0.15); color: #A855F7; }
        .lp-log-icon.error { background: rgba(248,113,113,0.15); color: #F87171; }
        .lp-log-icon.info { background: rgba(148,163,184,0.1); color: #64748B; }

        .lp-log-content { flex: 1; min-width: 0; }
        .lp-log-msg {
          color: #CBD5E1;
          font-size: 11.5px;
          line-height: 1.35;
          word-break: break-word;
        }
        .lp-log-time {
          color: #475569;
          font-size: 10px;
          margin-top: 2px;
        }

        .lp-empty-log {
          padding: 30px 14px;
          text-align: center;
          color: #475569;
          font-size: 11px;
        }
      </style>

      <div class="lp-grab-tab" id="lp-grab-tab">LP</div>

      <div class="lp-header">
        <div class="lp-logo">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="5" fill="#1E293B"/>
            <path d="M7 17V10h2v7H7zm1-8.5a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zM12 17v-4c0-1 .5-1.5 1.3-1.5s1.2.5 1.2 1.5v4h2v-4.5c0-2-1-3-2.5-3-.9 0-1.6.4-2 1v-.8h-2V17h2z" fill="#38BDF8"/>
          </svg>
          <span>LeadPilot <span class="lp-logo-accent">AI</span></span>
        </div>
        <button class="lp-collapse-btn" id="lp-collapse-btn" title="Collapse">‹</button>
      </div>

      <div class="lp-status-bar">
        <span class="lp-status-dot stopped" id="lp-status-dot"></span>
        <span class="lp-status-text" id="lp-status-text">Idle</span>
      </div>

      <div class="lp-timers" id="lp-timers">
        <div>
          <div class="lp-timer-row">
            <span class="lp-timer-label">Next cycle (scan → send)</span>
            <span class="lp-timer-value" id="lp-tick-countdown">--:--</span>
          </div>
          <div class="lp-progress-bar"><div class="lp-progress-fill" id="lp-tick-progress" style="width:0%"></div></div>
        </div>
      </div>

      <div class="lp-stats" id="lp-stats">
        <div class="lp-stat">
          <div class="lp-stat-value" id="lp-stat-sent">0</div>
          <div class="lp-stat-label">Sent</div>
        </div>
        <div class="lp-stat">
          <div class="lp-stat-value" id="lp-stat-replies">0</div>
          <div class="lp-stat-label">Replies</div>
        </div>
        <div class="lp-stat">
          <div class="lp-stat-value" id="lp-stat-qualified">0</div>
          <div class="lp-stat-label">Qualified</div>
        </div>
        <div class="lp-stat">
          <div class="lp-stat-value" id="lp-stat-pending">0</div>
          <div class="lp-stat-label">Pending</div>
        </div>
      </div>

      <div class="lp-log-header">Activity Log</div>
      <div class="lp-log" id="lp-log">
        <div class="lp-empty-log">No activity yet. Start a campaign to begin.</div>
      </div>
    `;

    document.body.appendChild(panel);

    // Collapse toggle
    function togglePanel() {
      panel.classList.toggle('collapsed');
      const btn = document.getElementById('lp-collapse-btn');
      btn.textContent = panel.classList.contains('collapsed') ? '›' : '‹';
    }
    document.getElementById('lp-collapse-btn').addEventListener('click', togglePanel);
    document.getElementById('lp-grab-tab').addEventListener('click', togglePanel);

    // Start countdown updates
    startCountdownTicker();

    // Initial data load — run immediately
    refreshPanelData();
    updateCountdowns();

    // Also refresh stats every 10 seconds as a fallback
    // (in case storage change events are missed)
    setInterval(refreshPanelData, 10000);
  }

  function removeSidePanel() {
    const panel = document.getElementById('leadpilot-panel');
    if (panel) panel.remove();
    if (panelState.countdownInterval) {
      clearInterval(panelState.countdownInterval);
      panelState.countdownInterval = null;
    }
  }

  // ---- Countdown Ticker ----
  function startCountdownTicker() {
    if (panelState.countdownInterval) clearInterval(panelState.countdownInterval);
    panelState.countdownInterval = setInterval(updateCountdowns, 1000);
  }

  function updateCountdowns() {
    safeStorageGet(['running', 'lastTickAt'], (data) => {
      if (!data.running) {
        setCountdown('lp-tick-countdown', 'lp-tick-progress', null);
        return;
      }
      const CYCLE_INTERVAL = 2 * 60 * 1000; // 2 min
      const tickAt = data.lastTickAt || Date.now();
      setCountdown('lp-tick-countdown', 'lp-tick-progress', tickAt, CYCLE_INTERVAL);
    });
  }

  function setCountdown(countdownId, progressId, lastAt, interval) {
    const countdownEl = document.getElementById(countdownId);
    const progressEl = document.getElementById(progressId);
    if (!countdownEl || !progressEl) return;

    if (!lastAt || !interval) {
      countdownEl.textContent = '--:--';
      countdownEl.className = 'lp-timer-value';
      progressEl.style.width = '0%';
      return;
    }

    const elapsed = Date.now() - lastAt;
    const remaining = Math.max(0, interval - elapsed);
    const pct = Math.min(100, (elapsed / interval) * 100);

    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;

    countdownEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    progressEl.style.width = `${pct}%`;

    // Color coding
    if (secs <= 5) {
      countdownEl.className = 'lp-timer-value now';
    } else if (secs <= 15) {
      countdownEl.className = 'lp-timer-value imminent';
    } else {
      countdownEl.className = 'lp-timer-value';
    }
  }

  // ---- Refresh Panel Data ----
  function refreshPanelData() {
    safeStorageGet(['running', 'campaigns', 'leads', 'conversations', 'activityLog'], (data) => {
      // Status
      const dot = document.getElementById('lp-status-dot');
      const text = document.getElementById('lp-status-text');
      if (dot && text) {
        if (data.running) {
          dot.className = 'lp-status-dot running';
          text.textContent = 'Running';
        } else {
          dot.className = 'lp-status-dot stopped';
          text.textContent = 'Stopped';
        }
      }

      // Stats
      const campaigns = data.campaigns || [];
      const leads = data.leads || [];
      const totals = campaigns.reduce((acc, c) => ({
        sent: acc.sent + (c.stats?.sent || 0),
        replied: acc.replied + (c.stats?.replied || 0),
        qualified: acc.qualified + (c.stats?.qualified || 0),
      }), { sent: 0, replied: 0, qualified: 0 });

      const pending = leads.filter(l => l.status === 'pending' && !l.needsEnrichment).length;

      const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      setVal('lp-stat-sent', totals.sent);
      setVal('lp-stat-replies', totals.replied);
      setVal('lp-stat-qualified', totals.qualified);
      setVal('lp-stat-pending', pending);

      // Activity log
      renderActivityLog(data.activityLog || []);
    });
  }

  // ---- Activity Log Renderer ----
  function renderActivityLog(logs) {
    const container = document.getElementById('lp-log');
    if (!container) return;

    if (logs.length === 0) {
      container.innerHTML = '<div class="lp-empty-log">No activity yet. Start a campaign to begin.</div>';
      return;
    }

    const iconMap = {
      tick: { cls: 'tick', icon: '⟳' },
      tick_done: { cls: 'tick', icon: '✓' },
      reply_check: { cls: 'reply', icon: '◎' },
      reply_check_done: { cls: 'reply', icon: '✓' },
      reply_received: { cls: 'reply', icon: '↵' },
      message_sent: { cls: 'send', icon: '↗' },
      send_failed: { cls: 'error', icon: '✗' },
      ai_generating: { cls: 'ai', icon: '◆' },
      ai_ready: { cls: 'ai', icon: '✓' },
      ai_error: { cls: 'error', icon: '✗' },
      awaiting_approval: { cls: 'ai', icon: '⏳' },
      qualification: { cls: 'send', icon: '★' },
      started: { cls: 'send', icon: '▶' },
      stopped: { cls: 'info', icon: '⏹' },
    };

    container.innerHTML = logs.map((entry, i) => {
      const icon = iconMap[entry.type] || { cls: 'info', icon: '·' };
      const timeStr = formatLogTime(entry.timestamp);
      const isNew = i === 0 && (Date.now() - entry.timestamp < 3000);

      return `
        <div class="lp-log-entry${isNew ? ' new' : ''}">
          <div class="lp-log-icon ${icon.cls}">${icon.icon}</div>
          <div class="lp-log-content">
            <div class="lp-log-msg">${escHtml(entry.message)}</div>
            <div class="lp-log-time">${timeStr}</div>
          </div>
        </div>`;
    }).join('');
  }

  function formatLogTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffSec = Math.floor((now - d) / 1000);

    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ---- Listen for updates ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'log_updated' || msg.action === 'state_updated') {
      refreshPanelData();
    }
  });

  // ---- Init: Show/hide panel based on running state ----
  safeStorageGet(['running'], (data) => {
    if (data.running) injectSidePanel();
  });

  // Wrap storage.onChanged in try/catch
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (!isContextValid()) { onContextInvalidated(); return; }
      if (changes.running) {
        if (changes.running.newValue) {
          injectSidePanel();
        } else {
          refreshPanelData();
        }
      }
      if (changes.activityLog || changes.campaigns || changes.leads || changes.conversations) {
        refreshPanelData();
      }
    });
  } catch (e) {
    onContextInvalidated();
  }

})();
