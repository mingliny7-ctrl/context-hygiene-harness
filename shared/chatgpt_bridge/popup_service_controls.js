"use strict";

// Service lifecycle feedback never masquerades as a SQLite save receipt.
const serviceActionNotice = document.getElementById('serviceActionNotice');
const collectorButton = document.getElementById('startCollector');
const atlasButton = document.getElementById('openAtlas');
let collectorState = 'unknown';
let serviceBusy = false;
let serviceRevision = 0;

function showCollectorState(result) {
    collectorState = result.ready ? 'ready' : result.state === 'stopped' ? 'stopped' : 'unknown';
    collectorButton.textContent = collectorState === 'ready' ? '关闭服务'
        : collectorState === 'stopped' ? '启动服务' : '重试检查服务';
}

async function checkCollector(showError = false) {
    if (serviceBusy) return;
    const revision = ++serviceRevision;
    try {
        const result = await chrome.runtime.sendMessage({type:'DESKTOP_SERVICE',action:'check_collector'});
        if (revision !== serviceRevision || serviceBusy) return;
        if (!result?.ok) throw new Error(result?.error || '无法确认采集服务状态。');
        if (!result.ready && result.state !== 'stopped') throw new Error(result.detail || '采集服务尚未通过健康检查。');
        showCollectorState(result);
    } catch (error) {
        if (revision !== serviceRevision || serviceBusy) return;
        showCollectorState({});
        if (showError) serviceActionNotice.textContent = error.message;
    } finally {
        if (revision === serviceRevision && !serviceBusy) collectorButton.disabled = false;
    }
}

async function runServiceAction(action) {
    if (serviceBusy) return;
    serviceBusy = true;
    ++serviceRevision; // Discard a status response started before this click.
    collectorButton.disabled = atlasButton.disabled = true;
    serviceActionNotice.textContent = action === 'stop_collector' ? '正在关闭采集，等待保存中的请求结束…'
        : action === 'start_collector' ? '正在检查并启动采集服务…' : '正在检查图谱服务，确认后打开…';
    try {
        const result = await chrome.runtime.sendMessage({type:'DESKTOP_SERVICE',action});
        const confirmed = action === 'stop_collector' ? result?.state === 'stopped' && result.ready === false : result?.ready;
        if (!result?.ok || !confirmed) throw new Error(result?.error || '未能确认服务状态，请重试。');
        if (action !== 'open_atlas') showCollectorState(result);
        serviceActionNotice.textContent = result.message;
    } catch (error) {
        serviceActionNotice.textContent = error.message || '本地服务操作失败。';
    } finally {
        serviceBusy = false;
        collectorButton.disabled = atlasButton.disabled = false;
    }
}

collectorButton.addEventListener('click', () => collectorState === 'unknown' ? checkCollector(true)
    : runServiceAction(collectorState === 'ready' ? 'stop_collector' : 'start_collector'));
atlasButton.addEventListener('click', () => runServiceAction('open_atlas'));
collectorButton.disabled = true;
collectorButton.textContent = '正在检查采集…';
checkCollector(true);
setInterval(() => checkCollector(), 5000);
