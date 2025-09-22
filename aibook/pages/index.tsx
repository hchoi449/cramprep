import Link from 'next/link';

export default function Home() {
  return (
    <main className="min-h-screen bg-white">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <h1 className="text-3xl font-bold text-brand-brown">AI Book</h1>
        <p className="mt-3 text-gray-700">Browse courses and continue learning.</p>
        <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {['algebra-1','algebra-2','geometry','precalculus','calculus'].map((slug)=> (
            <Link key={slug} href={`/courses/${slug}`}
              className="rounded-lg border border-gray-200 p-4 hover:shadow-md transition">
              <div className="text-sm uppercase tracking-wide text-gray-500">Course</div>
              <div className="mt-1 text-xl font-semibold capitalize">{slug.replace('-', ' ')}</div>
              <div className="mt-3 inline-flex items-center text-brand-brown">Open<i className="bi bi-arrow-right ml-2"/></div>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}


