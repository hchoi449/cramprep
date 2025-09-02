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

import eventsData from '../../data/events.json';

export const onRequestGet: PagesFunction = async () => {
  try {
    return new Response(JSON.stringify({ events: eventsData }), {
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


