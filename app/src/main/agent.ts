import http from 'http'

export class AgentHttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 4 })

/** Minimal JSON client for the VMMon agent, reached through a local SSH tunnel port. */
export class AgentClient {
  constructor(
    public port: number,
    public token: string
  ) {}

  request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          method,
          path,
          agent: keepAlive,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {})
          },
          timeout: timeoutMs
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json: unknown = undefined
            try {
              json = text ? JSON.parse(text) : undefined
            } catch {
              /* not json */
            }
            const status = res.statusCode || 0
            if (status >= 400) {
              const msg = (json as { error?: string } | undefined)?.error || text.slice(0, 200) || `HTTP ${status}`
              reject(new AgentHttpError(status, msg))
            } else resolve(json as T)
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error(`Agent 请求超时: ${path}`)))
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }

  get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>('GET', path, undefined, timeoutMs)
  }

  post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>('POST', path, body, timeoutMs)
  }
}
