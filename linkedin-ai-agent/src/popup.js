import { login, getSession, logout, getAuthHeaders } from './auth.js';
import { AIVORA_CONFIG } from './config.js';

// ============================================================
// LeadPilot AI — Popup Controller
// ============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Lead cap constants (FIX 11) ----
const LEAD_SOFT_CAP = 150;
const LEAD_HARD_CAP = 500;

// ---- State ----
let state = {
  campaigns: [],
  leads: [],
  conversations: [],
  settings: {
    apiKey: '',
    model: 'claude-sonnet-4-6',
    brandName: 'LeadPilot AI',
    brandColor: '#38BDF8',
    humanReview: true,
    randomDelay: true,
    dailyLimit: 25,
    dailyLimitEnabled: true,
  },
  running: false,
  pendingApprovals: [],
};

let dashboardLeads = [];
let dashboardSelectedIds = new Set();

// ---- Persistence ----
async function loadState() {
  const data = await chrome.storage.local.get(['campaigns', 'leads', 'conversations', 'settings', 'running', 'pendingApprovals']);
  if (data.campaigns) state.campaigns = data.campaigns;
  if (data.leads) state.leads = data.leads;
  if (data.conversations) state.conversations = data.conversations;
  if (data.settings) state.settings = { ...state.settings, ...data.settings };
  if (data.running) state.running = data.running;
  // FIX 3: Load persisted pending approvals
  state.pendingApprovals = data.pendingApprovals || [];
}

// FIX 14: Strip transient UI flags (_confirmDelete) before serializing to storage
async function saveState() {
  const cleanCampaigns = state.campaigns.map(({ _confirmDelete, ...c }) => c);
  const cleanLeads = state.leads.map(({ _confirmDelete, ...l }) => l);
  await chrome.storage.local.set({
    campaigns: cleanCampaigns,
    leads: cleanLeads,
    conversations: state.conversations,
    settings: state.settings,
    running: state.running,
  });
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  applyBranding();
  renderAll();
  bindEvents();
  updateStatusBar();

  // FIX 3: Recover any pending approvals that were saved when popup was closed
  if (state.pendingApprovals && state.pendingApprovals.length > 0) {
    showApprovalModal(state.pendingApprovals[0]);
  }

  // Check Aivora auth state
  await checkAivoraAuth();
});

// ---- Branding ----
function applyBranding() {
  document.documentElement.style.setProperty('--accent', state.settings.brandColor);
  const logoText = $('.logo-text');
  if (state.settings.brandName && state.settings.brandName !== 'LeadPilot AI') {
    logoText.innerHTML = state.settings.brandName;
  }
}

// ---- Tab Switching ----
function bindEvents() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // Campaign form
  $('#btn-new-campaign').addEventListener('click', () => {
    if (!requireApiKey()) return;
    $('#campaign-form').classList.remove('hidden');
  });
  $('#btn-cancel-campaign').addEventListener('click', () => {
    $('#campaign-form').classList.add('hidden');
    clearCampaignForm();
  });
  $('#btn-save-campaign').addEventListener('click', saveCampaign);

  // Leads
  $('#btn-add-leads').addEventListener('click', () => {
    if (!requireApiKey()) return;
    populateCampaignSelect();
    $('#lead-import-panel').classList.remove('hidden');
  });
  $('#btn-cancel-leads').addEventListener('click', () => {
    $('#lead-import-panel').classList.add('hidden');
  });
  $('#btn-import-leads').addEventListener('click', importLeads);

  // Settings
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-back-settings').addEventListener('click', closeSettings);
  $('#btn-save-settings').addEventListener('click', saveSettings);

  // Run / Stop
  $('#btn-run-campaign').addEventListener('click', startCampaign);
  $('#btn-stop-campaign').addEventListener('click', stopCampaign);

  // Conv filter
  $('#conv-filter').addEventListener('change', renderConversations);

  // Aivora auth & dashboard
  const aivoraLoginBtn = $('#btn-aivora-login');
  if (aivoraLoginBtn) aivoraLoginBtn.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(tc => tc.classList.remove('active'));
    const dashTab = $('#tab-btn-dashboard');
    if (dashTab) { dashTab.style.display = ''; dashTab.classList.add('active'); }
    const dashContent = $('#tab-dashboard');
    if (dashContent) dashContent.classList.add('active');
  });
  const aivoraLogoutBtn = $('#btn-aivora-logout');
  if (aivoraLogoutBtn) aivoraLogoutBtn.addEventListener('click', aivoraLogout);
  const signinBtn = $('#btn-aivora-signin');
  if (signinBtn) signinBtn.addEventListener('click', aivoraSignIn);
  const refreshDashBtn = $('#btn-refresh-dashboard');
  if (refreshDashBtn) refreshDashBtn.addEventListener('click', fetchDashboardLeads);
  const stageFilter = $('#dashboard-stage-filter');
  if (stageFilter) stageFilter.addEventListener('change', fetchDashboardLeads);
  const dashImportBtn = $('#btn-dashboard-import');
  if (dashImportBtn) dashImportBtn.addEventListener('click', importDashboardLeads);
  const loginEmail = $('#aivora-login-email');
  if (loginEmail) loginEmail.addEventListener('keydown', (e) => { if (e.key === 'Enter') aivoraSignIn(); });
  const loginPassword = $('#aivora-login-password');
  if (loginPassword) loginPassword.addEventListener('keydown', (e) => { if (e.key === 'Enter') aivoraSignIn(); });
}

