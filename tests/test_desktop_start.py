from shared.desktop_host import desktop_start
from shared.desktop_host.launcher import ROOT, services


def test_atlas_address_is_consistent_across_desktop_native_host_and_extension():
    import json
    import re

    atlas = services()[1]
    assert atlas.port == 14173
    assert desktop_start.ATLAS_URL == atlas.url + '/'
    worker = (ROOT / 'shared/chatgpt_bridge/bridge_worker.js').read_text(encoding='utf8')
    assert re.search(r"const ATLAS_URL = '([^']+)'", worker).group(1) == desktop_start.ATLAS_URL
    manifest = json.loads((ROOT / 'shared/chatgpt_bridge/manifest.json').read_text(encoding='utf8'))
    assert atlas.url + '/*' in manifest['host_permissions']
    script = (ROOT / 'scripts/start_atlas.ps1').read_text(encoding='utf8')
    assert int(re.search(r'\$Port = (\d+)', script).group(1)) == atlas.port


def test_desktop_shortcut_opens_atlas_only_after_both_services_are_ready(monkeypatch):
    calls = []
    class Launcher:
        def run(self):
            calls.append('run')
            return {'status': 'ready', 'services': [
                {'service': 'Collector', 'status': 'ready'},
                {'service': 'Atlas', 'status': 'ready'}]}
    monkeypatch.setattr(desktop_start, 'Launcher', Launcher)
    monkeypatch.setattr(desktop_start.webbrowser, 'open_new_tab', lambda url: calls.append(url) or True)
    assert desktop_start.start() is True
    assert calls == ['run', desktop_start.ATLAS_URL]


def test_desktop_shortcut_reports_failure_without_opening_atlas(monkeypatch):
    messages = []
    class Launcher:
        def run(self):
            return {'status': 'failed', 'services': [
                {'service': 'Collector', 'status': 'ready', 'detail': '已运行'},
                {'service': 'Atlas', 'status': 'failed', 'detail': '端口冲突'}]}
    monkeypatch.setattr(desktop_start, 'Launcher', Launcher)
    monkeypatch.setattr(desktop_start, 'show_error', messages.append)
    monkeypatch.setattr(desktop_start.webbrowser, 'open_new_tab', lambda url: (_ for _ in ()).throw(AssertionError(url)))
    assert desktop_start.start() is False
    assert 'Atlas：端口冲突' in messages[0]
