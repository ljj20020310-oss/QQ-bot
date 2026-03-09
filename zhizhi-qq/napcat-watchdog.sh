#!/bin/bash
docker logs -f napcat 2>&1 | while read line; do
  if echo "$line" | grep -q "KickedOffLine\|账号状态变更为离线"; then
    echo "$(date) 检测到掉线，重启 napcat..." >> /root/napcat-watchdog.log
    docker restart napcat
  fi
done