// ---- Campaigns ----
function saveCampaign() {
  const name = $('#campaign-name').value.trim();
  const template = $('#initial-template').value.trim();
  const repName = $('#rep-name').value.trim();
  const persona = $('#agent-persona').value.trim();
  const criteria = $('#qualification-criteria').value.trim();

  if (!repName) {
    showToast('Please enter your name — the AI needs it to identify itself');
    return;
  }
  const callScheduling = $('#call-scheduling').value.trim();
  const upsellTriggers = $('#upsell-triggers').value.trim();
  const insightGoals = $('#insight-goals').value.trim();
  const abandonRules = $('#abandon-rules').value.trim();
  const followupDelay = parseInt($('#followup-delay').value) || 24;
  const maxFollowups = parseInt($('#max-followups').value) || 3;

  if (!name || !template) {
    showToast('Campaign name and opening message are required');
    return;
  }

  const campaign = {
    id: 'camp_' + Date.now(),
    name,
    template,
    repName,
    persona,
    criteria,
    callScheduling,
    upsellTriggers,
    insightGoals,
    abandonRules,
    followupDelay,
    maxFollowups,
    status: 'active',
    created: new Date().toISOString(),
    stats: { sent: 0, replied: 0, qualified: 0, abandoned: 0, callsBooked: 0 },
  };

  state.campaigns.push(campaign);
  saveState();
  renderCampaigns();
  $('#campaign-form').classList.add('hidden');
  clearCampaignForm();
  updateStatusBar();
}

function clearCampaignForm() {
  $('#campaign-name').value = '';
  $('#initial-template').value = '';
  $('#rep-name').value = '';
  $('#agent-persona').value = '';
  $('#qualification-criteria').value = '';
  $('#call-scheduling').value = '';
  $('#upsell-triggers').value = '';
  $('#insight-goals').value = '';
  $('#abandon-rules').value = '';
  $('#followup-delay').value = 24;
  $('#max-followups').value = 3;
}

