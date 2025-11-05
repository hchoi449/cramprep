import { useState } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { AssignmentColumn } from './components/AssignmentColumn';
import { Assignment } from './components/AssignmentCard';
import { AddAssignmentDialog } from './components/AddAssignmentDialog';
import { ListTodo, Clock, CheckCircle2 } from 'lucide-react';

export default function App() {
  const [assignments, setAssignments] = useState<Assignment[]>([
    {
      id: '1',
      title: 'Write Essay on Shakespeare',
      subject: 'English Literature',
      dueDate: 'Nov 8, 2025',
      priority: 'high',
      description: 'Analyze themes in Macbeth - minimum 1500 words',
      status: 'todo',
    },
    {
      id: '2',
      title: 'Math Problem Set Chapter 5',
      subject: 'Calculus',
      dueDate: 'Nov 6, 2025',
      priority: 'high',
      description: 'Complete problems 1-25, show all work',
      status: 'todo',
    },
    {
      id: '3',
      title: 'Chemistry Lab Report',
      subject: 'Chemistry',
      dueDate: 'Nov 10, 2025',
      priority: 'medium',
      description: 'Document findings from acid-base titration experiment',
      status: 'in-progress',
    },
    {
      id: '4',
      title: 'History Presentation',
      subject: 'World History',
      dueDate: 'Nov 12, 2025',
      priority: 'medium',
      description: 'Create slides about the Industrial Revolution',
      status: 'in-progress',
    },
    {
      id: '5',
      title: 'Physics Homework',
      subject: 'Physics',
      dueDate: 'Nov 4, 2025',
      priority: 'low',
      description: 'Review Newton\'s laws and complete worksheet',
      status: 'completed',
    },
    {
      id: '6',
      title: 'Spanish Vocabulary Quiz Prep',
      subject: 'Spanish',
      dueDate: 'Nov 5, 2025',
      priority: 'medium',
      description: 'Study chapters 3-4 vocabulary list',
      status: 'completed',
    },
  ]);

  const handleDrop = (assignmentId: string, newStatus: string) => {
    setAssignments((prev) =>
      prev.map((assignment) =>
        assignment.id === assignmentId
          ? { ...assignment, status: newStatus }
          : assignment
      )
    );
  };

  const handleAddAssignment = (newAssignment: Omit<Assignment, 'id'>) => {
    const id = Date.now().toString();
    setAssignments((prev) => [...prev, { ...newAssignment, id }]);
  };

  const todoAssignments = assignments.filter((a) => a.status === 'todo');
  const inProgressAssignments = assignments.filter((a) => a.status === 'in-progress');
  const completedAssignments = assignments.filter((a) => a.status === 'completed');

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="min-h-screen bg-[#f5f5f7] p-8">
        <div className="max-w-[1400px] mx-auto">
          {/* Header */}
          <div className="mb-12 flex items-start justify-between">
            <div>
              <h1 className="text-5xl tracking-tight text-[#1d1d1f] mb-3">
                Assignments
              </h1>
              <p className="text-[#86868b] text-xl">
                Organize your work, your way.
              </p>
            </div>
            <AddAssignmentDialog onAdd={handleAddAssignment} />
          </div>

          {/* Kanban Board */}
          <div className="flex gap-5 overflow-x-auto pb-6">
            <AssignmentColumn
              title="To Do"
              status="todo"
              assignments={todoAssignments}
              onDrop={handleDrop}
              icon={<ListTodo className="w-[18px] h-[18px]" strokeWidth={2.5} />}
              color="text-[#ff3b30]"
            />
            <AssignmentColumn
              title="In Progress"
              status="in-progress"
              assignments={inProgressAssignments}
              onDrop={handleDrop}
              icon={<Clock className="w-[18px] h-[18px]" strokeWidth={2.5} />}
              color="text-[#ff9500]"
            />
            <AssignmentColumn
              title="Completed"
              status="completed"
              assignments={completedAssignments}
              onDrop={handleDrop}
              icon={<CheckCircle2 className="w-[18px] h-[18px]" strokeWidth={2.5} />}
              color="text-[#34c759]"
            />
          </div>
        </div>
      </div>
    </DndProvider>
  );
}
