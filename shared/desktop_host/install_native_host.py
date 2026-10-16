"""Explicit, per-user Edge registration; suitable for a future installer to call."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import winreg
from .launcher import ROOT
from .native_host import HOST_NAME

REGISTRY='Software\\Microsoft\\Edge\\NativeMessagingHosts\\'+HOST_NAME


def prompt_extension_id():
    """Run from Explorer's Windows session when an automation host has a different HKCU view."""
    config_path=Path(os.environ['LOCALAPPDATA'])/'ContextHarness/native-host/native-config.json'
    candidate=''
    if config_path.is_file():
        config=json.loads(config_path.read_text(encoding='utf8'))
        if Path(config.get('project_root','')).resolve()==ROOT.resolve():
            candidate=config.get('extension_id','')
    if not isinstance(candidate,str) or not re.fullmatch('[a-p]{32}',candidate):candidate=''
    print('Register Native Host for the Windows user running this installer. No services will be started.')
    value=input('Edge extension ID'+(' ['+candidate+']' if candidate else '')+': ').strip()
    return value or candidate


def install(extension_id):
    if not re.fullmatch('[a-p]{32}',extension_id):raise ValueError('Invalid Edge extension ID')
    directory=Path(os.environ['LOCALAPPDATA'])/'ContextHarness/native-host'
    directory.mkdir(parents=True,exist_ok=True)
    config_path=directory/'native-config.json'
    if config_path.exists():
        config=json.loads(config_path.read_text(encoding='utf8'))
        if Path(config['project_root']).resolve()!=ROOT.resolve():
            raise ValueError('A different checkout is registered; explicitly unregister it before switching')
    compiler=Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if not compiler.is_file():compiler=Path(os.environ['WINDIR'])/'Microsoft.NET/Framework/v4.0.30319/csc.exe'
    if not compiler.is_file():raise FileNotFoundError('Windows .NET Framework C# compiler is missing')
    temporary=directory/'ContextHarnessNativeHost.new.exe'
    subprocess.run([str(compiler),'/nologo','/target:winexe','/reference:System.Web.Extensions.dll',
                    '/out:'+str(temporary),str(ROOT/'shared/desktop_host/NativeHost.cs')],check=True,
                   creationflags=subprocess.CREATE_NO_WINDOW)
    executable=directory/'ContextHarnessNativeHost.exe'
    temporary.replace(executable)
    config_path.write_text(json.dumps({'project_root':str(ROOT),'extension_id':extension_id},indent=2),encoding='utf8')
    manifest=directory/(HOST_NAME+'.json')
    manifest.write_text(json.dumps({'name':HOST_NAME,'description':'Context Harness fixed local service operations',
                        'path':str(executable),'type':'stdio','allowed_origins':['chrome-extension://'+extension_id+'/']},indent=2),encoding='utf8')
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,REGISTRY) as key:previous=winreg.QueryValueEx(key,'')[0]
    except FileNotFoundError:previous=None
    backup=directory/'registration-backup.json'
    if not backup.exists():backup.write_text(json.dumps({'previous_registry_value':previous}),encoding='utf8')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,REGISTRY) as key:winreg.SetValueEx(key,'',0,winreg.REG_SZ,str(manifest))
    return {'host':HOST_NAME,'manifest':str(manifest),'extension_id':extension_id}


def unregister():
    directory=Path(os.environ['LOCALAPPDATA'])/'ContextHarness/native-host'
    config=json.loads((directory/'native-config.json').read_text(encoding='utf8'))
    if Path(config['project_root']).resolve()!=ROOT.resolve():raise ValueError('Registration belongs to another checkout')
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,REGISTRY) as key:current=winreg.QueryValueEx(key,'')[0]
    if Path(current).resolve()!=(directory/(HOST_NAME+'.json')).resolve():raise ValueError('Registration was changed externally')
    previous=json.loads((directory/'registration-backup.json').read_text(encoding='utf8'))['previous_registry_value']
    if previous:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER,REGISTRY) as key:winreg.SetValueEx(key,'',0,winreg.REG_SZ,previous)
    else:winreg.DeleteKey(winreg.HKEY_CURRENT_USER,REGISTRY)
    return {'unregistered':True,'files_preserved':True}


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--extension-id');group.add_argument('--unregister',action='store_true')
    group.add_argument('--interactive',action='store_true')
    args=parser.parse_args()
    print(json.dumps(unregister() if args.unregister else install(prompt_extension_id() if args.interactive else args.extension_id)))
