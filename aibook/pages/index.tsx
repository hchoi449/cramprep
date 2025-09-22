import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { CelebratePortal } from '../components/CelebratePulse';

export default function Home() {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [correct, setCorrect] = useState(false);

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">CelebratePulse demo</h1>
        <div className="relative inline-flex">
          <button ref={btnRef} className="btn btn-primary relative px-5 py-2 rounded-full bg-emerald-600 text-white">
            Check Answer
          </button>
          <CelebratePortal trigger={correct} anchorRef={btnRef} />
        </div>
        <div className="space-x-2">
          <button className="px-3 py-2 rounded bg-slate-200" onClick={() => { setCorrect(false); setTimeout(()=>setCorrect(true), 100); }}>Trigger celebration</button>
          <Link className="underline" href="#">Back</Link>
        </div>
      </div>
    </div>
  );
}


