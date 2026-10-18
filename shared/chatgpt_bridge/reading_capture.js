"use strict";
// A small inert document tree: no HTML, event handlers, styles, or executable attributes.
globalThis.AtlasReadingCapture = (() => {
    const allowed = new Set('p div h1 h2 h3 h4 h5 h6 strong em del ul ol li blockquote pre code table thead tbody tfoot tr th td a img br hr'.split(' '));
    const imageCache = new Map();
    const imagePending = new Set();
    const imageFailed = new Set();
    const maxImageBytes = 5_000_000;
    const imageTypes = new Set(['image/png','image/jpeg','image/webp','image/gif']);
    function captureAvailableMedia(root, onSaved) {
        if (typeof fetch !== 'function' || typeof btoa !== 'function') return;
        for (const img of root.querySelectorAll('img')) {
            const url = img.currentSrc || img.getAttribute('src') || '';
            if (!url.startsWith(`blob:${location.origin}/`) || !img.naturalWidth ||
                    imageCache.has(url) || imagePending.has(url) || imageFailed.has(url)) continue;
            imagePending.add(url);
            fetch(url).then(response => response.blob()).then(async blob => {
                if (!imageTypes.has(blob.type) || blob.size > maxImageBytes || blob.size === 0) throw Error('unsupported image');
                const bytes = new Uint8Array(await blob.arrayBuffer());
                let base64 = '';
                // Each encoded chunk ends on a multiple-of-three byte boundary.
                for (let i = 0; i < bytes.length; i += 8190)
                    base64 += btoa(String.fromCharCode(...bytes.subarray(i, i + 8190)));
                imageCache.set(url, `data:${blob.type};base64,${base64}`);
                while (imageCache.size > 8) imageCache.delete(imageCache.keys().next().value);
                onSaved();
            }).catch(() => imageFailed.add(url)).finally(() => imagePending.delete(url));
        }
    }
    function documentFor(element) {
        let count = 0;
        function visit(node, depth = 0) {
            if (++count > 8000 || depth > 36) throw new Error('document limit');
            if (node.nodeType === 3) return [{tag:'text', text:node.nodeValue || ''}];
            if (node.nodeType !== 1) return [];
            const tag = node.tagName.toLowerCase();
            if (/^(script|style|svg|button|input|textarea|nav)$/.test(tag) || node.hasAttribute('hidden') ||
                node.getAttribute('aria-hidden') === 'true' || /(?:^|\s)sr-only(?:\s|$)/.test(node.getAttribute('class') || '')) return [];
            if (tag === 'pre') {
                const code = node.querySelector('code');
                return [{tag:'pre', children:[{tag:'code', text:(code || node).textContent || ''}]}];
            }
            if (tag === 'img') {
                const raw = node.currentSrc || node.getAttribute('src') || '';
                if (/favicon|\/s2\/favicons/i.test(raw)) return [];
                let src = null;
                if (imageCache.has(raw)) src = imageCache.get(raw);
                else try {const url = new URL(raw, location.origin); if(url.protocol === 'https:') src=url.href;} catch (_) {}
                return [{tag:'img', src, alt:node.getAttribute('alt') || '原始回答图片'}];
            }
            const children = [...node.childNodes].flatMap(child => visit(child, depth+1));
            if (!allowed.has(tag)) return children;
            const item = {tag, children};
            if (tag === 'a') {
                const href=node.getAttribute('href');
                try {if(href)item.href = new URL(href, location.origin).href;} catch (_) {}
            }
            if (tag === 'ol' && node.hasAttribute('start')) item.start = Number.parseInt(node.getAttribute('start'),10) || 1;
            return [item];
        }
        try {
            const result = {version:1, nodes:[...element.childNodes].flatMap(node => visit(node))};
            return result.nodes.length && new TextEncoder().encode(JSON.stringify(result)).length <= 12_000_000 ? result : null;
        } catch (_) {return null;} // Never block plain-text capture on a presentation failure.
    }
    function hasImage(nodes) {return nodes.some(n => n.tag==='img' || hasImage(n.children || []));}
    return {documentFor, hasImage, captureAvailableMedia};
})();
