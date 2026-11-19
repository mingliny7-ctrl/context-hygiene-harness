"""One small provider contract; only DeepSeek is implemented in this module."""

from dataclasses import dataclass, field
import os
import re
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr


class AnalysisError(Exception):
    def __init__(self, code, detail, attempts=None):
        self.code, self.detail, self.attempts = code, detail, attempts or []
        self.diagnostics = []
        self.stats = {}
        super().__init__(f'{code}: {detail}')


@dataclass(frozen=True)
class LLMConfig:
    base_url: str = 'https://api.deepseek.com'
    model: str = 'deepseek-v4-pro'
    api_key: SecretStr | None = field(default=None, repr=False)
    timeout_seconds: float = 180
    context_tokens: int = 131072
    output_tokens: int = 4096
    max_attempts: int = 2

    def __post_init__(self):
        url = urlsplit(self.base_url)
        if (url.scheme != 'https' and not (url.scheme=='http' and url.hostname in ('localhost','127.0.0.1','::1'))) or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('Use HTTPS for a cloud model; credentials belong in private configuration')
        if not self.model.strip() or not 0 < self.timeout_seconds <= 600:
            raise ValueError('Invalid model or timeout')
        if not 2048 < self.context_tokens <= 1048576 or not 0 < self.output_tokens < self.context_tokens-2048:
            raise ValueError('Invalid context/output budget')
        if self.max_attempts not in (1,2):raise ValueError('At most one validation repair is permitted')

    @classmethod
    def from_env(cls):
        private = Path(os.getenv('ATLAS_PRIVATE_ENV', Path(os.getenv('LOCALAPPDATA', Path.home()))/'ContextHarness'/'deepseek.env'))
        values = {}
        if private.is_file():
            for line in private.read_text(encoding='utf-8-sig').splitlines():
                if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                    name,value=line.split('=',1)
                    values[name.strip()]=value.strip().strip('"').strip("'")
        def setting(name,default=''):
            return os.getenv(name) or values.get(name) or default
        secret = setting('DEEPSEEK_API_KEY')
        key_file = setting('ATLAS_DEEPSEEK_KEY_FILE')
        if not secret and key_file:
            text = Path(key_file).read_text(encoding='utf-8-sig').strip()
            matches = re.findall(r'(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]+',text)
            if len(set(matches)) != 1:
                raise AnalysisError('CONFIG_INVALID','Private key file must contain exactly one identifiable API key')
            secret = matches[0]
        if not secret:
            raise AnalysisError('CONFIG_MISSING','Configure DEEPSEEK_API_KEY in user environment or private deepseek.env; do not put it in Git/database')
        return cls(base_url=setting('DEEPSEEK_BASE_URL',cls.base_url),model=setting('DEEPSEEK_MODEL',cls.model),
                   api_key=SecretStr(secret),timeout_seconds=float(setting('ATLAS_LLM_TIMEOUT',str(cls.timeout_seconds))),
                   context_tokens=int(setting('ATLAS_LLM_CONTEXT',str(cls.context_tokens))),
                   output_tokens=int(setting('ATLAS_LLM_OUTPUT',str(cls.output_tokens))),
                   max_attempts=int(setting('ATLAS_LLM_MAX_ATTEMPTS',str(cls.max_attempts))))


class LLMProvider(Protocol):
    config: LLMConfig
    def complete(self, system: str, user: str) -> dict: ...


class DeepSeekProvider:
    def __init__(self, config: LLMConfig, transport=None):
        self.config,self.transport=config,transport

    def complete(self, system, user):
        if not self.config.api_key or not self.config.api_key.get_secret_value():
            raise AnalysisError('CONFIG_MISSING','DeepSeek API key is not configured')
        try:
            with httpx.Client(timeout=self.config.timeout_seconds,transport=self.transport,
                              trust_env=False,follow_redirects=False) as client:
                response=client.post(self.config.base_url.rstrip('/')+'/chat/completions',
                    headers={'Authorization':'Bearer '+self.config.api_key.get_secret_value()},
                    json={'model':self.config.model,'stream':False,'thinking':{'type':'disabled'},
                          'temperature':0,'max_tokens':self.config.output_tokens,
                          'response_format':{'type':'json_object'},
                          'messages':[{'role':'system','content':system},{'role':'user','content':user}]})
        except httpx.TimeoutException as error:
            raise AnalysisError('REQUEST_TIMEOUT','DeepSeek request timed out; no automatic transport retry') from error
        except httpx.RequestError as error:
            raise AnalysisError('MODEL_UNAVAILABLE','Cannot reach the configured DeepSeek endpoint') from error
        errors={401:'AUTH_FAILED',402:'INSUFFICIENT_BALANCE',403:'AUTH_FAILED',404:'MODEL_NOT_FOUND',429:'RATE_LIMITED'}
        if not response.is_success:
            raise AnalysisError(errors.get(response.status_code,'MODEL_ERROR'),f'DeepSeek HTTP {response.status_code}; response body and credentials are not logged')
        try:
            body=response.json()
        except ValueError as error:
            raise AnalysisError('INVALID_JSON','DeepSeek response envelope is not JSON') from error
        if not isinstance(body,dict) or body.get('error'):
            raise AnalysisError('MODEL_ERROR','DeepSeek returned an invalid envelope')
        choices=body.get('choices')
        if not isinstance(choices,list) or len(choices)!=1 or not isinstance(choices[0],dict):
            raise AnalysisError('INCOMPLETE_RESPONSE','Missing unique completion choice')
        choice=choices[0]
        if choice.get('finish_reason')!='stop' or not isinstance(choice.get('message'),dict):
            error = AnalysisError('INCOMPLETE_RESPONSE','Generation was truncated, filtered or incomplete')
            error.stats = {'finish_reason': choice.get('finish_reason'), 'request_id': body.get('id'),
                           'usage': body.get('usage') or {}}
            raise error
        message=choice['message']
        if message.get('role')!='assistant' or message.get('tool_calls'):
            raise AnalysisError('INCOMPLETE_RESPONSE','Only a final textual Assistant answer is accepted; no tools are executed')
        if not isinstance(body.get('model'),str) or not body['model']:
            raise AnalysisError('MODEL_ERROR','Response model identity is missing')
        return {'content':message.get('content'),'model':body['model'],
                'stats':{'request_id':body.get('id'),'model':body['model'],'configured_model':self.config.model,
                         'created':body.get('created'),'finish_reason':choice['finish_reason'],'usage':body.get('usage')}}
