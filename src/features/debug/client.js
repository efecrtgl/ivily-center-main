// Minimal Debug Adapter Protocol client: requests with sequence numbers, responses, events and
// reverse requests (answered as unsupported — Ivily Center does not launch processes on behalf
// of an adapter).

export class DapError extends Error {
  constructor(command, message, body) {
    super(message || `${command} failed`);
    this.command = command;
    this.body = body;
  }
}

export class DapClient {
  /** @param {(text: string) => void} send */
  constructor(send) {
    this.send = send;
    this.seq = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, command: string }>} */
    this.pending = new Map();
    /** @type {Set<(event: string, body: any) => void>} */
    this.listeners = new Set();
    this.closed = false;
  }

  /** @param {string} command @param {any} [args] @returns {Promise<any>} */
  request(command, args) {
    if (this.closed) return Promise.reject(new DapError(command, 'the debug session has ended'));
    const seq = this.seq++;
    const msg = { seq, type: 'request', command, ...(args !== undefined ? { arguments: args } : {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, command });
      try {
        this.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(seq);
        reject(e);
      }
    });
  }

  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Handle one message from the adapter. */
  receive(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body ?? {});
      else p.reject(new DapError(p.command, msg.body?.error?.format ?? msg.message, msg.body));
    } else if (msg.type === 'event') {
      for (const fn of this.listeners) fn(msg.event, msg.body ?? {});
    } else if (msg.type === 'request') {
      this.send(JSON.stringify({ seq: this.seq++, type: 'response', request_seq: msg.seq, command: msg.command, success: false, message: `${msg.command} is not supported by Ivily Center` }));
    }
  }

  /** The adapter went away: fail everything still waiting. */
  close() {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new DapError(p.command, 'the debug adapter exited'));
    this.pending.clear();
  }
}
