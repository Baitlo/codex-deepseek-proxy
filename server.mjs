import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';

loadDotEnv();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3456);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-v4-pro';
const LOCAL_API_KEY = process.env.LOCAL_API_KEY || '';
const THINKING = String(process.env.THINKING || 'enabled').toLowerCase();
const REASONING_EFFORT = normalizeEffort(process.env.REASONING_EFFORT || 'high');
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
const histories = new Map();

function loadDotEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
function normalizeEffort(v) {
  v = String(v || '').toLowerCase();
  if (v === 'max' || v === 'xhigh') return 'max';
  if (v === 'none' || v === 'disabled') return undefined;
  return 'high';
}
function j(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function err(res, code, message, type = 'invalid_request_error') {
  j(res, code, { error: { message, type, param: null, code: type } });
}
function auth(req, res) {
  if (!LOCAL_API_KEY) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (got !== LOCAL_API_KEY) { err(res, 401, 'Invalid local bearer token', 'authentication_error'); return false; }
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', c => s += c);
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function textOf(x) {
  if (typeof x === 'string') return x;
  if (!Array.isArray(x)) return '';
  return x.map(p => typeof p === 'string' ? p : (p?.text || p?.content || '')).join('');
}
function inputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  const out = [];
  if (!Array.isArray(input)) return out;
  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'message') out.push({ role: it.role || 'user', content: textOf(it.content) });
    else if (it.role) out.push({ role: it.role, content: textOf(it.content) });
    else if (it.type === 'function_call_output') out.push({ role: 'tool', tool_call_id: it.call_id || it.tool_call_id, content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? '') });
  }
  return out;
}
function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (t.type === 'function' && t.function) out.push({ type: 'function', function: t.function });
    else if (t.name) out.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || t.input_schema || { type: 'object', properties: {} } } });
  }
  return out.length ? out : undefined;
}
function usage(u = {}) {
  const input = u.input_tokens ?? u.prompt_tokens ?? 0;
  const output = u.output_tokens ?? u.completion_tokens ?? 0;
  return { input_tokens: input, input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens ?? 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 }, total_tokens: u.total_tokens ?? input + output };
}
function shell(id, model, status = 'in_progress') {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output: [], usage: usage() };
}
function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function chatReq(body) {
  const id = body.previous_response_id;
  const prior = id && histories.get(id) ? histories.get(id).slice() : [];
  const messages = prior.concat(inputToMessages(body.input));
  const r = { model: body.model || DEFAULT_MODEL, messages, stream: body.stream !== false };
  if (body.instructions) r.messages.unshift({ role: 'system', content: body.instructions });
  if (body.temperature !== undefined) r.temperature = body.temperature;
  if (body.top_p !== undefined) r.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) r.max_tokens = body.max_output_tokens;
  const tools = convertTools(body.tools); if (tools) r.tools = tools;
  if (body.tool_choice) r.tool_choice = body.tool_choice;
  if (THINKING !== 'disabled') { r.thinking = { type: 'enabled' }; if (REASONING_EFFORT) r.reasoning_effort = REASONING_EFFORT; }
  else r.thinking = { type: 'disabled' };
  return r;
}
async function postDeepSeek(payload) {
  return fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${DEEPSEEK_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}
async function responses(req, res) {
  if (!auth(req, res)) return;
  if (!DEEPSEEK_API_KEY) return err(res, 500, 'DEEPSEEK_API_KEY is missing', 'configuration_error');
  let body; try { body = await readBody(req); } catch { return err(res, 400, 'Invalid JSON'); }
  const id = 'resp_' + randomUUID().replaceAll('-', '');
  const model = body.model || DEFAULT_MODEL;
  const payload = chatReq(body);
  if (DEBUG) console.error(JSON.stringify(payload));
  let upstream;
  try { upstream = await postDeepSeek(payload); } catch (e) { return err(res, 502, String(e), 'upstream_error'); }
  if (!upstream.ok) { const t = await upstream.text(); res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(t); return; }
  if (body.stream === false) {
    const data = await upstream.json();
    const m = data.choices?.[0]?.message || {};
    const hist = payload.messages.slice(); hist.push(m); histories.set(id, hist);
    return j(res, 200, { ...shell(id, model, 'completed'), output: [{ id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content || '' }] }], usage: usage(data.usage) });
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, 'response.created', { type: 'response.created', response: shell(id, model) });
  const reader = upstream.body.getReader(); const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', finalUsage = {}, toolCalls = {}, textId = null;
  const ensureText = () => { if (textId) return; textId = 'msg_' + randomUUID().replaceAll('-', ''); sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: textId, type: 'message', role: 'assistant', content: [] } }); sse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: textId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }); };
  const line = l => { const t = l.trim(); if (!t.startsWith('data:')) return; const p = t.slice(5).trim(); if (!p || p === '[DONE]') return; let c; try { c = JSON.parse(p); } catch { return; } finalUsage = c.usage || finalUsage; const d = c.choices?.[0]?.delta || {}; if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content; if (typeof d.content === 'string' && d.content) { ensureText(); content += d.content; sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: textId, output_index: 0, content_index: 0, delta: d.content }); } if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) { const k = String(tc.index ?? 0); const cur = toolCalls[k] || { id: tc.id || 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name: '', arguments: '' } }; if (tc.function?.name) cur.function.name += tc.function.name; if (tc.function?.arguments) cur.function.arguments += tc.function.arguments; toolCalls[k] = cur; } };
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split(/\r?\n/); buf = parts.pop() || ''; for (const l of parts) line(l); }
  const msg = { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  const calls = Object.values(toolCalls); if (calls.length) msg.tool_calls = calls;
  const hist = payload.messages.slice(); hist.push(msg); histories.set(id, hist);
  if (textId) { sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: textId, output_index: 0, content_index: 0, text: content }); sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: textId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] } }); }
  for (const c of calls) sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { id: c.id, type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments } });
  sse(res, 'response.completed', { type: 'response.completed', response: { ...shell(id, model, 'completed'), usage: usage(finalUsage) } });
  res.end();
}
const server = http.createServer((req, res) => { const u = new URL(req.url, `http://${req.headers.host}`); if (req.method === 'GET' && u.pathname === '/health') return j(res, 200, { ok: true, provider: 'deepseek', thinking: THINKING }); if (req.method === 'GET' && u.pathname === '/v1/models') return j(res, 200, { object: 'list', data: ['deepseek-v4-pro', 'deepseek-v4-flash'].map(id => ({ id, object: 'model' })) }); if (req.method === 'POST' && u.pathname === '/v1/responses') return responses(req, res); return err(res, 404, 'not found', 'not_found'); });
server.listen(PORT, HOST, () => { console.log(`codex-deepseek-proxy listening on http://${HOST}:${PORT}`); });
