# 知知 QQ 机器人 🤖

> 一个有情绪、有记忆、会主动说话、能定时提醒的 QQ 群 AI 机器人

---

## ✨ 功能特性

- **真人风格聊天** — 有情绪波动、说话不规律、偶尔调皮
- **今日情绪系统** — 每天按概率随机生成情绪（开心/普通/慵懒/烦躁），全天保持一致
- **消息分段发送** — 像真人一样把回复拆成多条，带随机延迟
- **群友记忆** — 记住每个人的名字、爱好、生日等信息
- **定时提醒** — 在群里 @知知 设提醒，到点会 @你发消息
- **主动发消息** — 按概率自动发早安、晚安、冷知识、随机聊天
- **调皮话术** — 有人问问题时偶尔先撒个娇再回答

---

## 🏗️ 系统架构

```
QQ用户
  └→ NapCat (Docker, WebSocket port 3001)   ← QQ协议层
       └→ openclaw-qq 插件                   ← 消息桥接 + 情绪注入
            └→ OpenClaw Gateway              ← ws://0.0.0.0:18789
                 └→ Claude API               ← AI推理（Sonnet/Haiku）

定时提醒额外链路：
  openclaw cron → jobs.json → cron-proxy.py → NapCat WebSocket → QQ群
```

---

## 📁 项目结构

```
zhizhi-qq/
├── README.md
├── index.js              # openclaw-qq 插件（核心改动）
├── SYSTEM.md             # 知知人设提示词
├── cron-proxy.py         # 定时提醒守护进程（核心创新）
├── zhizhi-proactive.py   # 主动发消息脚本
├── napcat-watchdog.sh    # NapCat掉线自动重启
└── deploy/
    ├── openclaw.json.example   # Gateway配置示例
    └── install.sh              # 一键部署脚本（待完善）
```

---

## 🚀 快速部署

### 依赖

- Ubuntu 24.04 服务器
- Docker
- Node.js 22+（通过 nvm 安装）
- Python 3.10+
- OpenClaw（`npm install -g openclaw`）
- Anthropic API Key

### 第一步：启动 NapCat

```bash
docker run -d \
  --name napcat \
  -e NAPCAT_QUICK_LOGIN_QQ=你的机器人QQ号 \
  -e TZ=Asia/Shanghai \
  -p 3000-3001:3000-3001 \
  -p 6099:6099 \
  -v /root/napcat_data:/app/napcat/config \
  --restart always \
  mlikiowa/napcat-docker:latest
```

扫码登录（base64方式）：
```bash
docker exec napcat cat /app/napcat/cache/qrcode.png > /tmp/qrcode.png
base64 /tmp/qrcode.png
# 把输出内容发给Claude，让它生成HTML页面显示二维码扫码
```

### 第二步：配置 OpenClaw

```bash
# 安装
npm install -g openclaw

# 配置 ~/.openclaw/openclaw.json
# 关键：tools.profile 必须设为 "full"，gateway.bind 必须设为 "lan"
```

### 第三步：部署插件

```bash
# 复制 index.js 到插件目录
cp index.js ~/.openclaw/extensions/openclaw-qq/index.js

# 复制人设
cp SYSTEM.md ~/.openclaw/agents/main/workspace/SYSTEM.md
```

### 第四步：配置 API Key

```bash
echo "ANTHROPIC_API_KEY=sk-ant-xxx" > /root/.zhizhi-env
```

### 第五步：启动定时提醒

```bash
pip install websockets requests
cp cron-proxy.py /root/cron-proxy.py

cat > /etc/systemd/system/cron-proxy.service << 'SVCEOF'
[Unit]
Description=QQ Cron Proxy
After=openclaw.service

[Service]
ExecStart=/usr/bin/python3 /root/cron-proxy.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload && systemctl enable cron-proxy && systemctl start cron-proxy
```

### 第六步：配置主动发消息

```bash
cp zhizhi-proactive.py /root/zhizhi-proactive.py
# 编辑crontab
crontab -e
# 添加：0 * * * * python3 /root/zhizhi-proactive.py >> /root/zhizhi-proactive.log 2>&1
```

---

## 💡 核心技术说明

### 情绪系统

情绪由 `index.js` 在每次收到消息时计算并注入，不依赖 Claude 自己推断：

```javascript
function getTodayMood() {
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
  let hash = 0;
  for (let i = 0; i < today.length; i++) hash = (hash * 31 + today.charCodeAt(i)) % 10000;
  const r = hash % 100;
  if (r < 40) return '😊 开心';
  if (r < 70) return '😐 普通';
  if (r < 90) return '😴 慵懒';
  return '😤 烦躁';
}
```

| 情绪 | 概率 |
|------|------|
| 😊 开心 | 40% |
| 😐 普通 | 30% |
| 😴 慵懒 | 20% |
| 😤 烦躁 | 10% |

### 定时提醒的核心问题与解法

OpenClaw 内置 cron 触发时会报 `Unknown channel`，因为插件没有注册 deliver channel。

**解决方案**：`cron-proxy.py` 持续监听 `jobs.json`，发现新 job 立即缓存，到时间直接通过 NapCat WebSocket 发送，完全绕过 OpenClaw 的 channel 系统。

```
openclaw cron → 写入 jobs.json → cron-proxy 检测到 → 直连 NapCat WS 发消息
```

---

## 🔧 常用运维命令

```bash
# 重启服务
systemctl restart openclaw
systemctl restart cron-proxy

# 实时日志
journalctl -u cron-proxy -f

# 查看OpenClaw日志
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log \
  | python3 -c "import sys,json; [print(json.loads(l).get('1','')) for l in sys.stdin if l.strip()]" 2>/dev/null

# 确认今日情绪
node -e "
const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
let hash = 0;
for (let i = 0; i < today.length; i++) hash = (hash * 31 + today.charCodeAt(i)) % 10000;
const r = hash % 100;
console.log('今日:', r, r < 40 ? '😊开心' : r < 70 ? '😐普通' : r < 90 ? '😴慵懒' : '😤烦躁');
"
```

---

## ⚠️ 注意事项

- **不要用手机或其他设备登录机器人QQ号**，会触发被踢下线
- QQ 会拦截机器人主动发私聊，定时提醒请在**群里**设置
- `tools.profile` 必须设为 `"full"` 才能使用 cron 工具
- OpenClaw 的 18792 HTTP 接口可能因端口占用不可用，cron-proxy 已改为直连 NapCat WebSocket

---

## 📜 License

MIT
