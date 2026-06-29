import { NextResponse } from 'next/server';
import { listRegisteredProjects, readRunningEntries } from '@/lib/projects/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [projects, running] = await Promise.all([listRegisteredProjects(), readRunningEntries()]);
    const runningIds = new Set(running.map((entry) => entry.projectId));
    return NextResponse.json({
      success: true,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        running: runningIds.has(project.id),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list projects';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
