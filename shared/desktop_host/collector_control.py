"""Fixed Collector lifecycle, using a local Windows event rather than PID killing."""
import asyncio
import ctypes
from ctypes import wintypes
import hashlib
from pathlib import Path
import sys
import time

from .launcher import ROOT, probe, services


def event_name(root=ROOT):
    digest = hashlib.sha256(str(Path(root).resolve()).casefold().encode()).hexdigest()[:24]
    return 'Local\\ContextHarnessCollectorStop-' + digest


def kernel_api():
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateEventW.restype = wintypes.HANDLE
    kernel.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.OpenEventW.restype = wintypes.HANDLE
    kernel.SetEvent.argtypes = [wintypes.HANDLE]
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel


def signal_stop(root=ROOT):
    kernel = kernel_api()
    handle = kernel.OpenEventW(0x0002, False, event_name(root))  # EVENT_MODIFY_STATE
    if not handle:
        return False
    try:
        if not kernel.SetEvent(handle):
            raise OSError('Cannot signal Collector shutdown')
        return True
    finally:
        kernel.CloseHandle(handle)


def lifecycle_running(root=ROOT):
    kernel = kernel_api()
    handle = kernel.OpenEventW(0x00100000, False, event_name(root))  # SYNCHRONIZE
    if not handle:
        return False
    kernel.CloseHandle(handle)
    return True


def stop_collector(root=ROOT, timeout=25):
    service = services(root)[0]
    state, _ = probe(service)
    result = {'ok': True, 'service': 'Collector', 'state': 'stopped', 'ready': False}
    if state == 'stopped' and not lifecycle_running(root):
        return result
    if state not in ('ready', 'stopped'):
        return {**result, 'ok': False, 'state': state, 'code': 'STOP_UNVERIFIED', 'error': '无法确认采集服务身份，未关闭任何进程。'}
    if not signal_stop(root):
        return {**result, 'ok': False, 'state': 'ready', 'ready': True, 'code': 'STOP_UNMANAGED', 'error': '采集服务由旧启动方式运行，尚不支持安全关闭；请先退出旧服务。'}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if probe(service)[0] == 'stopped' and not lifecycle_running(root):
            return result
        time.sleep(.1)
    return {**result, 'ok': False, 'state': 'stopping', 'code': 'STOP_TIMEOUT', 'error': '采集服务正在结束请求，尚未确认关闭，请稍后重试。'}


async def serve():
    import uvicorn
    service = services()[0]
    kernel = kernel_api()
    handle = kernel.CreateEventW(None, True, False, event_name())
    if not handle:
        raise OSError('Cannot create Collector shutdown event')
    try:
        if ctypes.get_last_error() == 183:
            raise RuntimeError('Collector lifecycle already exists')
        sys.path.insert(0, str(service.app_dir))
        server = uvicorn.Server(uvicorn.Config(service.app, host='127.0.0.1', port=service.port))
        task = asyncio.create_task(server.serve())
        while not task.done():
            if kernel.WaitForSingleObject(handle, 0) == 0:
                server.should_exit = True  # uvicorn drains requests before shutdown.
            await asyncio.sleep(.1)
        await task
    finally:
        kernel.CloseHandle(handle)


if __name__ == '__main__':
    asyncio.run(serve())
