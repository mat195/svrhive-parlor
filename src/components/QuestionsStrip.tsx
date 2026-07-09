import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import { useSilk } from '../SilkContext';
import { useToast } from './Toast';

// Questions Strip — lives in Silk's column, between the Presence Bar and the chat.
// Collapsed: [ ● N questions from Silk · tap to answer ▼ ]. Expanded: the top-priority
// question as an inline card (context preview + plain why + answer widget), with a
// "See all N" link to the full queue. Replaces the old pinned-card-in-every-room.
//
// Renderable states are 'pending' (question_hunter's set) and legacy 'open'.

interface Q {
  id: string; question: string; why_asking: string | null; urgency: number;
  question_context: any; source_ref: any;
}

const OPEN_STATES = ['pending', 'open'];
const draftKey = (id: string) => `qdraft:${id}`;
// One-tap skip reasons → routed to the journal so the Question Hunter learns which
// questions weren't worth asking.
const SKIP_REASONS = ['not mine to answer', 'answered elsewhere', 'irrelevant now', 'other'];

function ContextPreview({ ctx }: { ctx: any }) {
  if (!ctx || !ctx.type) return null;
  if (ctx.type === 'link' || ctx.type === 'platform') {
    return (
      <div className="qctx-card">
        <span className="muted small">{ctx.platform || 'link'}</span>
        <a href={ctx.url} target="_blank" rel="noopener" className="qctx-url">{ctx.url} <span className="muted">open ↗</span></a>
      </div>
    );
  }
  if (ctx.type === 'release') {
    return (
      <div className="qctx-card">
        {ctx.coverArt ? <img src={ctx.coverArt} alt="" width="40" height="40" style={{ borderRadius: 6 }} /> : <div className="qctx-thumb">♪</div>}
        <div><div>{ctx.title}</div><div className="muted small">{ctx.date || 'date TBD'}</div></div>
      </div>
    );
  }
  if (ctx.type === 'collaborator') {
    return <div className="qctx-card"><div className="qctx-thumb">◑</div><div><div>{ctx.name}</div><div className="muted small">{ctx.role}{ctx.release ? ` · on "${ctx.release}"` : ''}</div></div></div>;
  }
  if (ctx.type === 'text') {
    return <div className="qctx-card"><blockquote className="qctx-quote">{ctx.label}: {ctx.value}</blockquote></div>;
  }
  return null;
}

