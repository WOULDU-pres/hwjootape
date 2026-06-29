import { NextResponse } from 'next/server';
import { createRegisteredProject } from '@/lib/projects/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    try {
      const project = await createRegisteredProject(name);
      return NextResponse.json({ success: true, id: project.id, name: project.name });
    } catch (error) {
      // wx flag throws EEXIST when the slug already exists.
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
        return NextResponse.json({ error: '같은 이름의 덱이 이미 있습니다.' }, { status: 409 });
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create project';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
