import { useDrop } from 'react-dnd';
import { AssignmentCard, Assignment } from './AssignmentCard';

interface AssignmentColumnProps {
  title: string;
  status: string;
  assignments: Assignment[];
  onDrop: (assignmentId: string, newStatus: string) => void;
  icon: React.ReactNode;
  color: string;
}

export function AssignmentColumn({ 
  title, 
  status, 
  assignments, 
  onDrop, 
  icon,
  color 
}: AssignmentColumnProps) {
  const [{ isOver }, drop] = useDrop(() => ({
    accept: 'assignment',
    drop: (item: { id: string }) => onDrop(item.id, status),
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  }));

  return (
    <div className="flex-1 min-w-[340px]">
      <div className={`rounded-[20px] p-5 h-full transition-all duration-300 ${
        isOver 
          ? 'bg-white/80 backdrop-blur-xl shadow-[0_8px_30px_rgba(0,0,0,0.12)] border-2 border-[#007aff]' 
          : 'bg-white/50 backdrop-blur-xl shadow-[0_2px_12px_rgba(0,0,0,0.04)] border border-[#d2d2d7]/20'
      }`}>
        <div className="flex items-center gap-3 mb-5 pb-4 border-b border-[#d2d2d7]/30">
          <div className={`${color} flex items-center justify-center`}>
            {icon}
          </div>
          <div className="flex-1">
            <h2 className="text-[17px] text-[#1d1d1f] tracking-[-0.022em]">
              {title}
            </h2>
            <p className="text-[13px] text-[#86868b] tracking-[-0.01em]">
              {assignments.length} {assignments.length === 1 ? 'assignment' : 'assignments'}
            </p>
          </div>
        </div>
        
        <div ref={drop} className="min-h-[500px]">
          {assignments.map((assignment) => (
            <AssignmentCard key={assignment.id} assignment={assignment} />
          ))}
          {assignments.length === 0 && (
            <div className="flex items-center justify-center h-48 border-2 border-dashed border-[#d2d2d7]/50 rounded-2xl">
              <p className="text-[#86868b] text-[15px] tracking-[-0.016em]">
                Drop assignments here
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
