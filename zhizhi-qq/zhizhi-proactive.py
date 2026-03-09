#!/usr/bin/env python3
# 主动发消息脚本 - 每小时由cron触发，按概率决定是否发送
import requests, json, random, datetime, sys, os

SEND_URL = "http://127.0.0.1:18792/send"
GROUP_ID = "你的群号"      # 修改为你的群号
USER_ID = "你的QQ号"       # 修改为你的QQ号

def get_api_key():
    with open("/root/.zhizhi-env") as f:
        for line in f:
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.strip().split("=", 1)[1]
    return ""

def get_weather(city="Changsha"):
    try:
        r = requests.get(f"https://wttr.in/{city}?format=3", timeout=5)
        return r.text.strip()
    except:
        return ""

def ask_claude(prompt, api_key, model="claude-haiku-4-5-20251001"):
    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": model, "max_tokens": 200, "messages": [{"role": "user", "content": prompt}]},
            timeout=30
        )
        return r.json()["content"][0]["text"].strip()
    except Exception as e:
        print(f"Claude error: {e}", file=sys.stderr)
        return ""

def send(text, is_group):
    for part in text.split("|||"):
        part = part.strip()
        if not part:
            continue
        body = {"groupId": GROUP_ID, "text": part} if is_group else {"userId": USER_ID, "text": part}
        try:
            requests.post(SEND_URL, json=body, timeout=5)
        except Exception as e:
            print(f"Send error: {e}", file=sys.stderr)

def main():
    now = datetime.datetime.now()
    hour = now.hour

    # 各时段发送概率
    prob_map = {
        range(7, 9): 0.7,
        range(9, 12): 0.2,
        range(12, 14): 0.3,
        range(14, 18): 0.15,
        range(18, 20): 0.3,
        range(20, 23): 0.4,
        range(23, 24): 0.2,
        range(0, 1): 0.1,
    }
    prob = 0.05
    for r, p in prob_map.items():
        if hour in r:
            prob = p
            break

    if random.random() > prob:
        sys.exit(0)

    api_key = get_api_key()
    if not api_key:
        print("未找到API key", file=sys.stderr)
        sys.exit(1)

    weather = get_weather()

    if hour in range(7, 9):
        msg_type = "早安问候"
    elif hour in range(22, 24) or hour in range(0, 2):
        msg_type = "晚安/深夜"
    else:
        msg_type = random.choice(["主动聊天", "冷知识", "有趣的事", "主动聊天"])

    weather_hint = f"当前天气：{weather}。" if weather else ""
    prompts = {
        "早安问候": f"你是知知，QQ群机器人，研二学生人设。{weather_hint}现在是早上{hour}点，自然发一条早安消息带天气提示，知知风格，2-3条用|||分隔，像朋友发消息。",
        "晚安/深夜": f"你是知知，现在{hour}点，发一条晚安或深夜感慨，知知风格，2-3条用|||分隔。",
        "主动聊天": f"你是知知，随机发'在吗'或'你们在干嘛'或'有没有人'，知知风格，1-2条用|||分隔，简短自然。",
        "冷知识": f"你是知知，分享一个有趣冷知识，认知科学/心理学方向，知知风格，2-3条用|||分隔。",
        "有趣的事": f"你是知知，分享一件最近觉得有意思的事或想法，知知风格，2-3条用|||分隔。",
    }

    text = ask_claude(prompts[msg_type], api_key)
    if not text:
        sys.exit(1)

    print(f"[{now}] 类型={msg_type} 内容={text[:50]}")

    if msg_type in ["早安问候", "晚安/深夜", "冷知识", "有趣的事"]:
        send(text, is_group=True)
    else:
        send(text, is_group=random.random() > 0.4)

if __name__ == "__main__":
    main()
