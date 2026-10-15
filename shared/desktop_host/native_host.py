"""One framed request from the allowlisted Edge extension; no arbitrary commands."""
import json
from pathlib import Path
import re
import struct
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from shared.desktop_host.launcher import Launcher, LaunchBusy, ROOT, probe, services

HOST_NAME='com.context_harness.desktop_host'
OPERATIONS={'check_collector':(0,False),'start_collector':(0,True),
            'check_atlas':(1,False),'start_atlas':(1,True)}
MAX_MESSAGE=4096


def read_exact(stream,size):
    parts=[]
    while size:
        part=stream.read(size)
        if not part:raise ValueError('Incomplete message')
        parts.append(part);size-=len(part)
    return b''.join(parts)


def read_message(stream):
    size=struct.unpack('<I',read_exact(stream,4))[0]
    if not 0<size<=MAX_MESSAGE:raise ValueError('Message too large')
    return json.loads(read_exact(stream,size).decode('utf8'))


def write_message(stream,result):
    body=json.dumps(result,ensure_ascii=False,separators=(',',':')).encode('utf8')
    stream.write(struct.pack('<I',len(body))+body);stream.flush()


def authorized(config,origin):
    if not isinstance(config,dict):return False
    extension_id=config.get('extension_id','')
    project_root=config.get('project_root')
    return (isinstance(extension_id,str) and re.fullmatch('[a-p]{32}',extension_id) is not None
            and isinstance(project_root,str) and Path(project_root).is_absolute()
            and origin=='chrome-extension://'+extension_id+'/'
            and Path(project_root).resolve()==ROOT.resolve())


def dispatch(request,launcher=None):
    if (not isinstance(request,dict) or set(request)!={'operation'} or not isinstance(request.get('operation'),str)
            or request['operation'] not in OPERATIONS):
        return {'ok':False,'code':'INVALID_OPERATION','error':'只允许固定的采集/图谱检查与启动操作。'}
    index,start=OPERATIONS[request['operation']]
    service=services()[index]
    if not start:
        state,detail=probe(service)
        return {'ok':True,'service':service.name,'state':state,'ready':state=='ready','detail':detail}
    try:
        result=(launcher or Launcher()).run((service,))['services'][0]
    except LaunchBusy:
        return {'ok':False,'code':'LAUNCH_BUSY','error':'服务启动检查正在进行，请稍后重试。'}
    except Exception:
        return {'ok':False,'code':'HOST_ERROR','error':'本地启动失败，请检查 Desktop Host 日志与 Python 环境。'}
    # Do not send paths, environment, log contents or configuration to the browser.
    return {'ok':result['status']=='ready','service':service.name,'ready':result['status']=='ready',
            'state':result['status'],'started':result['started'],
            'detail':result['detail'].split('；日志：')[0].split('，请检查日志：')[0],
            'code':None if result['status']=='ready' else 'START_FAILED'}


def main(argv=None,stdin=None,stdout=None):
    args=argv if argv is not None else sys.argv[1:]
    output=stdout or sys.stdout.buffer
    try:
        if len(args)!=2:raise ValueError('Missing private registration')
        config=json.loads(Path(args[0]).read_text(encoding='utf8'))
        if not authorized(config,args[1]):
            write_message(output,{'ok':False,'code':'FORBIDDEN_ORIGIN','error':'不受信任的扩展来源。'})
            return 1
        request=read_message(stdin or sys.stdin.buffer)
        result=dispatch(request)
    except (ValueError,KeyError,OSError,TypeError):
        result={'ok':False,'code':'INVALID_REQUEST','error':'Native Host 请求或注册配置无效。'}
    write_message(output,result)
    return 0


if __name__=='__main__':raise SystemExit(main())
