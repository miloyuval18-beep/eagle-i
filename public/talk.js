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
@media (max-width:520px){.et-opts{grid-template-columns:1fr}}`;
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
    if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { S.voice = null; });
    const status = (state, text) => {
      S.state = state; btn.className = 'et-btn ' + state; st.textContent = text; end.hidden = !S.on; end.textContent = W().end;
      btn.firstChild.textContent = state === 'speaking' ? '🔊' : state === 'thinking' ? '…' : '🎙';
      btn.setAttribute('aria-label', state === 'listening' ? 'Done' : state === 'speaking' ? 'Cut in' : W().tap);
    };
    const speak = (text) => new Promise(res => {
      const p = plain(text); if (!p || !S.on) return res();
      S.cut = false; if (!S.voice) S.voice = voiceFor(o.lang());
      const parts = p.match(/[^.!?]+[.!?]*/g) || [p]; let i = 0;
      status('speaking', W().speaking);
      const next = () => { if (!S.on || S.cut || i >= parts.length) return res(); const u = new SpeechSynthesisUtterance(parts[i++].trim()); u.lang = tag(o.lang()); if (S.voice) u.voice = S.voice; u.rate = RATE; u.pitch = 1; u.onend = next; u.onerror = () => res(); speechSynthesis.speak(u); };
      next();
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
      S.on = true; S.quiet = 0; loop();
    }
    function stop() {
      S.on = false; try { if (S.rec) S.rec.abort(); } catch (e) {} S.rec = null;
      try { speechSynthesis.cancel(); } catch (e) {} status('idle', W().tap);
    }
    btn.onclick = () => {
      if (S.state === 'speaking') { S.cut = true; speechSynthesis.cancel(); return; }
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
    let i = 0, over = false, lit = null;
    const voice = voiceFor(lang === 'es' ? 'es' : 'en');
    const light = (sel) => {
      if (lit) lit.classList.remove('et-lit'); lit = null;
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (el && el.offsetParent !== null) { lit = el; el.classList.add('et-lit'); try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
      // Out of the way of what it's pointing at.
      const r = lit && lit.getBoundingClientRect();
      card.classList.toggle('top', !!r && r.top + r.height / 2 > innerHeight * 0.45);
    };
    const finish = () => { if (over) return; over = true; try { speechSynthesis.cancel(); } catch (e) {} if (lit) lit.classList.remove('et-lit'); card.remove(); if (onDone) onDone(); };
    const next = () => {
      if (over) return;
      if (i >= steps.length) return finish();
      const st = steps[i++];
      card.querySelector('.et-tour-n').textContent = `${i} / ${steps.length}`;
      card.querySelector('.et-tour-t').textContent = st.say;
      card.querySelector('.et-tour-next').textContent = i >= steps.length ? W.done : W.next;
      light(st.el);
      // Says the step, then waits for the Next button (it never moves on by itself).
      const u = new SpeechSynthesisUtterance(plain(st.say)); u.lang = tag(lang); if (voice) u.voice = voice; u.rate = TOUR_RATE; u.pitch = 1;
      try { speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) {}
    };
    card.querySelector('.et-tour-skip').onclick = finish;
    card.querySelector('.et-tour-next').onclick = () => { try { speechSynthesis.cancel(); } catch (e) {} next(); };
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

  window.EagleTalk = { can, plain, mount, choose, style, tour, tourSteps, TOUR_WORDS };
})();
