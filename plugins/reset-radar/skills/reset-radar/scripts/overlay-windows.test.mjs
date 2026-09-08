import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWindowsOverlay, takeRefreshCommand, windowsOverlayPaths, windowsPayload } from './overlay-windows.mjs';

test('native renderer payload contains only safe display fields', () => {
  const payload = windowsPayload({ terminal:false, inFlight:false, retryAfterAt:0, payload:() => ({
    status:'ready', message:'ok', nextRefreshAt:123, apiKey:'never-forward',
    report:{personalProbability:25,weeklyWindows:[]},
  }) });
  assert.deepEqual(Object.keys(payload).sort(),['canRefresh','message','nextRefreshAt','refreshing','report','status']);
  assert.equal(JSON.stringify(payload).includes('never-forward'),false);
});

test('native card keeps state and command paths inside its selected directory', () => {
  const paths = windowsOverlayPaths('C:/state','overlay_1');
  assert.match(paths.statePath,/windows-overlay-overlay_1\.json$/);
  assert.match(paths.commandPath,/windows-overlay-overlay_1\.command\.json$/);
  assert.throws(() => windowsOverlayPaths('C:/state','../../bad'));
});

test('native card accepts the Windows PowerShell BOM on an explicit refresh command', async () => {
  const removed = [];
  assert.equal(await takeRefreshCommand('C:/state/command.json', {
    read:async () => '\uFEFF{"type":"refresh"}', remove:async (path) => removed.push(path),
  }),true);
  assert.deepEqual(removed,['C:/state/command.json']);
});

test('native card starts a hidden PowerShell host, refreshes through Node, and cleans up', async () => {
  const controller = new AbortController();
  const writes = [];
  const removed = [];
  let refreshes = 0;
  const manualValues = [];
  const environment = {
    sYsTeMrOoT:'C:/Windows', WINDIR:'C:/Windows', TEMP:'C:/Temp', tmp:'C:/Tmp',
    UserProfile:'C:/Users/test', localappdata:'C:/Users/test/AppData/Local',
    RESET_RADAR_API_KEY:'test-only-key', reset_radar_api_key_file:'C:/private/member-key',
    OPENAI_API_KEY:'private-openai-test-key', NODE_OPTIONS:'--require C:/private/inject.cjs',
    PATH:'C:/private/bin', PSModulePath:'C:/private/modules',
  };
  class Child extends EventEmitter { kill() { this.killed = true; return true; } }
  class Data {
    terminal = false;
    async refresh(_signal,{manual}) { refreshes += 1; manualValues.push(manual); }
    payload() { return {status:'ready',report:{personalProbability:25,baseProbability:25,weeklyWindows:[]}}; }
  }
  const result = await runWindowsOverlay({
    platform:'win32', environment, signal:controller.signal, sessionId:'test-session', directory:'C:/state', Data,
    load:async () => ({apiKey:'test-only-key',apiBase:'https://example.test'}),
    stat:async () => ({isFile:() => true,isSymbolicLink:() => false}),
    write:async (path,content) => writes.push({path,content}),
    read:async () => { throw Object.assign(new Error('missing'),{code:'ENOENT'}); },
    remove:async (path) => { removed.push(path); },
    spawnImpl:(_file,args,options) => {
      assert.deepEqual(args.slice(0,7),['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',args[6]]);
      assert.equal(options.windowsHide,true);
      assert.deepEqual(options.env, {
        SystemRoot:'C:/Windows', windir:'C:/Windows', TEMP:'C:/Temp', TMP:'C:/Tmp',
        USERPROFILE:'C:/Users/test', LOCALAPPDATA:'C:/Users/test/AppData/Local',
      });
      const childInput = JSON.stringify({args,env:options.env});
      for (const secret of ['test-only-key','C:/private/member-key','private-openai-test-key']) {
        assert.equal(childInput.includes(secret),false);
      }
      const child = new Child(); queueMicrotask(() => child.emit('spawn')); return child;
    },
    sleep:async () => controller.abort(),
  });
  assert.deepEqual(result,{reason:'closed'});
  assert.equal(refreshes,1);
  assert.deepEqual(manualValues,[true]);
  assert.ok(writes.some(({content}) => content.includes('personalProbability')));
  assert.equal(writes.some(({content}) => content.includes('test-only-key')),false);
  assert.equal(removed.length,2); // state and command cleanup; first fetch needs no command poll
});

test('native card rejects unsupported hosts before accessing configuration or starting a process', async () => {
  for (const platform of ['darwin', 'linux']) {
    await assert.rejects(runWindowsOverlay({
      platform,
      load: async () => assert.fail('configuration must not be read'),
      spawnImpl: () => assert.fail('renderer must not start'),
    }), /Windows only/);
  }
});
