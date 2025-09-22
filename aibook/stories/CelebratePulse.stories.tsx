import React, { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { CelebratePortal } from '../components/CelebratePulse';

const meta: Meta = {
  title: 'Feedback/CelebratePulse',
  component: CelebratePortal,
};
export default meta;

export const Demo: StoryObj = {
  render: () => {
    const btnRef = useRef<HTMLButtonElement>(null);
    const [trigger, setTrigger] = useState(false);
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="space-y-4">
          <div className="relative inline-flex">
            <button ref={btnRef} className="px-5 py-2 rounded-full bg-emerald-600 text-white relative">Check Answer</button>
            <CelebratePortal trigger={trigger} anchorRef={btnRef} />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={trigger} onChange={(e)=> setTrigger(e.target.checked)} />
            Trigger celebration
          </label>
        </div>
      </div>
    );
  },
};
