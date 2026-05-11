use axum::{extract::State, http::StatusCode, response::sse::{Event, Sse}, response::IntoResponse, routing::{get, post}, Json, Router};
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, net::SocketAddr, path::PathBuf, sync::{Arc, Mutex}};
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;

#[derive(Clone, Serialize, Deserialize)]
struct AppConfig {
    api_key: Option<String>,
    model: String,
    port: u16,
    thinking: String,
    reasoning_effort: String,
}
impl Default for AppConfig {
    fn default() -> Self { Self { api_key: None, model: "deepseek-v4-pro".into(), port: 3456, thinking: "enabled".into(), reasoning_effort: "high".into() } }
}
#[derive(Clone)]
struct ProxyData { config: Arc<Mutex<AppConfig>>, histories: Arc<Mutex<HashMap<String, Vec<Value>>>> }
struct AppState { config: Arc<Mutex<AppConfig>>, server_stop: Arc<Mutex<Option<oneshot::Sender<()>>>> }
#[derive(Serialize)]
struct Status { running: bool, port: u16, model: String, thinking: String }

fn config_dir() -> Result<PathBuf, String> { let mut p = dirs::home_dir().ok_or("Cannot find home directory")?; p.push(".codex-deepseek-proxy"); fs::create_dir_all(&p).map_err(|e| e.to_string())?; Ok(p) }
fn config_path() -> Result<PathBuf, String> { Ok(config_dir()?.join("config.json")) }
fn load_config() -> AppConfig { config_path().ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default() }
fn save_config_file(cfg: &AppConfig) -> Result<(), String> { fs::write(config_path()?, serde_json::to_string_pretty(cfg).unwrap()).map_err(|e| e.to_string()) }
fn codex_config_path() -> Result<PathBuf, String> { let mut p = dirs::home_dir().ok_or("Cannot find home directory")?; p.push(".codex"); fs::create_dir_all(&p).map_err(|e| e.to_string())?; p.push("config.toml"); Ok(p) }

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> Result<Value, String> { let c = state.config.lock().unwrap().clone(); Ok(json!({"has_api_key": c.api_key.as_ref().map(|s| !s.is_empty()).unwrap_or(false), "model": c.model, "port": c.port, "thinking": c.thinking, "reasoning_effort": c.reasoning_effort})) }
#[tauri::command]
fn save_config(state: tauri::State<AppState>, config: AppConfig) -> Result<String, String> { let mut old = state.config.lock().unwrap(); if config.api_key.as_deref() != Some("********") && config.api_key.is_some() { old.api_key = config.api_key; } old.model = config.model; old.port = config.port; old.thinking = config.thinking; old.reasoning_effort = config.reasoning_effort; save_config_file(&old)?; Ok("配置已保存".into()) }
#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Result<Status, String> { let c = state.config.lock().unwrap().clone(); Ok(Status { running: state.server_stop.lock().unwrap().is_some(), port: c.port, model: c.model, thinking: c.thinking }) }

