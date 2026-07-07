// Layer 4 embedding helper — OpenAI text-embedding-3-small (1536 dims). Used to
// embed journal entries / answers on write and to embed a query for retrieval.
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? '';
const MODEL = 'text-embedding-3-small';

export async function embed(text: string): Promise<number[] | null> {
  if (!OPENAI_API_KEY || !text?.trim()) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, 8000) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch { return null; }
}
