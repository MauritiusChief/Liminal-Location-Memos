const SESSION_STORAGE_KEY = 'liminal-location-memos.sessionId';

export function readStoredSessionId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.localStorage.getItem(SESSION_STORAGE_KEY);
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function writeStoredSessionId(sessionId: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}
