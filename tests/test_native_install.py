import json
from pathlib import Path

import pytest

from shared.desktop_host import install_native_host as installer


def test_interactive_registration_reuses_only_this_checkout_identity(tmp_path,monkeypatch):
    monkeypatch.setenv('LOCALAPPDATA',str(tmp_path))
    config=tmp_path/'ContextHarness/native-host/native-config.json'
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({'project_root':str(installer.ROOT),'extension_id':'a'*32}))
    monkeypatch.setattr('builtins.input',lambda prompt:'')
    assert installer.prompt_extension_id()=='a'*32
    config.write_text(json.dumps({'project_root':str(tmp_path/'other'),'extension_id':'a'*32}))
    assert installer.prompt_extension_id()==''


def test_invalid_extension_id_rejected_before_registration(tmp_path,monkeypatch):
    monkeypatch.setenv('LOCALAPPDATA',str(tmp_path))
    with pytest.raises(ValueError):installer.install('invalid & command')
    assert not (tmp_path/'ContextHarness').exists()
