import io
import json
from pathlib import Path
import struct
from unittest.mock import Mock

import pytest
from shared.desktop_host import native_host as host

ID='a'*32


def test_ping_has_no_service_side_effect(monkeypatch):
    monkeypatch.setattr(host,'probe',Mock(side_effect=AssertionError('Ping does not probe services')))
    launcher=Mock()
    assert host.dispatch({'operation':'ping'},launcher)=={'ok':True,'host':host.HOST_NAME,'protocol_version':1}
    launcher.run.assert_not_called()


def framed(value):
    body=json.dumps(value).encode()
    return struct.pack('<I',len(body))+body


@pytest.mark.parametrize('payload',[{},[],{'operation':'exec'},{'operation':'start_atlas','command':'bad'},
                                  {'operation':['start_atlas']},{'operation':None}])
def test_rejects_all_nonfixed_requests_without_launch(payload):
    launcher=Mock(side_effect=AssertionError('No command allowed'))
    assert host.dispatch(payload,launcher)['code']=='INVALID_OPERATION'
    launcher.run.assert_not_called()


@pytest.mark.parametrize('operation,name',[('start_collector','Collector'),('start_atlas','Atlas')])
def test_each_start_only_targets_its_service(operation,name):
    launcher=Mock()
    launcher.run.return_value={'services':[{'status':'ready','started':True,'detail':'健康检查通过'}]}
    result=host.dispatch({'operation':operation},launcher)
    assert result['ready'] and result['service']==name
    specs=launcher.run.call_args.args[0]
    assert len(specs)==1 and specs[0].name==name


@pytest.mark.parametrize('operation,name',[('check_collector','Collector'),('check_atlas','Atlas')])
def test_checks_never_start(monkeypatch,operation,name):
    monkeypatch.setattr(host,'probe',lambda s:('stopped','not running'))
    launcher=Mock()
    result=host.dispatch({'operation':operation},launcher)
    assert result['ok'] and not result['ready'] and result['service']==name
    launcher.run.assert_not_called()


def test_origin_and_checkout_are_both_required():
    config={'extension_id':ID,'project_root':str(host.ROOT)}
    assert host.authorized(config,'chrome-extension://'+ID+'/')
    assert not host.authorized(config,'chrome-extension://'+'b'*32+'/')
    assert not host.authorized({**config,'project_root':'C:/wrong-project'},'chrome-extension://'+ID+'/')
    assert not host.authorized([], 'chrome-extension://'+ID+'/')
    assert not host.authorized({'extension_id':ID},'chrome-extension://'+ID+'/')


@pytest.mark.parametrize('payload',[b'',b'\x02',struct.pack('<I',5000),struct.pack('<I',4)+b'{}'])
def test_binary_framing_rejects_incomplete_and_oversize(payload):
    with pytest.raises(ValueError):host.read_message(io.BytesIO(payload))


def test_protocol_stdout_is_one_frame_not_logs(tmp_path,monkeypatch):
    config=tmp_path/'config.json'
    config.write_text(json.dumps({'extension_id':ID,'project_root':str(host.ROOT)}))
    monkeypatch.setattr(host,'probe',lambda s:('ready','healthy'))
    output=io.BytesIO()
    assert host.main([str(config),'chrome-extension://'+ID+'/'],io.BytesIO(framed({'operation':'check_atlas'})),output)==0
    output.seek(0);result=host.read_message(output)
    assert result['ready'] and result['service']=='Atlas' and output.read()==b''


def test_untrusted_origin_is_rejected_before_reading_request(tmp_path):
    config=tmp_path/'config.json'
    config.write_text(json.dumps({'extension_id':ID,'project_root':str(host.ROOT)}))
    output=io.BytesIO()
    assert host.main([str(config),'chrome-extension://'+'b'*32+'/'],io.BytesIO(b''),output)==1
    output.seek(0);assert host.read_message(output)['code']=='FORBIDDEN_ORIGIN'


def test_launch_failure_is_not_success_and_paths_are_not_sent():
    launcher=Mock()
    launcher.run.return_value={'services':[{'status':'failed','started':True,'detail':'入口加载失败；日志：C:/private/path'}]}
    result=host.dispatch({'operation':'start_atlas'},launcher)
    assert not result['ok'] and not result['ready'] and 'C:/private/path' not in str(result)
