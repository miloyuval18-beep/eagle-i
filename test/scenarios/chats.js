// Ask Eagle I keeps several chats per person, like Claude or Gemini: listed
// newest first, searchable by title or anything said, renamed, named by the AI
// after the first answer, deleted; and nobody else ever sees them.
const { R } = require('./_local');
const assert = require('assert/strict');
process.env.ANTHROPIC_API_KEY = 'test-only';
let naming = (p) => ({ title: 'Ruiz framing schedule.' });
require.cache[require.resolve(R + '/lib/anthropic')] = { exports: { ...require(R + '/lib/anthropic'), generateJSON: async (p) => naming(p) } };
const { query, pool } = require(R + '/db');
const A = require(R + '/lib/crmAssistant');

(async () => {
  const t = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Chat Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  const t2 = (await query(`INSERT INTO tenants (company_name, industry, products) VALUES ('Other Chat Co', 'home_services', '{crm}') RETURNING id`)).rows[0].id;
  try {
    const me = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'me@chat.test', 'x', 'Moran', 'owner') RETURNING id`, [t])).rows[0].id;
    const colleague = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'alex@chat.test', 'x', 'Alex', 'member') RETURNING id`, [t])).rows[0].id;
    const stranger = (await query(`INSERT INTO users (tenant_id, email, password_hash, name, role) VALUES ($1, 'x@chat.test', 'x', 'X', 'owner') RETURNING id`, [t2])).rows[0].id;
    const ctx = { tenantId: t, userId: me }, cctx = { tenantId: t, userId: colleague }, sctx = { tenantId: t2, userId: stranger };
    const say = async (thread, role, text, ago) => {
      await query(`INSERT INTO crm_ai_messages (thread_id, role, content, display, created_at) VALUES ($1, $2, $3, $4, now() - $5::interval)`, [thread, role, JSON.stringify([{ type: 'text', text }]), JSON.stringify({ text }), ago]);
      await query(`UPDATE crm_ai_threads SET updated_at = now() - $2::interval WHERE id = $1`, [thread, ago]);
    };
    const a = await A.createThread(ctx, 'When does framing start at Ruiz');
    await say(a.id, 'user', 'When does framing start at Ruiz?', '3 days'); await say(a.id, 'assistant', 'Framing starts Monday with Gulf Framing.', '3 days');
    const b = await A.createThread(ctx, 'Draft the Park deck estimate');
    await say(b.id, 'user', 'Draft the Park deck estimate', '1 hour'); await say(b.id, 'assistant', 'Here is a draft: composite decking, 400 sq ft, railing included.', '1 hour');
    const empty = await A.createThread(ctx); // opened, never used
    const theirs = await A.createThread(cctx, 'Alex private chat');
    await say(theirs.id, 'user', 'Gulf Framing quote for Alex', '2 hours');

    // 1. Newest first; empty chats and other people's never listed.
    const list = await A.listThreads(ctx);
    assert.deepEqual(list.map(x => x.id), [b.id, a.id]);
    assert.ok(!list.some(x => x.id === empty.id), 'a chat with nothing said isn’t listed');
    // Older pages.
    const page2 = await A.listThreads(ctx, { before: list[0].updated_at });
    assert.deepEqual(page2.map(x => x.id), [a.id]);

    // 2. Search by title or anything said, with the matching words.
    const byText = await A.listThreads(ctx, { q: 'composite' });
    assert.equal(byText.length, 1); assert.equal(byText[0].id, b.id); assert.match(byText[0].snippet, /composite decking/);
    const byTitle = await A.listThreads(ctx, { q: 'ruiz' });
    assert.deepEqual(byTitle.map(x => x.id), [a.id]);
    assert.equal((await A.listThreads(ctx, { q: 'Gulf Framing quote for Alex' })).length, 0, 'never someone else’s');
    assert.equal((await A.listThreads(ctx, { q: '100%_' })).length, 0, 'wildcards are just characters');

    // 3. Rename: only your own.
    assert.equal((await A.renameThread(ctx, a.id, '  Ruiz   framing  ')).title, 'Ruiz framing');
    await assert.rejects(A.renameThread(ctx, a.id, '   '), /Give the chat a name/);
    await assert.rejects(A.renameThread(cctx, a.id, 'Mine'), /not found/);
    await assert.rejects(A.renameThread(sctx, a.id, 'Mine'), /not found/);
    await assert.rejects(A.threadView(cctx, a.id), /not found/);
    await assert.rejects(A.deleteThread(sctx, a.id), /not found/);

    // 4. The AI names a chat after its first answer (cleaned up); a failure keeps the old name.
    const c = await A.createThread(ctx, 'when is the ruiz framing');
    assert.equal(await A.nameThread(ctx, c.id, 'when is the ruiz framing', 'Monday.'), 'Ruiz framing schedule');
    assert.equal((await query('SELECT title FROM crm_ai_threads WHERE id = $1', [c.id])).rows[0].title, 'Ruiz framing schedule');
    naming = () => { throw new Error('down'); };
    assert.equal(await A.nameThread(ctx, c.id, 'x', 'y'), null);
    assert.equal((await query('SELECT title FROM crm_ai_threads WHERE id = $1', [c.id])).rows[0].title, 'Ruiz framing schedule');
    assert.equal(await A.nameThread(cctx, c.id, 'x', 'y'), null);

    // 5. Delete.
    await A.deleteThread(ctx, b.id);
    assert.ok(!(await A.listThreads(ctx)).some(x => x.id === b.id));
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM crm_ai_messages WHERE thread_id = $1', [b.id])).rows[0].n, 0, 'its messages go too');
    console.log('CHATS SCENARIO PASSED');
  } catch (e) {
    console.error('CHATS SCENARIO FAILED:', e);
    process.exitCode = 1;
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[t, t2]]).catch(() => {});
    await pool.end();
  }
})();
