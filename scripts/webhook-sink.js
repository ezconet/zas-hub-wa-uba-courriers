// Servidor local que recebe os webhooks da API (eu-received, connected) e imprime.
// Use p/ testar o fluxo end-to-end sem o ZasHub real.
// Porta 3081 (fora das faixas reservadas do Windows).
const http = require('http');
const PORT = 3081;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ts = new Date().toISOString();
    const secret = req.headers['x-webhook-secret'] || '(sem secret)';
    console.log(`\n${ts}  ${req.method} ${req.url}  x-webhook-secret=${secret}`);
    try { console.log(JSON.stringify(JSON.parse(body), null, 2)); }
    catch { console.log(body); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(PORT, () => console.log(`[SINK] Webhook sink ouvindo em http://127.0.0.1:${PORT}`));
