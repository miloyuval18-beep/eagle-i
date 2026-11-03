/* First-time tips for the customer pages (the homeowner's project page, a sub's page,
   the homeowners' and subs' own accounts), like the tips in the CRM: a card at the
   bottom, a step at a time, shown once on each phone. A "?" button brings it back.

   ccTips({ key, lang: () => 'en' | 'es', steps: [{ en: [title, text], es: [title, text], el }],
            button: element to put the "?" after, blocked: () => true while something
            else is open (it waits) }) */
(function () {
  const W = { en: { next: 'Next →', back: '← Back', done: 'OK, got it', close: 'Close', help: 'How this page works', of: 'of' },
              es: { next: 'Siguiente →', back: '← Atrás', done: 'Entendido', close: 'Cerrar', help: 'Cómo funciona esta página', of: 'de' } };
  const seen = (k) => { try { return localStorage.getItem('cctip:' + k) === '1'; } catch (e) { return false; } };
  const mark = (k) => { try { localStorage.setItem('cctip:' + k, '1'); } catch (e) {} };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let css = false;
  function style() {
    if (css) return; css = true;
    const s = document.createElement('style');
    s.textContent = `.cct{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));z-index:2200;width:min(520px,calc(100% - 24px));
      background:#15130f;color:#f3ecdc;border:1.5px solid rgba(212,175,97,.6);border-radius:18px;padding:16px 18px 14px;box-shadow:0 0 40px -10px rgba(212,175,97,.45),0 24px 60px -18px #000;font-size:18px;line-height:1.5}
      .cct.top{bottom:auto;top:calc(12px + env(safe-area-inset-top))}
      .cct-n{font-size:13px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#d4af61}
      .cct-t{font-family:'Cormorant Garamond',Georgia,serif;font-weight:700;font-size:25px;line-height:1.15;margin:4px 40px 6px 0;color:#f6ecd4}
      .cct-x{position:absolute;top:10px;right:10px;width:40px;height:40px;border-radius:50%;border:1px solid rgba(212,175,97,.5);background:transparent;color:#f3ecdc;font-size:18px;cursor:pointer}
      .cct-b{display:flex;justify-content:space-between;gap:10px;margin-top:12px}
      .cct-b button{font:inherit;font-weight:800;font-size:17px;border-radius:12px;padding:10px 18px;min-height:46px;cursor:pointer}
      .cct-back{background:transparent;color:#dcd0b6;border:1px solid rgba(212,175,97,.45)}
      .cct-go{margin-left:auto;border:0;color:#16130c;background:linear-gradient(180deg,#f2d690 0%,#dab364 45%,#b98d3c 100%)}
      .cct-lit{outline:3px solid #d4af61!important;outline-offset:3px;border-radius:10px;box-shadow:0 0 0 8px rgba(212,175,97,.18)!important}
      .cct-q{font:inherit;font-weight:800;font-size:17px;width:40px;height:40px;border-radius:50%;border:1px solid rgba(212,175,97,.6);background:transparent;color:#e8c983;cursor:pointer;margin-left:8px;flex:none}`;
    document.head.appendChild(s);
  }
  function show(o) {
    style();
    const old = document.querySelector('.cct'); if (old) old.remove();
    const L = () => (o.lang && o.lang() === 'es' ? 'es' : 'en');
    const steps = o.steps.filter(s => !s.when || s.when());
    if (!steps.length) return;
    let i = 0, lit = null;
    const card = document.createElement('div'); card.className = 'cct'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'false'); card.setAttribute('aria-labelledby', 'cct-t');
    document.body.appendChild(card);
    const unlight = () => { if (lit) lit.classList.remove('cct-lit'); lit = null; };
    const done = () => { unlight(); card.remove(); mark(o.key); };
    const draw = () => {
      const w = W[L()], st = steps[i], [t, b] = st[L()] || st.en, last = i === steps.length - 1;
      card.innerHTML = `<button type="button" class="cct-x" aria-label="${w.close}">✕</button>
        <div class="cct-n">${steps.length > 1 ? `${i + 1} ${w.of} ${steps.length}` : 'Tip'}</div><div class="cct-t" id="cct-t">${esc(t)}</div><div>${esc(b)}</div>
        <div class="cct-b">${i ? `<button type="button" class="cct-back">${w.back}</button>` : ''}<button type="button" class="cct-go">${last ? w.done : w.next}</button></div>`;
      card.querySelector('.cct-x').onclick = done;
      card.querySelector('.cct-go').onclick = () => { if (last) done(); else { i++; draw(); } };
      const bk = card.querySelector('.cct-back'); if (bk) bk.onclick = () => { i--; draw(); };
      unlight();
      const el = st.el && (typeof st.el === 'string' ? document.querySelector(st.el) : st.el);
      if (el && el.offsetParent !== null) { lit = el; el.classList.add('cct-lit'); try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {} }
      const r = lit && lit.getBoundingClientRect();
      card.classList.toggle('top', !!r && r.top + r.height / 2 > innerHeight * 0.5);
      setTimeout(() => { const g = card.querySelector('.cct-go'); if (g) g.focus({ preventScroll: true }); }, 30);
    };
    draw();
    document.addEventListener('keydown', function k(e) { if (e.key === 'Escape' && card.isConnected) { done(); document.removeEventListener('keydown', k); } });
  }
  window.ccTips = function (o) {
    // The "?" that brings the tips back, any time.
    const at = o.button && (typeof o.button === 'string' ? document.querySelector(o.button) : o.button);
    if (at && !document.getElementById('cct-q-' + o.key)) {
      style();
      const q = document.createElement('button'); q.type = 'button'; q.className = 'cct-q'; q.id = 'cct-q-' + o.key; q.textContent = '?';
      const lab = () => { const w = W[o.lang && o.lang() === 'es' ? 'es' : 'en']; q.title = w.help; q.setAttribute('aria-label', w.help); };
      lab(); q.onclick = () => { lab(); show(o); };
      at.after(q);
    }
    if (seen(o.key)) return;
    let n = 0;
    const tryShow = () => { if (o.blocked && o.blocked() && n++ < 600) return setTimeout(tryShow, 1000); show(o); };
    setTimeout(tryShow, 800);
  };
})();
