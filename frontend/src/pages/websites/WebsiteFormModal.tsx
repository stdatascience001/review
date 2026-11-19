import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { websitesApi } from '@/api/resources';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Form';
import { Modal } from '@/components/ui/Modal';
import { getErrorMessage } from '@/lib/api';
import type { Website, WebsiteStatus } from '@/types/api';

export const WebsiteFormModal = ({
  open,
  onClose,
  website,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  website?: Website | null;
  onSaved?: (w: Website) => void;
}) => {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', url: '', description: '', logoUrl: '', status: 'ACTIVE' as WebsiteStatus });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setForm({
      name: website?.name ?? '',
      url: website?.url ?? 'https://',
      description: website?.description ?? '',
      logoUrl: website?.logoUrl ?? '',
      status: website?.status ?? 'ACTIVE',
    });
  }, [open, website]);

  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        url: form.url.trim(),
        description: form.description.trim() || (website ? null : undefined),
        logoUrl: form.logoUrl.trim() || (website ? null : undefined),
        status: form.status,
      };
      return website ? websitesApi.update(website.id, body) : websitesApi.create(body);
    },
    onSuccess: (w) => {
      qc.invalidateQueries({ queryKey: ['websites'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(website ? 'Website updated' : 'Website added');
      onSaved?.(w);
      onClose();
    },
    onError: (err) => setError(getErrorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError('');
    mutation.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={website ? 'Edit website' : 'Add website'}
      description={website ? undefined : 'A unique Site ID and embed script are generated automatically.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="website-form" loading={mutation.isPending}>
            {website ? 'Save changes' : 'Add website'}
          </Button>
        </>
      }
    >
      <form id="website-form" onSubmit={submit} className="space-y-4">
        <Input label="Website name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Marketing Site" />
        <Input label="Website URL" required type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://www.example.com" />
        <Textarea label="Description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div className="flex items-end gap-3">
          <Input
            label="Logo URL"
            type="url"
            className="flex-1"
            value={form.logoUrl}
            onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
            placeholder="https://cdn.example.com/logo.png"
            hint="Must be an https:// image URL"
          />
          {form.logoUrl.startsWith('https://') && (
            <img src={form.logoUrl} alt="Logo preview" className="mb-6 h-10 w-10 rounded-lg border border-slate-200 object-contain" />
          )}
        </div>
        <Select
          label="Status"
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as WebsiteStatus })}
          options={[
            { value: 'ACTIVE', label: 'Active' },
            { value: 'INACTIVE', label: 'Inactive — no new tasks can be created' },
          ]}
        />
        {error && <p role="alert" className="whitespace-pre-line rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Modal>
  );
};
