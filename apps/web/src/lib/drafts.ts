/**
 * Draft persistence for the Work composer.
 *
 * A draft belongs to exactly one owner, repository and conversation. The key
 * includes all three, so switching repositories or conversations can never
 * leak text between them. Every edit advances a version; a send records the
 * version and text it submitted. Success clears the draft only when the stored
 * version still matches, so an edit made while the request was in flight is
 * never discarded.
 */

const PREFIX = 'moyu:draft:v1';

export interface DraftPending {
  /** The idempotency key of the send attempt that created this pending state. */
  clientMessageId: string;
  text: string;
  /** Draft version the pending send submitted. */
  version: number;
  at: string;
  /** Whether the request failed with an unknown network outcome. */
  ambiguous?: boolean;
}

export interface Draft {
  version: number;
  text: string;
  updatedAt: string;
  pending: DraftPending | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** In-memory fallback keeps unsaved input alive when browser storage is unavailable. */
const memory = new Map<string, Draft>();

function storage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') {
      return null;
    }
    const candidate = window.localStorage;
    if (!candidate) {
      return null;
    }
    return candidate;
  } catch {
    // Access can throw when the browser blocks storage for the origin.
    return null;
  }
}

export function draftKey(ownerId: string, repositoryId: string, conversationId: string): string {
  return `${PREFIX}:${ownerId}:${repositoryId}:${conversationId}`;
}

function ownerPrefix(ownerId: string): string {
  return `${PREFIX}:${ownerId}:`;
}

function parseDraft(raw: string | null): Draft | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<Draft> | null;
    if (!value || typeof value.text !== 'string') {
      return null;
    }
    const version = typeof value.version === 'number' ? value.version : 0;
    const pending = value.pending;
    const validPending =
      pending &&
      typeof pending.clientMessageId === 'string' &&
      typeof pending.text === 'string' &&
      typeof pending.version === 'number' &&
      typeof pending.at === 'string'
        ? {
            clientMessageId: pending.clientMessageId,
            text: pending.text,
            version: pending.version,
            at: pending.at,
            ambiguous: pending.ambiguous === true,
          }
        : null;
    return {
      version,
      text: value.text,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
      pending: validPending,
    };
  } catch {
    return null;
  }
}

export function loadDraft(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
): Draft | null {
  const key = draftKey(ownerId, repositoryId, conversationId);
  // The in-memory copy is this tab's newest edit. Prefer it after a failed
  // storage write, where localStorage can still hold an older version.
  const cached = memory.get(key);
  if (cached) {
    return cached;
  }
  const local = storage();
  if (local) {
    try {
      const parsed = parseDraft(local.getItem(key));
      if (parsed) {
        memory.set(key, parsed);
        return parsed;
      }
    } catch {
      // Fall through to the (empty) in-memory copy.
    }
  }
  return memory.get(key) ?? null;
}

/** Returns whether the draft reached browser storage; the in-memory copy always exists. */
export function saveDraft(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
  draft: Draft,
): boolean {
  const key = draftKey(ownerId, repositoryId, conversationId);
  memory.set(key, draft);
  const local = storage();
  if (!local) {
    return false;
  }
  try {
    local.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function removeDraft(ownerId: string, repositoryId: string, conversationId: string): void {
  const key = draftKey(ownerId, repositoryId, conversationId);
  memory.delete(key);
  const local = storage();
  if (!local) {
    return;
  }
  try {
    local.removeItem(key);
  } catch {
    // A blocked removal only loses the explicit-clear convenience, not input.
  }
}

/**
 * Explicit sign-out clears every draft of that owner, including pending
 * idempotency ids. Drafts of another owner are never touched.
 */
export function clearOwnerDrafts(ownerId: string): void {
  const prefix = ownerPrefix(ownerId);
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) {
      memory.delete(key);
    }
  }
  const local = storage();
  if (!local) {
    return;
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < local.length; index += 1) {
      const key = local.key(index);
      if (key && key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      local.removeItem(key);
    }
  } catch {
    // The in-memory copies are already cleared.
  }
}

export function draftForSend(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
  text: string,
  pendingClientMessageId?: string,
): Draft {
  const previous = loadDraft(ownerId, repositoryId, conversationId);
  const trimmed = text.trim();
  const version =
    previous && previous.text === trimmed ? previous.version : (previous?.version ?? 0) + 1;
  const pending =
    previous?.pending && previous.pending.text === trimmed
      ? previous.pending
      : pendingClientMessageId
        ? {
            clientMessageId: pendingClientMessageId,
            text: trimmed,
            version,
            at: new Date().toISOString(),
          }
        : null;
  return {
    version,
    text: trimmed,
    updatedAt: new Date().toISOString(),
    pending,
  };
}
