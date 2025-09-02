/**
 * Cloudflare Pages Function: POST /api/chat
 * Calls OpenAI Chat Completions (or Vision if image provided) and returns the assistant reply.
 * Requires OPENAI_API_KEY in Pages env.
 */
export const onRequestPost: PagesFunction = async (context) => {
  try {
    const apiKey = (context.env as any)?.OPENAI_API_KEY as string | undefined;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY' }), { status: 500, headers: jsonHeaders() });
    }

    const req = context.request;
    if (!(req.headers.get('content-type') || '').includes('application/json')) {
      return new Response(JSON.stringify({ error: 'Expected application/json' }), { status: 400, headers: jsonHeaders() });
    }

    /** @type {{ text?: string; imageDataURL?: string }} */
    const { text = '', imageDataURL } = await req.json();

    const userContent: any[] = [];
    if (text) userContent.push({ type: 'text', text });
    if (imageDataURL) userContent.push({ type: 'image_url', image_url: { url: imageDataURL } });

    const body = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful academic assistant for ThinkBigPrep.' },
        { role: 'user', content: userContent.length ? userContent : [{ type: 'text', text: 'Hello' }] }
      ],
      temperature: 0.3
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ error: `Upstream error ${res.status}: ${errText}` }), { status: 502, headers: jsonHeaders() });
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content ?? 'Sorry, I could not generate a response.';
    return new Response(JSON.stringify({ reply }), { status: 200, headers: jsonHeaders() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: jsonHeaders() });
  }
};

function jsonHeaders() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=0' };
}


