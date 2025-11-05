import { useDrag } from 'react-dnd';
import { Calendar, BookOpen } from 'lucide-react';

export interface Assignment {
  id: string;
  title: string;
  subject: string;
  dueDate: string;
  priority: 'low' | 'medium' | 'high';
  description: string;
}

interface AssignmentCardProps {
  assignment: Assignment;
}

export function AssignmentCard({ assignment }: AssignmentCardProps) {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: 'assignment',
    item: { id: assignment.id },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  }));

  const priorityConfig = {
    low: { 
      color: 'bg-[#007aff]',
      label: 'Low'
    },
    medium: { 
      color: 'bg-[#ff9500]',
      label: 'Medium'
    },
    high: { 
      color: 'bg-[#ff3b30]',
      label: 'High'
    },
  };

  const config = priorityConfig[assignment.priority];

  return (
    <div
      ref={drag}
      className={`cursor-move transition-all duration-200 ${
        isDragging ? 'opacity-40 scale-95' : 'opacity-100'
      }`}
    >
      <div className="bg-white rounded-2xl p-5 mb-3 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)] transition-all duration-300 border border-[#d2d2d7]/30">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="flex-1 text-[17px] text-[#1d1d1f] tracking-[-0.022em] leading-snug">
            {assignment.title}
          </h3>
          <div className={`${config.color} px-2.5 py-1 rounded-full flex-shrink-0`}>
            <span className="text-white text-[11px] tracking-wide uppercase">
              {config.label}
            </span>
          </div>
        </div>
        
        <p className="text-[#86868b] text-[15px] leading-relaxed mb-4 tracking-[-0.016em]">
          {assignment.description}
        </p>
        
        <div className="flex items-center gap-4 text-[13px] text-[#86868b]">
          <div className="flex items-center gap-1.5">
            <BookOpen className="w-[14px] h-[14px]" strokeWidth={2} />
            <span className="tracking-[-0.01em]">{assignment.subject}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Calendar className="w-[14px] h-[14px]" strokeWidth={2} />
            <span className="tracking-[-0.01em]">{assignment.dueDate}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
