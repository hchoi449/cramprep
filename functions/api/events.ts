/**
 * Cloudflare Pages Function: GET /api/events
 *
 * Types
 * type Subject = 'Algebra II' | 'Geometry' | 'Calculus' | 'Chemistry' | 'Physics' | 'Biology';
 * interface CalendarEvent {
 *   id: string;
 *   title: string;
 *   school: string;
 *   tutorName: string;
 *   subject: Subject;
 *   start: string; // ISO
 *   end: string;   // ISO
 *   meetLink?: string;
 *   comments?: string;
 *   createdBy: 'owner' | 'system';
 * }
 */

export const onRequestGet: PagesFunction = async (context) => {
  try {
    // Read seed data from the repo (bundled with Pages deploy)
    // Note: new Request URL build ensures relative path resolution under Pages
    const url = new URL('../../data/events.json', context.request.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to read events.json (${res.status})`);
    const json = await res.json();

    return new Response(JSON.stringify({ events: json }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=0',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, max-age=0',
      },
    });
  }
};


