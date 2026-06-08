// Supabase Edge Function: embed
// Generates embeddings using Supabase's built-in gte-small model (384 dimensions).
// No external API key required — runs entirely within the Supabase platform.
//
// Request body:  { input: string | string[] }
// Response body: { embeddings: number[][] }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { input } = await req.json();
    if (!input) {
      return new Response(JSON.stringify({ error: 'input is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const texts: string[] = Array.isArray(input) ? input : [input];

    // Supabase's built-in AI inference — no external API key needed
    const session = new Supabase.ai.Session('gte-small');

    const embeddings = await Promise.all(
      texts.map((text) =>
        session.run(text, { mean_pool: true, normalize: true })
      )
    );

    return new Response(
      JSON.stringify({ embeddings: embeddings.map((e) => Array.from(e as Float32Array)) }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[embed]', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
