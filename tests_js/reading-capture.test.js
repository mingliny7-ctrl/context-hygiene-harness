const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
class Element {
  constructor(tag,children=[],attrs={}){this.nodeType=1;this.tagName=tag.toUpperCase();this.childNodes=children;this.attrs=attrs;}
  get textContent(){return this.childNodes.map(c=>c.textContent??c.nodeValue).join('');}
  getAttribute(name){return this.attrs[name]??null;}
  hasAttribute(name){return name in this.attrs;}
  querySelector(tag){for(const child of this.childNodes){if(child.tagName===tag.toUpperCase())return child;const found=child.querySelector?.(tag);if(found)return found;}return null;}
  querySelectorAll(tag){return this.childNodes.flatMap(child=>[...(child.tagName===tag.toUpperCase()?[child]:[]),...(child.querySelectorAll?.(tag)||[])]);}
}
const text=value=>({nodeType:3,nodeValue:value});
const e=(tag,children=[],attrs={})=>new Element(tag,children,attrs);
const context={URL,TextEncoder,location:{origin:'https://chatgpt.com'}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../shared/chatgpt_bridge/reading_capture.js'),'utf8'),context);
const capture=context.AtlasReadingCapture;
test('visible DOM structure, exact code and image position survive without UI buttons or HTML handlers',()=>{
  const code='def f():\n    return "<script>"';
  const root=e('div',[e('h4',[text('ChatGPT 说：')],{class:'sr-only'}),e('h2',[text('标题')]),
    e('p',[e('strong',[text('重点')])]),e('pre',[e('button',[text('复制代码')]),e('code',[text(code)])]),
    e('img',[],{src:'https://images.openai.com/a.png',alt:'原图',onerror:'evil()'}),e('p',[text('图片后的段落')]),e('script',[text('EXECUTE')])]);
  const value=JSON.parse(JSON.stringify(capture.documentFor(root)));
  assert.deepEqual(value.nodes.map(n=>n.tag),['h2','p','pre','img','p']);
  assert.equal(value.nodes[2].children[0].text,code);
  assert.ok(!JSON.stringify(value).includes('onerror'));
  assert.ok(!JSON.stringify(value).includes('复制代码'));
  assert.ok(capture.hasImage(value.nodes));
});
test('favicons are not answer images; temporary resources become explicit unavailable images',()=>{
  const value=capture.documentFor(e('div',[e('img',[],{src:'https://google.com/s2/favicons?x=1'}),e('img',[],{src:'blob:https://chatgpt.com/private',alt:'生成图'})]));
  assert.equal(value.nodes.length,1);assert.equal(value.nodes[0].src,null);
});

test('an accessible same-origin blob is attached to the same message as local image bytes',async()=>{
  const url='blob:https://chatgpt.com/photo-1';
  const img=e('img',[],{src:url,alt:'用户附件'});img.currentSrc=url;img.naturalWidth=2048;
  const root=e('div',[img,e('p',[text('看图')])]);
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4,5]);
  context.btoa=s=>Buffer.from(s,'binary').toString('base64');
  context.fetch=async target=>{assert.equal(target,url);return {async blob(){return {type:'image/png',size:bytes.length,async arrayBuffer(){return bytes}}}};};
  await new Promise(resolve=>capture.captureAvailableMedia(root,resolve));
  const captured=capture.documentFor(root);
  assert.equal(captured.nodes[0].src,'data:image/png;base64,'+bytes.toString('base64'));
  assert.equal(captured.nodes[1].tag,'p');
});
