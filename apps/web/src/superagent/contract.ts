/**
 * MoYu adaptation layer: the type contract of the runtime management API that the
 * vendored Superagent settings components consume.
 *
 * The components under `./client` are copied from the pinned upstream commit
 * (6337fc82, see integrations/superagent/upstream.lock.json) and are unchanged
 * except for their import specifiers. What changed is the transport: instead of
 * the upstream DSH panel origin (`/orchestrator/api/...`) they call MoYu's
 * repository-scoped endpoints (`/api/v1/repositories/:id/superagent/...`), which
 * the API relays to the repository's own runtime.
 *
 * These declarations mirror the real responses, captured from a running instance
 * into `docs/evidence/m6c/contract/`. The server stays the authority: it validates
 * every save and returns its own 409/422. Pages MoYu does not render (tickets,
 * threads, decisions, overview) are typed loosely on purpose.
 */

export type Localized = { zh: string; en: string } | string;

/** One field of a Source's config schema, as the runtime reports it. */
export type FieldSpec =
  | { key: string; type: 'switch'; label: Localized; hint?: Localized; advanced?: boolean }
  | {
      key: string;
      type: 'select';
      label: Localized;
      hint?: Localized;
      advanced?: boolean;
      options: Array<{ value: string; label: Localized }>;
    }
  | {
      key: string;
      type: 'number';
      label: Localized;
      hint?: Localized;
      advanced?: boolean;
      min?: number;
      max?: number;
    }
  | {
      key: string;
      type: 'text';
      label: Localized;
      hint?: Localized;
      advanced?: boolean;
      pattern?: string;
      readonly?: boolean;
      choose?: Localized;
      refresh?: Localized;
    }
  | {
      key: string;
      type: 'fact';
      label: Localized;
      hint?: Localized;
      advanced?: boolean;
      settings?: string;
    }
  | {
      key: string;
      type: 'rows';
      label: Localized;
      hint?: Localized;
      advanced?: boolean;
      columns: RowColumn[];
    };

export interface RowColumn {
  key: string;
  type: 'text' | 'select';
  label: Localized;
  pattern?: string;
  optional?: boolean;
  choose?: Localized;
  refresh?: Localized;
  options?: Array<{ value: string; label: Localized }>;
}

export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed';

/** One row of a Source's admission table. */
export interface AdmissionRowView {
  id: string;
  label: Localized;
  note?: Localized;
  cells: Partial<Record<AdmissionCell, boolean>>;
}

export interface SourcePolicyView {
  fields: FieldSpec[];
  explicit: Localized;
  rows: AdmissionRowView[];
  sync?: { label: Localized; ready: boolean; health?: { state: string; at?: string; detail?: string } };
}

export interface SourceView {
  id: string;
  kind: string;
  title: Localized;
  description: Localized;
  installed: boolean;
  value: { enabled: boolean; config: Record<string, unknown> };
  revision: number;
  /** Config keys whose change restarts the runtime and interrupts running work. */
  restarts: string[];
  fields: FieldSpec[];
  facts: Record<string, Localized>;
  labels: Record<string, string>;
  policy?: SourcePolicyView;
  problem?: SetupProblem | null;
}

export interface PolicyRule {
  id: string;
  name: string;
  enabled: boolean;
  instruction: string;
}

export interface PolicyValue {
  rules: PolicyRule[];
  sources: Record<string, Record<string, unknown>>;
}

export interface EvalValue {
  mode: 'off' | 'observe' | 'auto';
  timeoutSeconds: number;
  model: RoleModel | null;
}

