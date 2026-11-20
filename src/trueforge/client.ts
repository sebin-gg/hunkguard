// TrueForge REST client. The extension never calls a model provider directly;
// all model traffic goes through the local TrueForge server.

export interface TurnEvent {
  type: string;
  id?: string;
  created_at?: string;
  thread_id?: string;
  [k: string]: unknown;
}

export interface ToolCallRef {
  tool_call_id?: string;
  id?: string;
  name?: string;
  [k: string]: unknown;
}

export class TrueForgeClient {
  constructor(private baseUrl: string) {}

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* SSE or empty */ }
    if (!res.ok) {
      const msg = (json as { error?: { message?: string } })?.error?.message ?? text.slice(0, 300);
      throw new TrueForgeError(res.status, msg);
    }
    return json;
  }

  async health(): Promise<boolean> {
    try { await this.req('GET', '/api/v1/models'); return true; } catch { return false; }
  }

  async registerMcpServer(name: string, url: string, description: string): Promise<void> {
    await this.req('PUT', '/api/v1/settings/mcp-servers', {
      manifest: { type: 'remote', name, url, description },
    });
  }

  async createSession(spec: AgentSpec): Promise<string> {
    const d = (await this.req('POST', '/api/v1/sessions', { agent: { spec } })) as { data: { id: string } };
    return d.data.id;
  }

  async sendTurn(sessionId: string, text: string): Promise<string> {
    const d = (await this.req('POST', `/api/v1/sessions/${sessionId}/turns`, {
      input: [{ type: 'user.message', content: text }],
      stream: true,
    })) as { data?: { id?: string }; id?: string } | Response;
    // stream:true returns an SSE Response in some deployments; handle both.
    if (d instanceof Response) {
      const reader = d.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let turnId = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as TurnEvent;
            if (ev.type === 'turn.created' && typeof ev.turn_id === 'string') turnId = ev.turn_id;
          } catch { /* partial */ }
        }
      }
      return turnId;
    }
    const turnId = (d as { data?: { id?: string } }).data?.id ?? (d as { id?: string }).id;
    if (!turnId) throw new TrueForgeError(0, 'turn created without id');
    return turnId;
  }

  async *streamTurnEvents(sessionId: string, turnId: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    const res = await fetch(`${this.baseUrl}/api/v1/sessions/${sessionId}/turns/${turnId}/subscribe`, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      // Fallback: poll the events endpoint.
      const seen = new Set<string>();
      while (true) {
        const d = (await this.req('GET', `/api/v1/sessions/${sessionId}/turns/${turnId}/events`)) as {
          data: TurnEvent[] | { items?: TurnEvent[] };
        };
        const items = Array.isArray(d.data) ? d.data : (d.data.items ?? []);
        let done = false;
        for (const ev of items) {
          const key = ev.id ?? JSON.stringify(ev).slice(0, 80);
          if (!seen.has(key)) { seen.add(key); yield ev; }
          if (ev.type === 'turn.done') done = true;
        }
        if (done) return;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { yield JSON.parse(payload) as TurnEvent; } catch { /* partial */ }
      }
    }
  }

  async respondApproval(sessionId: string, turnId: string, threadId: string, toolCallId: string, allow: boolean, reason?: string): Promise<void> {
    await this.req('POST', `/api/v1/sessions/${sessionId}/turns/${turnId}/events`, {
      events: [{
        type: 'user.tool_approval',
        thread_id: threadId,
        tool_call_id: toolCallId,
        approval: allow ? { status: 'allow' } : { status: 'deny', reason: reason ?? 'denied by user' },
      }],
    });
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.req('POST', `/api/v1/sessions/${sessionId}/cancel`, {});
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.req('DELETE', `/api/v1/sessions/${sessionId}`);
  }
}

export class TrueForgeError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface AgentSpec {
  model: { name: string; params?: Record<string, unknown> };
  instructions?: string;
  mcp_servers?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
}
