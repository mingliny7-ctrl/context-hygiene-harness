"use strict";

// Service feedback is separate from SQLite-confirmed collection receipts.
const serviceActionNotice = document.getElementById('serviceActionNotice');
function bindServiceButton(id, action, pendingText) {
    const button = document.getElementById(id);
    button.addEventListener('click', async () => {
        button.disabled = true;
        serviceActionNotice.textContent = pendingText;
        try {
            const result = await chrome.runtime.sendMessage({type:'DESKTOP_SERVICE',action});
            if (!result?.ok || !result.ready) throw new Error(result?.error || '未能确认服务健康，请重试。');
            serviceActionNotice.textContent = result.message;
        } catch (error) {
            serviceActionNotice.textContent = error.message || '本地服务启动失败。';
        } finally {
            button.disabled = false;
        }
    });
}
bindServiceButton('startCollector','start_collector','正在检查并启动采集服务…');
bindServiceButton('openAtlas','open_atlas','正在检查图谱服务，确认后打开…');
