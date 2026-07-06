import { useState } from 'react';
import { supabase, OWNER_EMAIL } from '../lib/supabase';

export default function SignIn({ wrongUser }: { wrongUser?: boolean }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setMsg('');
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: window.location.href.split('#')[0] },
    });
    if (error) {
      // Signups are disabled; a non-allowlisted email fails here — cleanly.
      setStatus('error');
      setMsg(
        /not allowed|signup|invalid/i.test(error.message)
          ? 'That email is not authorized for the Parlor.'
          : error.message,
      );
    } else {
      setStatus('sent');
    }
  }

  if (wrongUser) {
    return (
      <div className="center card auth">
        <h1>The Parlor</h1>
        <p className="muted">This account isn't authorized. Signing you out…</p>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    );
  }

  return (
    <div className="center">
      <form className="card auth" onSubmit={send}>
        <h1>The Parlor</h1>
        <p className="muted">Private. Magic-link sign-in for the owner only.</p>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder={OWNER_EMAIL}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button className="btn" type="submit" disabled={status === 'sending' || status === 'sent'}>
          {status === 'sending' ? 'Sending…' : status === 'sent' ? 'Check your email' : 'Send magic link'}
        </button>
        {status === 'sent' && <p className="ok">Link sent. Open it on this device.</p>}
        {status === 'error' && <p className="err">{msg}</p>}
      </form>
    </div>
  );
}
