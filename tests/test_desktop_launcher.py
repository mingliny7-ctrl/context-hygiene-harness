from dataclasses import replace
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import pytest

from shared.desktop_host import launcher as host


def test_existing_healthy_service_is_reused_without_process(monkeypatch,tmp_path):
    monkeypatch.setattr(host,'probe',lambda s:('ready','ok'))
    spawn=Mock(side_effect=AssertionError('No duplicate process'))
    monkeypatch.setattr(host.subprocess,'Popen',spawn)
    result=host.Launcher(log_dir=tmp_path).run()
    assert result['status']=='ready'
    assert all(not row['started'] for row in result['services'])
    assert json.loads((tmp_path/'latest.json').read_text(encoding='utf8'))==result
    spawn.assert_not_called()


def test_os_mutex_blocks_concurrent_launchers_and_releases():
    with host.LaunchLock():
        with pytest.raises(host.LaunchBusy):
            with host.LaunchLock():
                pytest.fail('Duplicate launcher acquired mutex')
    with host.LaunchLock():
        pass


@pytest.mark.parametrize('wrong',['identity','health','redirect','invalid_json'])
def test_live_http_identity_and_health_not_just_port(wrong,monkeypatch,tmp_path):
    spec=host.services()[0]
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if wrong=='redirect':
                self.send_response(302);self.send_header('Location','http://example.invalid');self.end_headers();return
            body={'info':{'title':'Other App' if wrong=='identity' else spec.title},'paths':dict.fromkeys(spec.required_paths,{})}
            if self.path=='/health':body={'status':'broken' if wrong=='health' else 'ok'}
            self.send_response(200);self.end_headers()
            self.wfile.write(b'not json' if wrong=='invalid_json' else json.dumps(body).encode())
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        spec=replace(spec,port=server.server_port)
        spawn=Mock(side_effect=AssertionError('Must not replace port owner'))
        monkeypatch.setattr(host.subprocess,'Popen',spawn)
        result=host.Launcher(log_dir=tmp_path,timeout=.1).ensure(spec)
        assert result['status']=='failed' and not result['started']
        assert host.port_open(spec.port)  # Never killed the unrelated HTTP process.
        spawn.assert_not_called()
    finally:
        server.shutdown();server.server_close();thread.join()


def test_spawn_uses_existing_python_hidden_flags_and_preserves_private_environment(monkeypatch,tmp_path):
    spec=host.services()[0]
    probes=iter([('stopped','none'),('ready','ok')])
    monkeypatch.setattr(host,'probe',lambda s:next(probes))
    monkeypatch.setenv('DEEPSEEK_API_KEY','test-only-not-a-real-key')
    monkeypatch.setenv('ATLAS_PRIVATE_ENV','private-location')
    process=Mock(pid=123);process.poll.return_value=None
    spawn=Mock(return_value=process)
    monkeypatch.setattr(host.subprocess,'Popen',spawn)
    result=host.Launcher(log_dir=tmp_path).ensure(spec)
    command=spawn.call_args.args[0];options=spawn.call_args.kwargs
    assert command[0]==str(host.ROOT/'plugins/context_hygiene/.venv/Scripts/python.exe')
    assert command[1:4]==['-m','uvicorn','app.main:app']
    assert options['creationflags'] & subprocess.CREATE_NO_WINDOW
    assert options['env']['DEEPSEEK_API_KEY']=='test-only-not-a-real-key'
    assert options['env']['ATLAS_PRIVATE_ENV']=='private-location'
    assert result['status']=='ready' and result['pid']==123
    assert 'test-only-not-a-real-key' not in json.dumps(result)


def test_missing_environment_and_independent_results(monkeypatch,tmp_path):
    collector,atlas=host.services()
    monkeypatch.setattr(host,'probe',lambda s:('stopped','none') if s.name=='Collector' else ('ready','ok'))
    launcher=host.Launcher(log_dir=tmp_path)
    launcher.python=tmp_path/'missing-python.exe'
    result=launcher.run()
    assert result['status']=='failed'
    assert [r['status'] for r in result['services']]==['failed','ready']
    assert 'FileNotFoundError' in result['services'][0]['detail']


def test_process_exit_reports_log_and_does_not_claim_success(monkeypatch,tmp_path):
    monkeypatch.setattr(host,'probe',lambda s:('stopped','none'))
    process=Mock(pid=123,returncode=1);process.poll.return_value=1
    monkeypatch.setattr(host.subprocess,'Popen',Mock(return_value=process))
    result=host.Launcher(log_dir=tmp_path).ensure(host.services()[0])
    assert result['status']=='failed' and '代码 1' in result['detail']
    assert Path(result['log']).is_file()


def test_startup_timeout_is_failure_not_ready(monkeypatch,tmp_path):
    monkeypatch.setattr(host,'probe',lambda s:('stopped','not ready'))
    process=Mock(pid=123);process.poll.return_value=None
    monkeypatch.setattr(host.subprocess,'Popen',Mock(return_value=process))
    result=host.Launcher(log_dir=tmp_path,timeout=.01).ensure(host.services()[0])
    assert result['status']=='failed' and '未确认可用' in result['detail']
    process.terminate.assert_not_called()


@pytest.mark.parametrize('marker,expected',[
    ('Error loading ASGI app','后端入口加载失败'),
    ('No module named secret-private-name','Python 依赖缺失'),
    ('address already in use','监听端口已被占用'),
])
def test_failure_reason_ignores_previous_runs_and_never_echoes_raw_log(tmp_path,marker,expected):
    log=tmp_path/'service.log'
    old=b'PermissionError from an older launch\n'
    log.write_bytes(old+(marker+' private-api-key-value').encode())
    reason=host.failure_reason(log,len(old))
    assert expected in reason and 'private-api-key-value' not in reason
    assert '权限不足' not in reason
