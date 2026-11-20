import * as vscode from 'vscode';

interface Msg { type: string; [k: string]: unknown }

export class HunkGuardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private messageHandler?: (msg: Msg) => void;

  constructor(private extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'hunkguard', 'HunkGuard', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m: Msg) => this.messageHandler?.(m), null, this.disposables);
  }

  onMessage(h: (msg: Msg) => void) { this.messageHandler = h; }
  reveal() { this.panel.reveal(vscode.ViewColumn.Beside); }

  post(msg: Msg) {
    void this.panel.webview.postMessage(msg);
  }

  dispose() { this.panel.dispose(); this.disposables.forEach(d => d.dispose()); }

  private html(): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);margin:0;display:flex;flex-direction:column;height:100vh}
      #log{flex:1;overflow-y:auto;padding:8px}
      .msg{margin:6px 0;padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
      .user{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
      .assistant{background:var(--vscode-textBlockQuote-background)}
      .tool{background:var(--vscode-editor-inactiveSelectionBackground);opacity:.9;font-family:var(--vscode-editor-font-family);font-size:11.5px}
      .err{background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder)}
      .info{opacity:.75}
      .hunk{border:1px solid var(--vscode-panel-border);border-radius:6px;margin:8px 0;padding:6px}
      .hunk .hd{display:flex;justify-content:space-between;align-items:center;font-family:var(--vscode-editor-font-family);font-size:11px}
      .hunk pre{font-family:var(--vscode-editor-font-family);font-size:11px;overflow-x:auto;max-height:220px;overflow-y:auto;margin:4px 0}
      .add{color:#4ec9b0}.del{color:#f48771}.ctx{color:var(--vscode-editor-foreground);opacity:.6}
      button{cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;padding:4px 10px;font-size:11.5px;margin-right:4px}
      button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
      button.danger{background:var(--vscode-inputValidation-errorBackground)}
      #input{display:flex;gap:6px;padding:8px;border-top:1px solid var(--vscode-panel-border)}
      textarea{flex:1;resize:none;height:44px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:6px;font-family:inherit}
      #bar{display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);align-items:center;font-size:11.5px}
      .pill{padding:2px 8px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:10.5px}
      .ctx-card{font-size:11px;opacity:.8;padding:4px 8px}
    </style></head><body>
      <div id="bar"><span id="status" class="pill">idle</span><span id="model" class="pill"></span><span style="flex:1"></span>
        <button onclick="send('newSession')">New session</button><button class="danger" onclick="send('stop')">Stop</button></div>
      <div id="log"></div>
      <div id="input"><textarea id="ta" placeholder="Ask the agent... (e.g. add flask config CLI command)"></textarea>
        <button class="primary" onclick="submit()">Send</button></div>
    <script>
      const vscode = acquireVsCodeApi();
      const log = document.getElementById('log');
      const ta = document.getElementById('ta');
      const statusEl = document.getElementById('status');
      const modelEl = document.getElementById('model');
      const hunks = new Map();
      let running = false;
      function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
      function add(cls, html){const d=document.createElement('div');d.className='msg '+cls;d.innerHTML=html;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
      function send(type, extra){vscode.postMessage(Object.assign({type},extra||{}))}
      function submit(){const t=ta.value.trim();if(!t)return;ta.value='';add('user',esc(t));send('prompt',{text:t})}
      ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit()}});
      function renderHunks(){
        document.querySelectorAll('.hunk').forEach(e=>e.remove());
        document.querySelectorAll('.hunkbar').forEach(e=>e.remove());
        const list=[...hunks.values()].filter(h=>h.status==='pending'||h.status==='stale');
        if(!list.length)return;
        const bar=document.createElement('div');bar.className='hunkbar msg info';
        bar.innerHTML='<b>'+list.length+' pending hunk(s)</b> <button class="primary" onclick="vscode.postMessage({type:\\'acceptAll\\'})">Accept all</button><button onclick="vscode.postMessage({type:\\'rejectAll\\'})">Reject all</button><button onclick="vscode.postMessage({type:\\'undo\\'})">Undo last</button>';
        log.appendChild(bar);
        for(const h of list){
          const d=document.createElement('div');d.className='hunk';
          const lines=h.preview.split('\\n').map(l=>{
            const c=l[0];const cls=c==='+'?'add':c==='-'?'del':'ctx';
            return '<span class="'+cls+'">'+esc(l)+'</span>';
          }).join('\\n');
          d.innerHTML='<div class="hd"><span>'+esc(h.filePath)+' · '+esc(h.header)+(h.status==='stale'?' · STALE':'')+'</span>'+
            '<span><button class="primary" onclick="send(\\'hunkAccept\\',{ids:[\\''+h.id+'\\']})">Accept</button>'+
            '<button onclick="send(\\'hunkReject\\',{ids:[\\''+h.id+'\\']})">Reject</button></span></div><pre>'+lines+'</pre>';
          log.appendChild(d);
        }
        log.scrollTop=log.scrollHeight;
      }
      window.addEventListener('message',e=>{
        const m=e.data;
        switch(m.type){
          case 'assistant': add('assistant',esc(m.text));break;
          case 'user': break;
          case 'toolCall': add('tool','🔧 <b>'+esc(m.name)+'</b> '+esc(m.args||''));break;
          case 'toolResult': add('tool','↳ '+esc((m.text||'').slice(0,800)));break;
          case 'event': break;
          case 'proposal':{
            (m.hunks||[]).forEach(h=>hunks.set(h.id,{...h,filePath:m.filePath}));
            add('info','📋 Proposal on <b>'+esc(m.filePath)+'</b> — '+m.hunks.length+' hunk(s) pending review');
            renderHunks();break;
          }
          case 'hunks':{
            hunks.clear();
            (m.hunks||[]).forEach(h=>hunks.set(h.id,h));
            renderHunks();break;
          }
          case 'approval':{
            const d=add('tool','⚠ Approval required: <b>'+esc(m.name)+'</b> '+
              '<button class="primary" onclick="send(\\'approve\\',{threadId:\\''+esc(m.threadId)+'\\',toolCallId:\\''+esc(m.toolCallId)+'\\'})">Allow</button>'+
              '<button class="danger" onclick="send(\\'deny\\',{threadId:\\''+esc(m.threadId)+'\\',toolCallId:\\''+esc(m.toolCallId)+'\\'})">Deny</button>');
            break;
          }
          case 'context':{
            const d=document.createElement('div');d.className='ctx-card';
            d.textContent='Context: '+m.files.map(f=>f.path+' ('+f.reason+')').join(', ')+' ~'+m.tokens+' tok'+(m.lowEnd?' · LOW-END':'');
            log.appendChild(d);break;
          }
          case 'session': modelEl.textContent=m.model;break;
          case 'turnStart': statusEl.textContent='running';running=true;break;
          case 'turnEnd': case 'done': case 'stopped': statusEl.textContent='idle';running=false;break;
          case 'modelFail': add('err','⚠ Model failed: '+esc(m.model)+' — '+esc(m.error));break;
          case 'error': add('err','✖ '+esc(m.message));break;
          case 'info': add('info','ℹ '+esc(m.message));break;
        }
      });
    </script></body></html>`;
  }
}
