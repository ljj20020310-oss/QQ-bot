#!/usr/bin/env python3
import json, time, re, asyncio, websockets, requests
from datetime import datetime

JOBS_FILE = '/root/.openclaw/cron/jobs.json'
NAPCAT_WS = 'ws://127.0.0.1:3001'
CHECK_INTERVAL = 2
API_KEY = open('/root/.zhizhi-env').read().strip().split('=',1)[1]

def generate_reminder(job_name, at_name=None):
    """调Claude生成自然的提醒文字"""
    target = at_name or '朋友'
    prompt = f'你是知知，QQ群里的AI女生。现在需要提醒{target}：{job_name}。用1句话，QQ聊天风格，活泼可爱，加emoji，不超过20字。只输出提醒文字本身，不要任何解释。'
    try:
        resp = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
            json={'model': 'claude-haiku-4-5-20251001', 'max_tokens': 100, 'messages': [{'role': 'user', 'content': prompt}]},
            timeout=15
        )
        data = resp.json()
        return data['content'][0]['text'].strip()
    except Exception as e:
        print(f'claude error: {e}', flush=True)
        return job_name  # 失败了就用原始job名

async def send_msg(group_id=None, user_id=None, text='', at_qq=None):
    try:
        async with websockets.connect(NAPCAT_WS, open_timeout=5) as ws:
            if group_id:
                message = []
                if at_qq:
                    message.append({'type': 'at', 'data': {'qq': str(at_qq)}})
                    message.append({'type': 'text', 'data': {'text': ' ' + text}})
                else:
                    message.append({'type': 'text', 'data': {'text': text}})
                payload = {'action': 'send_group_msg', 'params': {'group_id': int(group_id), 'message': message}, 'echo': '1'}
            else:
                payload = {'action': 'send_private_msg', 'params': {'user_id': int(user_id), 'message': [{'type': 'text', 'data': {'text': text}}]}, 'echo': '1'}
            await ws.send(json.dumps(payload))
            resp = await asyncio.wait_for(ws.recv(), timeout=5)
            print(f'send ok: {resp[:80]}', flush=True)
    except Exception as e:
        print(f'send error: {e}', flush=True)

def parse_target(session_key):
    m = re.search(r'qq_group_(\d+)', session_key or '')
    if m: return ('group', m.group(1))
    m = re.search(r'qq_private_(\d+)', session_key or '')
    if m: return ('private', m.group(1))
    return (None, None)

def get_at_qq(job):
    """从job里找要@的人的QQ"""
    # payload message里可能有QQ号
    payload = job.get('payload', {})
    msg = payload.get('message', '')
    m = re.search(r'\b(\d{6,11})\b', msg)
    if m: return m.group(1)
    # 私聊session的情况，取私聊对象
    sk = job.get('sessionKey', '')
    m = re.search(r'qq_private_(\d+)', sk)
    if m: return m.group(1)
    return None

def get_job_name(job):
    payload = job.get('payload', {})
    msg = payload.get('message', '')
    # 去掉QQ号和多余说明，留核心提醒内容
    clean = re.sub(r'\d{6,11}', '', msg)
    clean = re.sub(r'(请提醒|用QQ聊天风格|分\d-\d条|用\|\|\|分隔|活泼可爱|叫他|哥哥)', '', clean)
    clean = clean.strip('，。！,.! \n')
    if len(clean) > 5:
        return clean[:30]
    return job.get('name', '提醒时间到了')

cached_jobs = {}
fired = set()

async def main():
    while True:
        try:
            now_ms = int(time.time() * 1000)
            try:
                data = json.loads(open(JOBS_FILE).read())
                for job in data.get('jobs', []):
                    jid = job.get('id')
                    if jid and jid not in cached_jobs and jid not in fired:
                        cached_jobs[jid] = job
                        at = job.get('schedule', {}).get('at', '')
                        print(f'[cron-proxy] cached: {job.get("name")} at {at}', flush=True)
            except:
                pass

            for jid, job in list(cached_jobs.items()):
                if jid in fired:
                    del cached_jobs[jid]
                    continue
                sched = job.get('schedule', {})
                if sched.get('kind') != 'at':
                    continue
                at = sched.get('at', '')
                if not at:
                    continue
                run_ms = int(datetime.fromisoformat(at.replace('Z','+00:00')).timestamp() * 1000)
                if run_ms <= now_ms:
                    kind, target = parse_target(job.get('sessionKey',''))
                    at_qq = get_at_qq(job)
                    job_name = get_job_name(job)
                    print(f'[cron-proxy] FIRING: {job.get("name")} -> {kind}:{target} at_qq={at_qq}', flush=True)
                    # 调Claude生成自然提醒
                    msg = await asyncio.get_event_loop().run_in_executor(None, generate_reminder, job_name, None)
                    print(f'[cron-proxy] msg: {msg}', flush=True)
                    if kind == 'group':
                        await send_msg(group_id=target, text=msg, at_qq=at_qq)
                    elif kind == 'private':
                        await send_msg(user_id=target, text=msg)
                    else:
                        print(f'[cron-proxy] unknown target, skip', flush=True)
                    fired.add(jid)
                    del cached_jobs[jid]

        except Exception as e:
            print(f'loop error: {e}', flush=True)

        await asyncio.sleep(CHECK_INTERVAL)

asyncio.run(main())
