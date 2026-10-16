from unittest.mock import Mock
from dataclasses import replace
import json
import os
import socket
import subprocess
import sys
import time
from urllib.request import Request, ProxyHandler, build_opener

from shared.desktop_host import native_host
from shared.desktop_host import collector_control as control


def test_stop_is_fixed_collector_only():
    launcher = Mock()
    launcher.stop_collector.return_value = {'ok': True, 'service': 'Collector', 'state': 'stopped', 'ready': False}
    result = native_host.dispatch({'operation': 'stop_collector'}, launcher)
    assert result['ok'] and result['state'] == 'stopped'
    launcher.stop_collector.assert_called_once_with()
    launcher.run.assert_not_called()


def test_stop_refuses_unverified_port_owner(monkeypatch):
    monkeypatch.setattr(control, 'probe', lambda _: ('conflict', 'other service'))
    signal = Mock(side_effect=AssertionError('Do not signal unknown service'))
    monkeypatch.setattr(control, 'signal_stop', signal)
    assert control.stop_collector()['code'] == 'STOP_UNVERIFIED'
    signal.assert_not_called()


def test_stop_does_not_claim_success_before_service_exits(monkeypatch):
    monkeypatch.setattr(control, 'probe', lambda _: ('ready', 'healthy'))
    monkeypatch.setattr(control, 'signal_stop', lambda _: True)
    assert control.stop_collector(timeout=0)['code'] == 'STOP_TIMEOUT'


def test_old_external_service_is_not_killed(monkeypatch):
    monkeypatch.setattr(control, 'probe', lambda _: ('ready', 'healthy'))
    monkeypatch.setattr(control, 'signal_stop', lambda _: False)
    assert control.stop_collector()['code'] == 'STOP_UNMANAGED'


def test_stop_waits_and_is_idempotent(monkeypatch):
    # Unit state must not depend on the user's currently running Windows event.
    monkeypatch.setattr(control, 'lifecycle_running', lambda _: False)
    states = iter([('ready', 'healthy'), ('stopped', 'done')])
    monkeypatch.setattr(control, 'probe', lambda _: next(states))
    monkeypatch.setattr(control, 'signal_stop', lambda _: True)
    assert control.stop_collector()['state'] == 'stopped'
    monkeypatch.setattr(control, 'probe', lambda _: ('stopped', 'done'))
    signal = Mock(side_effect=AssertionError('Already stopped'))
    monkeypatch.setattr(control, 'signal_stop', signal)
    assert control.stop_collector()['ok']


def test_shutdown_event_is_scoped_to_checkout(tmp_path):
    assert control.event_name(tmp_path) == control.event_name(tmp_path)
    assert control.event_name(tmp_path) != control.event_name(tmp_path / 'other')


def test_real_windows_process_graceful_stop_and_sqlite_restart(tmp_path,monkeypatch):
    # Separate port, event name and database: never stop the user's Collector.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port=sock.getsockname()[1]
    spec=replace(control.services()[0],port=port)
    monkeypatch.setattr(control,'services',lambda root=tmp_path:(spec,))
    code='''
import asyncio,sys
from dataclasses import replace
from pathlib import Path
from shared.desktop_host import collector_control as c
spec=replace(c.services()[0],port=int(sys.argv[2]))
c.services=lambda:(spec,)
original_name=c.event_name
c.event_name=lambda:original_name(Path(sys.argv[1]))
asyncio.run(c.serve())
'''
    env={**os.environ,'CONVERSATION_DB_PATH':str(tmp_path/'isolated.db'), 'PYTHONPATH':str(control.ROOT)}
    client=build_opener(ProxyHandler({}))
    payload={'conversation_id':'lifecycle-test','messages':[
        {'key':'chatgpt:11111111-1111-4111-8111-111111111111:assistant','role':'assistant','content':'受控生命周期测试回答。'}]}
    for cycle in range(2):
        with (tmp_path/f'process-{cycle}.log').open('wb') as log:
            process=subprocess.Popen([sys.executable,'-c',code,str(tmp_path),str(port)],cwd=control.ROOT,
                env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline=time.monotonic()+10
            while control.probe(spec)[0]!='ready' and time.monotonic()<deadline:
                assert process.poll() is None, (tmp_path/f'process-{cycle}.log').read_text()
                time.sleep(.1)
            assert control.probe(spec)[0]=='ready'
            if cycle==0:
                with client.open(Request(spec.url+'/sync',data=json.dumps(payload).encode(),
                        headers={'Content-Type':'application/json'}),timeout=3) as response:
                    assert json.load(response)['assistant_reply_count']==1
            with client.open(spec.url+'/conversations/lifecycle-test/status',timeout=3) as response:
                receipt=json.load(response)
                assert receipt['assistant_reply_count']==1
                assert receipt['latest_assistant_preview']=='受控生命周期测试回答。'
            assert control.stop_collector(tmp_path)['ok']
            assert process.wait(timeout=5)==0  # Graceful exit, no termination signal.
            log_text=(tmp_path/f'process-{cycle}.log').read_text()
            assert 'Application shutdown complete' in log_text
        finally:
            if process.poll() is None:
                control.signal_stop(tmp_path)
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.terminate()  # Only the subprocess created by this test.
                    process.wait(timeout=5)
