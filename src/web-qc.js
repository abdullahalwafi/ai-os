const dns = require('dns').promises;

const MAX_BODY = 128 * 1024;
const TIMEOUT_MS = 12000;

function privateAddress(address) {
  if (address.includes(':')) return address === '::1' || /^fe[89ab]/i.test(address) || /^f[cd]/i.test(address);
  const parts = address.split('.').map(Number);
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function issue(severity, code, message) { return { severity, code, message }; }
function attr(html, name) { const m = new RegExp(`<[^>]+${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(html); return m?.[1]?.trim() || null; }
function meta(html, name) { const tags = html.match(/<meta\b[^>]*>/gi) || []; for (const tag of tags) if (new RegExp(`\\b(?:name|property)\\s*=\\s*["']${name}["']`, 'i').test(tag)) return attr(tag, 'content'); return null; }
async function body(response) {
  if (!response.body) return '';
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  while (size < MAX_BODY) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; chunks.push(value.slice(0, Math.max(0, MAX_BODY - (size - value.byteLength)))); }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}
function allowedHost(host, domain) { return host === domain || host === `www.${domain}`; }
async function safeFetch(url, domain) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !allowedHost(parsed.hostname, domain)) throw new Error('unsafe_url');
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(entry => privateAddress(entry.address))) throw new Error('unsafe_destination');
  const started = Date.now(); let current = parsed;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'DM-AI-OS-WebQC/1.0' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current.toString(), responseTime: Date.now() - started };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current.toString(), responseTime: Date.now() - started };
    const next = new URL(location, current);
    if (next.protocol !== 'https:' || !allowedHost(next.hostname, domain)) throw new Error('unsafe_redirect');
    current = next;
  }
  throw new Error('too_many_redirects');
}

async function optional(url, domain) {
  try { const r = await safeFetch(url, domain); const text = await body(r.response); return { status: r.response.status, present: r.response.ok, text, url: r.finalUrl }; }
  catch (error) { return { status: null, present: false, error: 'unreachable' }; }
}

async function inspect(brand) {
  const base = new URL(brand.website_url);
  if (base.protocol !== 'https:' || !allowedHost(base.hostname, brand.domain)) throw new Error('invalid_brand_website');
  const checked_at = new Date().toISOString(); const issues = [];
  let home;
  try { home = await safeFetch(base.toString(), brand.domain); }
  catch (error) { return { analysis_version: 1, check_type: 'WEB_QC_CHECK', brand: brand.brand_key, url: base.toString(), checked_at, homepage: { status: null, https: true }, issues: [issue('critical', 'homepage_unreachable', 'Homepage tidak dapat dijangkau melalui pemeriksaan publik.')], summary: 'Pemeriksaan parsial: homepage tidak dapat dijangkau.' }; }
  const html = await body(home.response); const contentType = home.response.headers.get('content-type') || null;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1].replace(/\s+/g, ' ').trim() || null;
  const description = meta(html, 'description'); const canonical = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(html)?.[0];
  const canonicalUrl = canonical ? attr(canonical, 'href') : null;
  const h1 = (html.match(/<h1\b/gi) || []).length; const robotsMeta = meta(html, 'robots'); const lang = /<html\b[^>]*\blang\s*=\s*["']([^"']+)/i.exec(html)?.[1] || null;
  if (home.response.status >= 500) issues.push(issue('critical', 'homepage_5xx', `Homepage mengembalikan HTTP ${home.response.status}.`));
  else if (home.response.status >= 400) issues.push(issue('high', 'homepage_4xx', `Homepage mengembalikan HTTP ${home.response.status}.`));
  if (!title) issues.push(issue('medium', 'missing_title', 'Homepage tidak memiliki title.')); else if (title.length < 20 || title.length > 70) issues.push(issue('warning', 'title_length', 'Panjang title berada di luar rentang informasional 20–70 karakter.'));
  if (!description) issues.push(issue('warning', 'missing_meta_description', 'Homepage tidak memiliki meta description.')); else if (description.length < 50 || description.length > 170) issues.push(issue('warning', 'meta_description_length', 'Panjang meta description berada di luar rentang informasional 50–170 karakter.'));
  if (!canonicalUrl) issues.push(issue('medium', 'missing_canonical', 'Homepage tidak memiliki canonical.'));
  if (h1 !== 1) issues.push(issue('warning', 'h1_count', `Homepage memiliki ${h1} elemen H1.`));
  const robots = await optional(new URL('/robots.txt', base).toString(), brand.domain);
  const sitemapXml = await optional(new URL('/sitemap.xml', base).toString(), brand.domain);
  const sitemapIndex = sitemapXml.present ? null : await optional(new URL('/sitemap_index.xml', base).toString(), brand.domain);
  const sitemap = sitemapXml.present ? sitemapXml : sitemapIndex;
  if (!sitemap?.present) issues.push(issue('medium', 'sitemap_not_found', 'Tidak ditemukan sitemap publik di lokasi standar.'));
  return { analysis_version: 1, check_type: 'WEB_QC_CHECK', brand: brand.brand_key, url: base.toString(), checked_at,
    homepage: { status: home.response.status, response_time_ms: home.responseTime, final_url: home.finalUrl, https: true, content_type: contentType, server: home.response.headers.get('server') || null },
    seo: { title_present: Boolean(title), title_length: title?.length || 0, meta_description_present: Boolean(description), meta_description_length: description?.length || 0, canonical_present: Boolean(canonicalUrl), canonical: canonicalUrl, h1_count: h1, robots_meta: robotsMeta, lang },
    robots: { status: robots.status, present: robots.present, summary: robots.present ? 'robots.txt tersedia.' : 'robots.txt tidak tersedia.' },
    sitemap: { found: Boolean(sitemap?.present), url: sitemap?.present ? sitemap.url : null }, issues,
    summary: `Pemeriksaan read-only selesai: homepage HTTP ${home.response.status}; ${issues.length} temuan.` };
}
module.exports = { inspect };
