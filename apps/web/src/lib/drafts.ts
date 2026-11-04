/**
 * Draft persistence for the Work composer.
 *
 * A draft belongs to exactly one owner, repository and conversation. The key
 * includes all three, so switching repositories or conversations can never
 * leak text between them. A lineage identifies one uninterrupted editing
 * session. Clearing (or deleting) the draft drops the lineage, so retyping the
 * same text cannot be mistaken for the edit an earlier send submitted. Every
 * send stores its own snapshot (clientMessageId, text, lineageId); success
 * settles only that snapshot and never a different lineage.
 */

const PREFIX = 'moyu:draft:v1';

/** One-shot UI notes handed from a send/merge to the conversation that loads next. */
const notices = new Map<string, string>();

export interface DraftPending {
  /** The idempotency key of the send attempt that created this pending state. */
  clientMessageId: string;
  text: string;
  /** Draft version the pending send submitted. */
  version: number;
  /** Editing lineage the pending send submitted; a different lineage is a different edit. */
  lineageId: string;
  at: string;
  /** Whether the request failed with an unknown network outcome. */
  ambiguous?: boolean;
}

/** An unresolved source draft kept while another conversation has its own pending send. */
export interface ParkedDraft {
  /** Source conversation id; also the key within parked. */
  id: string;
  sourceConversationId: string;
  version: number;
  lineageId: string;
  text: string;
  pending: DraftPending;
  deferredText?: string;
  updatedAt: string;
}