function renderCampaigns() {
  const list = $('#campaign-list');
  if (state.campaigns.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <p>No campaigns yet</p>
        <span>Create your first outreach campaign</span>
      </div>`;
    return;
  }

  list.innerHTML = state.campaigns.map(c => {
    const leadCount = state.leads.filter(l => l.campaignId === c.id).length;
    const isPaused = c.status === 'paused';
    const confirmingDelete = c._confirmDelete;

    return `
      <div class="card" data-id="${c.id}">
        <div class="card-header">
          <span class="card-title">${esc(c.name)}</span>
          <span class="badge badge-${c.status}">${c.status}</span>
        </div>
        <div class="card-meta">
          ${leadCount} leads · ${c.stats.sent} sent · ${c.stats.replied} replies · ${c.stats.qualified} qualified${c.stats.callsBooked ? ' · ' + c.stats.callsBooked + ' calls' : ''}${c.stats.abandoned ? ' · ' + c.stats.abandoned + ' exited' : ''}
        </div>
        <div class="card-actions">
          <button class="btn ${isPaused ? 'btn-primary' : 'btn-ghost'} btn-sm" data-action="toggle-campaign" data-id="${c.id}">
            ${isPaused ? '▶ Resume' : '⏸ Pause'}
          </button>
          ${confirmingDelete
            ? `<button class="btn btn-danger btn-sm" data-action="confirm-delete-campaign" data-id="${c.id}">Confirm Delete</button>
               <button class="btn btn-ghost btn-sm" data-action="cancel-delete-campaign" data-id="${c.id}">Cancel</button>`
            : `<button class="btn btn-ghost btn-sm" data-action="start-delete-campaign" data-id="${c.id}">Delete</button>`
          }
        </div>
      </div>`;
  }).join('');
}

// Campaign event delegation
$('#campaign-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'toggle-campaign') {
    const c = state.campaigns.find(x => x.id === id);
    if (c) {
      c.status = c.status === 'active' ? 'paused' : 'active';
      saveState();
      renderCampaigns();
    }
  } else if (action === 'start-delete-campaign') {
    const c = state.campaigns.find(x => x.id === id);
    if (c) { c._confirmDelete = true; renderCampaigns(); }
  } else if (action === 'cancel-delete-campaign') {
    const c = state.campaigns.find(x => x.id === id);
    if (c) { delete c._confirmDelete; renderCampaigns(); }
  } else if (action === 'confirm-delete-campaign') {
    state.campaigns = state.campaigns.filter(x => x.id !== id);
    state.leads = state.leads.filter(x => x.campaignId !== id);
    state.conversations = state.conversations.filter(x => x.campaignId !== id);
    saveState();
    renderAll();
  }
});

// Lead and campaign actions are handled via event delegation below (MV3 blocks inline onclick)

// ---- Leads ----
function populateCampaignSelect() {
  const sel = $('#campaign-select');
  sel.innerHTML = state.campaigns.map(c =>
    `<option value="${c.id}">${esc(c.name)}</option>`
  ).join('');
}

// FIX 11: Import with soft/hard cap enforcement
function importLeads() {
  const campaignId = $('#campaign-select').value;
  const raw = $('#lead-names').value.trim();
  if (!campaignId || !raw) {
    showToast('Select a campaign and enter leads');
    return;
  }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const totalAfterImport = state.leads.length + lines.length;

  if (totalAfterImport > LEAD_HARD_CAP) {
    showToast(`Import blocked: would reach ${totalAfterImport} leads (max ${LEAD_HARD_CAP})`);
    return;
  }
  if (totalAfterImport > LEAD_SOFT_CAP) {
    showToast(`Warning: ${totalAfterImport} leads may slow reply detection`, 'warning');
  }

  const newLeads = lines.map(line => {
    const isUrl = line.startsWith('http');
    let lead = {
      id: 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      campaignId,
      status: 'pending', // pending | messaged | replied | qualified | disqualified
      created: new Date().toISOString(),
    };

    if (isUrl) {
      lead.linkedinUrl = line;
      lead.name = 'Loading...';
      lead.firstName = '';
      lead.lastName = '';
      lead.company = '';
      lead.title = '';
      lead.needsEnrichment = true;
    } else {
      const parts = line.split(',').map(p => p.trim());
      lead.name = parts[0] || 'Unknown';
      const nameParts = lead.name.split(' ');
      lead.firstName = nameParts[0] || '';
      lead.lastName = nameParts.slice(1).join(' ') || '';
      lead.company = parts[1] || '';
      lead.title = parts[2] || '';
      lead.linkedinUrl = '';
    }

    return lead;
  });

  state.leads.push(...newLeads);
  saveState();
  renderLeads();
  $('#lead-import-panel').classList.add('hidden');
  $('#lead-names').value = '';
  renderCampaigns();
  updateStatusBar();

  // Trigger profile enrichment for URL-based leads
  const leadsToEnrich = newLeads.filter(l => l.needsEnrichment);
  if (leadsToEnrich.length > 0) {
    chrome.runtime.sendMessage({
      action: 'enrich_leads',
      data: { leadIds: leadsToEnrich.map(l => l.id) }
    });
  }
}

function renderLeads() {
  const list = $('#lead-list');
  if (state.leads.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
        <p>No leads added</p>
        <span>Import leads to start outreach</span>
      </div>`;
    return;
  }

  const statuses = ['pending', 'sending', 'pending_approval', 'messaged', 'replied', 'qualified', 'disqualified', 'send_failed', 'processing_reply', 'abandoned'];

  list.innerHTML = state.leads.map(l => {
    const initials = (l.firstName?.[0] || '') + (l.lastName?.[0] || '');
    const enriching = l.needsEnrichment;
    const failed = l.status === 'send_failed';
    const statusOptions = statuses.map(s =>
      `<option value="${s}" ${l.status === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`
    ).join('');

    return `
      <div class="card lead-card" data-id="${l.id}">
        <div class="lead-avatar">${enriching ? '<span class="enriching-spinner"></span>' : esc(initials.toUpperCase() || '?')}</div>
        <div class="lead-info">
          <div class="lead-name">${enriching ? 'Fetching profile...' : esc(l.name)}</div>
          <div class="lead-detail">${enriching ? esc(l.linkedinUrl) : (esc(l.title) + (l.company ? ' @ ' + esc(l.company) : ''))}</div>
          ${failed ? `<div class="lead-detail" style="color:var(--danger);margin-top:2px">⚠ ${esc(l.lastError || 'Send failed')}</div>` : ''}
        </div>
        <div class="lead-actions">
          <select class="lead-status-select" data-action="change-status" data-id="${l.id}">
            ${enriching ? '<option selected>enriching</option>' : statusOptions}
          </select>
          <button class="btn-icon ${l._confirmDelete ? 'btn-icon-danger' : ''}" data-action="delete-lead" data-id="${l.id}" title="${l._confirmDelete ? 'Click again to confirm' : 'Delete lead'}">
            ${l._confirmDelete ? '✓' : '✕'}
          </button>
        </div>
      </div>`;
  }).join('');
}

