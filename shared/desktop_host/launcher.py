"""Start existing loopback services, without shells, arbitrary commands or secrets."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Service:
    name: str
    port: int
    app: str
    app_dir: Path
    title: str
    health_path: str
    required_paths: tuple[str, ...]

    @property
    def url(self):
        return f'http://127.0.0.1:{self.port}'


def services(root=ROOT):
    return (
        Service('Collector',18000,'app.main:app',root/'plugins/context_hygiene/backend',
                'Context Harness Conversation Collector','/health',('/sync','/conversations/{conversation_id}/status')),
        Service('Atlas',14173,'plugins.conversation_atlas.backend.main:app',root,
                'Conversation Atlas · read-only Store integration','/api/atlas',('/api/atlas','/api/atlas/conversations/{conversation_id}')),
    )


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_json(url):
    # Ignore system proxies, never follow a local service to an external host.
    with build_opener(ProxyHandler({}),NoRedirect()).open(url,timeout=1) as response:
        body=response.read(2_000_001)
        if len(body)>2_000_000:
            raise ValueError('Oversized local health response')
        return json.loads(body)


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1',port),timeout=.2):
            return True
    except OSError:
        return False


def failure_reason(path, offset):
    # Classify only this launch's tail; never echo raw logs or possible secrets.
    try:
        with Path(path).open('rb') as log:
            log.seek(0,2)
            log.seek(max(offset,log.tell()-8192))
            tail=log.read().decode('utf8',errors='replace')
        for marker,reason in (
            ('address already in use','监听端口已被占用'),
            ('WinError 10048','监听端口已被占用'),
            ('No module named','Python 依赖缺失或模块路径不正确'),
            ('Error loading ASGI app','后端入口加载失败，请检查模块或依赖'),
            ('WinError 10013','Windows 禁止绑定监听端口，请检查系统保留端口'),
            ('PermissionError','访问所需文件的权限不足'),
            ('database is locked','数据库被其他操作占用'),
            ('unable to open database file','无法打开数据库文件'),
        ):
            if marker.casefold() in tail.casefold():return reason
    except OSError:
        pass
    return '后端进程异常退出，详细原因见日志'


def probe(service):
    if not port_open(service.port):
        return 'stopped','服务尚未监听'
    try:
        schema=read_json(service.url+'/openapi.json')
        if (not isinstance(schema,dict) or schema.get('info',{}).get('title')!=service.title
                or not all(p in schema.get('paths',{}) for p in service.required_paths)):
            return 'conflict',f'端口 {service.port} 被其他服务占用，服务身份不符'
        health=read_json(service.url+service.health_path)
        valid=(isinstance(health,dict) and (health.get('status')=='ok' if service.name=='Collector'
               else health.get('schemaVersion')==1 and health.get('provenance',{}).get('mode')=='real'
               and isinstance(health.get('conversations'),list)))
        return ('ready','身份与健康检查通过') if valid else ('unhealthy','服务身份已确认，但健康响应无效')
    except Exception as error:
        # Never print bodies, request headers, environment or provider settings.
        return 'unhealthy',f'端口 {service.port} 已占用，身份/健康检查失败：{type(error).__name__}'


class LaunchBusy(Exception):
    pass


class LaunchLock:
    """A per-checkout OS mutex; released automatically even after a launcher crash."""
    def __init__(self,root=ROOT):
        digest=hashlib.sha256(str(root.resolve()).casefold().encode()).hexdigest()[:24]
        self.name='Local\\ContextHarnessLauncher-'+digest
        self.handle=None

    def __enter__(self):
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.CreateMutexW.argtypes=[ctypes.c_void_p,wintypes.BOOL,wintypes.LPCWSTR]
        kernel.CreateMutexW.restype=wintypes.HANDLE
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        kernel.ReleaseMutex.argtypes=[wintypes.HANDLE]
        self.kernel=kernel
        self.handle=kernel.CreateMutexW(None,True,self.name)
        if not self.handle:
            raise OSError('Cannot acquire Windows launcher mutex')
        if ctypes.get_last_error()==183:
            kernel.CloseHandle(self.handle)
            self.handle=None
            raise LaunchBusy('另一个启动器正在检查服务，请查看它的结果；本窗口不会重复启动进程。')
        return self

    def __exit__(self,*args):
        if self.handle:
            self.kernel.ReleaseMutex(self.handle)
            self.kernel.CloseHandle(self.handle)
            self.handle=None


class Launcher:
    def __init__(self,root=ROOT,log_dir=None,timeout=25):
        self.root=Path(root).resolve()
        self.python=self.root/'plugins/context_hygiene/.venv/Scripts/python.exe'
        suffix=hashlib.sha256(str(self.root).casefold().encode()).hexdigest()[:12]
        self.log_dir=Path(log_dir) if log_dir else Path(os.getenv('LOCALAPPDATA',Path.home()))/'ContextHarness/logs/desktop-host'/suffix
        self.timeout=timeout
        self.spawned=[]  # Handles for controlled tests; GUI never terminates services.

    def ensure(self,service):
        started=time.monotonic()
        state,detail=probe(service)
        result={'service':service.name,'url':service.url,'health_url':service.url+service.health_path,
                'status':'failed','started':False,'pid':None,'detail':detail}
        if state=='ready':
            result.update(status='ready',detail='已运行；身份与健康检查通过')
            return result
        process=None
        if state=='stopped':
            try:
                if not self.python.is_file():
                    raise FileNotFoundError('项目现有 Python 环境不存在；请恢复 .venv')
                self.log_dir.mkdir(parents=True,exist_ok=True)
                log=self.log_dir/(service.name.lower()+'.log')
                env=os.environ.copy()
                env['PYTHONPATH']=str(self.root)+(os.pathsep+env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
                command=[str(self.python),'-m','uvicorn',service.app,'--app-dir',str(service.app_dir),
                         '--host','127.0.0.1','--port',str(service.port)]
                if service == services(self.root)[0]:
                    command=[str(self.python),'-m','shared.desktop_host.collector_control']
                with log.open('ab') as output:
                    log_offset=output.tell()
                    process=subprocess.Popen(command,cwd=self.root,env=env,stdin=subprocess.DEVNULL,
                        stdout=output,stderr=subprocess.STDOUT,close_fds=True,
                        creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
                self.spawned.append(process)
                result.update(started=True,pid=process.pid,log=str(log))
            except Exception as error:
                result['detail']=f'启动失败：{type(error).__name__}：{error}'
                return result
        elif state=='conflict':
            return result
        # An occupied but unverified port is NEVER an invitation to spawn or kill.
        while time.monotonic()-started<self.timeout:
            if process is not None and process.poll() is not None:
                reason=failure_reason(result['log'],log_offset)
                result['detail']=f'{reason}（代码 {process.returncode}）；日志：{result["log"]}'
                return result
            state,detail=probe(service)
            if state=='ready':
                result.update(status='ready',detail='身份与健康检查通过')
                return result
            if state=='conflict':
                break
            time.sleep(.25)
        result['detail']=detail+'；未确认可用，请检查服务日志或端口占用。没有结束任何服务进程。'
        return result

    def stop_collector(self):
        from .collector_control import stop_collector
        with LaunchLock(self.root):
            return stop_collector(self.root,self.timeout)

    def run(self,specs=None,notify=None):
        with LaunchLock(self.root):
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures=[executor.submit(self.ensure,s) for s in (specs or services(self.root))]
                results=[]
                for future in futures:
                    result=future.result()
                    results.append(result)
                    if notify:notify(result)
            self.log_dir.mkdir(parents=True,exist_ok=True)
            summary={'status':'ready' if all(r['status']=='ready' for r in results) else 'failed','services':results}
            temp=self.log_dir/'latest.tmp'
            temp.write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
            temp.replace(self.log_dir/'latest.json')
            return summary