export default function QuestionsStrip({ variant = 'dock' }: { variant?: 'dock' | 'brain' }) {
  const isBrain = variant === 'brain';
  const [queue, setQueue] = useState<Q[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');
  const [showSrc, setShowSrc] = useState(false);
  const [skipMenu, setSkipMenu] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [pending, setPending] = useState(0);
  const { pointAt, askSilk } = useSilk();
  const toast = useToast();

  const answeringRef = useRef(false);
  answeringRef.current = answering;

  // Load the whole open queue (top-priority first). Locked while answering:
  // realtime updates are counted (pending++) and applied when the lock releases.
  const load = useCallback(async (force = false) => {
    if (answeringRef.current && !force) { setPending((p) => p + 1); return; }
    const { data } = await supabase.from('silk_questions')
      .select('id, question, why_asking, urgency, question_context, source_ref')
      .in('status', OPEN_STATES)
      .order('urgency', { ascending: false }).order('created_at', { ascending: false });
    const rows = (data ?? []) as Q[];
    setQueue(rows);
    setAnswering(false); setShowSrc(false); setPending(0); setLeaving(false);
    setSelectedId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null));
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel('questions-strip')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'silk_questions' }, () => {
        if (answeringRef.current) setPending((p) => p + 1); else load(true);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const current = queue.find((q) => q.id === selectedId) ?? queue[0] ?? null;
  const count = queue.length;
  const open = isBrain || expanded; // in Brain the section is always open (a pinned queue)

  // When the top card changes, restore its draft + point Silk at its brain node.
  useEffect(() => {
    if (!current) return;
    setAnswer(localStorage.getItem(draftKey(current.id)) ?? '');
    if (expanded && current.source_ref?.node_key) pointAt(current.source_ref.node_key);
  }, [current?.id, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (current && answer) localStorage.setItem(draftKey(current.id), answer); }, [answer, current]);

  async function submit() {
    if (!current) return;
    const id = current.id;
    setLeaving(true); // card animates out
    try { await callFn('answer-propagate', { question_id: id, answer }); }
    catch { await supabase.from('silk_questions').update({ status: 'answered', answer, answered_at: new Date().toISOString() }).eq('id', id); }
    localStorage.removeItem(draftKey(id));
    // advance to the next question after the exit animation
    setTimeout(() => { setSelectedId(null); load(true); }, 220);
  }
  // Skip = a real terminal state (was only decrementing urgency, so the card never
  // left). Marks status='skipped' + timestamp, journals the reason for Hunter tuning,
  // drops the card, decrements the counter, and loads the next question in the slot.
  async function skip(reason: string) {
    if (!current) return;
    const id = current.id, q = current.question;
    setSkipMenu(false); setLeaving(true);
    await supabase.from('silk_questions').update({ status: 'skipped', skipped_at: new Date().toISOString(), skip_reason: reason }).eq('id', id);
    await supabase.from('silk_journal').insert({ entry: `Mat skipped "${q}" — reason: ${reason}. Question Hunter tuning: questions like this aren't worth asking.`, tags: ['question-skip', 'hunter-tuning', reason.replace(/\s+/g, '-')] });
    localStorage.removeItem(draftKey(id));
    toast(`Skipped — ${reason}`, async () => { await supabase.from('silk_questions').update({ status: 'pending', skipped_at: null, skip_reason: null }).eq('id', id); load(true); });
    setTimeout(() => { setSelectedId(null); load(true); }, 220);
  }
  function cancelAnswer() { setAnswering(false); if (pending > 0) load(true); }

  const dot = <span className={`qstrip-dot ${count ? '' : 'empty'}`} />;

  return (
    <div className={`qstrip ${isBrain ? 'qstrip-brain' : ''}`}>
      {isBrain ? (
        <div className="brainq-head">
          <span className="brainq-dot c-unverified" title="Awaiting your answer" />
          <span className="brainq-title">Silk's Questions</span>
          <span className="muted small">{count ? `${count} pending` : 'none open'}</span>
        </div>
      ) : (
        <button className="qstrip-bar" onClick={() => count && setExpanded((e) => !e)} aria-expanded={expanded} disabled={!count}>
          {dot}
          <span className="qstrip-label">
            {count ? <>{count} question{count > 1 ? 's' : ''} from Silk <span className="muted">· tap to answer</span></> : <span className="muted">no open questions</span>}
          </span>
          {count > 0 && <span className="qstrip-chev">{expanded ? '▲' : '▼'}</span>}
        </button>
      )}
      {isBrain && count === 0 && <div className="muted small brainq-empty">No open questions — you're all caught up.</div>}

      {open && count > 0 && !showAll && current && (
        <div className={`qstrip-card ${leaving ? 'leaving' : ''}`}>
          <div className="qhead">
            <span className="q-text">{current.question}</span>
            {current.source_ref && Object.keys(current.source_ref).length > 0 && (
              <button className="q-info" title="Where this comes from" onClick={() => setShowSrc((s) => !s)}>ⓘ</button>
            )}
          </div>
          {current.why_asking && <div className="qwhy">{current.why_asking}</div>}
          <ContextPreview ctx={current.question_context} />
          {showSrc && <div className="muted small qsrc">source: {JSON.stringify(current.source_ref)}</div>}

          {answering ? (
            <>
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
                <input value={answer} onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') cancelAnswer(); if (e.key === 'Enter' && answer.trim()) submit(); }}
                  placeholder="Your answer…" style={{ flex: 1 }} autoFocus />
                <button className="btn sm" disabled={!answer.trim()} onClick={submit}>Save</button>
                <button className="btn sm ghost" onClick={cancelAnswer}>Cancel</button>
              </div>
              {pending > 0 && <div className="muted small" style={{ marginTop: '0.3rem' }}>answering — {pending} update{pending > 1 ? 's' : ''} pending</div>}
            </>
          ) : (
            <div className="qacts">
              <button className="btn sm" onClick={() => setAnswering(true)}>Answer</button>
              <button className="btn sm ghost" onClick={() => askSilk(`About "${current.question}": `)}>Ask Silk</button>
              <div className="qskip">
                <button className="btn sm ghost" onClick={() => setSkipMenu((m) => !m)} aria-haspopup="menu" aria-expanded={skipMenu} aria-label="Skip">Skip ▾</button>
                {skipMenu && (
                  <ul className="qskip-menu" role="menu">
                    {SKIP_REASONS.map((r) => (
                      <li key={r}><button role="menuitem" onClick={() => skip(r)}>{r}</button></li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {count > 1 && <button className="link small qstrip-seeall" onClick={() => setShowAll(true)}>See all {count} ▾</button>}
        </div>
      )}

      {open && count > 0 && showAll && (
        <div className="qstrip-card">
          <div className="muted small" style={{ marginBottom: '0.4rem' }}>All {count} open questions — tap one to answer</div>
          <ul className="qstrip-list">
            {queue.map((q) => (
              <li key={q.id}>
                <button onClick={() => { setSelectedId(q.id); setShowAll(false); setAnswering(true); }}>
                  <span className="qstrip-urg">{q.urgency}</span> {q.question}
                </button>
              </li>
            ))}
          </ul>
          <button className="link small qstrip-seeall" onClick={() => setShowAll(false)}>▲ back to top question</button>
        </div>
      )}
    </div>
  );
}
