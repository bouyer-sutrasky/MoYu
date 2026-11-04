import type { BridgeBranchList, BridgeCapabilities, BridgeModelList } from '@moyu/contracts';
import type { Repository } from '@moyu/db';
import type { RuntimeBridgeClient } from '@moyu/runtime-client';

import type { ApiConfig } from '../config';
import { ApiProblem } from '../lib/errors';
import { createBridgeClient } from '../runtime/bridge';

export interface SelectedModel {
  provider: string;
  model: string;
  reasoningEffort?: string | null;
}

/**
 * Returns a client only when the repository has both an endpoint and a token.
 * Creation-time verification is best effort: a deployment without a runtime
 * must keep accepting conversations, because the runtime is authoritative again
 * when the first message is delivered.
 */
export function bridgeClientIfConfigured(
  config: ApiConfig,
  repository: Repository,
): RuntimeBridgeClient | null {
  try {
    return createBridgeClient(config, repository);
  } catch {
    return null;
  }
}

/** Rejects a model or reasoning effort the runtime does not advertise. */
export function assertModelAvailable(catalog: BridgeModelList, selected: SelectedModel): void {
  const option = catalog.models.find(
    (candidate) => candidate.provider === selected.provider && candidate.model === selected.model,
  );
  const label = `${selected.provider}/${selected.model}`;
  if (!option) {
    throw ApiProblem.invalid(
      `The selected model is not available in the repository runtime: ${label}`,
    );
  }
  const effort = selected.reasoningEffort ?? null;
  if (effort !== null) {
    const efforts = option.reasoningEfforts ?? [];
    if (!efforts.includes(effort)) {
      throw ApiProblem.invalid(`The reasoning effort "${effort}" is not available for ${label}`);
    }
  }
}

/** Rejects a base branch the runtime no longer lists. */
export function assertBranchAvailable(
  list: Pick<BridgeBranchList, 'branches'>,
  branch: string,
): void {
  if (!list.branches.some((candidate) => candidate.name === branch)) {
    throw ApiProblem.invalid(`The base branch no longer exists: ${branch}`);
  }
}

/** Capability check shared by preference saving and branch listing. */
export function advertisesBranches(capabilities: BridgeCapabilities): boolean {
  return capabilities.capabilities.branches === true;
}
