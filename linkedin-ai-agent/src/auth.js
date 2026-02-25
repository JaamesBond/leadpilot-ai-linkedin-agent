// Aivora Authentication Module
// Handles Supabase email/password auth for Chrome Extension (MV3)
// Uses plain fetch — no Supabase SDK dependency

import { AIVORA_CONFIG } from './config.js';

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'aivora_access_token',
  REFRESH_TOKEN: 'aivora_refresh_token',
  USER: 'aivora_user',
  EXPIRES_AT: 'aivora_expires_at',
};

/**
 * Login with email and password via Supabase Auth REST API.
 * Stores tokens in chrome.storage.local.
 * @returns {{ user: object, access_token: string }}
 */
export async function login(email, password) {
  const res = await fetch(
    `${AIVORA_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: AIVORA_CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error_description || err.msg || 'Login failed');
  }

  const data = await res.json();

  await chrome.storage.local.set({
    [STORAGE_KEYS.ACCESS_TOKEN]: data.access_token,
    [STORAGE_KEYS.REFRESH_TOKEN]: data.refresh_token,
    [STORAGE_KEYS.USER]: data.user,
    [STORAGE_KEYS.EXPIRES_AT]: data.expires_at,
  });

  return { user: data.user, access_token: data.access_token };
}

/**
 * Get current session from storage.
 * Returns null if not logged in or tokens expired.
 * Auto-refreshes if token is expired but refresh_token exists.
 */
export async function getSession() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.ACCESS_TOKEN,
    STORAGE_KEYS.REFRESH_TOKEN,
    STORAGE_KEYS.USER,
    STORAGE_KEYS.EXPIRES_AT,
  ]);

  const accessToken = stored[STORAGE_KEYS.ACCESS_TOKEN];
  const refreshToken = stored[STORAGE_KEYS.REFRESH_TOKEN];
  const user = stored[STORAGE_KEYS.USER];
  const expiresAt = stored[STORAGE_KEYS.EXPIRES_AT];

  if (!accessToken || !refreshToken) return null;

  // Check if expired (with 60s buffer)
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt && now >= expiresAt - 60) {
    try {
      return await refreshSession();
    } catch {
      await logout();
      return null;
    }
  }

  return { access_token: accessToken, refresh_token: refreshToken, user };
}

/**
 * Refresh the session using the stored refresh token.
 */
export async function refreshSession() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.REFRESH_TOKEN]);
  const refreshToken = stored[STORAGE_KEYS.REFRESH_TOKEN];

  if (!refreshToken) throw new Error('No refresh token');

  const res = await fetch(
    `${AIVORA_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: AIVORA_CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    }
  );

  if (!res.ok) {
    throw new Error('Token refresh failed');
  }

  const data = await res.json();

  await chrome.storage.local.set({
    [STORAGE_KEYS.ACCESS_TOKEN]: data.access_token,
    [STORAGE_KEYS.REFRESH_TOKEN]: data.refresh_token,
    [STORAGE_KEYS.USER]: data.user,
    [STORAGE_KEYS.EXPIRES_AT]: data.expires_at,
  });

  return { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user };
}

/**
 * Logout — clear all stored auth data.
 */
export async function logout() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.ACCESS_TOKEN,
    STORAGE_KEYS.REFRESH_TOKEN,
    STORAGE_KEYS.USER,
    STORAGE_KEYS.EXPIRES_AT,
  ]);
}

/**
 * Get auth headers for Aivora API requests.
 * Returns headers object with Bearer token + apikey.
 * Returns null if not authenticated.
 */
export async function getAuthHeaders() {
  const session = await getSession();
  if (!session) return null;

  return {
    Authorization: `Bearer ${session.access_token}`,
    apikey: AIVORA_CONFIG.SUPABASE_ANON_KEY,
  };
}

/**
 * Check if user is currently logged in (non-expired session exists).
 */
export async function isLoggedIn() {
  const session = await getSession();
  return session !== null;
}
