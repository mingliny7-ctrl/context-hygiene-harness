"""Explicit single-conversation CLI with a small Atlas derived cache."""

import argparse
import json
from pathlib import Path
import time
from .analysis import AnalysisError, analyze_conversation


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--conversation-id', required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--cache-db', type=Path)
    parser.add_argument('--regenerate', action='store_true', help='Explicitly replace a compatible analysis')
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    print('READING_ORDERED_CONVERSATION -> CACHE_LOOKUP -> LLM_IF_NEEDED', flush=True)
    try:
        result = analyze_conversation(args.conversation_id,cache_db_path=args.cache_db,regenerate=args.regenerate)
    except (AnalysisError, ValueError) as error:
        failure = {'status':'failed','conversation_id':args.conversation_id,
                   'error':getattr(error,'code','CONFIG_INVALID'), 'detail':str(error),
                   'elapsed_seconds':round(time.perf_counter()-started,3), 'attempts':getattr(error,'attempts',[])}
        (args.output_dir/'failure.json').write_text(json.dumps(failure,ensure_ascii=False,indent=2),encoding='utf8')
        if getattr(error,'diagnostics',None):
            (args.output_dir/'failure-diagnostics.json').write_text(json.dumps(error.diagnostics,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(failure,ensure_ascii=False),flush=True)
        return 1
    (args.output_dir/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    analysis, source, inference = result['analysis'], result['input'], result['inference']
    report = f'''# 单 Conversation DeepSeek 语义分析验收

模型生成内容，尚未经过人工事实确认。Pydantic通过只代表结构有效。

- Conversation：{source['conversation_id']}
- 顺序：{source['ordering']}；已存储输入全文，历史完整性未知。
- 输入：User {source['counts']['user']} 条，Assistant {source['counts']['assistant']} 条；排除空正文 {source['excluded_empty_count']} 条。
- 原分析模型：{inference['model']}；当前读取方式：{inference['mode']}
- 耗时：{inference['elapsed_seconds']} 秒；尝试：{len(inference['attempts'])} 次。
- 缓存命中：{result['cache']['hit']}；本次实际模型请求：{inference['actual_model_calls']} 次。
- 推理状态：{result['status']}；Pydantic：passed。
- Python原文ID/角色/所属Conversation校验及原文回读：passed；这不代表结论逻辑已获人工确认。
- 输入 SHA256：{source['sha256']}

## 标题

{analysis['title']}

## 摘要

{analysis['summary']}

## 结论或方案（模型提取，待人工核对）

{chr(10).join('- '+text for text in analysis['outcomes']) or '无明确结论。'}

## 关键词

{'、'.join(analysis['keywords'])}

## 关键 Assistant 原始回答

{chr(10).join('### '+ref['message_id']+chr(10)+chr(10)+ref['reason']+chr(10)+chr(10)+'原文开头（Python从SQLite提取，完整回答见result.json）：'+chr(10)+'> '+result['source_references'][ref['message_id']]['content'][:160].replace(chr(10),chr(10)+'> ')+chr(10) for ref in analysis['key_assistant_answers'])}

## 讨论结论的原文依据

{chr(10).join('- 结论 '+str(e['outcome_index']+1)+'：'+ref['message_id']+'（原文全文及SHA256见result.json/source_references）' for e in analysis['outcome_evidence'] for ref in e['sources']) or '无明确讨论结论。'}

## 持久化缓存

```json
{json.dumps(result['cache'],ensure_ascii=False,indent=2)}
```

## 实际调用证据

```json
{json.dumps(inference,ensure_ascii=False,indent=2)}
```

完整原文、稳定消息ID、模型输出和校验结果见result.json。仅写Atlas独立派生缓存，没有写原始Conversation数据库。
'''
    (args.output_dir/'analysis-report.md').write_text(report,encoding='utf8')
    print(json.dumps({'status':'validated','analysis':analysis,'inference':inference},ensure_ascii=False),flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
