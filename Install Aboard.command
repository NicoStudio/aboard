#!/bin/zsh
set -uo pipefail

PROJECT_ROOT=${0:A:h}
cd "$PROJECT_ROOT"

show_message() {
  /usr/bin/osascript -e "$1" >/dev/null 2>&1 || true
}

pause_after_error() {
  if [[ -t 0 ]]; then
    echo
    read -k 1 "?按任意键关闭窗口 / Press any key to close…"
    echo
  fi
}

clear
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Aboard 一键安装 / Easy Installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "安装期间不需要输入命令，请等待完成提示。"
echo "No commands are needed. Please wait for completion."
echo

if [[ ! -d "/Applications/ChatGPT.app" ]]; then
  echo "❌ 请先安装官方 ChatGPT/Codex macOS 应用。"
  echo "   Install the official ChatGPT/Codex macOS app first."
  echo "   https://openai.com/chatgpt/desktop/"
  show_message 'display dialog "请先安装官方 ChatGPT/Codex macOS 应用，然后重新运行 Aboard 安装器。" with title "Aboard 无法安装" buttons {"知道了"} default button 1 with icon stop'
  pause_after_error
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 这台 Mac 还没有 Python 3。"
  echo "   Install Python 3, then run this installer again:"
  echo "   https://www.python.org/downloads/macos/"
  show_message 'display dialog "这台 Mac 还没有 Python 3。安装 Python 3 后，请重新运行 Aboard 安装器。\n\npython.org/downloads/macos/" with title "Aboard 无法安装" buttons {"知道了"} default button 1 with icon stop'
  pause_after_error
  exit 1
fi

echo "开始安装，这通常只需要一两分钟……"
echo "Installing Aboard. This usually takes a minute or two…"
echo

if ./scripts/install-on-mac.sh; then
  echo
  echo "✅ Aboard 安装完成。应用已经打开。"
  echo "   Aboard is installed and ready."
  show_message 'display dialog "Aboard 已安装完成并打开。以后可以从“应用程序”或程序坞启动。" with title "Aboard 安装完成" buttons {"完成"} default button 1 with icon note'
  exit 0
else
  install_status=$?
fi

echo
echo "❌ 安装没有完成。请查看上方最后一条提示，处理后重新双击安装器。"
echo "   Installation did not finish. Read the last message above, then try again."
show_message 'display dialog "Aboard 没有安装完成。请查看终端窗口中的最后一条提示，处理后重新运行安装器。" with title "Aboard 安装失败" buttons {"知道了"} default button 1 with icon stop'
pause_after_error
exit "$install_status"
