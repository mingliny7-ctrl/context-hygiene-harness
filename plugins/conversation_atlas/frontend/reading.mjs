/** Safe reading DOM. Captured presentation and semantic plain text stay separate. */
export function safeUrl(value, image = false) {
  try {
    const u=new URL(value);
    if(image && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length<=12_000_000) return value;
    if (!(image ? ['https:'] : ['https:','http:']).includes(u.protocol) || u.username || u.password) return null;
    if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname) || /\.(local|localhost)$/i.test(u.hostname) || (u.port && !['80','443'].includes(u.port))) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return null;
    return u.href;
  } catch (_) {return null;}
}

const text=value=>({tag:'text',text:value});
function inline(value) {
  const nodes=[]; let position=0;
  const re=/(`[^`\n]+`|\*\*[^*]+\*\*|__[^_]+__|!\[[^\]]*\]\([^\s)]+\)|\[[^\]]+\]\([^\s)]+\)|\*[^*\n]+\*)/g;
  for (const match of value.matchAll(re)) {
    nodes.push(text(value.slice(position,match.index))); const token=match[0];
    if(token[0]==='`') nodes.push({tag:'code',text:token.slice(1,-1)});
    else if(token.startsWith('**')||token.startsWith('__')) nodes.push({tag:'strong',children:inline(token.slice(2,-2))});
    else if(token[0]==='*') nodes.push({tag:'em',children:inline(token.slice(1,-1))});
    else {const image=token[0]==='!';const at=token.indexOf('](');const label=token.slice(image?2:1,at);const url=token.slice(at+2,-1);nodes.push(image?{tag:'img',alt:label,src:url}:{tag:'a',href:url,children:[text(label)]});}
    position=match.index+token.length;
  }
  nodes.push(text(value.slice(position))); return nodes;
}

