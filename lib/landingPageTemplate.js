// Fixed HTML/CSS template for a tenant's published public landing page.
// Deliberately NOT rendering raw AI output — the owner AI-drafts, edits,
// and approves these fields first (see routes/leads.js), and only the
// approved field values ever reach this template, escaped.
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderLandingPageHtml(page, profile, companyName) {
  const e = escapeHtml;
  const phone = e(profile.phone || '');
  const email = e(profile.email || '');
  const addr = e(profile.address || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${e(page.meta_title || companyName)}</title>
<meta name="description" content="${e(page.meta_desc || page.subheadline || '')}">
<style>
:root{--ink:#12203a;--ink2:#5a7290;--blue:#1a7ee8;--blue2:#3aa0ff;--bg:#f6f9fd;--card:#ffffff;--bdr:#e2e9f2;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.6}
.hero{background:linear-gradient(135deg,#0d1b30,#132a4d);color:#fff;padding:56px 24px;text-align:center}
.eyebrow{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#8fc4ff;margin-bottom:10px}
h1{font-size:clamp(28px,5vw,42px);margin-bottom:12px}
.sub{font-size:17px;color:#c7d9f2;max-width:560px;margin:0 auto 18px}
.offer{display:inline-block;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);border-radius:24px;padding:8px 20px;font-size:14px;margin-bottom:22px}
.ctas{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.cta1,.cta2{padding:13px 26px;border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;display:inline-block}
.cta1{background:var(--blue);color:#fff}
.cta2{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.4)}
.wrap{max-width:900px;margin:0 auto;padding:48px 24px}
.section{margin-bottom:36px}
.section h2{font-size:22px;margin-bottom:10px;color:var(--ink)}
.section p{color:var(--ink2);font-size:15.5px}
.formcard{background:var(--card);border:1px solid var(--bdr);border-radius:14px;padding:28px;max-width:520px;margin:0 auto;box-shadow:0 10px 30px rgba(20,40,80,.08)}
.formcard h2{margin-bottom:16px}
label{display:block;font-size:12px;color:var(--ink2);margin:12px 0 5px}
input,textarea{width:100%;border:1px solid var(--bdr);border-radius:8px;padding:11px 12px;font-size:14px;font-family:inherit}
textarea{min-height:70px;resize:vertical}
button{width:100%;margin-top:18px;background:var(--blue);color:#fff;border:none;border-radius:8px;padding:13px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:var(--blue2)}
button:disabled{opacity:.6;cursor:not-allowed}
.status{font-size:13px;margin-top:10px;text-align:center;display:none}
.footer{text-align:center;color:var(--ink2);font-size:13px;padding:24px}
.hp{position:absolute;left:-9999px;opacity:0}
</style>
</head>
<body>
<div class="hero">
  <div class="eyebrow">${e(companyName)}${addr ? ' · ' + addr : ''}${phone ? ' · ' + phone : ''}</div>
  <h1>${e(page.headline || companyName)}</h1>
  <div class="sub">${e(page.subheadline || '')}</div>
  ${page.offer ? `<div class="offer">${e(page.offer)}</div>` : ''}
  <div class="ctas">
    <a class="cta1" href="#lead-form">${e(page.cta_primary || 'Get In Touch')}</a>
    ${phone ? `<a class="cta2" href="tel:${phone}">${e(page.cta_secondary || ('Call ' + phone))}</a>` : ''}
  </div>
</div>
<div class="wrap">
  ${page.about_para ? `<div class="section"><h2>About ${e(companyName)}</h2><p>${e(page.about_para)}</p></div>` : ''}
  ${page.service_para ? `<div class="section"><h2>Our Service</h2><p>${e(page.service_para)}</p></div>` : ''}
  ${page.trust_para ? `<div class="section"><h2>Why Choose Us</h2><p>${e(page.trust_para)}</p></div>` : ''}
  <div class="formcard" id="lead-form">
    <h2>Get In Touch</h2>
    <form id="leadForm">
      <label>Name</label><input type="text" name="name" required>
      <label>Phone</label><input type="tel" name="phone">
      <label>Email</label><input type="email" name="email">
      <label>How can we help?</label><textarea name="message"></textarea>
      <input class="hp" type="text" name="company_website" tabindex="-1" autocomplete="off">
      <button type="submit" id="submitBtn">Send</button>
      <div class="status" id="formStatus"></div>
    </form>
  </div>
</div>
<div class="footer">${e(companyName)}${phone ? ' · ' + phone : ''}${email ? ' · ' + email : ''}${addr ? ' · ' + addr : ''}</div>
<script>
document.getElementById('leadForm').addEventListener('submit', async function(e){
  e.preventDefault();
  var btn = document.getElementById('submitBtn');
  var status = document.getElementById('formStatus');
  var form = e.target;
  var body = {
    name: form.name.value, phone: form.phone.value, email: form.email.value,
    message: form.message.value, company_website: form.company_website.value
  };
  btn.disabled = true;
  status.style.display = 'block';
  status.style.color = '#5a7290';
  status.textContent = 'Sending...';
  try {
    var r = await fetch(window.location.pathname + '/submit', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    var d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'Something went wrong.');
    status.style.color = '#0a8a4a';
    status.textContent = "Thanks — we'll be in touch shortly.";
    form.reset();
  } catch (err) {
    status.style.color = '#c0293f';
    status.textContent = err.message;
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;
}

module.exports = { renderLandingPageHtml, escapeHtml };
