import { invoke } from '@tauri-apps/api/core';

const $ = (id) => document.getElementById(id);
const log = (msg) => { $('log').textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2); };

function formConfig() {
  return {
    api_key: $('apiKey').value.trim(),
    model: $('model').value,
    port: Number($('port').value || 3456),
    thinking: $('thinking').value,
    reasoning_effort: $('effort').value,
  };
}

async function refresh() {
  try {
    const cfg = await invoke('get_config');
    $('model').value = cfg.model || 'deepseek-v4-pro';
    $('port').value = cfg.port || 3456;
    $('thinking').value = cfg.thinking || 'enabled';
    $('effort').value = cfg.reasoning_effort || 'high';
    $('apiKey').value = cfg.has_api_key ? '********' : '';
    const status = await invoke('get_status');
    $('statusBadge').textContent = status.running ? '运行中' : '未启动';
    $('statusBadge').className = status.running ? 'badge running' : 'badge';
    log(status);
  } catch (e) { log(String(e)); }
}

$('saveBtn').addEventListener('click', async () => {
  const cfg = formConfig();
  if (cfg.api_key === '********') delete cfg.api_key;
  log(await invoke('save_config', { config: cfg }));
  await refresh();
});

$('startBtn').addEventListener('click', async () => { log(await invoke('start_proxy')); await refresh(); });
$('stopBtn').addEventListener('click', async () => { log(await invoke('stop_proxy')); await refresh(); });
$('testBtn').addEventListener('click', async () => { log(await invoke('test_connection')); await refresh(); });
$('codexBtn').addEventListener('click', async () => { log(await invoke('configure_codex')); });
$('launchBtn').addEventListener('click', async () => { log(await invoke('install_launch_agent')); });
$('restoreBtn').addEventListener('click', async () => { log(await invoke('restore_codex_backup')); });

refresh();
