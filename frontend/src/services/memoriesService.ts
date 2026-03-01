export interface MemoryEntry {
  category: 'preference' | 'fact' | 'pattern';
  content: string;
}

export interface MemoriesResponse {
  entries: MemoryEntry[];
  raw: string;
}

export async function fetchMemories(): Promise<MemoriesResponse> {
  const resp = await fetch('/api/memories');
  if (!resp.ok) throw new Error('Failed to fetch memories');
  return resp.json();
}

export async function deleteMemory(content: string): Promise<void> {
  const resp = await fetch('/api/memories', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(err.error || 'Failed to delete memory');
  }
}