export interface RoleModel {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ExecutorValue {
  model: RoleModel | null;
  maxWorkers: number;
  directory: string;
  prepare: string;
  blockedCommands: string[];
}

export interface Settings {
  policy: PolicyValue;
  eval: EvalValue;
  executor: ExecutorValue;
}

export interface SettingsView {
  policyVersion: string;
  blocks: {
    policy: { revision: number; value: PolicyValue };
    eval: { revision: number; value: EvalValue };
    executor: { revision: number; value: ExecutorValue };
  };
  sources: SourceView[];
  environment: {
    root: string;
    variables: Array<{
      owner: string;
      enabled: boolean;
      variables: Array<{ key: string; ticket?: boolean; description: Localized }>;
    }>;
  };
}

export interface SetupMachine {
  stateDir: string;
  promptMaxChars: number;
  admissionContextMaxPages: number;
  admissionContextTimeoutMs: number;
}

export interface TicketStageUnknown {
  stage: string;
  action?: string;
}
export type TicketStage =
  | { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' }
  | { stage: 'idle' }
  | { stage: 'ended' }
  | TicketStageUnknown;

export interface SetupView {
  machine: SetupMachine;
  problem: SetupProblem | null;
  feishuProblem: SetupProblem | null;
  accounts: {
    repository: string;
    agent: string;
    feishu: { name?: string; botId: string } | null;
  };
}

export interface RuntimeHealth {
  runtime?: { state?: string };
  [key: string]: unknown;
}

export interface StateView {
  setup: SetupView;
  load: { running: number; queued: number; maxWorkers: number };
  masterId: string | null;
  paused: boolean;
  health: RuntimeHealth;
}

export interface HistoryChange {
  code: string;
  source?: string;
  part?: string;
  field?: string;
  name?: string;
  from?: unknown;
  to?: unknown;
  items?: string[];
}

export interface HistoryView {
  current: number;
  policyVersion: string;
  items: Array<{
    revision: number;
    savedAt: string;
    source: string;
    block: string;
    policyVersion: string;
    policyChanged: boolean;
    notified: Array<{ id: string; title: string }>;
    changes: HistoryChange[] | null;
  }>;
}

export interface BuiltInPartView {
  key: string;
  roles: string[];
  text: string;
  base?: string;
}

export interface PromptConfig {
  communication: string;
  scope: string;
  delivery: string;
  skills: Record<string, string>;
  overrides?: Record<string, { text: string; base?: string }>;
}

export interface PromptsView {
  masterId: string;
  current: { revision: number; config: PromptConfig };
  defaults: PromptConfig;
  sections: string[];
  skillName: string;
  builtin: string;
  skillPrefix: string;
  parts: BuiltInPartView[];
  defaultChanged: Array<{ part: string; removed?: boolean }>;
  revision: number;
  sessions: Array<{ id: string; title: string }>;
  notificationPending: boolean;
  revisions: number[];
  next_offset: number | null;
}

export interface ModelCatalog {
  default: RoleModel | null;
  routableProviders: string[];
  groups: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      reasoning?: { efforts: Array<{ id: string; name: string }> };
    }>;
  }>;
  failures: unknown[];
}

export interface Health {
  name: string;
  state: 'ready' | 'paused' | 'error' | 'idle' | string;
  code?: string;
  detail: string;
  at?: string;
}

export interface SourceStatusView {
  id: string;
  title: Localized;
  installed: boolean;
  enabled: boolean;
  state: string;
  health: Health[];
  stats: { received: number; filtered: number; lastAt: string };
  problem?: SetupProblem | null;
  filtered: Array<{ id: string; actor: string; preview: string; reason: string; at: string }>;
  dropped: Array<{
    id: string;
    preview: string;
    dropped: { reason: string; at: string };
    ticket?: { id: string; title: string };
    thread?: string;
  }>;
}

/** Labels for runtime health checks, as the runtime reports them. */
export const HEALTH_TEXT: Record<string, { zh: string; en: string }> = {};

/**
 * The management API surface, as the vendored components name it.
 * Only the settings endpoints are served by MoYu today; the ticket/thread routes
 * are declared so the shared components typecheck, and calling them returns the
 * relay's 404/422 instead of pretending to work.
 */
