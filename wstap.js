const w = new WebSocket('wss://pharahp.ellite.dev');
let t0 = null;
w.addEventListener('open', () => console.log('[connected]'));
w.addEventListener('message', (e) => {
    const n = Date.now();
    if (!t0) t0 = n;
    console.log('+' + (n - t0) + 'ms', e.data);
});
w.addEventListener('close', () => console.log('[closed]'));
w.addEventListener('error', (e) => console.log('[error]', e.message || e));
