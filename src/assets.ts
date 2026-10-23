/** Inline static assets, served by the Worker itself (no extra bindings). */

export const APP_JS = `(function () {
  'use strict';

  var msg = document.getElementById('msg');
  var nextInput = document.getElementById('next');
  var busy = false;

  function setMsg(text, kind) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function safeNext(value) {
    if (typeof value !== 'string') return '/';
    if (value.charAt(0) !== '/') return '/';
    if (value.charAt(1) === '/' || value.charAt(1) === '\\\\') return '/';
    return value;
  }

  function reset() {
    busy = false;
    if (window.turnstile && typeof window.turnstile.reset === 'function') {
      window.turnstile.reset();
    }
  }

  function submit(token) {
    if (busy) return;
    busy = true;
    setMsg('正在验证…', 'wait');

    fetch('/api/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        token: token,
        next: safeNext(nextInput ? nextInput.value : '/')
      })
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () { return {}; })
          .then(function (data) {
            if (response.ok && data && data.ok) {
              setMsg('验证通过，正在跳转…', 'ok');
              window.location.replace(safeNext(data.next));
              return;
            }
            if (response.status === 429) {
              setMsg('请求过于频繁，请稍后再试。', 'err');
            } else if (response.status === 500) {
              setMsg('服务端配置不完整，请联系站点管理员。', 'err');
            } else {
              setMsg('验证未通过，请重新验证。', 'err');
            }
            reset();
          });
      })
      .catch(function () {
        setMsg('网络错误，请重试。', 'err');
        reset();
      });
  }

  window.onTurnstileOk = submit;
  window.onTurnstileError = function () {
    setMsg('验证组件加载失败，请检查网络后刷新页面。', 'err');
  };
  window.onTurnstileExpired = function () {
    setMsg('验证已过期，请重新验证。', 'warn');
  };
})();
`;

export const STYLE_CSS = `:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --text: #16181d;
  --muted: #626977;
  --line: #e3e6eb;
  --accent: #2f6df6;
  --ok: #157f4a;
  --err: #c02b2b;
  --warn: #9a6700;
  --radius: 14px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --panel: #161a21;
    --text: #e9edf4;
    --muted: #99a2b3;
    --line: #262c37;
    --accent: #6d9bff;
    --ok: #57d19a;
    --err: #ff8080;
    --warn: #f0c464;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", Roboto, sans-serif;
}

.card {
  width: 100%;
  max-width: 420px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 28px;
  text-align: center;
}

.wrap {
  width: 100%;
  max-width: 760px;
  align-self: flex-start;
  margin-top: 32px;
}

h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0 0 4px; }
p { margin: 0 0 16px; color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }

.turnstile-slot { display: flex; justify-content: center; min-height: 66px; margin: 8px 0 4px; }

.msg { min-height: 22px; margin: 10px 0 0; font-size: 13px; color: var(--muted); }
.msg.ok { color: var(--ok); }
.msg.err { color: var(--err); }
.msg.warn { color: var(--warn); }
.msg.wait { color: var(--muted); }

.hint { font-size: 12px; color: var(--muted); margin-top: 18px; }

.repo {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 20px;
  margin-bottom: 14px;
}

.meta { font-size: 13px; color: var(--muted); margin: 0 0 14px; }
.meta .tag {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 1px 6px;
  color: var(--text);
}

ul.assets { list-style: none; margin: 0; padding: 0; }
ul.assets li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-top: 1px solid var(--line);
}
ul.assets li:first-child { border-top: none; }

a.download {
  flex: 1;
  min-width: 0;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a.download:hover { text-decoration: underline; }

.size { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
a.button {
  display: inline-block;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 13px;
  color: var(--text);
  text-decoration: none;
  background: var(--bg);
}
a.button:hover { border-color: var(--accent); color: var(--accent); }

.empty { color: var(--muted); font-size: 14px; margin: 4px 0 0; }
.notice {
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 14px;
  background: var(--bg);
}
`;
