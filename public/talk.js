/* Eagle I talk: a spoken conversation with an assistant, using the browser's own
   voice-to-text and text-to-voice. Used by the homeowner project page, the sub
   page and Eagle I Marketing (the CRM has the same thing built into crm.html).

   EagleTalk.mount(host, {
     ask(text) -> Promise<string>      sends what was said, shows it in the chat, resolves with the reply
     lang() -> 'en' | 'es'
     words: optional labels (Spanish pages pass their own)
   }) → { start(), stop() }
   EagleTalk.choose({ title, talk, type, note, onPick(mode) })  the one-time Talk or Type question.

   Tap once: it listens, sends what you said when you stop, reads the answer aloud in
   short sentences and listens again, like a phone call. Tap while it talks to cut in;
   “that’s all” or two quiet turns end it. */
(function () {
  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const can = () => !!SR() && 'speechSynthesis' in window;
  const WORDS = {
    en: { tap: 'Tap to talk', listening: 'Listening… tap when you’re done', thinking: 'Thinking…', speaking: 'Speaking… tap to cut in', end: 'End conversation', bye: 'Okay. Talk soon.', sorry: 'Sorry, I didn’t catch that.', mic: 'Allow the microphone for this site in your browser settings, then tap to talk.' },
    es: { tap: 'Toque para hablar', listening: 'Escuchando… toque cuando termine', thinking: 'Pensando…', speaking: 'Hablando… toque para interrumpir', end: 'Terminar', bye: 'Muy bien. Hasta pronto.', sorry: 'Perdón, no le entendí.', mic: 'Permita el micrófono para este sitio en su navegador y toque para hablar.' }
  };
  const BYE = /^(that's all|that is all|that's it|goodbye|bye|i'm done|im done|stop|nothing else|no thanks|eso es todo|adiós|adios|nada más|nada mas)\b/i;
  const tag = (l) => (l === 'es' ? 'es-US' : 'en-US');

  // What a person would say: no symbols, lists or links.
  function plain(t) {
    return String(t || '').replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_#`>|~]/g, '')
      .replace(/^\s*[-•]\s+/gm, '').replace(/\n{2,}/g, '. ').replace(/\n/g, ', ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
      .replace(/\s+([.,!?])/g, '$1').replace(/\.\s*\./g, '.').replace(/:\s*,/g, ':').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
  }
  // The most natural voice this device has.
  function voiceFor(lang) {
    const vs = speechSynthesis.getVoices().filter(v => v.lang && v.lang.replace('_', '-').toLowerCase().startsWith(lang));
    const rank = v => (/natural|neural|premium|enhanced/i.test(v.name) ? 0 : /(Samantha|Ava|Allison|Aria|Jenny|Google US English|Google español|Zoe|Nicky|Paulina|Monica)/i.test(v.name) ? 1 : v.localService ? 2 : 3);
    return vs.sort((a, b) => rank(a) - rank(b))[0] || null;
  }

  // The natural voice (routes/tts.js, Google's): used while this month's free allowance
  // lasts. When the server says it's used up (or anything goes wrong, or the phone won't
  // play it), the browser's own voice says it instead, for the rest of the visit.
  const cloud = (() => {
    let A = null, off = false, stopFn = null, silent = null;
    const el = () => { if (!A) { A = new Audio(); A.preload = 'auto'; } return A; };
    // A moment of silence, played from a tap, so the phone lets later answers play.
    const quiet = () => {
      if (silent) return silent;
      const b = new ArrayBuffer(46), v = new DataView(b), w = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 38, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, 2, true); v.setInt16(44, 0, true);
      return (silent = URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
    };
    function unlock() { if (off) return; try { const a = el(); a.src = quiet(); const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    // How loud the answer is, 50 times a second, so the host's mouth can follow it. Measured
    // from a copy of the sound; the sound itself plays as usual (never routed through this).
    let dec = null, env = null;
    async function loudness(blob) {
      try {
        if (!dec) dec = new (window.AudioContext || window.webkitAudioContext)();
        const raw = await blob.arrayBuffer();
        const buf = await new Promise((ok, no) => { const p = dec.decodeAudioData(raw, ok, no); if (p && p.then) p.then(ok, no); });
        const d = buf.getChannelData(0), step = Math.max(1, Math.floor(buf.sampleRate / 50)), out = [];
        for (let i = 0; i < d.length; i += step) { let s = 0, n = 0; for (let j = i; j < Math.min(d.length, i + step); j += 4) { s += d[j] * d[j]; n++; } out.push(Math.sqrt(s / Math.max(1, n))); }
        const top = out.slice().sort((a, b) => a - b)[Math.floor(out.length * .9)] || 1;
        return out.map(v => Math.min(1, v / top));
      } catch (e) { return null; }
    }
    async function fetchOne(text, lang, rate) {
      try {
        const r = await fetch('/api/tts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang, rate, page: location.pathname }) });
        if (r.status !== 200) { if (r.status === 204 && ['limit', 'off'].includes(r.headers.get('X-Voice-Fallback'))) off = true; return null; }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob); urlEnv.set(url, await loudness(blob));
        return url;
      } catch (e) { return null; }
    }
    const urlEnv = new Map();
    const play = (url) => new Promise(res => {
      const a = el(); const done = (ok) => { stopFn = null; env = null; a.onended = a.onerror = null; try { URL.revokeObjectURL(url); } catch (e) {} res(ok); };
      stopFn = () => { try { a.pause(); } catch (e) {} done(true); };
      a.onended = () => done(true); a.onerror = () => done(false);
      env = urlEnv.get(url) || null; urlEnv.delete(url);
      a.src = url; const p = a.play(); if (p && p.catch) p.catch(() => done(false));
    });
    // true: said (or cut off); false: not said, so use the browser's voice.
    async function say(text, { lang = 'en', rate = 0.9, alive = () => true } = {}) {
      if (off || !text) return false;
      const chunks = []; let cur = '';
      for (const t of (text.match(/[^.!?]+[.!?]*/g) || [text])) { if (cur && (cur + t).length > 900) { chunks.push(cur); cur = ''; } cur += t; }
      if (cur.trim()) chunks.push(cur.trim());
      let pending = fetchOne(chunks[0], lang, rate);
      for (let i = 0; i < chunks.length; i++) {
        const url = await pending;
        if (!url) return i > 0;
        if (i + 1 < chunks.length) pending = fetchOne(chunks[i + 1], lang, rate);
        if (!alive()) { try { URL.revokeObjectURL(url); } catch (e) {} return true; }
        if (!(await play(url))) return i > 0;
        if (!alive()) return true;
      }
      return true;
    }
    function stop() { if (stopFn) stopFn(); else if (A) { try { A.pause(); } catch (e) {} } }
    // How loud the natural voice is right now (0 to 1), or -1 when it isn't the one speaking.
    function level() { if (!A || A.paused || !env) return -1; return env[Math.floor(A.currentTime * 50)] || 0; }
    return { say, stop, unlock, level, get off() { return off; } };
  })();

  // The host: Eagle I's lion in a suit, above the talk button. His mouth opens on the loud
  // part of each word of the natural voice (or, with the device's own voice, in a talking
  // rhythm); he leans in to listen, tilts his head to think, and the frame glows while he
  // speaks. Anyone can hide him (remembered on this device).
  const HOST_KEY = 'eaglei_host';
  function lionHost(where) {
    style();
    const box = document.createElement('div'); box.className = 'et-hostbox';
    box.innerHTML = `<div class="et-host" data-state="idle"><div class="et-him"><img class="et-base" src="/host/closed.jpg" alt="Eagle I's host, a lion in a suit" width="800" height="800"><img class="et-mouth" src="/host/mouth.png" alt=""></div><div class="et-ring"></div><div class="et-ring b"></div><div class="et-dots" aria-hidden="true"><i></i><i></i><i></i></div><button type="button" class="et-hide" aria-label="Hide the lion">✕</button></div><button type="button" class="et-show" hidden>🦁 Show the lion</button>`;
    where.prepend(box);
    const card = box.querySelector('.et-host'), mouth = box.querySelector('.et-mouth'), show = box.querySelector('.et-show');
    const hidden = () => { try { return localStorage.getItem(HOST_KEY) === 'off'; } catch (e) { return false; } };
    const apply = () => { const h = hidden(); card.hidden = h; show.hidden = !h; };
    box.querySelector('.et-hide').onclick = () => { try { localStorage.setItem(HOST_KEY, 'off'); } catch (e) {} apply(); };
    show.onclick = () => { try { localStorage.removeItem(HOST_KEY); } catch (e) {} apply(); };
    apply();
    let state = 'idle', open = false, flip = 0;
    const tick = () => {
      if (!box.isConnected) return;
      let o = false;
      if (state === 'speaking') {
        const lv = cloud.level();
        if (lv >= 0) o = open ? lv > .22 : lv > .42;
        else { const now = performance.now(); if (now > flip) { open = !open; flip = now + (open ? 90 + Math.random() * 120 : 70 + Math.random() * 130); } o = open; }
      }
      open = o; mouth.style.opacity = o ? '1' : '0';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return { set(s) { state = s === 'speaking' || s === 'listening' || s === 'thinking' ? s : 'idle'; card.dataset.state = state; }, el: box };
  }
  const hush = () => { cloud.stop(); try { speechSynthesis.cancel(); } catch (e) {} };

  let styled = false;
  function style() {
    if (styled) return; styled = true;
    const css = document.createElement('style');
    css.textContent = `.et-talk{display:flex;flex-direction:column;align-items:center;gap:8px;padding:10px 8px 6px}
.et-live{min-height:24px;font-size:18px;text-align:center;font-style:italic;max-width:560px}
.et-btn{width:88px;height:88px;border-radius:50%;border:0;cursor:pointer;display:grid;place-items:center;font-size:36px;color:#fff;background:linear-gradient(135deg,#1b4fd8,#3b6cf0);box-shadow:0 10px 24px -8px rgba(27,79,216,.7)}
.et-btn.listening{background:linear-gradient(135deg,#c9a24a,#e2c178);animation:etPulse 1.4s infinite}
.et-btn.speaking{background:linear-gradient(135deg,#14161c,#2c313d)}
.et-btn.thinking{opacity:.8}
@keyframes etPulse{0%{box-shadow:0 0 0 0 rgba(201,162,74,.55)}70%{box-shadow:0 0 0 18px rgba(201,162,74,0)}100%{box-shadow:0 0 0 0 rgba(201,162,74,0)}}
.et-status{font-weight:800;font-size:18px}
.et-end{font:inherit;font-size:16px;font-weight:700;border:1px solid #aab4c3;background:#fff;color:#0b1220;border-radius:10px;padding:8px 14px;min-height:42px;cursor:pointer}
.et-end[hidden]{display:none}
.et-shade{position:fixed;inset:0;background:rgba(11,18,32,.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px}
.et-box{background:#fff;color:#0b1220;border-radius:16px;max-width:560px;width:100%;padding:22px 18px;box-shadow:0 30px 60px -18px rgba(11,18,32,.45);font-family:inherit}
.et-box h2{font-size:23px;margin:0 0 4px}.et-box p{color:#36435a;margin:0 0 12px;font-size:17px}
.et-opts{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.et-opt{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;padding:18px 12px;border:2px solid #cdd4df;border-radius:14px;background:#fff;cursor:pointer;font:inherit;color:#0b1220}
.et-opt:hover:not(:disabled){border-color:#1b4fd8}.et-opt:disabled{opacity:.6;cursor:not-allowed}
.et-opt .i{font-size:40px}.et-opt b{font-size:21px}.et-opt span:not(.i){font-size:16px;color:#36435a}.et-opt em{font-size:14px;color:#c01b1b}
.et-tour,.et-shade{font-family:'Inter','Nunito Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
.et-tour{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:2100;width:min(520px,calc(100% - 24px));background:#14161c;color:#fff;border:2px solid #c9a24a;border-radius:16px;padding:14px 16px;box-shadow:0 20px 40px -12px rgba(0,0,0,.55)}
.et-tour.top{bottom:auto;top:calc(12px + env(safe-area-inset-top))}
.et-tour-h{display:flex;justify-content:space-between;font-weight:800;font-size:15px;color:#e2c178;letter-spacing:.02em}
.et-tour-t{font-size:19px;line-height:1.45;margin:8px 0 12px;min-height:56px}
.et-tour-b{display:flex;justify-content:space-between;gap:10px}
.et-tour-b button{font:inherit;font-weight:800;font-size:16.5px;border-radius:10px;padding:9px 16px;min-height:44px;cursor:pointer;border:0}
.et-tour-skip{background:transparent;color:#c9cfdb;border:1px solid #3a4150!important}
.et-tour-next{background:#c9a24a;color:#14161c}
.et-lit{outline:4px solid #c9a24a!important;outline-offset:4px;border-radius:12px;animation:etGlow 1.2s ease-in-out infinite}
@keyframes etGlow{50%{outline-color:#e2c178}}
.et-again{font:inherit;font-size:15px;background:none;border:0;color:inherit;opacity:.75;text-decoration:underline;cursor:pointer;padding:4px}
.et-toggle{font:inherit;font-size:15.5px;font-weight:700;border:1px solid #aab4c3;background:#fff;color:#0b1220;border-radius:999px;padding:6px 12px;min-height:38px;cursor:pointer;white-space:nowrap}
@media (max-width:520px){.et-opts{grid-template-columns:1fr}}
.et-hostbox{display:flex;flex-direction:column;align-items:center;width:100%}
.et-host{position:relative;width:min(220px,62vw);aspect-ratio:1;border-radius:18px;background:#000;border:2px solid rgba(201,162,74,.6);box-shadow:0 18px 36px -18px rgba(0,0,0,.6);transition:box-shadow .3s;margin:2px 0 6px}
.et-host[hidden]{display:none}
.et-him{position:absolute;inset:0;overflow:hidden;border-radius:16px;transform-origin:50% 92%;transition:transform .45s ease}
.et-him img{position:absolute;display:block;-webkit-user-drag:none;user-select:none}
.et-base{inset:0;width:100%;height:100%}
.et-mouth{left:37.48%;top:39.075%;width:25.518%;height:34.29%;opacity:0;transition:opacity 70ms linear}
.et-host[data-state="speaking"]{box-shadow:0 0 0 2px rgba(231,201,131,.55),0 0 34px 4px rgba(231,201,131,.35),0 18px 36px -18px rgba(0,0,0,.6)}
.et-host[data-state="speaking"] .et-him{animation:etBob 2.6s ease-in-out infinite}
@keyframes etBob{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-2px) rotate(.6deg)}}
.et-host[data-state="listening"] .et-him{transform:scale(1.04)}
.et-host[data-state="thinking"] .et-him{transform:rotate(-2deg) translateY(-2px)}
.et-ring{position:absolute;inset:0;border-radius:18px;border:3px solid #e7c983;opacity:0;pointer-events:none}
.et-host[data-state="listening"] .et-ring{animation:etRing 1.8s ease-out infinite}
.et-host[data-state="listening"] .et-ring.b{animation-delay:.9s}
@keyframes etRing{0%{opacity:.8;inset:0}100%{opacity:0;inset:-14px}}
.et-dots{position:absolute;top:10px;right:12px;display:flex;gap:5px;opacity:0;transition:opacity .3s}
.et-host[data-state="thinking"] .et-dots{opacity:1}
.et-dots i{width:9px;height:9px;border-radius:50%;background:#e7c983;animation:etDot 1.2s infinite}
.et-dots i:nth-child(2){animation-delay:.2s}.et-dots i:nth-child(3){animation-delay:.4s}
@keyframes etDot{0%,100%{opacity:.25}50%{opacity:1}}
.et-hide{position:absolute;top:6px;left:6px;width:34px;height:34px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#e7c983;font-size:15px;cursor:pointer;opacity:.75}
.et-hide:hover,.et-hide:focus-visible{opacity:1}
.et-show{border:0;background:none;color:inherit;font:inherit;font-size:15px;font-weight:700;text-decoration:underline;cursor:pointer;opacity:.8;margin:2px 0 6px}
@media (max-height:700px){.et-host{width:min(170px,48vw)}}
@media (prefers-reduced-motion:reduce){.et-host .et-him,.et-ring,.et-dots i{animation:none!important}.et-him{transition:none}}`;
    document.head.appendChild(css);
  }

  function choose({ title, sub, talk, type, note, noMic, onPick }) {
    style();
    const ok = can();
    const shade = document.createElement('div'); shade.className = 'et-shade';
    shade.innerHTML = `<div class="et-box" role="dialog" aria-modal="true" aria-label="${title}"><h2>${title}</h2><p>${sub}</p>
      <div class="et-opts"><button class="et-opt" data-m="talk" ${ok ? '' : 'disabled'}><span class="i">🎙</span><b>${talk[0]}</b><span>${talk[1]}</span>${ok ? '' : `<em>${noMic}</em>`}</button>
      <button class="et-opt" data-m="text"><span class="i">⌨️</span><b>${type[0]}</b><span>${type[1]}</span></button></div>
      ${note ? `<p style="margin:12px 0 0;font-size:15px">${note}</p>` : ''}</div>`;
    shade.querySelectorAll('.et-opt').forEach(b => b.onclick = () => { shade.remove(); onPick(b.dataset.m); });
    // On <html>: a page whose <body> has a CSS filter would pin it to the page, not the screen.
    document.documentElement.appendChild(shade);
  }

  function mount(host, o) {
    style();
    const W = () => Object.assign({}, WORDS[o.lang() === 'es' ? 'es' : 'en'], (o.words || {})[o.lang()] || {});
    host.innerHTML = '<div class="et-talk"><div class="et-live" aria-live="polite"></div><button class="et-btn" type="button"><span aria-hidden="true">🎙</span></button><div class="et-status"></div><button class="et-end" type="button" hidden></button><button class="et-again" type="button"></button></div>';
    const live = host.querySelector('.et-live'), btn = host.querySelector('.et-btn'), st = host.querySelector('.et-status'), end = host.querySelector('.et-end');
    const S = { on: false, state: 'idle', rec: null, voice: null, quiet: 0, cut: false };
    const lion = o.host === false ? null : lionHost(host.querySelector('.et-talk'));
    if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { S.voice = null; });
    const status = (state, text) => {
      S.state = state; btn.className = 'et-btn ' + state; st.textContent = text; end.hidden = !S.on; end.textContent = W().end;
      if (lion) lion.set(state);
      btn.firstChild.textContent = state === 'speaking' ? '🔊' : state === 'thinking' ? '…' : '🎙';
      btn.setAttribute('aria-label', state === 'listening' ? 'Done' : state === 'speaking' ? 'Cut in' : W().tap);
    };
    const speak = (text) => new Promise(res => {
      const p = plain(text); if (!p || !S.on) return res();
      S.cut = false; if (!S.voice) S.voice = voiceFor(o.lang());
      status('speaking', W().speaking);
      // The natural voice first; the browser's own if it can't.
      cloud.say(p, { lang: o.lang(), rate: RATE, alive: () => S.on && !S.cut }).then(said => {
        if (said || !S.on || S.cut) return res();
        const parts = p.match(/[^.!?]+[.!?]*/g) || [p]; let i = 0;
        const next = () => { if (!S.on || S.cut || i >= parts.length) return res(); const u = new SpeechSynthesisUtterance(parts[i++].trim()); u.lang = tag(o.lang()); if (S.voice) u.voice = S.voice; u.rate = RATE; u.pitch = 1; u.onend = next; u.onerror = () => res(); speechSynthesis.speak(u); };
        next();
      });
    });
    const listen = () => new Promise(res => {
      let fin = '', mid = ''; const r = S.rec = new (SR())(); r.lang = tag(o.lang()); r.interimResults = true; r.continuous = false;
      live.textContent = '';
      r.onresult = e => { mid = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t + ' '; else mid += t; } live.textContent = (fin + mid).trim(); };
      r.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { S.on = false; live.textContent = W().mic; } };
      r.onend = () => { S.rec = null; res((fin || mid).trim()); };
      status('listening', W().listening);
      try { r.start(); } catch (e) { S.rec = null; res(''); }
    });
    async function loop() {
      while (S.on) {
        const said = await listen();
        if (!S.on) break;
        if (!said) { if (++S.quiet >= 2) { stop(); break; } continue; }
        S.quiet = 0; live.textContent = '';
        if (BYE.test(said) && said.split(/\s+/).length <= 4) { await speak(W().bye); stop(); break; }
        status('thinking', W().thinking);
        let reply = null;
        try { reply = await o.ask(said); } catch (e) { reply = null; }
        if (!S.on) break;
        await speak(reply || W().sorry);
      }
    }
    function start() {
      // A tap is what lets a phone speak, so wake the voice here.
      try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) {}
      cloud.unlock();
      S.on = true; S.quiet = 0; loop();
    }
    function stop() {
      S.on = false; try { if (S.rec) S.rec.abort(); } catch (e) {} S.rec = null;
      hush(); status('idle', W().tap);
    }
    btn.onclick = () => {
      if (S.state === 'speaking') { S.cut = true; hush(); return; }
      if (S.state === 'listening') { if (S.rec) S.rec.stop(); return; }
      if (S.state === 'thinking') return;
      start();
    };
    end.onclick = stop;
    const again = host.querySelector('.et-again');
    const walk = () => { stop(); tour({ lang: o.lang(), steps: tourSteps({ lang: o.lang(), button: btn, toggle: o.toggle, confirm: o.confirm, who: o.who }) }); };
    again.onclick = walk;
    status('idle', W().tap);
    again.textContent = TOUR_WORDS[o.lang() === 'es' ? 'es' : 'en'].again;
    return { start, stop, walk, refresh: () => { if (!S.on) status('idle', W().tap); again.textContent = TOUR_WORDS[o.lang() === 'es' ? 'es' : 'en'].again; } };
  }

  // The spoken walk-through after someone picks Talk: Eagle I explains talking in its own
  // voice, a sentence on screen at a time, lighting up what it's talking about.
  // steps: [{ say, el }] (el: a CSS selector or element, optional). Must start from a tap.
  // Speaking speed: a little slower than the device default, easier to follow.
  const RATE = 0.9, TOUR_RATE = 0.85;
  const TOUR_WORDS = { en: { title: 'How talking works', skip: 'Skip', done: 'Got it', next: 'Next →', again: '▶ How talking works' }, es: { title: 'Cómo funciona hablar', skip: 'Saltar', done: 'Entendido', next: 'Siguiente →', again: '▶ Cómo funciona hablar' } };
  function tour({ lang = 'en', steps, onDone }) {
    style();
    if (!('speechSynthesis' in window) || !steps || !steps.length) { if (onDone) onDone(); return; }
    const W = TOUR_WORDS[lang === 'es' ? 'es' : 'en'];
    const card = document.createElement('div'); card.className = 'et-tour'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', W.title);
    card.innerHTML = `<div class="et-tour-h"><span>🔊 ${W.title}</span><span class="et-tour-n"></span></div><div class="et-tour-t" aria-live="polite"></div>
      <div class="et-tour-b"><button type="button" class="et-tour-skip">${W.skip}</button><button type="button" class="et-tour-next">${W.done}</button></div>`;
    document.documentElement.appendChild(card);
    let i = 0, over = false, lit = null, step = 0;
    cloud.unlock();
    const voice = voiceFor(lang === 'es' ? 'es' : 'en');
    const light = (sel) => {
      if (lit) lit.classList.remove('et-lit'); lit = null;
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (el && el.offsetParent !== null) { lit = el; el.classList.add('et-lit'); try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
      // Out of the way of what it's pointing at.
      const r = lit && lit.getBoundingClientRect();
      card.classList.toggle('top', !!r && r.top + r.height / 2 > innerHeight * 0.45);
    };
    const finish = () => { if (over) return; over = true; hush(); if (lit) lit.classList.remove('et-lit'); card.remove(); if (onDone) onDone(); };
    const next = () => {
      if (over) return;
      if (i >= steps.length) return finish();
      const st = steps[i++];
      card.querySelector('.et-tour-n').textContent = `${i} / ${steps.length}`;
      card.querySelector('.et-tour-t').textContent = st.say;
      card.querySelector('.et-tour-next').textContent = i >= steps.length ? W.done : W.next;
      light(st.el);
      // Says the step, then waits for the Next button (it never moves on by itself).
      hush();
      const mine = ++step;
      cloud.say(plain(st.say), { lang: lang === 'es' ? 'es' : 'en', rate: TOUR_RATE, alive: () => !over && step === mine }).then(said => {
        if (said || over || step !== mine) return;
        const u = new SpeechSynthesisUtterance(plain(st.say)); u.lang = tag(lang); if (voice) u.voice = voice; u.rate = TOUR_RATE; u.pitch = 1;
        try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
      });
    };
    card.querySelector('.et-tour-skip').onclick = finish;
    card.querySelector('.et-tour-next').onclick = () => { hush(); next(); };
    next();
    return { stop: finish };
  }
  // The usual walk-through. o: { lang, button, toggle, confirm (says yes/no for sending), who ('Eagle I') }
  function tourSteps(o) {
    const es = o.lang === 'es', who = o.who || 'Eagle I';
    return (es ? [
      { say: `Hola, soy ${who}. Eligió hablar, así que le explico cómo funciona.` },
      { say: 'Toque el botón grande y redondo y hable con naturalidad, como en una llamada. Cuando termine de hablar, le respondo en voz alta.', el: o.button },
      { say: 'Después vuelvo a escuchar, así que puede seguir la conversación sin tocar nada.', el: o.button },
      { say: 'Si estoy hablando y quiere interrumpir, toque el botón.', el: o.button },
      ...(o.confirm ? [{ say: 'Antes de enviar algo a alguien, siempre le pregunto. Solo diga sí o no.' }] : []),
      { say: 'Cuando termine, diga “eso es todo”. Y si prefiere escribir, toque este botón cuando quiera.', el: o.toggle },
      { say: 'Listo. Toque el botón cuando quiera empezar.', el: o.button }
    ] : [
      { say: `Hi, I'm ${who}. You picked talking, so here's how it works.` },
      { say: 'Tap the big round button and just talk, like you would on the phone. When you stop talking, I answer out loud.', el: o.button },
      { say: 'Then I listen again on my own, so you can keep the conversation going without touching anything.', el: o.button },
      { say: 'If I’m talking and you want to cut in, tap the button.', el: o.button },
      ...(o.confirm ? [{ say: 'Before I send anything to anyone, I always ask first. Just say yes or no.' }] : []),
      { say: 'When you’re finished, say “that’s all”. And if you’d rather type, tap this button any time.', el: o.toggle },
      { say: 'That’s it. Tap the button whenever you’re ready.', el: o.button }
    ]);
  }

  window.EagleTalk = { can, plain, mount, choose, style, tour, tourSteps, TOUR_WORDS, cloud, host: lionHost };
})();