export interface TicketLineView {
  id: string;
  title: string;
  stage: TicketStage;
  question?: string | null;
  [key: string]: unknown;
}
export interface DecisionLineView {
  id: string;
  kind: string;
  at: string;
  [key: string]: unknown;
}
export type TicketFilter = 'open' | 'person' | 'working' | 'idle' | 'ended';
export type ThreadFilter = 'subscribed' | 'evaluating' | 'recent' | 'all';
export const TICKET_FILTERS: readonly TicketFilter[] = ['open', 'person', 'working', 'idle', 'ended'];
export const THREAD_FILTERS: readonly ThreadFilter[] = ['subscribed', 'evaluating', 'recent', 'all'];

type Paged = { offset?: number; limit?: number };
type Delivery = 'injected' | 'pending';
/**
 * Loose shape for management pages MoYu does not render (tickets, threads,
 * decisions, overview). The vendored components still typecheck against them; the
 * server remains the authority for those responses.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

export interface Api {
  'GET state': { response: StateView };
  'GET overview': { response: { problems: Loose[] } & Loose };
  'GET search': { query: { q: string }; response: { tickets: Loose[] } & Loose };
  'GET sources': { response: SourceStatusView[] };
  'GET settings': { response: SettingsView };
  'POST sources/:id/labels': { response: { added: string[] } };
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: { items: Loose[] } & Loose };
  'GET threads/:key': {
    query?: { limit?: number; before?: string; around?: string };
    response: { timeline: Loose[] } & Loose;
  };
  'POST threads/:key/unsubscribe': {
    response: { removed: boolean; thread: string; context_delivery: Delivery };
  };
  'POST triggers/:id/requeue': { response: { queued: boolean } };
  'GET decisions': {
    query?: Paged & { kind?: string; window?: '24h' };
    response: { items: Loose[] } & Loose;
  };
  'POST decisions/:id/dismiss': { response: { dismissed: true } };
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: { items: Loose[] } & Loose };
  'GET tickets/:id': { response: Loose };
  'POST tickets/:id/retry': { response: { retried: true } };
  'POST tickets/:id/stop': { response: { stopped: true } };
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } };
  'PUT settings/:block': {
    body: { value: unknown; revision: number };
    response: { revision: number; restarting: boolean };
  };
  'GET policy/history': { response: HistoryView };
  'POST policy-sync/:id': { response: { policy: unknown } };
  'POST setup/check': { response: { restarting: true } };
  'GET models': { response: ModelCatalog };
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView };
  'PUT prompts': {
    body: { config: PromptConfig; baseRevision: number };
    response: { revision: number; context_delivery: Delivery };
  };
  'POST prompts/preview': { body: PromptConfig; response: Loose };
}

type Path<K> = K extends `${string} ${infer P}` ? P : never;
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}`
    ? Record<Name, string>
    : unknown;
export type RouteParams<K extends keyof Api> = Params<Path<K>>;
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>;
export type ApiResponse<K extends keyof Api> = Api[K]['response'];

/** The locale function the components receive. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Snapshot of one instance's Deployment configuration. */
export interface DeploymentSnapshot<V = Record<string, unknown>> {
  status: string;
  writable: boolean;
  mode?: string;
  revision: number;
  value: V;
}

/** DSH plugin-manager config form: snapshot/subscribe/mutate against the host config. */
export interface ConfigForm<V = Record<string, unknown>> {
  getSnapshot(): DeploymentSnapshot<V> | undefined;
  subscribe(listener: () => void): () => void;
  mutate(ops: Array<Record<string, unknown>>, revision: number): Promise<boolean>;
}

/** The page-shaped form the Deployment view consumes: a snapshot plus a mutate. */
export interface ConfigPageForm<V = Record<string, unknown>> {
  state: DeploymentSnapshot<V> | undefined;
  mutate(ops: Array<Record<string, unknown>>, revision: number): Promise<boolean>;
}
