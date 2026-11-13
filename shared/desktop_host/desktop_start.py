"""One-click Windows entry point for the existing Collector and Atlas services."""

import ctypes
import webbrowser

from .launcher import Launcher

ATLAS_URL = 'http://127.0.0.1:4173/'


def show_error(message):
    ctypes.windll.user32.MessageBoxW(None, message, 'Conversation Atlas 启动失败', 0x10)


def start():
    try:
        result = Launcher().run()
        if result['status'] != 'ready':
            failures = [f"{item['service']}：{item['detail']}" for item in result['services']
                        if item['status'] != 'ready']
            show_error('部分服务未能启动：\n' + '\n'.join(failures)
                       + '\n\n诊断结果已保存到本机 ContextHarness 日志目录。')
            return False
        if not webbrowser.open_new_tab(ATLAS_URL):
            show_error('两个服务已就绪，但无法自动打开浏览器。\n请访问 ' + ATLAS_URL)
            return False
        return True
    except Exception as error:
        # Do not surface an unexpected exception body: it may contain private configuration.
        show_error(f'启动检查失败：{type(error).__name__}。请检查本机 ContextHarness 日志。')
        return False


if __name__ == '__main__':
    start()