// Lead event delegation — handles clicks AND select changes
$('#lead-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="delete-lead"]');
  if (!btn) return;
  const id = btn.dataset.id;
  const lead = state.leads.find(l => l.id === id);
  if (!lead) return;

  if (lead._confirmDelete) {
    state.leads = state.leads.filter(l => l.id !== id);
    state.conversations = state.conversations.filter(c => c.leadId !== id);
    saveState();
    renderAll();
  } else {
    lead._confirmDelete = true;
    renderLeads();
    setTimeout(() => {
      const l = state.leads.find(x => x.id === id);
      if (l && l._confirmDelete) {
        delete l._confirmDelete;
        renderLeads();
      }
    }, 3000);
  }
});

$('#lead-list').addEventListener('change', (e) => {
  const select = e.target.closest('[data-action="change-status"]');
  if (!select) return;
  const id = select.dataset.id;
  const newStatus = select.value;
  const lead = state.leads.find(l => l.id === id);
  if (!lead) return;

  const oldStatus = lead.status;
  lead.status = newStatus;
  lead.lastError = null;

  const conv = state.conversations.find(c => c.leadId === id);
  if (conv) {
    if (newStatus === 'pending') {
      state.conversations = state.conversations.filter(c => c.leadId !== id);
    } else if (newStatus === 'qualified') {
      conv.status = 'qualified';
    } else if (newStatus === 'disqualified') {
      conv.status = 'disqualified';
    } else if (newStatus === 'messaged') {
      conv.status = 'awaiting_reply';
    } else if (newStatus === 'replied') {
      conv.status = 'replied';
    }
  }

  if (newStatus === 'qualified' && oldStatus !== 'qualified') {
    const campaign = state.campaigns.find(c => c.id === lead.campaignId);
    if (campaign) campaign.stats.qualified++;
  }
  if (oldStatus === 'qualified' && newStatus !== 'qualified') {
    const campaign = state.campaigns.find(c => c.id === lead.campaignId);
    if (campaign) campaign.stats.qualified = Math.max(0, campaign.stats.qualified - 1);
  }

  saveState();
  renderAll();
});

