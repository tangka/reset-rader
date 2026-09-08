import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { filterTargets, discoverTargets, desktopListeners, findDesktopTarget, CdpPage } from './overlay-cdp.mjs';

const target = {id:'main-1',type:'page',url:'app://-/index.html',port:9333,
  webSocketDebuggerUrl:'ws://127.0.0.1:9333/devtools/page/main-1'};

test('target selection excludes Pets, web tabs, remote sockets, different ports and malformed identities',() => {
  const bad = [
    {...target,url:'app://-/avatar-overlay'}, {...target,url:'https://chatgpt.com'},
    {...target,type:'service_worker'}, {...target,webSocketDebuggerUrl:'ws://evil.example:9333/devtools/page/main-1'},
    {...target,webSocketDebuggerUrl:'ws://127.0.0.1:9444/devtools/page/main-1'},
    {...target,webSocketDebuggerUrl:'ws://u:p@127.0.0.1:9333/devtools/page/main-1'},
    {...target,webSocketDebuggerUrl:target.webSocketDebuggerUrl+'?token=secret'},
    {...target,webSocketDebuggerUrl:'ws://127.0.0.1:9333/other'}, {...target,id:'<script>'},
  ];
  assert.deepEqual(filterTargets([...bad,target],9333),[{id:target.id,url:target.url,
    webSocketDebuggerUrl:target.webSocketDebuggerUrl}]);
  assert.throws(() => new CdpPage(bad[3]),/Unsafe/);
});

test('discovery uses only loopback, no redirects, bounded bodies and never prints response contents',async () => {
  let request;
  const found = await discoverTargets(9333,{fetchImpl:async (...args) => {
    request = args;
    return new Response(JSON.stringify([target]));
  }});
  assert.equal(found.length,1);
  assert.equal(request[0],'http://127.0.0.1:9333/json/list');
  assert.equal(request[1].redirect,'error');
  assert.equal(request[1].headers.authorization,undefined);
  await assert.rejects(discoverTargets(9333,{fetchImpl:async () => new Response('x'.repeat(300000))}),/No compatible/);
  await assert.rejects(discoverTargets('https://remote'),/port/);
});

test('only known desktop process-owned loopback listeners are candidates',async () => {
  const commands = [];
  const result = await desktopListeners({platform:'darwin',executeImpl:async (file,args) => {
    commands.push([file,args]);
    if (file === '/bin/ps') return {stdout:'17 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n18 /usr/bin/node\n'};
    return {stdout:'p17\nn127.0.0.1:9333\nn127.0.0.1:9444\nn*:9444\nn192.168.1.2:9555\nn[::1]:9666\n'};
  }});
  assert.deepEqual(result.listeners,[{pid:17,path:'/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',port:9333}]);
  assert.equal(commands.length,2);
  assert.ok(commands[1][1].includes('17'));
  assert.ok(!commands.some(([file]) => /kill|open/.test(file)));
});

test('no usable endpoint is explicit; multiple windows require selection, no silent first-target injection',async () => {
  const listenersImpl = async () => ({processes:[{pid:17}],listeners:[{pid:17,port:9333}]});
  await assert.rejects(findDesktopTarget({listenersImpl,discover:async () => []}),/未提供兼容/);
  const second = {...target,id:'main-2'};
  await assert.rejects(findDesktopTarget({listenersImpl,discover:async () => [target,second]}),error => {
    assert.deepEqual(error.targets,[{id:'main-1',pid:17,port:9333},{id:'main-2',pid:17,port:9333}]);
    return true;
  });
  const selected = await findDesktopTarget({listenersImpl,discover:async () => [target,second],targetId:'main-2'});
  assert.equal(selected.id,'main-2');
  let probes = 0;
  await assert.rejects(findDesktopTarget({port:9444,listenersImpl,discover:async () => { probes++; return [target]; }}));
  assert.equal(probes,0);
});

