export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  msgCount: number;
}

export interface SessionListResponse {
  active: string;
  list: SessionMeta[];
}

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  /** Agent / LLM 侧文本（含隐式「引用提示」） */
  content: string;
  /** 用户气泡展示 HTML（蓝字 mention chips）；缺省时由 content 回退渲染 */
  html?: string;
  status?: 'running' | 'done';
}

export interface Session extends SessionMeta {
  messages: Message[];
}

export interface AguiEvent {
  type: 'RUN_STARTED' | 'TEXT_MESSAGE_START' | 'TEXT_MESSAGE_CONTENT' | 'TEXT_MESSAGE_END' | 'TOOL_CALL_START' | 'TOOL_CALL_END' | 'RUN_FINISHED' | 'RUN_ERROR';
  delta?: string;
  toolName?: string;
  result?: { reply: string };
  error?: string;
}

export interface SuggestionItem {
  title?: string;
  reason?: string;
  context?: string;
  trigger?: string;
  _id?: string;
  apps?: string[];
  raw?: string;
}

export interface OrbConfig {
  dirs: string[];
  version: number;
}

export interface OrbAPI {
  onSuggestion: (cb: (item: SuggestionItem) => void) => () => void;
  addTodo: (item: SuggestionItem) => void;
  ignore: (item: SuggestionItem) => void;
  resizePopup: (height: number) => void;
  listSessions: () => Promise<SessionListResponse>;
  getSession: (id: string) => Promise<Session | null>;
  createSession: () => Promise<SessionListResponse>;
  deleteSession: (id: string) => Promise<SessionListResponse>;
  renameSession: (id: string, name: string) => Promise<{ id: string; name: string } | null>;
  switchSession: (id: string) => Promise<Session>;
  reorderSessions: (ids: string[]) => Promise<{ ok: boolean }>;
  chatStream: (payload: string | { text: string; html?: string; sessionId?: string }, handlers: {
    onEvent?: (ev: AguiEvent) => void;
    onDone?: (result: { reply?: string }) => void;
    onError?: (err: string) => void;
  }) => void;
  getFilter: () => Promise<{ denyApps: string[]; allowApps: string[] }>;
  setFilter: (f: { denyApps: string[]; allowApps: string[] }) => void;
  getConfig: () => Promise<OrbConfig>;
  setConfig: (cfg: Partial<OrbConfig>) => void;
  getRunningProcesses: () => Promise<string[]>;
  toolsList: () => Promise<{ categories: { key: string; label: string; tools: { name: string; label?: string; desc?: string }[] }[] }>;
  listFiles: () => Promise<string[]>;
  getRecall: () => Promise<any[]>;
  getRejected: () => Promise<any[]>;
  restoreRejected: (id: string) => Promise<void>;
}

declare global {
  interface Window {
    orb: OrbAPI;
  }
}

export {};