// ---- Conversations ----
function renderConversations() {
  const filter = $('#conv-filter').value;
  const list = $('#conversation-list');
  let convs = state.conversations;
  if (filter !== 'all') {
    convs = convs.filter(c => c.status === filter);
  }

  if (convs.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
        <p>No conversations</p>
        <span>${filter !== 'all' ? 'No conversations match this filter' : 'Start a campaign to begin'}</span>
      </div>`;
    return;
  }

  list.innerHTML = convs.map(c => {
    const lead = state.leads.find(l => l.id === c.leadId);
    const lastMsg = c.messages[c.messages.length - 1];
    const insightsHtml = c.insights?.length
      ? `<div class="conv-insights">${c.insights.map(i => `<span class="insight-tag">${esc(i.key)}: ${esc(i.value)}</span>`).join('')}</div>`
      : '';
    return `
      <div class="card" data-conv-id="${c.id}">
        <div class="card-header">
          <span class="card-title">${esc(lead?.name || 'Unknown')}</span>
          <span class="badge badge-${c.status}">${c.status.replace('_', ' ')}</span>
        </div>
        <div class="conv-preview">${esc(lastMsg?.text?.slice(0, 120) || '...')}</div>
        ${insightsHtml}
        <div class="card-meta">${c.messages.length} messages · Last: ${timeAgo(lastMsg?.timestamp)}</div>
      </div>`;
  }).join('');
}

// ---- Settings ----
function openSettings() {
  const p = $('#panel-settings');
  p.classList.remove('hidden');
  $('#api-key').value = state.settings.apiKey;
  $('#model-select').value = state.settings.model;
  $('#brand-name').value = state.settings.brandName;
  $('#brand-color').value = state.settings.brandColor;
  $('#human-review').checked = state.settings.humanReview;
  $('#random-delay').checked = state.settings.randomDelay;
  $('#daily-limit-toggle').checked = state.settings.dailyLimitEnabled;
  $('#daily-limit').value = state.settings.dailyLimit;
}

function closeSettings() {
  $('#panel-settings').classList.add('hidden');
}

function saveSettings() {
  state.settings.apiKey = $('#api-key').value.trim();
  state.settings.model = $('#model-select').value;
  state.settings.brandName = $('#brand-name').value.trim() || 'LeadPilot AI';
  state.settings.brandColor = $('#brand-color').value;
  state.settings.humanReview = $('#human-review').checked;
  state.settings.randomDelay = $('#random-delay').checked;
  state.settings.dailyLimitEnabled = $('#daily-limit-toggle').checked;
  state.settings.dailyLimit = parseInt($('#daily-limit').value) || 25;
  saveState();
  applyBranding();
  closeSettings();
}

// ---- Campaign Runner ----
function startCampaign() {
  if (!requireApiKey()) return;
  state.running = true;
  saveState();
  chrome.runtime.sendMessage({ action: 'start_campaign' });
  updateStatusBar();
}

function stopCampaign() {
  state.running = false;
  saveState();
  chrome.runtime.sendMessage({ action: 'stop_campaign' });
  updateStatusBar();
}

function updateStatusBar() {
  const bar = $('#status-bar');
  const hasWork = state.campaigns.some(c => c.status === 'active') && state.leads.length > 0;
  bar.classList.toggle('hidden', !hasWork);

  const pulse = bar.querySelector('.pulse');
  const text = $('#status-text');
  const runBtn = $('#btn-run-campaign');
  const stopBtn = $('#btn-stop-campaign');

  if (state.running) {
    pulse.classList.add('running');
    text.textContent = 'Running...';
    runBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    pulse.classList.remove('running');
    const pending = state.leads.filter(l => l.status === 'pending').length;
    text.textContent = `${pending} leads pending`;
    runBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
  }
}

// ---- Render All ----
function renderAll() {
  renderSetupBanner();
  renderCampaigns();
  renderLeads();
  renderConversations();
}

function renderSetupBanner() {
  let banner = document.getElementById('setup-banner');
  if (state.settings.apiKey) {
    if (banner) banner.remove();
    return;
  }
  if (banner) return; // already shown
  banner = document.createElement('div');
  banner.id = 'setup-banner';
  banner.className = 'setup-banner';
  // innerHTML is static content, no user data
  banner.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Set up your API key to get started';
  banner.addEventListener('click', openSettings);
  const tabs = document.querySelector('.tabs');
  if (tabs) tabs.after(banner);
}

// ---- Helpers ----
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// Non-blocking toast notification (replaces alert/confirm which freeze Chrome extension popups)
let _toastTimer = null;
function showToast(msg, type = 'error', duration = 4000) {
  const toast = document.getElementById('toast-message');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast toast-${type}`;
  void toast.offsetWidth; // force reflow for re-trigger
  toast.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

function requireApiKey() {
  if (state.settings.apiKey) return true;
  showToast('Set your Anthropic API key in Settings first', 'warning');
  openSettings();
  return false;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ---- Aivora Auth & Dashboard ----
async function checkAivoraAuth() {
  const session = await getSession();
  const loginBtn = $('#btn-aivora-login');
  const userDiv = $('#aivora-user');
  const emailSpan = $('#aivora-email');
  const dashboardTab = $('#tab-btn-dashboard');
  const dashboardLogin = $('#dashboard-login');
  const dashboardLeadsDiv = $('#dashboard-leads');

  if (session && session.user) {
    if (loginBtn) loginBtn.classList.add('hidden');
    if (userDiv) userDiv.classList.remove('hidden');
    if (emailSpan) emailSpan.textContent = session.user.email || 'Connected';
    if (dashboardTab) dashboardTab.style.display = '';
    if (dashboardLogin) dashboardLogin.classList.add('hidden');
    if (dashboardLeadsDiv) dashboardLeadsDiv.classList.remove('hidden');
    fetchDashboardLeads();
  } else {
    if (loginBtn) loginBtn.classList.remove('hidden');
    if (userDiv) userDiv.classList.add('hidden');
    if (dashboardTab) dashboardTab.style.display = 'none';
    if (dashboardLogin) dashboardLogin.classList.remove('hidden');
    if (dashboardLeadsDiv) dashboardLeadsDiv.classList.add('hidden');
  }
}

async function aivoraSignIn() {
  const email = $('#aivora-login-email')?.value?.trim();
  const password = $('#aivora-login-password')?.value;
  const errorDiv = $('#aivora-login-error');

  if (!email || !password) {
    if (errorDiv) { errorDiv.textContent = 'Email and password are required'; errorDiv.classList.remove('hidden'); }
    return;
  }

  const btn = $('#btn-aivora-signin');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
  if (errorDiv) errorDiv.classList.add('hidden');

  try {
    await login(email, password);
    await checkAivoraAuth();
  } catch (err) {
    if (errorDiv) { errorDiv.textContent = err.message || 'Login failed'; errorDiv.classList.remove('hidden'); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
  }
}

async function aivoraLogout() {
  await logout();
  dashboardLeads = [];
  dashboardSelectedIds.clear();
  await checkAivoraAuth();
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(tc => tc.classList.remove('active'));
  $$('.tab')[0]?.classList.add('active');
  $('#tab-campaigns')?.classList.add('active');
}

async function fetchDashboardLeads() {
  const headers = await getAuthHeaders();
  if (!headers) return;

  const stageFilter = $('#dashboard-stage-filter')?.value || '';
  const params = new URLSearchParams({ limit: '50' });
  if (stageFilter) params.set('pipelineStage', stageFilter);

  const list = $('#dashboard-lead-list');
  // Note: innerHTML usage here is safe — all dynamic values are escaped via esc()
  if (list) list.innerHTML = '<div class="empty-state"><span class="enriching-spinner"></span><p style="margin-top:8px">Loading leads...</p></div>';

  try {
    const res = await fetch(`${AIVORA_CONFIG.BACKEND_URL}/api/content/linkedin-leads?${params}`, {
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    dashboardLeads = result.data || [];
    dashboardSelectedIds.clear();
    renderDashboardLeads();
  } catch (err) {
    if (list) list.innerHTML = `<div class="empty-state"><p>Failed to load leads</p><span>${esc(err.message)}</span></div>`;
  }
}

function renderDashboardLeads() {
  const list = $('#dashboard-lead-list');
  if (!list) return;

  if (dashboardLeads.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
        <p>No leads found</p>
        <span>Try a different filter or generate leads in the Aivora dashboard</span>
      </div>`;
    updateDashboardImportBar();
    return;
  }

  // All dynamic values passed through esc() to prevent XSS
  list.innerHTML = dashboardLeads.map(l => {
    const initials = ((l.first_name?.[0] || '') + (l.last_name?.[0] || '')).toUpperCase() || '?';
    const checked = dashboardSelectedIds.has(l.id) ? 'checked' : '';
    const stageBadge = l.pipeline_stage && l.pipeline_stage !== 'new'
      ? `<span class="badge badge-${esc(l.pipeline_stage)}">${esc(l.pipeline_stage)}</span>`
      : '';
    return `
      <div class="card lead-card dashboard-lead-card" data-dashboard-id="${esc(String(l.id))}">
        <input type="checkbox" class="dashboard-lead-check" data-id="${esc(String(l.id))}" ${checked}>
        <div class="lead-avatar">${esc(initials)}</div>
        <div class="lead-info">
          <div class="lead-name">${esc(l.full_name || 'Unknown')} ${stageBadge}</div>
          <div class="lead-detail">${esc(l.job_title || '')}${l.company_name ? ' @ ' + esc(l.company_name) : ''}</div>
          ${l.industry ? `<div class="lead-detail">${esc(l.industry)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.dashboard-lead-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) {
        dashboardSelectedIds.add(id);
      } else {
        dashboardSelectedIds.delete(id);
      }
      updateDashboardImportBar();
    });
  });

  updateDashboardImportBar();
}

function updateDashboardImportBar() {
  const bar = $('#dashboard-import-bar');
  const countSpan = $('#dashboard-selected-count');
  if (!bar) return;

  if (dashboardSelectedIds.size > 0) {
    bar.classList.remove('hidden');
    if (countSpan) countSpan.textContent = `${dashboardSelectedIds.size} selected`;
    const sel = $('#dashboard-campaign-select');
    if (sel) {
      sel.innerHTML = state.campaigns.map(c =>
        `<option value="${esc(c.id)}">${esc(c.name)}</option>`
      ).join('');
    }
  } else {
    bar.classList.add('hidden');
  }
}

function dashboardLeadToExtensionLead(dbLead, campaignId) {
  return {
    id: 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    dashboardLeadId: dbLead.id,
    campaignId,
    name: dbLead.full_name || '',
    firstName: dbLead.first_name || '',
    lastName: dbLead.last_name || '',
    company: dbLead.company_name || '',
    title: dbLead.job_title || '',
    linkedinUrl: dbLead.linkedin || '',
    status: 'pending',
    created: new Date().toISOString(),
    needsEnrichment: !dbLead.linkedin && !dbLead.personal_research,
    dashboardData: {
      personal_research: dbLead.personal_research,
      personalized_message: dbLead.personalized_message,
      company_weakness: dbLead.company_weakness,
      company_description: dbLead.company_description,
      industry: dbLead.industry,
      headline: dbLead.headline,
    },
  };
}

function importDashboardLeads() {
  const campaignId = $('#dashboard-campaign-select')?.value;
  if (!campaignId) {
    showToast('Please select a campaign first');
    return;
  }

  const selectedLeads = dashboardLeads.filter(l => dashboardSelectedIds.has(l.id));
  if (selectedLeads.length === 0) return;

  const totalAfterImport = state.leads.length + selectedLeads.length;
  if (totalAfterImport > LEAD_HARD_CAP) {
    showToast(`Import blocked: would reach ${totalAfterImport} leads (max ${LEAD_HARD_CAP})`);
    return;
  }
  if (totalAfterImport > LEAD_SOFT_CAP) {
    showToast(`Warning: ${totalAfterImport} leads may slow reply detection`, 'warning');
  }

  const newLeads = selectedLeads.map(l => dashboardLeadToExtensionLead(l, campaignId));
  state.leads.push(...newLeads);
  saveState();
  renderLeads();
  renderCampaigns();
  updateStatusBar();

  dashboardSelectedIds.clear();
  renderDashboardLeads();

  const leadsToEnrich = newLeads.filter(l => l.needsEnrichment);
  if (leadsToEnrich.length > 0) {
    chrome.runtime.sendMessage({
      action: 'enrich_leads',
      data: { leadIds: leadsToEnrich.map(l => l.id) }
    });
  }

  showToast(`${selectedLeads.length} leads imported to campaign`, 'success');
}

// ---- Listen for background messages ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'state_updated') {
    loadState().then(() => {
      renderAll();
      updateStatusBar();
    });
  }
  if (msg.action === 'approval_needed') {
    // FIX 3: Update local pendingApprovals from storage then show modal
    chrome.storage.local.get(['pendingApprovals']).then(data => {
      state.pendingApprovals = data.pendingApprovals || [];
    });
    showApprovalModal(msg.data);
  }
});

// ---- Approval Modal (FIX 8: two-button reject) ----
function showApprovalModal(data) {
  // Remove any existing modal first
  const existing = document.querySelector('.approval-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'approval-overlay';
  overlay.innerHTML = `
    <div class="approval-modal">
      <h3>Review Message Before Sending</h3>
      <div class="lead-context">To: <strong>${esc(data.leadName)}</strong> ${data.leadTitle ? '· ' + esc(data.leadTitle) : ''}</div>
      <textarea id="approval-text" rows="5">${esc(data.message)}</textarea>
      <div class="form-actions">
        ${data.type === 'initial'
          ? `<button class="btn btn-ghost" id="btn-queue-msg" title="Return to pending queue">Back to Queue</button>
             <button class="btn btn-danger btn-sm" id="btn-disqualify-msg" title="Permanently disqualify this lead">Disqualify</button>`
          : `<button class="btn btn-ghost" id="btn-reject-msg">Skip</button>`
        }
        <button class="btn btn-primary" id="btn-approve-msg">Send</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#btn-approve-msg').addEventListener('click', () => {
    const finalText = overlay.querySelector('#approval-text').value;
    chrome.runtime.sendMessage({ action: 'approve_message', data: { ...data, message: finalText } });
    overlay.remove();
    // FIX 3: Remove from local state and show next if any
    removeApprovalAndShowNext(data.leadId);
  });

  // FIX 8: "Back to Queue" sends action: 'reset' (lead returns to pending)
  const queueBtn = overlay.querySelector('#btn-queue-msg');
  if (queueBtn) {
    queueBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'reject_message', data: { ...data, action: 'reset' } });
      overlay.remove();
      removeApprovalAndShowNext(data.leadId);
    });
  }

  // FIX 8: "Disqualify" sends action: 'disqualify' (lead is permanently removed)
  const disqualifyBtn = overlay.querySelector('#btn-disqualify-msg');
  if (disqualifyBtn) {
    disqualifyBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'reject_message', data: { ...data, action: 'disqualify' } });
      overlay.remove();
      removeApprovalAndShowNext(data.leadId);
    });
  }

  // Follow-up reject (skip only)
  const rejectBtn = overlay.querySelector('#btn-reject-msg');
  if (rejectBtn) {
    rejectBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'reject_message', data });
      overlay.remove();
      removeApprovalAndShowNext(data.leadId);
    });
  }
}

// FIX 3: Remove resolved approval and show the next queued one
function removeApprovalAndShowNext(resolvedLeadId) {
  state.pendingApprovals = state.pendingApprovals.filter(a => a.leadId !== resolvedLeadId);
  if (state.pendingApprovals.length > 0) {
    // Show the next queued approval after a brief delay
    setTimeout(() => showApprovalModal(state.pendingApprovals[0]), 300);
  }
}