function socketClass({context,fail = false,quiet = false} = {}) {
  return class extends EventTarget {
    readyState = 0;
    constructor() { super(); queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }); }
    send(data) {
      const call = JSON.parse(data);
      assert.equal(call.method,'Runtime.evaluate');
      assert.equal(call.params.returnByValue,true);
      if (quiet) return;
      const result = fail ? {exceptionDetails:{text:'secret'}}
        : {result:{value:vm.runInNewContext(call.params.expression,context)}};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:call.id,result})})));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  };
}

test('CDP permits same-app route navigation but rejects browser/Pets and non-shell documents before mutation',async () => {
  const context = {location:{protocol:'app:',host:'-',href:'app://-/thread/new'},
    document:{querySelector:() => ({})},mutations:0};
  const page = new CdpPage(target,{WebSocketImpl:socketClass({context})});
  await page.open();
  assert.equal(await page.evaluate('++mutations'),1);
  context.location.href = 'app://-/avatar-overlay';
  assert.equal((await page.evaluate('++mutations')).unsupported,true);
  context.location = {protocol:'https:',host:'example.com',href:'https://example.com'};
  assert.equal((await page.evaluate('++mutations')).unsupported,true);
  assert.equal(context.mutations,1);
  page.close();
  await assert.rejects(page.evaluate('1'),/closed/);
});

test('the current desktop requires both its root main and app-shell header before mutation',async () => {
  const selectors = new Set();
  const context = {location:{protocol:'app:',host:'-',href:'app://-/index.html'},mutations:0,
    document:{querySelector:selector => selectors.has(selector) ? {} : null}};
  const page = new CdpPage(target,{WebSocketImpl:socketClass({context})});
  await page.open();
  try {
    assert.equal((await page.evaluate('++mutations')).unsupported,true);
    selectors.add('#root main');
    assert.equal((await page.evaluate('++mutations')).unsupported,true);
    selectors.add('[data-testid="app-shell-header-context-menu-surface"]');
    assert.equal(await page.evaluate('++mutations'),1);
    selectors.delete('#root main');
    assert.equal((await page.evaluate('++mutations')).unsupported,true);
    selectors.add('#root main');
    context.location.href = 'app://-/avatar-overlay';
    assert.equal((await page.evaluate('++mutations')).unsupported,true);
    assert.equal(context.mutations,1);
  } finally { page.close(); }
});

test('evaluation exceptions are sanitized and pending timeouts/closure reject boundedly',async () => {
  const page = new CdpPage(target,{WebSocketImpl:socketClass({fail:true}),timeoutMs:20});
  await page.open();
  await assert.rejects(page.evaluate('1'),error => error.message === 'Codex overlay evaluation failed.');
  page.close();
  const silent = new CdpPage(target,{WebSocketImpl:socketClass({quiet:true}),timeoutMs:20});
  await silent.open();
  await assert.rejects(silent.evaluate('1'),/timed out/);
  const waiting = silent.evaluate('1');
  silent.close();
  await assert.rejects(waiting,/closed/);
  assert.equal(silent.pending.size,0);
});

test('cleanup removes only its own same-origin card after the main shell disappears',async () => {
  let removals = 0;
  const state = {owner:'own-session',status:() => ({owner:'own-session'}),
    remove:() => { removals++; return {installed:false}; }};
  const context = {location:{protocol:'app:',host:'-',href:'app://-/thread/new'},
    document:{querySelector:() => null},window:{__resetRadarOverlayV1:state},mutations:0};
  const page = new CdpPage(target,{WebSocketImpl:socketClass({context})});
  await page.open();
  try {
    assert.equal((await page.evaluate('++mutations')).unsupported,true);
    assert.equal(context.mutations,0);
    await page.removeOverlay('foreign-session');
    assert.equal(removals,0);
    assert.equal((await page.removeOverlay('own-session')).installed,false);
    assert.equal(removals,1);
    context.location = {protocol:'https:',host:'example.com',href:'https://example.com'};
    assert.equal((await page.removeOverlay('own-session')).unsupported,true);
    context.location = {protocol:'app:',host:'other',href:'app://other/'};
    assert.equal((await page.removeOverlay('own-session')).unsupported,true);
    assert.equal(removals,1);
  } finally { page.close(); }
});
