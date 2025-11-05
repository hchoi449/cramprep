import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Plus } from 'lucide-react';
import { Assignment } from './AssignmentCard';

interface AddAssignmentDialogProps {
  onAdd: (assignment: Omit<Assignment, 'id'>) => void;
}

export function AddAssignmentDialog({ onAdd }: AddAssignmentDialogProps) {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    subject: '',
    dueDate: '',
    priority: 'medium' as 'low' | 'medium' | 'high',
    description: '',
  });
  const [rawDate, setRawDate] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.title || !formData.subject || !rawDate) {
      return;
    }

    // Format the date for display
    const date = new Date(rawDate);
    const formattedDate = date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric', 
      year: 'numeric' 
    });

    onAdd({
      ...formData,
      dueDate: formattedDate,
      status: 'todo',
    });

    // Reset form
    setFormData({
      title: '',
      subject: '',
      dueDate: '',
      priority: 'medium',
      description: '',
    });
    setRawDate('');
    
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-[#007aff] hover:bg-[#0051d5] text-white rounded-full px-6 h-11 shadow-[0_2px_8px_rgba(0,122,255,0.3)] transition-all duration-200 hover:shadow-[0_4px_12px_rgba(0,122,255,0.4)]">
          <Plus className="w-5 h-5 mr-2" strokeWidth={2.5} />
          New Assignment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] bg-white rounded-3xl border border-[#d2d2d7]/30 shadow-[0_20px_60px_rgba(0,0,0,0.15)] p-0 overflow-hidden">
        <DialogHeader className="px-7 pt-7 pb-5 border-b border-[#d2d2d7]/30">
          <DialogTitle className="text-[28px] text-[#1d1d1f] tracking-[-0.026em]">
            Add New Assignment
          </DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="px-7 py-6 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="title" className="text-[15px] text-[#1d1d1f] tracking-[-0.016em]">
              Title
            </Label>
            <Input
              id="title"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              placeholder="Enter assignment title"
              required
              className="h-11 bg-[#f5f5f7] border-[#d2d2d7]/30 rounded-xl text-[15px] tracking-[-0.016em] focus-visible:ring-[#007aff] focus-visible:ring-2 focus-visible:ring-offset-0 transition-all"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject" className="text-[15px] text-[#1d1d1f] tracking-[-0.016em]">
              Subject
            </Label>
            <Input
              id="subject"
              value={formData.subject}
              onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
              placeholder="e.g., Mathematics, English"
              required
              className="h-11 bg-[#f5f5f7] border-[#d2d2d7]/30 rounded-xl text-[15px] tracking-[-0.016em] focus-visible:ring-[#007aff] focus-visible:ring-2 focus-visible:ring-offset-0 transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="dueDate" className="text-[15px] text-[#1d1d1f] tracking-[-0.016em]">
                Due Date
              </Label>
              <Input
                id="dueDate"
                type="date"
                value={rawDate}
                onChange={(e) => setRawDate(e.target.value)}
                required
                className="h-11 bg-[#f5f5f7] border-[#d2d2d7]/30 rounded-xl text-[15px] tracking-[-0.016em] focus-visible:ring-[#007aff] focus-visible:ring-2 focus-visible:ring-offset-0 transition-all"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="priority" className="text-[15px] text-[#1d1d1f] tracking-[-0.016em]">
                Priority
              </Label>
              <Select
                value={formData.priority}
                onValueChange={(value: 'low' | 'medium' | 'high') =>
                  setFormData({ ...formData, priority: value })
                }
              >
                <SelectTrigger className="h-11 bg-[#f5f5f7] border-[#d2d2d7]/30 rounded-xl text-[15px] tracking-[-0.016em] focus:ring-[#007aff] focus:ring-2 focus:ring-offset-0 transition-all">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-white rounded-2xl border border-[#d2d2d7]/30 shadow-[0_10px_40px_rgba(0,0,0,0.15)]">
                  <SelectItem value="low" className="rounded-lg text-[15px] tracking-[-0.016em] focus:bg-[#f5f5f7]">
                    Low
                  </SelectItem>
                  <SelectItem value="medium" className="rounded-lg text-[15px] tracking-[-0.016em] focus:bg-[#f5f5f7]">
                    Medium
                  </SelectItem>
                  <SelectItem value="high" className="rounded-lg text-[15px] tracking-[-0.016em] focus:bg-[#f5f5f7]">
                    High
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description" className="text-[15px] text-[#1d1d1f] tracking-[-0.016em]">
              Description
            </Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Add any additional details..."
              rows={4}
              className="bg-[#f5f5f7] border-[#d2d2d7]/30 rounded-xl text-[15px] tracking-[-0.016em] resize-none focus-visible:ring-[#007aff] focus-visible:ring-2 focus-visible:ring-offset-0 transition-all"
            />
          </div>

          <div className="flex gap-3 pt-4">
            <Button
              type="button"
              onClick={() => setOpen(false)}
              className="flex-1 h-11 bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[#1d1d1f] rounded-xl transition-all duration-200"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1 h-11 bg-[#007aff] hover:bg-[#0051d5] text-white rounded-xl shadow-[0_2px_8px_rgba(0,122,255,0.3)] transition-all duration-200 hover:shadow-[0_4px_12px_rgba(0,122,255,0.4)]"
            >
              Add Assignment
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
