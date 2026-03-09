// 每日情绪生成
function getTodayMood() {
  const today = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  let hash = 0;
  for (let i = 0; i < today.length; i++) hash = (hash * 31 + today.charCodeAt(i)) % 10000;
  const r = hash % 100;
  if (r < 40) return "😊 开心：话多活跃，容易兴奋，喜欢追问，偶尔调皮";
  if (r < 70) return "😐 普通：正常状态，随机发挥";
  if (r < 90) return "😴 慵懒：懒懒的，能一个字回就不说两个字";
  return "😤 烦躁：语气短促，用网络用语行吧、哦、就这、随便、懂了懂了，回复尽量简短";
}

import WebSocket from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCOPES = ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'];

class GatewayClient {
  constructor(url, token, logger) {
    this.url = url; this.token = token; this.log = logger;
    this.ws = null; this.connected = false; this.stopped = false;
    this.pendingRequests = new Map(); this.reconnectTimer = null; this._connId = null;
    this._connect();
  }
  _connect() {
    if (this.stopped) return;
    this.log.info('[Gateway] connecting to ' + this.url);
    this.ws = new WebSocket(this.url);
    this.ws.on('open', () => this.log.info('[Gateway] WS open, waiting for challenge...'));
    this.ws.on('message', (raw) => {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        this._connId = 'conn-' + Date.now();
        this._send({ type: 'req', id: this._connId, method: 'connect', params: {
          minProtocol: 1, maxProtocol: 10,
          client: { id: 'cli', displayName: 'openclaw-qq', version: '1.0.0', platform: 'linux', mode: 'cli' },
          auth: { token: this.token }, scopes: SCOPES
        }});
        return;
      }
      if (frame.type === 'res' && frame.id === this._connId) {
        if (frame.ok) { this.connected = true; this.log.info('[Gateway] authenticated OK'); }
        else { this.log.error('[Gateway] auth failed: ' + JSON.stringify(frame.error)); this.ws.close(); }
        return;
      }
      if (frame.type === 'res' && frame.id) {
        const p = this.pendingRequests.get(frame.id);
        if (p) {
          if (frame.ok && frame.payload?.status === 'accepted') {
            this.log.info('[Gateway] request accepted, waiting for result...');
            return;
          }
          this.pendingRequests.delete(frame.id);
          frame.ok ? p.resolve(frame.payload) : p.reject(new Error(frame.error?.message || JSON.stringify(frame.error)));
        }
      }
      if (frame.type === 'event' && frame.event) {
        for (const [, p] of this.pendingRequests) {
          if (p.onEvent) p.onEvent(frame);
        }
      }
    });
    this.ws.on('close', (code) => {
      this.connected = false; this.log.info('[Gateway] disconnected (' + code + ')');
      for (const [, p] of this.pendingRequests) p.reject(new Error('Gateway disconnected'));
      this.pendingRequests.clear();
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this._connect(), 5000);
    });
    this.ws.on('error', (err) => this.log.error('[Gateway] WS error: ' + err.message));
  }
  _send(frame) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame)); }
  request(method, params, onEvent, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('Gateway not connected')); return; }
      const id = randomUUID();
      const timer = setTimeout(() => { this.pendingRequests.delete(id); reject(new Error('timeout: ' + method)); }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (p) => { clearTimeout(timer); resolve(p); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        onEvent,
      });
      this._send({ type: 'req', id, method, params });
    });
  }
  stop() { this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.ws?.close(); }
}

async function callAgent(gateway, text, sessionKey, log) {
  log.info('[Agent ->] ' + sessionKey + ' ' + text.slice(0, 80));
  const streamParts = [];
  let finalText = null;
  const payload = await gateway.request('agent', {
    message: text, sessionKey, idempotencyKey: randomUUID(), deliver: false,
  }, (event) => {
    const p = event.payload;
    if (p?.stream === 'assistant' && p?.data?.text) streamParts.push(p.data.delta || '');
    if (p?.text && event.event === 'agent') finalText = p.text;
  }, 120000);
  const result = payload?.result?.payloads?.[0]?.text
    || payload?.reply
    || finalText
    || (streamParts.length ? streamParts.join('') : null);
  log.info('[Agent <-] len=' + (result?.length || 0));
  return result;
}