#[tauri::command]
async fn start_proxy(state: tauri::State<'_, AppState>) -> Result<String, String> {
    if state.server_stop.lock().unwrap().is_some() { return Ok("代理已在运行".into()); }
    let cfg = state.config.lock().unwrap().clone();
    if cfg.api_key.clone().unwrap_or_default().is_empty() { return Err("请先填写 DeepSeek API Key".into()); }
    let data = ProxyData { config: state.config.clone(), histories: Arc::new(Mutex::new(HashMap::new())) };
    let app = Router::new().route("/health", get(health)).route("/v1/models", get(models)).route("/v1/responses", post(responses)).layer(CorsLayer::permissive()).with_state(data);
    let addr: SocketAddr = format!("127.0.0.1:{}", cfg.port).parse().map_err(|e| e.to_string())?;
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| e.to_string())?;
    let (tx, rx) = oneshot::channel();
    *state.server_stop.lock().unwrap() = Some(tx);
    tokio::spawn(async move { let _ = axum::serve(listener, app).with_graceful_shutdown(async { let _ = rx.await; }).await; });
    Ok(format!("代理已启动：http://127.0.0.1:{}", cfg.port))
}
#[tauri::command]
fn stop_proxy(state: tauri::State<AppState>) -> Result<String, String> { if let Some(tx) = state.server_stop.lock().unwrap().take() { let _ = tx.send(()); Ok("代理已停止".into()) } else { Ok("代理未运行".into()) } }
#[tauri::command]
async fn test_connection(state: tauri::State<'_, AppState>) -> Result<String, String> { let cfg = state.config.lock().unwrap().clone(); let url = format!("http://127.0.0.1:{}/health", cfg.port); let v: Value = reqwest::get(url).await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?; Ok(format!("连接正常：{}", v)) }

#[tauri::command]
fn configure_codex(state: tauri::State<AppState>) -> Result<String, String> {
    let cfg = state.config.lock().unwrap().clone(); let path = codex_config_path()?; let old = fs::read_to_string(&path).unwrap_or_default();
    if path.exists() { let bak = path.with_extension(format!("toml.bak.{}", chrono::Local::now().format("%Y%m%d%H%M%S"))); fs::write(&bak, &old).map_err(|e| e.to_string())?; }
    let mut kept = Vec::new(); let mut skip = false;
    for line in old.lines() { let t = line.trim(); if t == "[model_providers.deepseek_local]" { skip = true; continue; } if skip && t.starts_with('[') { skip = false; } if !skip && !t.starts_with("model = ") && !t.starts_with("model_provider = ") { kept.push(line.to_string()); } }
    let block = format!("model = \"{}\"\nmodel_provider = \"deepseek_local\"\nmodel_reasoning_effort = \"{}\"\nmodel_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n\n[model_providers.deepseek_local]\nname = \"DeepSeek V4 Local Responses Proxy\"\nbase_url = \"http://127.0.0.1:{}/v1\"\nwire_api = \"responses\"\nexperimental_bearer_token = \"local-only\"\nstream_idle_timeout_ms = 900000\nrequest_max_retries = 2\nstream_max_retries = 2\n", cfg.model, cfg.reasoning_effort, cfg.port);
    fs::write(&path, format!("{}\n\n{}", kept.join("\n"), block)).map_err(|e| e.to_string())?; Ok(format!("已写入 {}，并已自动备份旧文件", path.display()))
}
#[tauri::command]
fn restore_codex_backup() -> Result<String, String> { let path = codex_config_path()?; let dir = path.parent().ok_or("Invalid codex path")?; let mut backups: Vec<_> = fs::read_dir(dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with("config.toml.bak.")).collect(); backups.sort_by_key(|e| e.file_name()); let latest = backups.pop().ok_or("没有找到备份")?; fs::copy(latest.path(), &path).map_err(|e| e.to_string())?; Ok(format!("已恢复 {}", latest.path().display())) }
#[tauri::command]
fn install_launch_agent() -> Result<String, String> { Ok("DMG 版建议使用系统登录项启动 App。本最小实现已内置代理管理；后续可接入 macOS Login Item/LaunchAgent。".into()) }

async fn health(State(data): State<ProxyData>) -> Json<Value> { let c = data.config.lock().unwrap().clone(); Json(json!({"ok": true, "provider": "deepseek", "thinking": c.thinking})) }
async fn models() -> Json<Value> { Json(json!({"object":"list","data":[{"id":"deepseek-v4-pro","object":"model"},{"id":"deepseek-v4-flash","object":"model"}]})) }
fn usage(u: &Value) -> Value { let i = u.get("prompt_tokens").and_then(Value::as_i64).unwrap_or(0); let o = u.get("completion_tokens").and_then(Value::as_i64).unwrap_or(0); json!({"input_tokens":i,"input_tokens_details":{"cached_tokens":0},"output_tokens":o,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":u.get("total_tokens").and_then(Value::as_i64).unwrap_or(i+o)}) }
fn response_shell(id: &str, model: &str, status: &str) -> Value { json!({"id":id,"object":"response","created_at":chrono::Utc::now().timestamp(),"status":status,"model":model,"output":[],"usage":usage(&json!({}))}) }
fn input_messages(input: &Value) -> Vec<Value> { if let Some(s) = input.as_str() { return vec![json!({"role":"user","content":s})]; } input.as_array().unwrap_or(&vec![]).iter().filter_map(|x| { if x.get("type") == Some(&json!("function_call_output")) { Some(json!({"role":"tool","tool_call_id":x.get("call_id").or_else(||x.get("tool_call_id")).cloned().unwrap_or(json!("")),"content":x.get("output").cloned().unwrap_or(json!(""))})) } else { let role = x.get("role")?.as_str()?; let content = x.get("content").map(text_content).unwrap_or_default(); Some(json!({"role":role,"content":content})) } }).collect() }
fn text_content(v: &Value) -> String { if let Some(s) = v.as_str() { return s.into(); } v.as_array().map(|a| a.iter().filter_map(|p| p.get("text").or_else(||p.get("content")).and_then(Value::as_str)).collect::<Vec<_>>().join("")).unwrap_or_default() }
fn tools(v: Option<&Value>) -> Option<Value> { let arr = v?.as_array()?; Some(Value::Array(arr.iter().filter_map(|t| { if t.get("function").is_some() { Some(t.clone()) } else { Some(json!({"type":"function","function":{"name":t.get("name")?.as_str()?,"description":t.get("description").and_then(Value::as_str).unwrap_or(""),"parameters":t.get("parameters").or_else(||t.get("input_schema")).cloned().unwrap_or(json!({"type":"object","properties":{}}))}})) } }).collect())) }

async fn responses(State(data): State<ProxyData>, Json(body): Json<Value>) -> impl IntoResponse {
    let cfg = data.config.lock().unwrap().clone(); let api_key = cfg.api_key.unwrap_or_default(); if api_key.is_empty() { return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":{"message":"missing api key"}}))).into_response(); }
    let id = format!("resp_{}", chrono::Utc::now().timestamp_micros()); let model = body.get("model").and_then(Value::as_str).unwrap_or(&cfg.model).to_string();
    let mut messages = if let Some(prev) = body.get("previous_response_id").and_then(Value::as_str).and_then(|p| data.histories.lock().unwrap().get(p).cloned()) { prev } else { vec![] };
    if let Some(ins) = body.get("instructions").and_then(Value::as_str) { messages.push(json!({"role":"system","content":ins})); }
    messages.extend(input_messages(body.get("input").unwrap_or(&json!(""))));
    let mut req = json!({"model":model,"messages":messages,"stream":true,"thinking":{"type":cfg.thinking}});
    if cfg.thinking != "disabled" { req["reasoning_effort"] = json!(cfg.reasoning_effort); }
    if let Some(t) = tools(body.get("tools")) { req["tools"] = t; }
    if let Some(tc) = body.get("tool_choice") { req["tool_choice"] = tc.clone(); }
    let client = reqwest::Client::new(); let upstream = client.post("https://api.deepseek.com/chat/completions").bearer_auth(api_key).json(&req).send().await;
    let Ok(resp) = upstream else { return (StatusCode::BAD_GATEWAY, Json(json!({"error":{"message":"upstream error"}}))).into_response(); };
    if !resp.status().is_success() { let txt = resp.text().await.unwrap_or_default(); return (StatusCode::BAD_GATEWAY, Json(json!({"error":{"message":txt}}))).into_response(); }
    let stream = async_stream::stream! { yield Ok::<Event, std::convert::Infallible>(Event::default().event("response.created").data(json!({"type":"response.created","response":response_shell(&id,&model,"in_progress")}).to_string())); yield Ok(Event::default().event("response.completed").data(json!({"type":"response.completed","response":response_shell(&id,&model,"completed")}).to_string())); };
    Sse::new(stream).into_response()
}

pub fn run() {
    tauri::Builder::default().manage(AppState { config: Arc::new(Mutex::new(load_config())), server_stop: Arc::new(Mutex::new(None)) }).invoke_handler(tauri::generate_handler![get_config, save_config, get_status, start_proxy, stop_proxy, test_connection, configure_codex, restore_codex_backup, install_launch_agent]).run(tauri::generate_context!()).expect("error while running tauri application");
}
