import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

// Supabase gte-small: 384-dimensional embeddings, no API key required.
// Module-level init is recommended by Supabase for session reuse across invocations.
let session: Supabase.ai.Session | null = null;
let initError: string | null = null;

try {
  session = new Supabase.ai.Session('gte-small');
} catch (e) {
  initError = String(e);
  console.error('[embed] Session init failed:', e);
}

Deno.serve(async (req) => {
  if (!session || initError) {
    console.error('[embed] No session available. Init error:', initError);
    return new Response(
      JSON.stringify({ error: `Session init failed: ${initError ?? 'session is null'}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { input } = await req.json();

    if (!input || (typeof input !== 'string' && !Array.isArray(input))) {
      return new Response(
        JSON.stringify({ error: 'input must be a string or array of strings' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (Array.isArray(input)) {
      const embeddings = await Promise.all(
        input.map((text: string) =>
          session!.run(text, { mean_pool: true, normalize: true })
        ),
      );
      return new Response(
        JSON.stringify({ embeddings: embeddings.map((e) => Array.from(e)) }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    const embedding = await session.run(input, { mean_pool: true, normalize: true });
    return new Response(
      JSON.stringify({ embedding: Array.from(embedding) }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[embed] Request error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