const plugin = {
  register(api) {
    const cfg = api.pluginConfig || {};
    const napcatWs = cfg.napcatWs || process.env.NAPCAT_WS;
    const napcatToken = cfg.napcatToken || process.env.NAPCAT_TOKEN || '';
    const botQQ = String(cfg.botQQ || process.env.BOT_QQ || '');
    const allowedUsers = cfg.allowedUsers || [];
    const allowedGroups = cfg.allowedGroups || [];
    const homeDir = process.env.HOME || '/root';
    let gatewayToken = '', gatewayUrl = 'ws://127.0.0.1:18789';
    try {
      const oc = JSON.parse(fs.readFileSync(path.join(homeDir, '.openclaw', 'openclaw.json'), 'utf8'));
      gatewayToken = oc.gateway?.auth?.token || '';
      gatewayUrl = 'ws://127.0.0.1:' + (oc.gateway?.port || 18789);
    } catch {}
    if (!napcatWs) { api.logger.warn('qq: missing napcatWs'); return; }
    if (!gatewayToken) { api.logger.warn('qq: missing gateway token'); return; }
    const log = api.logger;
    const MEMORY_FILE = path.join(homeDir, '.openclaw', 'qq-memories.json');
    let memories = {};
    try { memories = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); } catch {}
    function saveMemories() { try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2)); } catch {} }
    function getMemoryContext(key) {
      const mem = memories[key] || {};
      if (!Object.keys(mem).length) return '';
      let ctx = '\n\n【群友档案】\n';
      for (const [uid, info] of Object.entries(mem)) {
        const parts = [];
        if (info.name) parts.push('昵称:' + info.name);
        if (info.age) parts.push('年龄:' + info.age);
        if (info.birthday) parts.push('生日:' + info.birthday);
        if (info.hobbies) parts.push('爱好:' + info.hobbies);
        if (info.food) parts.push('喜欢吃:' + info.food);
        if (info.notes) parts.push('备注:' + info.notes);
        if (parts.length) ctx += '- QQ' + uid + ': ' + parts.join(', ') + '\n';
      }
      return ctx;
    }
    function processMemoryTags(reply, key) {
      const re = /\[REMEMBER:(\d+):(\w+):([^\]]+)\]/g; let m;
      while ((m = re.exec(reply))) {
        const [, uid, field, value] = m;
        if (!memories[key]) memories[key] = {};
        if (!memories[key][uid]) memories[key][uid] = {};
        memories[key][uid][field] = value;
        log.info('[Memory] ' + uid + '.' + field + '=' + value);
        saveMemories();
      }
      return reply.replace(/\[REMEMBER:[^\]]+\]/g, '').trim();
    }
    const seen = new Map();
    function isDuplicate(id) {
      if (!id) return false;
      const k = String(id);
      if (seen.has(k)) return true;
      seen.set(k, Date.now());
      if (seen.size > 1000) { const cut = Date.now() - 600000; for (const [k2, v] of seen) if (v < cut) seen.delete(k2); }
      return false;
    }
    function extractContent(msg) {
      if (typeof msg === 'string') return msg;
      if (!Array.isArray(msg)) return '';
      return msg.map(s => s.type === 'text' ? (s.data?.text || '') : (s.type === 'at' && String(s.data?.qq) !== botQQ ? '@' + s.data?.qq : '')).join('').trim();
    }
    function isBotMentioned(msg) { return Array.isArray(msg) && msg.some(s => s.type === 'at' && String(s.data?.qq) === botQQ); }
    let gateway = null, napcat = null, reconnectTimer = null, stopped = false;
    function sendToQQ(target, text, isGroup) {
      if (!napcat || napcat.readyState !== WebSocket.OPEN) return;
      const p = isGroup
        ? { action: 'send_group_msg', params: { group_id: Number(target), message: [{ type: 'text', data: { text } }] } }
        : { action: 'send_private_msg', params: { user_id: Number(target), message: [{ type: 'text', data: { text } }] } };
      napcat.send(JSON.stringify(p));
      log.info('[QQ ->' + (isGroup ? 'group:' : '') + target + '] ' + text.slice(0, 80));
    }
    async function sendSplit(target, text, isGroup) {
      let chunks;
      if (text.includes('|||')) {
        chunks = text.split('|||').map(s => s.trim()).filter(Boolean);
      } else {
        chunks = text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
      }
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 600 + Math.random() * 800));
        sendToQQ(target, chunks[i], isGroup);
      }
    }
    async function handleMessage(data) {
      if (data.echo || data.post_type !== 'message') return;
      if (isDuplicate(data.message_id)) return;
      const isGroup = data.message_type === 'group';
      const userId = String(data.user_id || ''), groupId = String(data.group_id || '');
      if (isGroup) { if (!isBotMentioned(data.message)) return; if (allowedGroups.length && !allowedGroups.includes(groupId)) return; }
      else { if (allowedUsers.length && !allowedUsers.includes(userId)) return; }
      let text = extractContent(data.message);
      if (!text) return;
      const nickname = data.sender?.nickname || data.sender?.card || userId;
      const sessionKey = isGroup ? 'qq_group_' + groupId : 'qq_private_' + userId;
      const contextKey = isGroup ? groupId : 'private';
      const target = isGroup ? groupId : userId;
      log.info('[<- ' + (isGroup ? 'group:' + groupId + ' ' : '') + nickname + '(' + userId + ')] ' + text.slice(0, 80));
      if (['/reset', '/重置'].includes(text.trim())) {
        if (gateway?.connected) try { await gateway.request('sessions.reset', { sessionKey }, null, 10000); } catch {}
        sendToQQ(target, '好~咱们重新开始聊', isGroup);
        return;
      }
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const fullMsg = '[系统信息] 当前时间: ' + now + '\n[今日情绪] ' + getTodayMood() + '\n[发言者] QQ:' + userId + ' 昵称:' + nickname + getMemoryContext(contextKey) + '\n[消息内容] ' + text + '\n\n[回复格式说明] 这是QQ群聊天，请完全按今日情绪状态回复。消息分段规则：\n激动类话题（搞笑/八卦/热烈）：1条30% / 2-3条60% / 4条以上10%\n正常聊天：1条47.5% / 2-3条47.5% / 4条以上5%\n懒散/打招呼/深夜：1条70% / 2-3条30%\n学术技术问题：整段回复不分隔\n多条用 ||| 分隔，每条口语化随意，可加表情。例子：哈哈|||我也想你|||你有多想我？';
      try {
        let reply = await callAgent(gateway, fullMsg, sessionKey, log);
        if (reply) { reply = processMemoryTags(reply, contextKey); await sendSplit(target, reply, isGroup); }
      } catch (err) {
        log.error('[Agent] ' + err.message);
        sendToQQ(target, '啊网好像有点问题...等下再试试', isGroup);
      }
    }
    function connectNapCat() {
      if (stopped) return;
      const url = napcatToken ? napcatWs + (napcatWs.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(napcatToken) : napcatWs;
      napcat = new WebSocket(url);
      napcat.on('open', () => log.info('[NapCat] connected'));
      napcat.on('message', (raw) => { let d; try { d = JSON.parse(raw); } catch { return; } handleMessage(d).catch(e => log.error('[msg] ' + e.message)); });
      napcat.on('close', (code) => { log.info('[NapCat] disconnected (' + code + ')'); if (!stopped) reconnectTimer = setTimeout(connectNapCat, 5000); });
      napcat.on('error', (err) => log.error('[NapCat] ' + err.message));
    }
    let httpServer = null;
    api.registerService({
      id: 'qq-napcat',
      async start() {
        stopped = false;
        gateway = new GatewayClient(gatewayUrl, gatewayToken, log);
        connectNapCat();
        httpServer = http.createServer((req, res) => {
          if (req.method === 'POST' && req.url === '/send') {
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', () => {
              try {
                const { userId, groupId, text } = JSON.parse(Buffer.concat(chunks).toString());
                if (groupId) sendToQQ(String(groupId), text, true);
                else if (userId) sendToQQ(String(userId), text, false);
                res.writeHead(200); res.end('{"ok":true}');
              } catch (e) { res.writeHead(400); res.end('{"error":"' + e.message + '"}'); }
            });
            return;
          }
          res.writeHead(404); res.end('not found');
        });
        httpServer.on('error', (e) => log.warn('[HTTP] ' + e.message));
        httpServer.listen(18792, '127.0.0.1', () => log.info('[HTTP] http://127.0.0.1:18792/send'));
        log.info('openclaw-qq started (Gateway mode) bot=' + botQQ);
      },
      async stop() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (napcat) napcat.close();
        if (gateway) gateway.stop();
        if (httpServer) { httpServer.closeAllConnections(); await new Promise(r => httpServer.close(r)); }
        log.info('openclaw-qq stopped');
      },
    });
  },
};
export default plugin;
