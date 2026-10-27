#!/usr/bin/env python3
"""自测 SMTP 凭据：连接邮箱服务器、登录、并发出一封测试邮件。

用途：在部署 Cloudflare Worker 之前先确认「服务器地址 / 端口 / 账号 / 密码」是对的。
注意：本机发出的邮件不经过腾讯企业邮服务器，SPF 一定不通过，这是预期现象，
只要 SMTP 返回码不是 5xx 就说明凭据没问题。

用法：
    python3 scripts/test_smtp.py --user you@liyueovo.top --to me@qq.com
    # 密码也可以走环境变量，避免留在命令历史里：
    set SMTP_PASSWORD=xxxx  (Windows)  /  export SMTP_PASSWORD=xxxx  (macOS/Linux)
"""
import argparse
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage


def main():
    parser = argparse.ArgumentParser(description="SMTP credential self-test")
    parser.add_argument("--host", default="smtp.exmail.qq.com", help="SMTP server (default: 腾讯企业邮)")
    parser.add_argument("--port", type=int, default=465, help="SMTP port (default: 465 implicit TLS)")
    parser.add_argument("--user", required=True, help="登录账号，一般就是邮箱地址")
    parser.add_argument("--password", default=os.environ.get("SMTP_PASSWORD", ""), help="密码，默认读环境变量 SMTP_PASSWORD")
    parser.add_argument("--to", required=True, help="收件人（用来验证真的能发出去）")
    parser.add_argument("--from", dest="sender", default=None, help="发信地址，默认与 --user 相同")
    args = parser.parse_args()

    if not args.password:
        print("缺少密码：请传 --password 或设置环境变量 SMTP_PASSWORD")
        return 2

    sender = args.sender or args.user
    message = EmailMessage()
    message["From"] = sender
    message["To"] = args.to
    message["Subject"] = "Liyue Status - SMTP 自测"
    message.set_content(
        "SMTP 凭据自测成功。\n\n"
        "这封邮件由本机直接发出，仅用于验证账号密码是否正确。\n"
        "收到它说明后面 Cloudflare Worker 的发信配置也是通的。"
    )

    print(f"连接 {args.host}:{args.port} …")
    context = ssl.create_default_context()
    try:
        with smtplib.SMTP_SSL(args.host, args.port, context=context, timeout=25) as smtp:
            smtp.ehlo("liyue-status")
            print(f"  服务器: {smtp.esmtp_features.get('auth', '?')}")
            smtp.login(args.user, args.password)
            print("  登录成功")
            smtp.send_message(message)
    except smtplib.SMTPAuthenticationError as exc:
        print(f"认证失败: {exc}")
        print("  · 确认账号/密码正确；企业邮可在「安全设置」里改用客户端专用密码")
        return 1
    except smtplib.SMTPException as exc:
        print(f"SMTP 失败: {exc}")
        return 1
    except OSError as exc:
        print(f"网络失败: {exc}")
        print("  · 465 端口被封时改用 587（STARTTLS），但当前 Worker 只支持 465 隐式 TLS")
        return 1

    print(f"已发送测试邮件到 {args.to}，请查收（含垃圾箱）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