/** Literal stored Markdown only; lost ChatGPT DOM structure is never guessed back. */
export function markdownDocument(content) {
  const lines=content.replace(/\r\n/g,'\n').split('\n'); const nodes=[];
  const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(s=>s.trim());
  for(let i=0;i<lines.length;){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    const fence=line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if(fence){let code=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(fence[1]))code.push(lines[i++]);if(i<lines.length)i++;nodes.push({tag:'pre',children:[{tag:'code',text:code.join('\n')}]});continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/);
    if(heading){nodes.push({tag:`h${heading[1].length}`,children:inline(heading[2])});i++;continue;}
    if(i+1<lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i+1])){
      const head={tag:'tr',children:cells(line).map(c=>({tag:'th',children:inline(c)}))};const rows=[];i+=2;
      while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push({tag:'tr',children:cells(lines[i++]).map(c=>({tag:'td',children:inline(c)}))});
      nodes.push({tag:'table',children:[{tag:'thead',children:[head]},{tag:'tbody',children:rows}]});continue;
    }
    if(/^\s*>/.test(line)){const quoted=[];while(i<lines.length&&/^\s*>/.test(lines[i]))quoted.push(lines[i++].replace(/^\s*> ?/,''));nodes.push({tag:'blockquote',children:markdownDocument(quoted.join('\n')).nodes});continue;}
    const bullet=line.match(/^\s*(?:([-+*])|([0-9]+)[.)])\s+(.+)$/);
    if(bullet){const list={tag:bullet[2]?'ol':'ul',children:[]};if(bullet[2])list.start=Number(bullet[2]);
      while(i<lines.length){const row=lines[i].match(/^\s*(?:([-+*])|([0-9]+)[.)])\s+(.+)$/);if(!row||Boolean(row[2])!==Boolean(bullet[2]))break;list.children.push({tag:'li',children:inline(row[3])});i++;}nodes.push(list);continue;}
    const paragraph=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,6}\s|\s*>|\s*[-+*]\s|\s*\d+[.)]\s|\s*```|\s*~~~)/.test(lines[i]))paragraph.push(lines[i++]);
    nodes.push({tag:'p',children:inline(paragraph.join('\n'))});
  }
  return {version:1,nodes};
}

const tags=new Set('p div h1 h2 h3 h4 h5 h6 strong em del ul ol li blockquote pre code table thead tbody tfoot tr th td a img br hr'.split(' '));
export function renderDocument(value, doc=document) {
  const root=doc.createElement('div');root.className='reading-prose';let count=0;
  const sourceText=n=>(typeof n.text==='string'?n.text:'')+(n.children||[]).map(sourceText).join('');
  const build=(n,depth=0,insidePre=false)=>{
    if(++count>8000||depth>36||!n||typeof n!=='object')return doc.createTextNode('');
    if(n.tag==='text')return doc.createTextNode(typeof n.text==='string'?n.text:'');
    if(!tags.has(n.tag))return doc.createTextNode('');
    if(n.tag==='img'){
      const figure=doc.createElement('figure');const status=doc.createElement('figcaption');status.textContent=n.alt||'原始图片';
      const src=safeUrl(n.src,true);
      if(src){const image=doc.createElement('img');image.alt=n.alt||'原始回答图片';image.loading='lazy';image.referrerPolicy='no-referrer';
        image.addEventListener('error',()=>{image.remove();status.textContent='图片无法访问或链接已失效 · '+(n.alt||'原始图片');figure.classList.add('image-unavailable');},{once:true});image.src=src;figure.append(image);}
      else {status.textContent='图片不可用（未保存可访问的资源地址） · '+(n.alt||'原始图片');figure.className='image-unavailable';}
      figure.append(status);return figure;
    }
    const element=doc.createElement(n.tag);
    if(n.tag==='a'){const href=safeUrl(n.href);if(href){element.href=href;element.target='_blank';element.rel='noopener noreferrer';}}
    if(n.tag==='ol'&&Number.isInteger(n.start))element.start=Math.max(1,Math.min(n.start,100000));
    if(typeof n.text==='string')element.append(doc.createTextNode(n.text));
    for(const child of Array.isArray(n.children)?n.children:[])element.append(build(child,depth+1,insidePre||n.tag==='pre'));
    // ChatGPT also renders block code as <code class="block whitespace-pre"> inside divs.
    // A real multiline CODE node retains its whitespace even without a PRE ancestor.
    if(n.tag==='code'&&!insidePre&&sourceText(n).includes('\n')){const pre=doc.createElement('pre');pre.append(element);return pre;}
    if(n.tag==='table'){const wrap=doc.createElement('div');wrap.className='reading-table';wrap.append(element);return wrap;}
    return element;
  };
  for(const node of value?.version===1&&Array.isArray(value.nodes)?value.nodes:[])root.append(build(node));
  return root;
}

export function renderReading(message, doc=document) {
  const container=doc.createElement('div');const presentation=message.presentation;
  const observed=message.observedPresentation||message.observed_presentation;
  if(!presentation&&observed?.version===1&&observed.nodes?.length) {
    let showingObserved=true;
    const note=doc.createElement('p');note.className='reading-limitation';
    const toggle=doc.createElement('button');toggle.className='reading-version-toggle';
    const draw=()=>{
      note.textContent=showingObserved?'当前显示再次采集的页面结构；它与旧正文不同，可能不完整。旧正文和索引均未替换，可切换核对。':'当前显示已保存的旧正文；其原始排版可能未采集。页面结构与旧正文不同。';
      toggle.textContent=showingObserved?'查看已保存旧正文':'查看再次采集的页面结构';
      container.replaceChildren(note,toggle,renderDocument(showingObserved?observed:markdownDocument(message.content||''),doc));
    };
    toggle.addEventListener('click',()=>{showingObserved=!showingObserved;draw();});draw();return container;
  }
  const plainOnly=nodes=>nodes.every(n=>['text','div','p','br'].includes(n.tag)&&plainOnly(n.children||[]));
  if(presentation?.version===1 && presentation.nodes?.length) {
    const typedMarkdown=message.role==='user' && plainOnly(presentation.nodes) && /(^|\n)#{1,6}\s|```|\*\*[^*]+\*\*/.test(message.content||'');
    container.append(renderDocument(typedMarkdown?markdownDocument(message.content):presentation,doc));
  }
  else {
    const note=doc.createElement('p');note.className='reading-limitation';
    note.textContent=(message.presentationStatus||message.presentation_status)==='source_mismatch'
      ?'页面结构与旧正文版本不一致，以下保留已保存文本，不套用不同版本的格式。'
      :'旧记录仅保存文本，原始格式及图片可能缺失；以下按已保存内容阅读。';
    container.append(note,renderDocument(markdownDocument(message.content||'〔尚未保存正文〕'),doc));
  }
  return container;
}
