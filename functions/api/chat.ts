/**
 * Cloudflare Pages Function: POST /api/chat
 * Minimal mock that echoes back guidance and a short reply.
 */
export const onRequestPost: PagesFunction = async (context) => {
  try {
    const req = context.request;
    const contentType = req.headers.get('content-type') || '';

    /** @type {{ text?: string; imageName?: string }} */
    let payload = {};

    if (contentType.includes('application/json')) {
      payload = await req.json();
    } else if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      payload.text = String(formData.get('text') || '');
      const file = formData.get('image');
      if (file && typeof file === 'object' && 'name' in file) {
        payload.imageName = (file as File).name;
      }
    } else {
      return new Response(JSON.stringify({ error: 'Unsupported content type' }), { status: 400, headers: jsonHeaders() });
    }

    const text = (payload.text || '').trim();

    const reply = `Thanks for the details${payload.imageName ? ` (received ${payload.imageName})` : ''}.` +
      (text ? ` You said: "${text}". Our tutor-matching AI will suggest a plan and time.` : ' Tell me what you need help with to get started.');

    return new Response(JSON.stringify({ reply }), { status: 200, headers: jsonHeaders() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { status: 500, headers: jsonHeaders() });
  }
};

function jsonHeaders() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=0' };
}


