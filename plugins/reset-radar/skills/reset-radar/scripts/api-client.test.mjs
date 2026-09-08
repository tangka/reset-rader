import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { commandTarget, queryRadar, readConfiguration } from './api-client.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const script = join(directory, 'reset-radar.mjs');
const API_KEY = `rr_live_${'a'.repeat(12)}_${'B'.repeat(43)}`;

function runScript(argumentsList, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...argumentsList], {
      env: { PATH: process.env.PATH, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr, stdout }));
  });
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}/radar-api/member/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
}

test('builds only documented read-only command targets', () => {
  assert.equal(commandTarget(['overview']), '/overview?naturalCycle=exclude');
  assert.equal(commandTarget(['status']), '/service-status');
  assert.equal(
    commandTarget(['history', 'codex', '--limit', '7', '--date', '2026-09-07']),
    '/reset-history/codex?limit=7&date=2026-09-07',
  );
  assert.throws(() => commandTarget(['history', '../payment']), /canonical platform/);
  assert.throws(() => commandTarget(['history', 'codex', '--limit', '15']), /1 to 14/);
  assert.throws(() => commandTarget(['admin']), /unknown command/);
});

test('mistaken credentials in arguments are never echoed by argument errors', () => {
  for (const args of [[API_KEY],['history','codex',API_KEY],['history','codex',API_KEY,'value']]) {
    assert.throws(() => commandTarget(args), (error) => !error.message.includes(API_KEY));
  }
});

test('requires a valid member key and HTTPS except for loopback testing', () => {
  assert.throws(() => readConfiguration({}), /missing or invalid/);
  assert.throws(
    () => readConfiguration({
      RESET_RADAR_API_KEY: API_KEY,
      RESET_RADAR_API_BASE: 'http://example.test/member/v1',
    }),
    /must use HTTPS/,
  );
  assert.equal(
    readConfiguration({
      RESET_RADAR_API_KEY: API_KEY,
      RESET_RADAR_API_BASE: 'http://127.0.0.1:4567/member/v1/',
    }).apiBase,
    'http://127.0.0.1:4567/member/v1',
  );
});

test('queries the member API with bearer auth and emits machine-readable JSON', async () => {
  await withServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/radar-api/member/v1/overview?naturalCycle=exclude');
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ apiVersion: 1, naturalCycle: 'exclude', generatedAt: '2026-09-07T08:00:00.000Z' }));
  }, async (apiBase) => {
    const result = await runScript(['overview'], {
      RESET_RADAR_API_KEY: API_KEY,
      RESET_RADAR_API_BASE: apiBase,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      apiVersion: 1,
      naturalCycle: 'exclude',
      generatedAt: '2026-09-07T08:00:00.000Z',
    });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(API_KEY), false);
  });
});

test('rejects a legacy server that ignores exclusion and never follows redirects', async () => {
  let calls = 0;
  await assert.rejects(queryRadar({apiBase:'https://example.test',apiKey:API_KEY,
    target: commandTarget(['overview']), fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify({platforms:[]}));
    }}), /did not confirm/);
  assert.equal(calls, 1);
});

test('honours Retry-After without echoing error payload and rejects unsafe URL forms', async () => {
  await assert.rejects(queryRadar({apiBase:'https://example.test',apiKey:API_KEY,
    target:commandTarget(['overview']), fetchImpl:async () => new Response(JSON.stringify({error:API_KEY,
      retryAfterSeconds:12}), {status:429,headers:{'retry-after':'900'}})}), (error) => {
    assert.equal(error.status,429);
    assert.equal(error.retryAfterSeconds,900);
    assert.equal(error.message.includes(API_KEY),false);
    return true;
  });
  for (const apiBase of ['ftp://localhost','https://user:pass@example.test','https://example.test?key=1']) {
    assert.throws(() => readConfiguration({RESET_RADAR_API_KEY:API_KEY,RESET_RADAR_API_BASE:apiBase}));
  }
});

test('redacts a success payload reflecting the key', async () => {
  const payload = await queryRadar({apiBase:'https://example.test',apiKey:API_KEY,
    target:'/service-status', fetchImpl:async () => new Response(JSON.stringify({secret:API_KEY}))});
  assert.equal(JSON.stringify(payload).includes(API_KEY),false);
});

test('HTTP redirects never receive a forwarded member request', async () => {
  let redirectedRequests = 0;
  await withServer((_request,response) => {
    redirectedRequests += 1;
    response.end('{}');
  }, async (destination) => {
    await withServer((_request,response) => {
      response.writeHead(302,{location:destination}); response.end();
    }, async (apiBase) => {
      await assert.rejects(queryRadar({apiBase,apiKey:API_KEY,target:'/service-status'}),/could not reach/);
    });
  });
  assert.equal(redirectedRequests,0);
});

test('response body is bounded and the timeout remains active after headers', async () => {
  await assert.rejects(queryRadar({apiBase:'https://example.test',apiKey:API_KEY,
    target:'/service-status',fetchImpl:async () => new Response(' '.repeat(2*1024*1024+1))}),/invalid JSON/);
  await withServer((_request,response) => {
    response.writeHead(200,{'content-type':'application/json'});
    response.write('{"waiting":');
  }, async (apiBase) => {
    await assert.rejects(queryRadar({apiBase,apiKey:API_KEY,target:'/service-status',timeoutMs:50}),
      /timed out|could not reach/);
  });
});

test('encodes history cursors without exposing the key', async () => {
  const cursor = '2026-09-07T08:00:00.000Z|record-1';
  await withServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, '/radar-api/member/v1/reset-history/claude');
    assert.equal(url.searchParams.get('before'), cursor);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ apiVersion: 1, platform: 'claude', records: [] }));
  }, async (apiBase) => {
    const result = await runScript(['history', 'claude', '--before', cursor], {
      RESET_RADAR_API_KEY: API_KEY,
      RESET_RADAR_API_BASE: apiBase,
    });
    assert.equal(result.status, 0);
    assert.equal(`${result.stdout}${result.stderr}`.includes(API_KEY), false);
  });
});

test('maps API failures to safe guidance without printing a response that echoes the key', async () => {
  await withServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: API_KEY, code: 'invalid_api_key' }));
  }, async (apiBase) => {
    const result = await runScript(['overview'], {
      RESET_RADAR_API_KEY: API_KEY,
      RESET_RADAR_API_BASE: apiBase,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid or revoked/);
    assert.equal(`${result.stdout}${result.stderr}`.includes(API_KEY), false);
  });
});
