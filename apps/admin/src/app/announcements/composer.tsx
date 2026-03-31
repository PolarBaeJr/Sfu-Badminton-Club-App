'use client';

import { useState } from 'react';
import { Button, Input, Textarea, Select, Card } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { publishAnnouncement, saveDraftAnnouncement } from './actions';

const TYPES = [
  { value: 'info', label: 'Info', desc: 'General club update', color: 'bg-blue-500/20 text-blue-400' },
  { value: 'warning', label: 'Warning', desc: 'Important notice', color: 'bg-[#F59E0B]/20 text-[#F59E0B]' },
  { value: 'urgent', label: 'Urgent', desc: 'Time-sensitive', color: 'bg-[#EF4444]/20 text-[#EF4444]' },
  { value: 'event', label: 'Event', desc: 'Session or tournament', color: 'bg-purple-500/20 text-purple-400' },
];

export function AnnouncementComposer({ totalPlayers }: { totalPlayers: number }) {
  const [type, setType] = useState('info');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [sendPush, setSendPush] = useState(true);
  const [audience, setAudience] = useState('all');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handlePublish() {
    if (!title.trim()) { toast('Title is required', 'error'); return; }
    if (!body.trim()) { toast('Body is required', 'error'); return; }
    setLoading(true);
    try {
      await publishAnnouncement({ type, title, body, pinned, send_push: sendPush, target_audience: audience });
      toast('Announcement published', 'success');
      setTitle('');
      setBody('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to publish', 'error');
    }
    setLoading(false);
  }

  async function handleSaveDraft() {
    if (!title.trim()) { toast('Title is required', 'error'); return; }
    setLoading(true);
    try {
      await saveDraftAnnouncement({ type, title, body, pinned, send_push: sendPush, target_audience: audience });
      toast('Draft saved', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save', 'error');
    }
    setLoading(false);
  }

  return (
    <Card className="sticky top-8">
      <h2 className="text-lg font-semibold text-white mb-4">New Announcement</h2>

      {/* Type selector */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {TYPES.map((t) => (
          <button
            key={t.value}
            onClick={() => setType(t.value)}
            className={`p-3 rounded-lg border text-left transition-colors ${
              type === t.value
                ? 'border-[#E94560] bg-[#E94560]/10'
                : 'border-white/10 hover:border-white/20'
            }`}
          >
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${t.color}`}>
              {t.label}
            </span>
            <p className="text-xs text-gray-500 mt-1">{t.desc}</p>
          </button>
        ))}
      </div>

      {/* Title */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium text-gray-300">Title</label>
          <span className={`text-xs ${title.length > 80 ? 'text-[#EF4444]' : 'text-gray-500'}`}>
            {title.length}/100
          </span>
        </div>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 100))}
          placeholder="Announcement title"
        />
      </div>

      {/* Body */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <label className="text-sm font-medium text-gray-300">Body</label>
          <span className={`text-xs ${body.length > 900 ? 'text-[#EF4444]' : 'text-gray-500'}`}>
            {body.length}/1000
          </span>
        </div>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 1000))}
          placeholder="Write your announcement..."
          rows={6}
        />
      </div>

      {/* Options */}
      <div className="space-y-3 mb-4">
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-300">Pin to top</label>
          <button
            onClick={() => setPinned(!pinned)}
            className={`w-10 h-6 rounded-full transition-colors ${pinned ? 'bg-[#E94560]' : 'bg-white/10'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${pinned ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-300">Send push notification</label>
          <button
            onClick={() => setSendPush(!sendPush)}
            className={`w-10 h-6 rounded-full transition-colors ${sendPush ? 'bg-[#E94560]' : 'bg-white/10'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${sendPush ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <Select
          label="Target Audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          options={[
            { value: 'all', label: 'All Players' },
            { value: 'competitive', label: 'Competitive Only' },
            { value: 'recreational', label: 'Recreational Only' },
            { value: 'eligible_only', label: 'Eligible Only' },
          ]}
        />
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={handleSaveDraft} disabled={loading}>
          Save Draft
        </Button>
        <Button onClick={handlePublish} loading={loading} className="flex-1">
          Publish to {totalPlayers} players
        </Button>
      </div>
    </Card>
  );
}
