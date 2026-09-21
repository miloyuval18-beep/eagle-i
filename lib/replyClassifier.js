// Sorts an incoming reply to a vendor email into one of five buckets, with
// plain rules rather than AI: it costs nothing, gives the same answer every
// time, and can show exactly which words decided it.
//
//   auto_reply   out-of-office and other automatic responses (not a real reply)
//   unsubscribe  asks to stop hearing from us — acted on automatically
//   not_now      a polite "no", "not now" or "already covered"
//   interested   wants to talk, asks for details, or gives a number to call
//   other        anything unclear, or mixed signals — left for a person to read
//
// It only ever reads the newly written part of a reply. Quoted history and our
// own footer (which itself contains the word "unsubscribe") are cut off first,
// so quoting our email back can never opt anyone out.

const QUOTE_CUTS = [
  /^\s*on .{5,200}wrote:\s*$/im,
  /^\s*-{2,}\s*(original message|forwarded message)/im,
  /^\s*_{5,}\s*$/m,
  /^\s*from:\s.+$/im,
  /if you'd rather not receive emails like this/i,
  /if you.d rather not receive emails/i
];

function newContent(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  t = t.split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
  let cut = t.length;
  for (const re of QUOTE_CUTS) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  return t.slice(0, cut).trim();
}

const AUTO_SUBJECT = /^(re:\s*)?(auto(matic)?[ -]?(reply|response)|out of (the )?office|undeliverable|delivery status|mail delivery|away from)/i;
const AUTO_BODY = /(out of (the )?office|automatic(ally generated)? (reply|response)|auto-?reply|auto-?response|i am (currently )?(away|out of)|i('m| am) (currently )?(on (vacation|leave|holiday|pto)|traveling)|will (be )?(out|away|back)\b.{0,40}(return|respond|reply)|limited access to (my )?email|this is an automated|do not reply to this (e-?mail|message)|no-?reply)/i;
const UNSUB = /(\bunsubscribe\b|\bremove (me|us|my (e-?mail|address|name))\b|\btake (me|us) off\b|\bstop (e-?mailing|sending|contacting|messaging)\b|\bdo not (e-?mail|contact)\b|\bdon'?t (e-?mail|contact)\b|\bopt[ -]?out\b|\bno more (e-?mails|messages)\b|\bplease remove\b)/i;
const NOT_NOW = /(\bnot interested\b|\bno,? thank(s| you)\b|\bnot (at this time|right now|currently|looking)\b|\bmaybe (later|next|in the future)\b|\bcheck back\b|\bat capacity\b|\bfully (booked|staffed)\b|\bwe('re| are) (all set|good|covered)\b|\balready (have|work|use|partner)\b|\bnot a (good )?fit\b|\bwe'?ll pass\b|\bno need\b|\bnot accepting\b|\bnot taking (on )?(any )?new\b|\bnot available\b|\bunavailable\b|\b(schedule|calendar|plate) is (full|packed|booked)\b|\bfull (schedule|plate)\b|\bbooked (up|solid)\b)/i;
const INTERESTED = /(\binterested\b|\bsounds (good|great|interesting|like)\b|\blet'?s (talk|chat|connect|meet|schedule|set up|get together)\b|\b(love|like|happy|glad|would be glad) to\b|\bcall (me|us)\b|\bgive (me|us) a (call|ring)\b|\breach (me|us)\b|\bmy (cell|mobile|number|phone|direct)\b|\bportfolio\b|\battached\b|\blunch\b|\bcoffee\b|\bmeet(ing)?\b|\bavailable\b|\bschedule\b|\bsend (me )?(more|over|some|details|info)\b|\btell (me|us) more\b|\bmore (info|information|details)\b|\bwould love\b|^(yes|sure|absolutely|definitely)\b)/im;
const PHONE = /(\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b)/;

const HEAD_CHARS = 700;

function classifyReply({ subject, text } = {}) {
  const subj = String(subject || '');
  const body = newContent(text);
  const head = body.slice(0, HEAD_CHARS);

  if (AUTO_SUBJECT.test(subj.trim()) || AUTO_BODY.test(head)) {
    return { category: 'auto_reply', reason: 'looks like an automatic reply' };
  }
  if (!head) return { category: 'other', reason: 'no readable text' };

  const un = UNSUB.exec(head);
  if (un) return { category: 'unsubscribe', reason: `they wrote "${un[0].trim()}"` };

  const no = NOT_NOW.exec(head);
  // Words inside a "no" phrase ("not interested", "our schedule is full") must not count as a "yes".
  const rest = head.replace(new RegExp(NOT_NOW.source, 'gi'), ' ');
  const yes = INTERESTED.exec(rest) || (PHONE.test(rest) ? ['a phone number'] : null);
  if (no && yes) return { category: 'other', reason: 'mixed signals; worth a read' };
  if (no) return { category: 'not_now', reason: `they wrote "${no[0].trim()}"` };
  if (yes) return { category: 'interested', reason: `they wrote "${String(yes[0]).trim().slice(0, 40)}"` };
  return { category: 'other', reason: 'no clear signal' };
}

const CATEGORY_LABELS = {
  interested: 'Interested',
  not_now: 'Not now / not interested',
  unsubscribe: 'Asked to unsubscribe',
  auto_reply: 'Automatic reply',
  other: 'Needs a look'
};
const CATEGORIES = Object.keys(CATEGORY_LABELS);

// First plain address in a From header ("Jo <jo@x.com>" or "jo@x.com").
function senderAddress(from) {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(String(from || '')) || /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(String(from || ''));
  return m ? m[1].toLowerCase() : null;
}

module.exports = { classifyReply, newContent, CATEGORY_LABELS, CATEGORIES, senderAddress };
