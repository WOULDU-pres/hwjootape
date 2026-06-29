'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Deck dashboard (hub home) — Airbnb-inspired: white canvas, single Rausch accent,
 *  soft cards, one shadow tier. Lists decks and creates new ones. */

const RAUSCH = '#ff385c';
const RAUSCH_ACTIVE = '#e00b41';
const INK = '#222222';
const MUTED = '#6a6a6a';
const HAIRLINE = '#dddddd';
const CARD_SHADOW = 'rgba(0,0,0,0.02) 0 0 0 1px, rgba(0,0,0,0.04) 0 2px 6px 0, rgba(0,0,0,0.1) 0 4px 8px 0';

interface DeckItem {
  id: string;
  name: string;
  createdAt: string;
  running: boolean;
}

export default function DecksDashboard() {
  const router = useRouter();
  const [decks, setDecks] = useState<DeckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    // `loading` starts true; setState only happens after the await (not synchronously in the effect).
    try {
      const res = await fetch('/api/projects/list');
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setDecks(data.projects ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  // Fetch the deck list once on mount. setState happens only after the await, but the
  // rule still flags the call — legitimate on-mount data load, so disable it here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  function open(id: string) {
    router.push(`/deck?project=${encodeURIComponent(id)}`);
  }

  async function createDeck() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      open(data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '덱 생성 실패');
      setBusy(false);
    }
  }

  return (
    <div
      className="min-h-screen w-full bg-white"
      style={{ color: INK, fontFamily: 'Inter, "Helvetica Neue", system-ui, -apple-system, sans-serif' }}
    >
      <div className="mx-auto max-w-5xl px-8 py-12">
        <header className="mb-8">
          <h1 className="text-[28px] font-bold">🍌 내 덱</h1>
          <p className="mt-1 text-[15px]" style={{ color: MUTED }}>
            덱을 골라 열거나, 새로 만들어 AI로 슬라이드를 생성하세요.
          </p>
        </header>

        {error && (
          <div className="mb-6 rounded-lg p-3 text-[14px]" style={{ backgroundColor: '#fff8f6', color: '#c13515' }}>
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* New deck card */}
          {creating ? (
            <div className="rounded-[14px] p-5" style={{ boxShadow: CARD_SHADOW }}>
              <label className="text-[13px] font-medium" style={{ color: MUTED }}>새 덱 이름</label>
              <input
                autoFocus
                className="mt-2 h-11 w-full rounded-lg px-3 text-[15px] outline-none"
                style={{ border: `1px solid ${HAIRLINE}` }}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createDeck(); if (e.key === 'Escape') setCreating(false); }}
                placeholder="예: 2026 사업 전략"
                disabled={busy}
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={createDeck}
                  disabled={busy || !newName.trim()}
                  className="h-10 flex-1 rounded-lg text-[14px] font-medium text-white disabled:opacity-40"
                  style={{ backgroundColor: busy ? RAUSCH_ACTIVE : RAUSCH }}
                >
                  {busy ? '만드는 중…' : '만들기'}
                </button>
                <button
                  onClick={() => { setCreating(false); setNewName(''); }}
                  disabled={busy}
                  className="h-10 rounded-lg px-4 text-[14px]"
                  style={{ border: `1px solid ${INK}` }}
                >
                  취소
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-[14px] text-[15px] font-medium transition-colors"
              style={{ border: `2px dashed ${HAIRLINE}`, color: RAUSCH }}
            >
              <span className="text-[28px] leading-none">＋</span>
              새 덱 만들기
            </button>
          )}

          {/* Existing decks */}
          {decks.map((deck) => (
            <button
              key={deck.id}
              onClick={() => open(deck.id)}
              className="flex min-h-[132px] flex-col justify-between rounded-[14px] p-5 text-left transition-transform hover:-translate-y-0.5"
              style={{ boxShadow: CARD_SHADOW }}
            >
              <div>
                <div className="text-[17px] font-semibold">{deck.name}</div>
                <div className="mt-1 text-[13px]" style={{ color: MUTED }}>{deck.id}</div>
              </div>
              <div className="flex items-center gap-2 text-[12px]" style={{ color: MUTED }}>
                {deck.running && (
                  <span className="inline-flex items-center gap-1" style={{ color: RAUSCH }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: RAUSCH }} />실행 중
                  </span>
                )}
                <span>열기 →</span>
              </div>
            </button>
          ))}
        </div>

        {!loading && decks.length === 0 && !creating && (
          <p className="mt-8 text-[14px]" style={{ color: '#929292' }}>
            아직 덱이 없습니다. “새 덱 만들기”로 시작하세요.
          </p>
        )}
      </div>
    </div>
  );
}