export interface Draft {
  version: number;
  /** Stable across edits, replaced when the draft is cleared and recreated. */
  lineageId: string;
  text: string;
  updatedAt: string;
  pending: DraftPending | null;
  /**
   * Unsent text merged in from a hidden source while this conversation had a
   * send awaiting confirmation. It is never joined into `text` until that
   * pending send settles, so the pending retry keeps its own key and body.
   */
  deferredText?: string;
  /** Unresolved sends parked by an alias resolution so nothing is discarded. */
  parked?: ParkedDraft[];
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

export function newLineageId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `lineage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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

export function markDraftNotice(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
  text: string,
): void {
  notices.set(draftKey(ownerId, repositoryId, conversationId), text);
}

export function consumeDraftNotice(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
): string | null {
  const key = draftKey(ownerId, repositoryId, conversationId);
  const text = notices.get(key) ?? null;
  notices.delete(key);
  return text;
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
    // Legacy drafts have no lineage. Give the loaded copy one; an in-flight
    // send from before this change simply cannot settle against it.
    const lineageId =
      typeof value.lineageId === 'string' && value.lineageId ? value.lineageId : newLineageId();
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
            lineageId:
              typeof pending.lineageId === 'string' && pending.lineageId
                ? pending.lineageId
                : lineageId,
            at: pending.at,
            ambiguous: pending.ambiguous === true,
          }
        : null;
    return {
      version,
      lineageId,
      text: value.text,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
      pending: validPending,
      ...(typeof value.deferredText === 'string' && value.deferredText.length > 0
        ? { deferredText: value.deferredText }
        : {}),
      ...(Array.isArray(value.parked) && value.parked.length > 0
        ? {
            parked: value.parked.flatMap((item): ParkedDraft[] => {
              if (!item || typeof item !== 'object') return [];
              const parked = item as Partial<ParkedDraft>;
              if (
                typeof parked.id !== 'string' ||
                typeof parked.text !== 'string' ||
                !parked.pending ||
                typeof parked.pending.clientMessageId !== 'string' ||
                typeof parked.pending.text !== 'string' ||
                typeof parked.pending.version !== 'number' ||
                typeof parked.pending.at !== 'string'
              ) {
                return [];
              }
              const pending: DraftPending = {
                clientMessageId: parked.pending.clientMessageId,
                text: parked.pending.text,
                version: parked.pending.version,
                lineageId:
                  typeof parked.pending.lineageId === 'string' && parked.pending.lineageId
                    ? parked.pending.lineageId
                    : typeof parked.lineageId === 'string' && parked.lineageId
                      ? parked.lineageId
                      : newLineageId(),
                at: parked.pending.at,
                ambiguous: parked.pending.ambiguous === true,
              };
              return [
                {
                  id: parked.id,
                  sourceConversationId:
                    typeof parked.sourceConversationId === 'string'
                      ? parked.sourceConversationId
                      : parked.id,
                  version: typeof parked.version === 'number' ? parked.version : pending.version,
                  lineageId:
                    typeof parked.lineageId === 'string' && parked.lineageId
                      ? parked.lineageId
                      : pending.lineageId,
                  text: parked.text,
                  pending,
                  ...(typeof parked.deferredText === 'string' && parked.deferredText.length > 0
                    ? { deferredText: parked.deferredText }
                    : {}),
                  updatedAt:
                    typeof parked.updatedAt === 'string'
                      ? parked.updatedAt
                      : new Date().toISOString(),
                },
              ];
            }),
          }
        : {}),
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
  for (const key of [...notices.keys()]) {
    if (key.startsWith(prefix)) {
      notices.delete(key);
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

function joinText(current: string | undefined, added: string): string {
  const first = current?.trimEnd() ?? '';
  const second = added.trim();
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return `${first}\n\n${second}`;
}

export interface DraftMigration {
  draft: Draft | null;
  /** True when the target had a send awaiting confirmation, so text went to deferredText. */
  deferred: boolean;
  /** True when this send left unsent content that moved to the target. */
  moved: boolean;
}

export interface SentSnapshot {
  clientMessageId: string;
  text: string;
  lineageId: string;
}

/**
 * Settles one successful send on the source conversation and moves everything
 * it did not send to the target. The sent body is excluded only when the
 * source still holds exactly that snapshot; the source's deferredText and any
 * newer editable text are unsent and must survive even when they equal the
 * sent body. A target pending send keeps its body, key and deferred text
 * untouched; incoming remaining content is appended to its deferredText.
 */
export function migrateSentDraftToConversation(
  ownerId: string,
  repositoryId: string,
  sourceConversationId: string,
  targetConversationId: string,
  sent: SentSnapshot,
): DraftMigration {
  const target = loadDraft(ownerId, repositoryId, targetConversationId);
  const source = loadDraft(ownerId, repositoryId, sourceConversationId);
  if (!source) {
    return { draft: target, deferred: false, moved: false };
  }
  const sentBodyStillOnly =
    source.lineageId === sent.lineageId && source.text.trim() === sent.text.trim();
  const unsentText = sentBodyStillOnly ? '' : source.text;
  const unsentDeferred = source.deferredText ?? '';
  const remaining = joinText(unsentText, unsentDeferred);
  if (remaining.trim().length === 0) {
    removeDraft(ownerId, repositoryId, sourceConversationId);
    return { draft: target, deferred: false, moved: false };
  }
  if (target?.pending) {
    const updated: Draft = {
      ...target,
      deferredText: joinText(target.deferredText, remaining),
      updatedAt: new Date().toISOString(),
    };
    saveDraft(ownerId, repositoryId, targetConversationId, updated);
    removeDraft(ownerId, repositoryId, sourceConversationId);
    return { draft: updated, deferred: true, moved: true };
  }
  const combinedText = [target?.text, unsentText, target?.deferredText, unsentDeferred]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .reduce((current, part) => joinText(current, part), '');
  const migrated: Draft = {
    // A new lineage: the combined text is a new unsent edit. A late response
    // from either conversation can no longer match and clear it.
    version: Math.max(target?.version ?? 0, source.version) + 1,
    lineageId: newLineageId(),
    text: combinedText,
    updatedAt: new Date().toISOString(),
    pending: null,
  };
  saveDraft(ownerId, repositoryId, targetConversationId, migrated);
  removeDraft(ownerId, repositoryId, sourceConversationId);
  return { draft: migrated, deferred: false, moved: true };
}

/**
 * Moves a source draft when the API resolves its conversation to a merged
 * target without a send response (for example a committed POST whose response
 * was lost). Without a target draft the source state moves intact, so an
 * unresolved send keeps its idempotency key and can be retried on the target.
 */
export function moveDraftToAlias(
  ownerId: string,
  repositoryId: string,
  sourceConversationId: string,
  targetConversationId: string,
): Draft | null {
  if (sourceConversationId === targetConversationId) {
    return loadDraft(ownerId, repositoryId, targetConversationId);
  }
  const source = loadDraft(ownerId, repositoryId, sourceConversationId);
  const target = loadDraft(ownerId, repositoryId, targetConversationId);
  if (!source) {
    return target;
  }
  if (!target) {
    saveDraft(ownerId, repositoryId, targetConversationId, source);
    removeDraft(ownerId, repositoryId, sourceConversationId);
    return source;
  }
  if (source.pending) {
    // An alias GET does not prove this clientMessageId was accepted. Never
    // settle or discard it: park the whole source state (body, key, lineage,
    // deferred text) beside the target's own draft for itemized recovery.
    const parked = [...(target.parked ?? [])];
    const entry: ParkedDraft = {
      id: sourceConversationId,
      sourceConversationId,
      version: source.version,
      lineageId: source.lineageId,
      text: source.text,
      pending: source.pending,
      ...(source.deferredText ? { deferredText: source.deferredText } : {}),
      updatedAt: source.updatedAt,
    };
    const index = parked.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      parked[index] = entry;
    } else {
      parked.push(entry);
    }
    const kept: Draft = {
      ...target,
      parked,
      updatedAt: new Date().toISOString(),
    };
    saveDraft(ownerId, repositoryId, targetConversationId, kept);
    removeDraft(ownerId, repositoryId, sourceConversationId);
    return kept;
  }
  if (target.pending) {
    const updated: Draft = {
      ...target,
      deferredText: joinText(joinText(target.deferredText, source.text), source.deferredText ?? ''),
      updatedAt: new Date().toISOString(),
    };
    saveDraft(ownerId, repositoryId, targetConversationId, updated);
    removeDraft(ownerId, repositoryId, sourceConversationId);
    return updated;
  }
  const text = [target.text, source.text, target.deferredText, source.deferredText]
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .reduce((current, part) => joinText(current, part), '');
  const merged: Draft = {
    version: Math.max(target.version, source.version) + 1,
    lineageId: newLineageId(),
    text,
    updatedAt: new Date().toISOString(),
    pending: null,
  };
  saveDraft(ownerId, repositoryId, targetConversationId, merged);
  removeDraft(ownerId, repositoryId, sourceConversationId);
  return merged;
}

export interface SettledSend {
  draft: Draft | null;
  /** False when this response belongs to a draft lineage that no longer exists. */
  settled: boolean;
  /** True when deferred merge text was promoted into the composer. */
  promoted: boolean;
}

/**
 * Settles exactly one successful send by its idempotency key. A different
 * lineage (clear + retype, explicit clear, another draft) is never touched, so
 * a stale response cannot clear new unsent content with the same version and
 * text. When the target has deferred merge text, it replaces the sent body.
 */
export function settleSuccessfulSend(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
  clientMessageId: string,
): SettledSend {
  const draft = loadDraft(ownerId, repositoryId, conversationId);
  if (!draft?.pending || draft.pending.clientMessageId !== clientMessageId) {
    return { draft, settled: false, promoted: false };
  }
  const exactSnapshot =
    draft.lineageId === draft.pending.lineageId && draft.text === draft.pending.text;
  if (exactSnapshot) {
    if (draft.deferredText && draft.deferredText.trim().length > 0) {
      const promoted: Draft = {
        version: draft.version + 1,
        lineageId: newLineageId(),
        text: draft.deferredText,
        updatedAt: new Date().toISOString(),
        pending: null,
        ...(draft.parked ? { parked: draft.parked } : {}),
      };
      saveDraft(ownerId, repositoryId, conversationId, promoted);
      return { draft: promoted, settled: true, promoted: true };
    }
    if (draft.parked && draft.parked.length > 0) {
      // The sent body leaves the composer, but other unresolved source sends
      // remain available for itemized recovery.
      const cleared: Draft = {
        ...draft,
        version: draft.version + 1,
        lineageId: newLineageId(),
        text: '',
        pending: null,
      };
      saveDraft(ownerId, repositoryId, conversationId, cleared);
      return { draft: cleared, settled: true, promoted: false };
    }
    removeDraft(ownerId, repositoryId, conversationId);
    return { draft: null, settled: true, promoted: false };
  }
  // Edited during the send: only the settled pending snapshot is cleared; the
  // newer text (and any deferred merge text) stays.
  const kept: Draft = { ...draft, pending: null };
  saveDraft(ownerId, repositoryId, conversationId, kept);
  return { draft: kept, settled: true, promoted: false };
}

/** Restores the exact body of an unresolved send so it can be retried by key. */
export function restorePendingDraft(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
): Draft | null {
  const draft = loadDraft(ownerId, repositoryId, conversationId);
  if (!draft?.pending) {
    return draft;
  }
  // Keep the edit made after the send. It is not part of the pending body, so
  // restore it only after the old send settles; overwriting it would lose the
  // user's newer unsent content.
  const newerText =
    draft.text.trim().length > 0 && draft.text.trim() !== draft.pending.text
      ? draft.text
      : undefined;
  const restored: Draft = {
    ...draft,
    version: draft.version + 1,
    text: draft.pending.text,
    ...(newerText
      ? { deferredText: joinText(draft.deferredText, newerText) }
      : draft.deferredText
        ? { deferredText: draft.deferredText }
        : {}),
    updatedAt: new Date().toISOString(),
  };
  saveDraft(ownerId, repositoryId, conversationId, restored);
  return restored;
}

/** Appends deferred merge text to the editable draft, but only after pending settles. */
export function restoreDeferredDraft(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
): Draft | null {
  const draft = loadDraft(ownerId, repositoryId, conversationId);
  if (!draft?.deferredText || draft.pending) {
    return draft;
  }
  const restored: Draft = {
    ...draft,
    version: draft.version + 1,
    lineageId: newLineageId(),
    text: joinText(draft.text, draft.deferredText),
    deferredText: undefined,
    updatedAt: new Date().toISOString(),
  };
  saveDraft(ownerId, repositoryId, conversationId, restored);
  return restored;
}

/**
 * Restores one parked unresolved send after the current draft has no pending
 * send of its own. Current unsent text and the parked deferred text are kept
 * in deferredText, so neither side is lost while the restored key is checked.
 */
export function restoreParkedDraft(
  ownerId: string,
  repositoryId: string,
  conversationId: string,
  parkedId: string,
): Draft | null {
  const draft = loadDraft(ownerId, repositoryId, conversationId);
  if (!draft || draft.pending) {
    return draft;
  }
  const parked = draft.parked ?? [];
  const index = parked.findIndex((item) => item.id === parkedId);
  if (index < 0) {
    return draft;
  }
  const item = parked[index];
  if (!item) {
    return draft;
  }
  const remaining = parked.filter((entry) => entry.id !== parkedId);
  const deferredText = joinText(joinText(draft.deferredText, draft.text), item.deferredText ?? '');
  const restored: Draft = {
    version: Math.max(draft.version, item.version) + 1,
    lineageId: item.lineageId,
    text: item.text.trim().length > 0 ? item.text : item.pending.text,
    pending: item.pending,
    ...(deferredText.trim().length > 0 ? { deferredText } : {}),
    updatedAt: new Date().toISOString(),
    ...(remaining.length > 0 ? { parked: remaining } : {}),
  };
  saveDraft(ownerId, repositoryId, conversationId, restored);
  return restored;
}

/**
 * Builds the draft for a send. Unchanged text reuses its pending idempotency
 * key; new text belongs to the same editing lineage (unless the draft was
 * cleared), so an old response still cannot clear it.
 */
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
            lineageId: previous?.lineageId ?? newLineageId(),
            at: new Date().toISOString(),
          }
        : null;
  return {
    version,
    lineageId: previous?.lineageId ?? newLineageId(),
    text: trimmed,
    updatedAt: new Date().toISOString(),
    pending,
    ...(previous?.deferredText ? { deferredText: previous.deferredText } : {}),
    ...(previous?.parked ? { parked: previous.parked } : {}),
  };
}
