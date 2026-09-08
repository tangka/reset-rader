#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandTarget, queryRadar, safeJson, RadarApiError } from './api-client.mjs';
import { loadConfiguration, stateDirectory, readPrivateFile, writePrivateFile, configureKey } from './configuration.mjs';
import { readLocalCodexRateLimits } from './local-codex.mjs';
import { runtimeSetupMessage } from './codex-runtime.mjs';
import { buildPersonalProbability } from './personal-probability.mjs';
import { checkChanges, runWatch } from './monitor.mjs';

const USAGE = `Reset Radar (read-only, weekly quota only)
  personal                         Personal 24h probability (default)
  overview                         Radar probabilities, natural cycle excluded
  status                           Provider service status
  history <platform> [--limit 1-14] [--before <cursor>] [--date YYYY-MM-DD]
  check [--threshold 0-100]         One monitoring check, persistent deduplication
  watch [--threshold 0-100]         Foreground monitor, every 10 minutes; Ctrl+C stops
  overlay doctor [--port N]        Read-only check for a compatible Codex desktop
  overlay start [--port N] [--target ID]  In-Codex floating radar; close or Ctrl+C stops
  overlay launch                  Debug-launch installed macOS app only after it exits
  configure --key-stdin             Save owner-only Key from stdin, never argv
  --help
No command starts a model inference, consumes a reset, or changes membership.`;

export async function personal(configuration, {signal, readLimits = readLocalCodexRateLimits,
  query = queryRadar, now = Date.now()} = {}) {
  const overview = await query({...configuration,target:commandTarget(['overview']),signal});
  let rateLimits;
  try { rateLimits = await readLimits({signal}); } catch (error) {
    if (signal?.aborted) throw new Error('Cancelled.');
    const setupMessage = runtimeSetupMessage(error);
    if (setupMessage) throw Object.assign(new Error(setupMessage), {code:error.code});
    rateLimits = null;
  }
  return buildPersonalProbability(overview,rateLimits,{now});
}

function thresholdArgument(args) {
  if (!args.length) return 80;
  if (args.length !== 2 || args[0] !== '--threshold' || !/^\d+(\.\d+)?$/.test(args[1])) {
    throw new Error('Use --threshold with a number from 0 to 100.');
  }
  const value = Number(args[1]);
  if (value < 0 || value > 100) throw new Error('Threshold must be between 0 and 100.');
  return value;
}

export async function checkOnce(configuration, {threshold=80, directory=stateDirectory(),
  signal, sample=personal, clock=Date.now, now=clock()} = {}) {
  const identity = createHash('sha256').update(`${configuration.apiBase}\n${configuration.apiKey}`).digest('hex').slice(0,24);
  const path = join(directory, `monitor-${identity}.json`);
  let previousState = null;
  try { previousState = JSON.parse(await readPrivateFile(path)); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read monitor state safely.');
  }
  if (previousState?.retryAt > now) {
    return {notifications:[],skipped:'retry_after',retryAfterSeconds:Math.ceil((previousState.retryAt-now)/1000)};
  }
  try {
    const report = await sample(configuration,{signal,now});
    const {state,notifications} = checkChanges({report,threshold,previousState,now});
    await writePrivateFile(path,JSON.stringify(state));
    return {report,notifications};
  } catch (error) {
    if (error.status === 429) {
      await writePrivateFile(path,JSON.stringify({...previousState,
        retryAt:clock()+Math.max(600,error.retryAfterSeconds || 0)*1000}));
    }
    throw error;
  }
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`); return;
  }
  const command = args[0] || 'personal';
  if (command === 'overlay') {
    const {overlayMain} = await import('./overlay-runner.mjs');
    await overlayMain(args.slice(1),environment);
    return;
  }
  if (command === 'configure') {
    if (args.length !== 2 || args[1] !== '--key-stdin' || process.stdin.isTTY) {
      throw new Error('Pipe the Key to configure --key-stdin locally; do not paste it into chat or arguments.');
    }
    await configureKey(process.stdin,environment);
    process.stdout.write('Key saved locally with owner-only permissions.\n'); return;
  }
  const configuration = await loadConfiguration(environment);
  const write = (value) => process.stdout.write(`${safeJson(value,configuration.apiKey)}\n`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    if (command === 'check' || command === 'watch') {
      const threshold = thresholdArgument(args.slice(1));
      const sample = () => checkOnce(configuration,{threshold,directory:stateDirectory(environment),signal:controller.signal});
      if (command === 'check') write(await sample());
      else await runWatch({sample,emit:write,signal:controller.signal});
    } else if (command === 'personal' && args.length <= 1) {
      write(await personal(configuration,{signal:controller.signal}));
    } else {
      write(await queryRadar({...configuration,target:commandTarget(args),signal:controller.signal}));
    }
  } finally {
    process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Only our safe messages; never dump request options or error stacks.
    process.stderr.write(`${error.message}\n`);
    if (error instanceof RadarApiError) process.stderr.write(`HTTP ${error.status}\n`);
    process.exitCode = 1;
  });
}
