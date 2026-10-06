const dns = require('dns').promises;
const https = require('https');
const http = require('http');
const net = require('net');

function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  // Global unicast only; reject mapped IPv4, loopback, link-local and ULA.
  return net.isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip) && !ip.toLowerCase().startsWith('2001:db8:');
}
async function getPage(input, redirects = 0) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Use a public http or https website.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Only public company websites can be read.');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, {
      headers: { 'User-Agent': 'StarkCompanyOnboarding/1.0', Accept: 'text/html' },
      lookup: (_hostname, options, cb) => options.all ? cb(null, [selected]) : cb(null, selected.address, selected.family),
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 3) return reject(new Error('Too many website redirects.'));
        getPage(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200 || !String(res.headers['content-type']).includes('text/html')) { res.resume(); reject(new Error('The website did not return a readable public page.')); return; }
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 1000000) req.destroy(new Error('Website page is too large.')); else chunks.push(chunk); });
      res.on('end', () => resolve({ url: url.href, html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Website took too long to respond.')));
    req.on('error', reject);
  });
}
function plain(html) {
  return html.replace(/<(script|style|nav|footer|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, 16000);
}
async function ingestWebsite(input, fetchPage = getPage) {
  const first = await fetchPage(input);
  const base = new URL(first.url);
  const links = [...first.html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map(m => { try { return new URL(m[1], base); } catch { return null; } }).filter(u => u && u.origin === base.origin && /about|services|products|help|company/i.test(u.pathname));
  const urls = [...new Set(links.map(u => u.href))].filter(u => u !== base.href).slice(0, 3);
  const pages = [{ url: first.url, text: plain(first.html) }];
  for (const url of urls) {
    try { const page = await fetchPage(url); if (new URL(page.url).origin === base.origin) pages.push({ url: page.url, text: plain(page.html) }); } catch { /* Main page remains available; report pages actually read. */ }
  }
  if (!pages.some(p => p.text.length > 80)) throw new Error('Not enough readable text. Add a company description instead.');
  return pages;
}
module.exports = { ingestWebsite, publicAddress, plain };
