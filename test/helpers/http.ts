import { createServer as createRawServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { createConfig } from '../../src/config.ts';
import { SessionRegistry } from '../../src/core/registry.ts';
import { createServer } from '../../src/server.ts';
import type { FakeSource } from './fake-source.ts';

export interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): unknown;
}

export interface TestServer {
  port: number;
  /** A request with full control of the headers — `fetch` will not let us set `Host`. */
  fetch(path: string, options?: RequestOptions): Promise<Response>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
}

/**
 * The real server on an ephemeral port, in front of fake sources.
 *
 * Routing, the host guard and the origin check are properties of the server, so
 * they are tested through a socket rather than by calling the handler directly —
 * a header the server never sees is a header the test cannot get wrong.
 */
export async function startServer(t: TestContext, sources: FakeSource[]): Promise<TestServer> {
  const config = createConfig({ port: 0 });
  const server = createServer({ config, registry: new SessionRegistry(config, sources) });
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve(null))));

  const port = (server.address() as AddressInfo).port;
  return { port, fetch: (path, options) => send(port, path, options) };
}

/** A listener occupying a port, so a test can watch the real server step past it. */
export async function occupyPort(t: TestContext): Promise<{ port: number; server: Server }> {
  const server = createRawServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(() => resolve(null))));
  return { port: (server.address() as AddressInfo).port, server };
}

function send(port: number, path: string, options: RequestOptions = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
