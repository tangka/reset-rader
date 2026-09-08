export const rendererError = () => new Error('Windows radar renderer could not start or stopped unexpectedly; reopen the card.');

// Process creation is not proof that WPF parsed its XAML and opened the window.
export function waitForWindowsRenderer(child, { signal, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let received = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onFailure);
      child.off('exit', onFailure);
      signal?.removeEventListener('abort', onFailure);
      if (error) reject(rendererError()); else resolve();
    };
    const onFailure = () => finish(true);
    const onData = (chunk) => {
      received += chunk.toString('utf8');
      if (received.length > 4096) return finish(true);
      if (received.split(/\r?\n/).slice(0, -1).includes('RESET_RADAR_READY')) finish(false);
    };
    const timer = setTimeout(onFailure, timeoutMs);
    child.stdout?.on('data', onData);
    child.once('error', onFailure);
    child.once('exit', onFailure);
    signal?.addEventListener('abort', onFailure, { once: true });
    if (signal?.aborted || !child.stdout) finish(true);
  });
}
