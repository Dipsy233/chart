/**
 * ChartEvent — the one shape Chart understands.
 *
 * It is deliberately a *copy* of Absence's event union, not an import of it.
 * Chart has to be embeddable (in Absence today, in something else tomorrow), so
 * the engine owns its own vocabulary; `src/adapters/absence.ts` is the only
 * place that knows where the events come from. A copy also means Chart can add
 * fields the observer does not have yet without waiting for the observer.
 *
 * The rule is the same one Absence uses: flat payloads, `type` narrows the
 * payload. No adapter, no runtime, no Pi, no OS knowledge lives here.
 */

export interface AgentStartPayload {
  model: string;
}

export interface AgentEndPayload {
  reason: "completed" | "aborted" | "error" | string;
}

export interface MessagePayload {
  role: "user" | "assistant" | "system";
  content: string;
  streaming?: boolean;
}

export interface ThinkingPayload {
  content: string;
  streaming?: boolean;
}

export interface ToolStartPayload {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolUpdatePayload {
  toolCallId: string;
  toolName: string;
  partial: unknown;
}

export interface ToolEndPayload {
  toolCallId: string;
  toolName: string;
  isError: boolean;
}

export interface FileReadPayload {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface FileWritePayload {
  path: string;
  content: string;
}

export interface FileEditPayload {
  path: string;
  before: string;
  after: string;
  diff: string;
}

export interface FileChangePayload {
  path: string;
  kind: "created" | "modified" | "deleted";
  /** The watcher saw this outside the project root. */
  outside?: boolean;
}

export interface CommandPayload {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SearchPayload {
  tool: string;
  query: string;
  scope?: string;
  matches: number;
}

export interface ProcessPayload {
  pid: number;
  ppid?: number;
  name: string;
  commandLine: string;
  status: "running" | "exited";
  startedAt: number;
  exitedAt?: number;
  exitCode?: number;
  children: number;
  command?: string;
  kind?: "primary" | "tool";
  kindReason?: string;
}

export interface ApprovalPayload {
  id: string;
  kind: string;
  title: string;
  detail: string;
  reason?: string;
  cwd?: string;
  options: Array<{ value: string; label: string }>;
}

export interface McpPayload {
  server: string;
  tool: string;
  toolName: string;
  toolCallId: string;
  isError: boolean;
  durationMs?: number;
}

export interface ErrorPayload {
  message: string;
}

export interface ChartEventPayloadMap {
  agent_start: AgentStartPayload;
  agent_end: AgentEndPayload;
  message: MessagePayload;
  thinking: ThinkingPayload;
  tool_start: ToolStartPayload;
  tool_update: ToolUpdatePayload;
  tool_end: ToolEndPayload;
  file_read: FileReadPayload;
  file_write: FileWritePayload;
  file_edit: FileEditPayload;
  file_change: FileChangePayload;
  command: CommandPayload;
  search: SearchPayload;
  process: ProcessPayload;
  approval: ApprovalPayload;
  mcp: McpPayload;
  error: ErrorPayload;
}

export type ChartEventType = keyof ChartEventPayloadMap;

export const CHART_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "message",
  "thinking",
  "tool_start",
  "tool_update",
  "tool_end",
  "file_read",
  "file_write",
  "file_edit",
  "file_change",
  "command",
  "search",
  "process",
  "approval",
  "mcp",
  "error",
] as const satisfies readonly ChartEventType[];

export type ChartEvent = {
  [K in ChartEventType]: {
    id: string;
    sessionId: string;
    timestamp: number;
    type: K;
    payload: ChartEventPayloadMap[K];
  };
}[ChartEventType];

export type ChartEventOf<K extends ChartEventType> = Extract<ChartEvent, { type: K }>;

/**
 * Streaming deltas carry the whole value so far, so storing every one is
 * quadratic. Chart skips them for facts and keeps the final event instead —
 * same cut Absence makes, and it is what makes the reduction cheap.
 */
export function isStreamingEvent(event: ChartEvent): boolean {
  return (event.type === "message" || event.type === "thinking") && event.payload.streaming === true;
}

/** The path an event touches, if it touches one. */
export function eventPath(event: ChartEvent): string | undefined {
  switch (event.type) {
    case "file_read":
    case "file_write":
    case "file_edit":
    case "file_change":
      return event.payload.path;
    default:
      return undefined;
  }
}
